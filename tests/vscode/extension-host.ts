// 실제 VS Code 확장 호스트에서 자동 감지·명령·설정 전환·창별 결과 격리를 검증한다.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';

interface Api {
  identity(): { windowInstanceId: string; extensionHostPid: number };
  snapshot(): { enabled: boolean; automatic: { enabled: boolean; connections: unknown[] }; results: { status: string; text: string; windowInstanceId: string }[]; diagnostics: unknown[]; native?: { hwnd: bigint } };
  test: { bind(): Promise<boolean>; flashId(): string | undefined; unbind(): void };
}
async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 45000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('Extension Host timeout'); await new Promise(r => setTimeout(r, 50)); }
}
export async function run(): Promise<void> {
  const root = process.env.JOB_FINISH_HOST_ARTIFACTS!;
  const role = vscode.workspace.workspaceFile ? basename(vscode.workspace.workspaceFile.fsPath, '.code-workspace') : 'single';
  const resultFile = join(root, role === 'single' ? 'extension-host.json' : `${role}-result.json`);
  const children: ChildProcessWithoutNullStreams[] = [];
  const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value));
  try {
    const extension = vscode.extensions.getExtension<Api>('JobFinish.JobFinish'); assert.ok(extension);
    const api = await extension.activate(); const identity = api.identity();
    assert.match(identity.windowInstanceId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(api.test).sort(), ['bind', 'flashId', 'unbind']);
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['results', 'bindWindow', 'stopFlash', 'diagnostics']) assert.ok(commands.includes(`jobFinish.${command}`));
    for (const command of ['runCodex', 'runClaude', 'continue', 'resume', 'cancel', 'respond', 'reconnect', 'detach']) assert.ok(!commands.includes(`jobFinish.${command}`), `Removed command still registered: ${command}`);
    await vscode.commands.executeCommand('jobFinish.stopFlash'); assert.equal(api.test.flashId(), undefined);
    await vscode.commands.executeCommand('jobFinish.diagnostics');
    const settings = extension.packageJSON.contributes.configuration.flatMap((group: { properties: object }) => Object.keys(group.properties));
    assert.deepEqual(settings.sort(), ['jobFinish.enabled', 'jobFinish.flash', 'jobFinish.flashMode', 'jobFinish.flashTimeoutSeconds', 'jobFinish.toast', 'jobFinish.toastIcon', 'jobFinish.toastIconPath']);
    const external = spawn(process.execPath, [join(process.env.JOB_FINISH_TEST_AGENT_ROOT!, 'observed-agent.cjs'), 'app-server'],
      { windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    children.push(external);
    const output: Buffer[] = []; external.stdout.on('data', chunk => output.push(chunk));
    const sent: unknown[] = [];
    const send = (...events: unknown[]) => { sent.push(...events); external.stdin.write(JSON.stringify({ events }) + '\n'); };
    const completed = (id: string, text: string, status = 'completed') => ({ method: 'turn/completed', params: { threadId: 'shared-session', turn: { id, status, items: [{ type: 'agentMessage', phase: 'final_answer', text }] } } });
    send(completed('shared-turn', role === 'single' ? 'EXTERNAL_OK' : `RESULT_${role}`));
    await until(() => api.snapshot().results.length === 1);
    assert.equal(api.snapshot().results[0]!.windowInstanceId, identity.windowInstanceId);
    assert.equal(api.snapshot().automatic.connections.length, 1);
    if (role !== 'single') {
      write(`${role}-ready.json`, identity);
      await until(() => existsSync(join(root, `${role === 'A' ? 'B' : 'A'}-ready.json`)));
      const other = JSON.parse(readFileSync(join(root, `${role === 'A' ? 'B' : 'A'}-ready.json`), 'utf8'));
      assert.notEqual(other.windowInstanceId, identity.windowInstanceId);
      assert.equal(api.snapshot().results.length, 1);
      assert.equal(api.snapshot().results[0]!.text, `RESULT_${role}`);
      write(`${role}-checked.json`, {});
      await until(() => existsSync(join(root, `${role === 'A' ? 'B' : 'A'}-checked.json`)));
    } else {
      assert.equal(api.snapshot().results[0]!.text, 'EXTERNAL_OK');
      await vscode.workspace.getConfiguration('jobFinish').update('enabled', false, vscode.ConfigurationTarget.Workspace);
      await until(() => !api.snapshot().automatic.enabled); assert.equal(api.snapshot().automatic.connections.length, 0);
      send(completed('disabled', 'DISABLED'));
      await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(api.snapshot().results.length, 1);
      await vscode.workspace.getConfiguration('jobFinish').update('enabled', true, vscode.ConfigurationTarget.Workspace);
      await until(() => api.snapshot().automatic.enabled && api.snapshot().automatic.connections.length === 1);
      send(completed('reenabled', 'REENABLED_OK'), completed('failed', 'ERROR', 'failed'), completed('cancelled', 'CANCELLED', 'interrupted'));
      await until(() => api.snapshot().results.length === 4);
      assert.deepEqual(api.snapshot().results.map(result => result.status), ['completed', 'completed', 'error', 'cancelled']);
      const question = { method: 'item/started', params: { threadId: 'shared-session', turnId: 'question-turn',
        item: { type: 'agentMessage', id: 'question', phase: 'commentary', text: '', questions: [{ title: 'Which environment?' }] } } };
      send(question, question, { ...question, method: 'item/completed' }, completed('question-turn', 'ASYNC_DONE'));
      await until(() => api.snapshot().results.length === 6);
      assert.deepEqual(api.snapshot().results.slice(-2).map(result => [result.status, result.text]), [['waitingForInput', 'Which environment?'], ['completed', 'ASYNC_DONE']]);
      const claude = spawn(process.execPath, [join(process.env.JOB_FINISH_TEST_AGENT_ROOT!, 'observed-agent.cjs'), '--output-format', 'stream-json'],
        { windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      children.push(claude); claude.stdout.resume();
      claude.stdin.write(JSON.stringify({ events: [{ type: 'result', session_id: 'claude-session', uuid: 'result', subtype: 'success', is_error: false, result: 'CLAUDE_OK' }] }) + '\n');
      await until(() => api.snapshot().results.length === 7); assert.equal(api.snapshot().results.at(-1)!.text, 'CLAUDE_OK');
    }
    assert.equal(Buffer.concat(output).toString('utf8'), sent.map(event => JSON.stringify(event) + '\n').join(''));
    assert.deepEqual(api.snapshot().diagnostics, []);
    writeFileSync(resultFile, JSON.stringify({ passed: true, role, version: vscode.version, identity, snapshot: api.snapshot() }, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
  } catch (error) {
    writeFileSync(resultFile, JSON.stringify({ passed: false, error: String(error), stack: (error as Error).stack }, null, 2)); throw error;
  } finally { for (const child of children) child.kill(); }
}
