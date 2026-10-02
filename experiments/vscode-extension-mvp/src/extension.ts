import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Signal, Provider, LogFormat, SignalParser } from "./signals";
import { JsonlTail } from "./tail";
import { claimLog } from "./ownership";
import { launchProbe, resolveExecutable } from "./runner";

export interface WatchRequest { path: string; provider: Provider; format: LogFormat; sessionId?: string; fromStart?: boolean }
export interface ReceivedSignal extends Signal { windowInstanceId: string; logPath: string; receivedAt: string }
export interface MvpApi {
  identity: { windowInstanceId: string; vscodeSessionId: string; workspaceUris: string[]; extensionHostPid: number; startedAt: string };
  snapshot(): { signals: ReceivedSignal[]; watcherEvents: number; focusEvents: number; documentEvents: number; errors: string[] };
  watch(request: WatchRequest): Promise<{ flush(): Promise<void>; dispose(): Promise<void> }>;
  probe(provider: Provider, marker?: string): Promise<{ journal: string; exitCode: number | null; signals: ReceivedSignal[] }>;
  dispose(): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<MvpApi> {
  const testRoot = context.extensionMode === vscode.ExtensionMode.Test ? process.env.JF_MVP_SHARED : undefined;
  const storage = testRoot ?? context.globalStorageUri.fsPath;
  await mkdir(storage, { recursive: true });
  const identity = { windowInstanceId: randomUUID(), vscodeSessionId: vscode.env.sessionId,
    workspaceUris: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()),
    extensionHostPid: process.pid, startedAt: new Date().toISOString() };
  const signals: ReceivedSignal[] = [];
  const errors: string[] = [];
  let watcherEvents = 0, focusEvents = 0, documentEvents = 0;
  const output = vscode.window.createOutputChannel("Job-Finish MVP");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.text = `$(pulse) JF ${identity.windowInstanceId.slice(0, 8)}`;
  status.tooltip = JSON.stringify(identity, null, 2);
  status.command = "jobFinishMvp.results";
  status.show();
  output.appendLine(JSON.stringify({ event: "activated", ...identity }));
  const subscriptions = [output, status,
    vscode.window.onDidChangeWindowState(state => { focusEvents++; output.appendLine(JSON.stringify({ event: "focus", focused: state.focused })); }),
    vscode.workspace.onDidChangeTextDocument(() => { documentEvents++; })];
  const watches = new Set<{ flush(): Promise<void>; dispose(): Promise<void> }>();
  const running = new Set<() => void>();
  const reportError = (error: unknown) => { const message = String(error); errors.push(message); output.appendLine(message); };

