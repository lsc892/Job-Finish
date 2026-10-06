// Isolated desktop harness: real observation, C# toast and native window focus.
import * as vscode from 'vscode';
import { activate as activateProduct } from '../src/extension';
import { Win32 } from '../src/windows/native';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';

interface Api {
  identity(): { windowInstanceId: string; extensionHostPid: number };
  snapshot(): { events: { event: string }[]; native?: { hwnd: bigint }; [key: string]: unknown };
  test: { unbind(): void; bind(): Promise<boolean> };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const write = (file: string, value: unknown) => { writeFileSync(`${file}.tmp`, JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2)); renameSync(`${file}.tmp`, file); };
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const testContext = new Proxy(context, { get: (target, key) => key === 'extensionMode' ? vscode.ExtensionMode.Test : Reflect.get(target, key) });
  const api = await activateProduct(testContext) as Api;
  void run(api, context).catch(error => writeFileSync(join(process.env.JOB_FINISH_TOAST_ARTIFACTS!, `${basename(vscode.workspace.workspaceFile!.fsPath, '.code-workspace')}-error.json`), JSON.stringify({ error: String(error), stack: (error as Error).stack })));
}
async function run(api: Api, context: vscode.ExtensionContext): Promise<void> {
  const root = process.env.JOB_FINISH_TOAST_ARTIFACTS!;
  const role = basename(vscode.workspace.workspaceFile!.fsPath, '.code-workspace');
  const native = new Win32(); const identity = api.identity();
  const koffi: typeof import('koffi', { with: { 'resolution-mode': 'import' } }) = require('koffi');
  const user = koffi.load('user32.dll');
  const isIconic = user.func('__stdcall', 'IsIconic', 'int32', ['uintptr_t']);
  const isZoomed = user.func('__stdcall', 'IsZoomed', 'int32', ['uintptr_t']);
  const showWindow = user.func('__stdcall', 'ShowWindow', 'int32', ['uintptr_t', 'int32']);
  const title = `JF TOAST TEST ${identity.windowInstanceId}`;
  await vscode.workspace.getConfiguration('window').update('title', title, vscode.ConfigurationTarget.Workspace);
  const end = Date.now() + 10_000;
  while (!native.enumerate(true).some(window => window.title.includes(title))) { if (Date.now() > end) throw new Error(`Test window not found: ${JSON.stringify(native.enumerate(true).map(window => window.title))}`); await pause(50); }
  const own = native.enumerate(true).find(window => window.title.includes(title))!;
  await vscode.workspace.getConfiguration('window').update('title', 'JF TOAST SAME TITLE', vscode.ConfigurationTarget.Workspace);
  const external = spawn(process.execPath, [join(process.env.JOB_FINISH_TEST_AGENT_ROOT!, 'observed-agent.cjs'), 'app-server'],
    { windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  external.stdout.resume(); context.subscriptions.push({ dispose: () => external.kill() });
  write(join(root, `${role}-ready.json`), { ...identity, hwnd: own.hwnd.toString(), version: vscode.version });
  let last = '';
  const observations: { at: string; foreground: string; focused: boolean; minimized: boolean; maximized: boolean }[] = [];
  const snapshot = () => ({ ...api.snapshot(), observations, focused: vscode.window.state.focused, foreground: native.foreground().toString(), hwnd: own.hwnd.toString(),
    minimized: !!isIconic(own.hwnd), maximized: !!isZoomed(own.hwnd) });
  const commandFile = join(root, `${role}-command.json`);
  while (true) {
    const observed = { at: new Date().toISOString(), foreground: native.foreground().toString(), focused: vscode.window.state.focused, minimized: !!isIconic(own.hwnd), maximized: !!isZoomed(own.hwnd) };
    const previous = observations.at(-1);
    if (!previous || previous.foreground !== observed.foreground || previous.focused !== observed.focused || previous.minimized !== observed.minimized || previous.maximized !== observed.maximized) {
      observations.push(observed); if (observations.length > 100) observations.shift();
    }
    if (existsSync(commandFile)) {
      const command = JSON.parse(readFileSync(commandFile, 'utf8')) as { id: string; action: string; turn?: string; unbind?: boolean };
      if (command.id !== last) {
        last = command.id;
        if (command.action === 'focus') await vscode.commands.executeCommand('workbench.action.focusWindow');
        if (command.action === 'bind') {
          // Require the product focus listener to bind; do not repair it with a test-only observe call.
          const bindingDeadline = Date.now() + 1600;
          while (api.snapshot().native?.hwnd !== own.hwnd && Date.now() < bindingDeadline) await pause(50);
          if (api.snapshot().native?.hwnd !== own.hwnd) throw new Error(`Isolated window failed actual focused HWND observation: ${JSON.stringify(snapshot(), (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item)}`);
        }
        if (command.action === 'minimize') showWindow(own.hwnd, 6);
        if (command.action === 'maximize') showWindow(own.hwnd, 3);
        if (command.action === 'emit') {
          if (command.unbind) api.test.unbind();
          external.stdin.write(JSON.stringify({ events: [
            { method: 'turn/started', params: { threadId: role, turn: { id: command.turn, status: 'inProgress' } } },
            { method: 'turn/completed', params: { threadId: role, turn: { id: command.turn, status: 'completed', items: [{ type: 'agentMessage', text: 'Toast activation verification' }] } } },
          ] }) + '\n');
        }
        if (command.action === 'snapshot') write(join(root, `${role}-${command.id}.json`), snapshot());
        write(join(root, `${role}-ack.json`), { id: last });
      }
    }
    await pause(20);
  }
}
