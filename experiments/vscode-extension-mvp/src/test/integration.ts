import * as vscode from "vscode";
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MvpApi } from "../extension";
import { launchProbe, resolveExecutable } from "../runner";

async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, timeout = 30_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Integration test condition timed out.");
}
async function exists(filename: string): Promise<boolean> { try { await readFile(filename); return true; } catch { return false; } }
async function nativeLog(provider: string, session: string): Promise<string | undefined> {
  const base = path.join(os.homedir(), provider === "codex" ? ".codex/sessions" : ".claude/projects");
  async function walk(dir: string): Promise<string | undefined> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(session)) return filename;
      if (entry.isDirectory()) { const found = await walk(filename); if (found) return found; }
    }
  }
  return walk(base);
}
export async function run(): Promise<void> {
  const root = process.env.JF_MVP_SHARED!;
  const role = process.env.JF_MVP_ROLE!;
  const extension = vscode.extensions.getExtension<MvpApi>("job-finish.job-finish-mvp");
  assert.ok(extension, "VS Code must load the real development extension");
  const api = await extension.activate();
  const report: any = { role, identity: api.identity, vscodeVersion: vscode.version, checks: {} };
  try {
    await writeFile(path.join(root, `identity-${role}.json`), JSON.stringify(api.identity));
    const sharedLog = path.join(root, "A.jsonl");
    if (role === "reload") {
      const watch = await api.watch({ path: sharedLog, provider: "codex", format: "transcript", sessionId: "A" });
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.equal(api.snapshot().signals.length, 0);
      await appendFile(sharedLog, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "after-restart", last_agent_message: "RESTART_ONLY" } }) + "\n");
      await until(() => api.snapshot().signals, x => x.length === 1);
      report.checks.noHistoricalReplay = true;
      report.checks.newEventsAfterRestart = true;
      await watch.dispose();
      return;
    }
    const otherRole = role === "A" ? "B" : "A";
    await until(() => exists(path.join(root, `identity-${otherRole}.json`)), Boolean);
    const other = JSON.parse(await readFile(path.join(root, `identity-${otherRole}.json`), "utf8"));
    assert.notEqual(api.identity.windowInstanceId, other.windowInstanceId);
    report.checks.uniqueWindowId = true;
    report.sameWorkspace = JSON.stringify(api.identity.workspaceUris) === JSON.stringify(other.workspaceUris);
    const ownLog = path.join(root, `${role}.jsonl`);
    const watch = await api.watch({ path: ownLog, provider: "codex", format: "transcript", sessionId: role });
    if (role === "A") await writeFile(path.join(root, "A-owns-shared"), "ready");
    else {
      await until(() => exists(path.join(root, "A-owns-shared")), Boolean);
      await assert.rejects(api.watch({ path: sharedLog, provider: "codex", format: "transcript" }), /already owned/);
      report.checks.duplicateOwnerRejected = true;
    }
    await writeFile(path.join(root, `${role}-watching`), "ready");
    await until(() => exists(path.join(root, `${otherRole}-watching`)), Boolean);
    const marker = `WINDOW_${role}_완료`;
    const row = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: `turn-${role}`, last_agent_message: marker } });
    const bytes = Buffer.from(row + "\n");
    const split = bytes.indexOf(Buffer.from("완")) + 1;
    await appendFile(ownLog, bytes.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(api.snapshot().signals.length, 0, "Incomplete JSON must not notify");
    await appendFile(ownLog, bytes.subarray(split));
    await until(() => api.snapshot().signals, x => x.length === 1);
    await appendFile(ownLog, row + "\n");
    await new Promise(resolve => setTimeout(resolve, 700));
    const routed = api.snapshot().signals;
    assert.equal(routed.length, 1, "Same native turn must notify once");
    assert.equal(routed[0].text, marker);
    assert.equal(routed[0].windowInstanceId, api.identity.windowInstanceId);
    assert.ok(api.snapshot().watcherEvents > 0, "Real VS Code FileSystemWatcher events are required");
    report.checks.fileWatcher = true;
    report.checks.routing = true;
    report.checks.duplicateSuppression = true;
    await watch.dispose();

    const document = await vscode.workspace.openTextDocument({ content: "before", language: "plaintext" });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), "after ");
    await vscode.workspace.applyEdit(edit);
    await until(() => api.snapshot().documentEvents, n => n > 0);
    report.checks.documentEvents = true;

    if (process.env.JF_MVP_LIVE === "1") {
      const provider = role === "A" ? "codex" : "claude";
      const configured = process.env[`JF_MVP_${provider.toUpperCase()}_EXECUTABLE`];
      if (configured) await vscode.workspace.getConfiguration("jobFinishMvp").update(`${provider}Executable`, configured, vscode.ConfigurationTarget.Global);
      const executable = await resolveExecutable(provider, configured);
      const version = (await promisify(execFile)(executable, ["--version"], { windowsHide: true })).stdout.trim();
      report.runtime = { executable, version };
      const liveMarker = `JF_LIVE_${role}`;
      const result = await api.probe(provider, liveMarker);
      report.live = result;
      assert.equal(result.exitCode, 0, `${provider} process must exit successfully`);
      assert.equal(result.signals.length, 1, `${provider} must supply one completion signal`);
      assert.equal(result.signals[0].status, "completed");
      assert.equal(result.signals[0].text.trim(), liveMarker);
      assert.equal(result.signals[0].windowInstanceId, api.identity.windowInstanceId);
      report.checks.liveProvider = true;
      const filename = await nativeLog(provider, result.signals[0].sessionId);
      assert.ok(filename, "A persisted native session log must exist");
      const baseline = (await readFile(filename, "utf8")).length;
      const nativeWatch = await api.watch({ path: filename, provider, format: "transcript", sessionId: result.signals[0].sessionId });
      const journal = path.join(root, `resume-${provider}.jsonl`);
      await writeFile(journal, "");
      const nativeMarker = `JF_NATIVE_${role}`;
      const runner = launchProbe({ provider, executable,
        cwd: path.join(root, "probe-workspace"), journal, sessionId: result.signals[0].sessionId, resume: true,
        prompt: `Do not use tools. Reply with exactly: ${nativeMarker}` });
      const resumed = await runner.done;
      await new Promise(resolve => setTimeout(resolve, 1000));
      const nativeSignals = api.snapshot().signals.filter(s => s.logPath === filename);
      const appended = (await readFile(filename, "utf8")).slice(baseline).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      report.native = { provider, exitCode: resumed.exitCode, signals: nativeSignals,
        schema: appended.map(x => ({ type: x.type, subtype: x.subtype, payloadType: x.payload?.type,
          stopReason: x.message?.stop_reason, version: x.version })) };
      assert.equal(resumed.exitCode, 0);
      assert.equal(nativeSignals.length, 1, "The real resumed native log must produce a watcher signal");
      assert.equal(nativeSignals[0].status, provider === "codex" ? "completed" : "responseObserved");
      assert.equal(nativeSignals[0].text.trim(), nativeMarker);
      report.checks.nativeSessionWatch = true;
      await nativeWatch.dispose();
    }
    await writeFile(path.join(root, `${role}-done`), "done");
    await until(() => exists(path.join(root, `${otherRole}-done`)), Boolean);
  } catch (error) { report.failure = String(error); throw error; }
  finally {
    report.snapshot = api.snapshot();
    await api.dispose();
    await writeFile(path.join(root, `report-${role}.json`), JSON.stringify(report, null, 2));
  }
}
