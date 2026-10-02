import { runTests } from "@vscode/test-electron";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

async function main(): Promise<void> {
  // Codex Work can set this for its own helpers; a test host must run Electron UI.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const root = path.join(extensionDevelopmentPath, ".verification", new Date().toISOString().replace(/[:.]/g, "-"));
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE ?? (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe") : undefined);
  const live = process.argv.includes("--live");
  const summaries: any[] = [];
  for (const scenario of ["same-workspace", "different-workspaces"]) {
    const shared = path.join(root, scenario);
    const workspaceA = path.join(shared, "workspace-A"), workspaceB = scenario === "same-workspace" ? workspaceA : path.join(shared, "workspace-B");
    await mkdir(workspaceA, { recursive: true }); await mkdir(workspaceB, { recursive: true });
    await writeFile(path.join(shared, "A.jsonl"), ""); await writeFile(path.join(shared, "B.jsonl"), "");
    const launch = (role: string, workspace: string, profile: string, withLive: boolean) => runTests({
      vscodeExecutablePath, extensionDevelopmentPath, extensionTestsPath: path.join(__dirname, "integration.js"),
      extensionTestsEnv: { JF_MVP_SHARED: shared, JF_MVP_ROLE: role, JF_MVP_LIVE: withLive ? "1" : "0" },
      launchArgs: [workspace, "--new-window", "--user-data-dir", path.join(shared, profile), "--extensions-dir", path.join(shared, "extensions"),
        "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--disable-updates"],
      timeout: withLive ? 300_000 : 60_000
    });
    console.log(`Testing ${scenario}${live && scenario === "same-workspace" ? " with real Codex/Claude calls" : ""}`);
    const results = await Promise.allSettled([
      launch("A", workspaceA, "profile-A", live && scenario === "same-workspace"),
      launch("B", workspaceB, "profile-B", live && scenario === "same-workspace")
    ]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const a = JSON.parse(await readFile(path.join(shared, "report-A.json"), "utf8"));
    const b = JSON.parse(await readFile(path.join(shared, "report-B.json"), "utf8"));
    assert.equal(a.sameWorkspace, scenario === "same-workspace");
    assert.equal(b.sameWorkspace, scenario === "same-workspace");
    await launch("reload", workspaceA, "profile-A", false);
    const reloaded = JSON.parse(await readFile(path.join(shared, "report-reload.json"), "utf8"));
    assert.notEqual(a.identity.windowInstanceId, reloaded.identity.windowInstanceId);
    summaries.push({ scenario, a, b, reloaded });
  }
  const summary = { verifiedAt: new Date().toISOString(), platform: `${os.platform()} ${os.arch()}`, live, summaries };
  await writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`Verification passed. Evidence: ${path.join(root, "summary.json")}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
