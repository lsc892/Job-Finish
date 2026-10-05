// Runs in normal development windows so both windows share VS Code's actual profile/storage.
// Only the test harness supplies ExtensionMode.Test; production APIs stay read-only.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { activate as activateProduct, deactivate as deactivateProduct } from '../src/extension';
import { runWithApi } from './extension-host';

interface Snapshot {
  results: { text: string; status: string; windowInstanceId: string }[];
  sessions: { binding: { sessionId: string; connectionId: string }; state: { turns: { id: string; status: string }[] } }[];
}
interface Api {
  identity(): { windowInstanceId: string; extensionHostPid: number };
  snapshot(): Snapshot;
  test: { open(provider: string, cwd: string, id?: string): Promise<string>; run(id: string, prompt: string): Promise<void>; cancel(id: string): Promise<void>; release(id: string): void; bind(): Promise<boolean>; flashId(): string | undefined };
}
interface RestartState { stage: 'reload' | 'crash'; session: string; identities: string[]; connections: string[] }
async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('Same-profile host timeout'); await new Promise(r => setTimeout(r, 50)); }
}
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const testContext = new Proxy(context, { get: (target, key) => key === 'extensionMode' ? vscode.ExtensionMode.Test : Reflect.get(target, key) });
  const api = await activateProduct(testContext) as Api;
  const root = process.env.JOB_FINISH_PROFILE_ARTIFACTS!;
  const role = basename(vscode.workspace.workspaceFile!.fsPath, '.code-workspace');
  const write = (name: string, data: unknown) => writeFileSync(join(root, name), JSON.stringify(data, null, 2));
  const read = (name: string) => JSON.parse(readFileSync(join(root, name), 'utf8'));
  const has = (name: string) => existsSync(join(root, name));
  const cwd = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const identity = api.identity();
  try {
    assert.ok(api.test);
    if (process.env.JOB_FINISH_PROFILE_NATIVE === '1') {
      await runWithApi(api as Parameters<typeof runWithApi>[0], root, role); return;
    }
    const storage = context.globalStorageUri.fsPath;
    if (role === 'B') {
      await until(() => has('A-ready.json'));
      const a = read('A-ready.json'); assert.equal(storage, a.storage);
      assert.notEqual(identity.windowInstanceId, a.identity.windowInstanceId);
      assert.notEqual(identity.extensionHostPid, a.identity.extensionHostPid);
      await assert.rejects(() => api.test.open('codex', cwd, a.session), /owned/);
      const session = await api.test.open('codex', cwd); await api.test.run(session, 'PROFILE_B');
      await until(() => api.snapshot().results.length === 1);
      write('B-ready.json', { identity, storage }); await until(() => has('A-result.json'));
      assert.equal(api.snapshot().results.length, 1); assert.equal(api.snapshot().results[0]!.text, 'PROFILE_B');
      assert.equal(api.snapshot().results[0]!.windowInstanceId, identity.windowInstanceId);
      const resumed = await api.test.open('codex', cwd, a.session);
      assert.equal(api.snapshot().results.length, 1, 'No historical completion after ownership transfer');
      api.test.release(resumed); api.test.release(session);
      write('B-result.json', { passed: true, identity, storage, checks: ['sameProfileStorage', 'exclusiveOwnership', 'isolatedResults', 'ownershipTransferNoReplay'] });
      return;
    }
    const restart = context.workspaceState.get<RestartState>('restart');
    if (!restart) {
      const session = await api.test.open('codex', cwd); await api.test.run(session, 'PROFILE_A');
      await until(() => api.snapshot().results.length === 1);
      assert.equal(api.snapshot().results[0]!.windowInstanceId, identity.windowInstanceId);
      await api.test.run(session, 'wait');
      write('A-ready.json', { identity, session, storage }); await until(() => has('B-ready.json'));
      assert.equal(api.snapshot().results.length, 1, 'Other window result must not cross');
      await context.workspaceState.update('restart', { stage: 'reload', session, identities: [identity.windowInstanceId], connections: [api.snapshot().sessions[0]!.binding.connectionId] } satisfies RestartState);
      // Reload tears down the RPC endpoint; completion is verified by the next activation.
      void vscode.commands.executeCommand('workbench.action.reloadWindow').then(undefined, () => {}); return;
    }
    assert.ok(!restart.identities.includes(identity.windowInstanceId), 'Activation must generate a fresh UUID');
    const session = await api.test.open('codex', cwd, restart.session);
    assert.equal(api.snapshot().results.length, 0, 'Completed checkpoints must not notify again');
    const state = api.snapshot().sessions[0]!;
    assert.equal(state.state.turns.length, 1); assert.equal(state.state.turns[0]!.status, 'running');
    assert.ok(!restart.connections.includes(state.binding.connectionId));
    await api.test.cancel(session); await until(() => api.snapshot().results.length === 1);
    assert.equal(api.snapshot().results[0]!.status, 'cancelled');
    const identities = [...restart.identities, identity.windowInstanceId];
    const connections = [...restart.connections, state.binding.connectionId];
    if (restart.stage === 'reload') {
      await api.test.run(session, 'wait');
      await context.workspaceState.update('restart', { stage: 'crash', session, identities, connections } satisfies RestartState);
      write('A-kill-ready.json', { identity, session, storage }); return;
    }
    api.test.release(session);
    write('A-result.json', { passed: true, identity, identities, connections, storage,
      checks: ['sameProfileStorage', 'isolatedResults', 'windowReload', 'forcedExtensionHostExit', 'deadOwnerReclaim', 'freshUUID', 'newConnection', 'recoveryNoReplay', 'trackedTurnReconciled'] });
  } catch (error) { write(`${role}-result.json`, { passed: false, error: String(error), stack: (error as Error).stack }); }
}
export function deactivate(): void { deactivateProduct(); }