  const api: MvpApi = {
    identity,
    snapshot: () => ({ signals: [...signals], watcherEvents, focusEvents, documentEvents, errors: [...errors] }),
    async watch(request) {
      const release = await claimLog(path.join(storage, "owners"), request.path, identity.windowInstanceId);
      const parser = new SignalParser(request.provider, request.format, request.sessionId);
      const seen = new Set<string>();
      let ready = false, disposed = false;
      const tail = new JsonlTail(request.path, (record, position) => {
        if (disposed) return;
        const signal = parser.parse(record, position);
        if (!signal || seen.has(signal.key)) return;
        seen.add(signal.key);
        const received = { ...signal, windowInstanceId: identity.windowInstanceId, logPath: request.path, receivedAt: new Date().toISOString() };
        signals.push(received);
        output.appendLine(JSON.stringify({ event: "signal", ...received }));
        status.text = `$(bell) JF ${identity.windowInstanceId.slice(0, 8)} · ${signal.status}`;
        // Test mode records the same notification path without leaving popup UI behind.
        if (context.extensionMode !== vscode.ExtensionMode.Test) {
          void vscode.window.showInformationMessage(`Job-Finish [${identity.windowInstanceId.slice(0, 8)}] ${signal.provider}: ${signal.status}`, "Show signals")
            .then(action => { if (action) output.show(); });
        }
      }, reportError);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(request.path), path.basename(request.path)));
      const changed = () => { if (disposed) return; watcherEvents++; if (ready) void tail.drain(); };
      const events = [watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)];
      try { await tail.initialize(request.fromStart); ready = true; await tail.drain(); }
      catch (error) { events.forEach(s => s.dispose()); watcher.dispose(); await release(); throw error; }
      const watch = {
        flush: () => tail.drain(),
        async dispose() {
          if (disposed) return;
          disposed = true; events.forEach(s => s.dispose()); watcher.dispose();
          await tail.drain(); await release(); watches.delete(watch);
        }
      };
      watches.add(watch);
      output.appendLine(JSON.stringify({ event: "bound", windowInstanceId: identity.windowInstanceId, ...request }));
      return watch;
    },
    async probe(provider, marker = `JF_MVP_${randomUUID()}`) {
      const settings = vscode.workspace.getConfiguration("jobFinishMvp");
      const executable = await resolveExecutable(provider, settings.get<string>(`${provider}Executable`));
      const journal = path.join(storage, `${identity.windowInstanceId}-${provider}-${randomUUID()}.jsonl`);
      await writeFile(journal, "");
      const watch = await api.watch({ path: journal, provider, format: "runtime" });
      // A clean temporary folder prevents the validation prompt reading project instructions.
      const cwd = path.join(storage, "probe-workspace");
      await mkdir(cwd, { recursive: true });
      const run = launchProbe({ provider, executable, cwd, journal, sessionId: randomUUID(),
        prompt: `This is an integration connectivity test. Do not use tools or read or change files. Reply with exactly: ${marker}` });
      running.add(run.cancel);
      try {
        const result = await run.done;
        // Watcher is the live trigger. Explicit flush also covers a final coalesced file event.
        await watch.flush();
        return { journal, exitCode: result.exitCode, signals: signals.filter(s => s.logPath === journal) };
      } finally { running.delete(run.cancel); await watch.dispose(); }
    },
    async dispose() { running.forEach(cancel => cancel()); await Promise.all([...watches].map(w => w.dispose())); subscriptions.forEach(s => s.dispose()); }
  };
  const commands = [
    vscode.commands.registerCommand("jobFinishMvp.identity", () => { output.appendLine(JSON.stringify(identity, null, 2)); output.show(); return identity; }),
    vscode.commands.registerCommand("jobFinishMvp.results", () => { output.appendLine(JSON.stringify(api.snapshot(), null, 2)); output.show(); }),
    vscode.commands.registerCommand("jobFinishMvp.probe", async () => {
      const provider = await vscode.window.showQuickPick(["codex", "claude"], { title: "Agent connectivity test" });
      if (!provider) return;
      try { return await api.probe(provider as Provider); } catch (error) { reportError(error); void vscode.window.showErrorMessage(String(error)); }
    }),
    vscode.commands.registerCommand("jobFinishMvp.bind", async () => {
      const provider = await vscode.window.showQuickPick(["codex", "claude"], { title: "Session transcript provider" });
      if (!provider) return;
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "Session log": ["jsonl"] },
        defaultUri: vscode.Uri.file(path.join(os.homedir(), provider === "codex" ? ".codex/sessions" : ".claude/projects")) });
      if (!files?.[0]) return;
      try { await api.watch({ path: files[0].fsPath, provider: provider as Provider, format: "transcript", sessionId: path.basename(files[0].fsPath, ".jsonl") }); }
      catch (error) { reportError(error); void vscode.window.showErrorMessage(String(error)); }
    })
  ];
  context.subscriptions.push(...commands, { dispose: () => { void api.dispose().catch(reportError); } });
  activeApi = api;
  return api;
}
let activeApi: MvpApi | undefined;
export async function deactivate(): Promise<void> { await activeApi?.dispose(); }
