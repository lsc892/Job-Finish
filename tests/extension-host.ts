import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Win32 } from '../src/windows/native';
const koffi: typeof import('koffi', { with: { 'resolution-mode': 'import' } }) = require('koffi');

interface Api {
  identity(): { windowInstanceId: string; extensionHostPid: number };
  snapshot(): { results: { status: string; text: string; windowInstanceId: string }[]; diagnostics: unknown[]; sessions: unknown[]; native?: { hwnd: bigint } };
  test: { open(provider: string, cwd: string, sessionId?: string): Promise<string>; run(id: string, prompt: string): Promise<void>; cancel(id: string): Promise<void>; release(id: string): void; bind(): Promise<boolean>; flashId(): string | undefined };
}
async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('Extension Host timeout'); await new Promise(r => setTimeout(r, 50)); }
}
export async function run(): Promise<void> {
  const root = process.env.JOB_FINISH_HOST_ARTIFACTS!;
  const role = vscode.workspace.workspaceFile ? basename(vscode.workspace.workspaceFile.fsPath, '.code-workspace') : 'single';
  const extension = vscode.extensions.getExtension<Api>('lsc892.job-finish'); assert.ok(extension);
  return runWithApi(await extension.activate(), root, role);
}
export async function runWithApi(api: Api, root: string, role: string): Promise<void> {
  const resultFile = role === 'single' ? 'extension-host.json' : `${role}-result.json`;
  try {
    assert.ok(api.test, 'Test API gated to ExtensionMode.Test');
    const identity = api.identity(); assert.match(identity.windowInstanceId, /^[0-9a-f-]{36}$/);
    const title = `JF TEST ${role} ${identity.windowInstanceId}`;
    await vscode.workspace.getConfiguration('window').update('title', title, vscode.ConfigurationTarget.Workspace);
    const native = new Win32(); const setForeground = koffi.load('user32.dll').func('__stdcall', 'SetForegroundWindow', 'int32', ['uintptr_t']);
    await until(() => native.enumerate(true).some(w => w.title.includes(title)));
    const ownWindow = native.enumerate(true).find(w => w.title.includes(title))!;
    koffi.load('user32.dll').func('__stdcall', 'ShowWindow', 'int32', ['uintptr_t', 'int32'])(ownWindow.hwnd, 9);
    const focus = (hwnd: bigint) => {
      setForeground(hwnd);
    };
    focus(ownWindow.hwnd);
    writeFileSync(join(root, `${role}-focus.json`), JSON.stringify({ own: ownWindow.hwnd.toString(), nativeForeground: native.foreground().toString(), focused: vscode.window.state.focused }));
    await new Promise(resolve => setTimeout(resolve, 500));
    const canFocusNative = vscode.window.state.focused && native.foreground() === ownWindow.hwnd;
    if (canFocusNative) assert.equal(await api.test.bind(), true);
    if (role !== 'single') await vscode.workspace.getConfiguration('window').update('title', 'JOB-FINISH SAME TITLE', vscode.ConfigurationTarget.Workspace);
    if (role !== 'single') {
      const cwd = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      if (role === 'A') {
        const session = await api.test.open('codex', cwd); await api.test.run(session, 'wait');
        writeFileSync(join(root, 'A-ready.json'), JSON.stringify({ ...identity, session, hwnd: ownWindow.hwnd.toString(), canFocusNative }));
        await until(() => existsSync(join(root, 'B-ready.json')));
        const other = JSON.parse(readFileSync(join(root, 'B-ready.json'), 'utf8'));
        assert.notEqual(other.windowInstanceId, identity.windowInstanceId); assert.notEqual(other.hwnd, ownWindow.hwnd.toString());
        if (canFocusNative && other.canFocusNative) await until(() => !vscode.window.state.focused);
        await api.test.cancel(session); await until(() => api.snapshot().results.length === 1);
        if (canFocusNative && other.canFocusNative) await until(() => !!api.test.flashId());
        writeFileSync(join(root, 'A-flashed.json'), JSON.stringify({ notificationId: api.test.flashId(), binding: api.snapshot().native?.hwnd.toString() }));
        await until(() => existsSync(join(root, 'B-checked.json')));
        if (canFocusNative && other.canFocusNative) { focus(ownWindow.hwnd); await until(() => vscode.window.state.focused && !api.test.flashId()); }
        await api.test.run(session, 'RESULT_A'); await until(() => api.snapshot().results.length === 2);
        if (canFocusNative && other.canFocusNative) assert.equal(api.test.flashId(), undefined);
        api.test.release(session); writeFileSync(join(root, 'A-finished.json'), '{}');
      } else {
        await until(() => existsSync(join(root, 'A-ready.json')));
        const other = JSON.parse(readFileSync(join(root, 'A-ready.json'), 'utf8'));
        await assert.rejects(() => api.test.open('codex', cwd, other.session), /owned/);
        const session = await api.test.open('codex', cwd); await api.test.run(session, 'FOCUSED_B'); await until(() => api.snapshot().results.length === 1);
        assert.equal(api.test.flashId(), undefined);
        writeFileSync(join(root, 'B-ready.json'), JSON.stringify({ ...identity, hwnd: ownWindow.hwnd.toString(), canFocusNative }));
        await until(() => existsSync(join(root, 'A-flashed.json')));
        assert.equal(api.snapshot().results.length, 1); assert.equal(api.test.flashId(), undefined);
        assert.equal(api.snapshot().results[0]!.text, 'FOCUSED_B');
        writeFileSync(join(root, 'B-checked.json'), '{}'); await until(() => existsSync(join(root, 'A-finished.json')));
        api.test.release(session);
      }
      writeFileSync(join(root, resultFile), JSON.stringify({ passed: true, role, identity, nativeHwnd: ownWindow.hwnd.toString(), canFocusNative,
        checks: ['windowRouting', 'exclusiveOwnership'], nativeChecks: canFocusNative ? 'See both window focus flags' : 'SKIPPED: Windows foreground activation refused; manual desktop verification required' }, null, 2));
      return;
    }
    const commands = await vscode.commands.getCommands(true); assert.ok(commands.includes('jobFinish.runCodex')); assert.ok(commands.includes('jobFinish.respond'));
    const session = await api.test.open('codex', vscode.workspace.workspaceFolders![0]!.uri.fsPath);
    await api.test.run(session, 'EXTENSION_HOST_OK');
    await until(() => api.snapshot().results.length === 1);
    const first = api.snapshot().results[0]!; assert.equal(first.text, 'EXTENSION_HOST_OK'); assert.equal(first.status, 'completed'); assert.equal(first.windowInstanceId, identity.windowInstanceId);
    await api.test.run(session, 'wait'); await api.test.cancel(session); await until(() => api.snapshot().results.length === 2);
    assert.equal(api.snapshot().results[1]!.status, 'cancelled');
    const nativeBound = await api.test.bind();
    api.test.release(session); assert.equal(api.snapshot().sessions.length, 0);
    writeFileSync(join(root, resultFile), JSON.stringify({ passed: true, version: vscode.version, identity, nativeBound, snapshot: api.snapshot() }, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
  } catch (error) {
    writeFileSync(join(root, resultFile), JSON.stringify({ passed: false, error: String(error), stack: (error as Error).stack }, null, 2)); throw error;
  }
}
