import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { buildCodexNotifyArgv, buildCommand, notifierScriptPath } from "../src/cli/command.js";
import {
  codexJobFinishTarget,
  codexUsesInstallDir,
  installCodex,
  uninstallCodex,
} from "../src/cli/installers/codex.js";
import { JOB_FINISH_MARKER } from "../src/cli/settings-merge.js";

const platform = "win32" as const;

interface TestContext {
  after(cleanup: () => void): void;
}

let failures = 0;

function test(name: string, run: (context: TestContext) => void): void {
  const cleanups: Array<() => void> = [];
  try {
    run({ after: (cleanup) => cleanups.push(cleanup) });
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}`);
    console.error(error);
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
  }
}

function fixture(t: TestContext): { configPath: string; installDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "job-finish-codex-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    configPath: path.join(root, ".codex", "config.toml"),
    installDir: path.join(root, "install with spaces"),
  };
}

function writeToml(configPath: string, value: TOML.JsonMap): void {
  const dir = path.dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, TOML.stringify(value), "utf8");
}

function readToml(configPath: string): Record<string, any> {
  return TOML.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
}

test("installs a Codex Stop hook while preserving unrelated notify and hooks", (t) => {
  const { configPath, installDir } = fixture(t);
  writeToml(configPath, {
    model: "gpt-test",
    notify: ["python", "existing-notify.py"],
    hooks: {
      Stop: [
        {
          hooks: [{ type: "command", command: "echo existing", timeout: 5 }],
        },
      ],
    },
  });

  const result = installCodex(configPath, installDir, platform);
  const parsed = readToml(configPath);
  const installedText = readFileSync(configPath, "utf8");

  assert.ok(result.backupPath && existsSync(result.backupPath));
  assert.match(installedText, /\[\[hooks\.Stop\]\]/);
  assert.match(installedText, /\[\[hooks\.Stop\.hooks\]\]/);
  assert.deepEqual(parsed.notify, ["python", "existing-notify.py"]);
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, "echo existing");
  assert.equal(parsed.hooks.Stop[1].hooks[0].timeout, 30);
  assert.match(parsed.hooks.Stop[1].hooks[0].command, /-Event codex$/);
  assert.equal(codexJobFinishTarget(configPath), notifierScriptPath(installDir, platform));
  assert.equal(codexUsesInstallDir(configPath, installDir, platform), true);
});

test("migrates the legacy notify callback and remains idempotent", (t) => {
  const { configPath, installDir } = fixture(t);
  const script = notifierScriptPath(installDir, platform);
  writeToml(configPath, {
    notify: buildCodexNotifyArgv(script, platform),
  });

  assert.equal(codexJobFinishTarget(configPath), script);
  installCodex(configPath, installDir, platform);
  installCodex(configPath, installDir, platform);

  const parsed = readToml(configPath);
  assert.equal(parsed.notify, undefined);
  assert.equal(parsed.hooks.Stop.length, 1);
  assert.equal(parsed.hooks.Stop[0].hooks.length, 1);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, buildCommand(script, platform, "codex"));
});

test("uninstall removes only Job-Finish handlers and keeps user configuration", (t) => {
  const { configPath, installDir } = fixture(t);
  const script = notifierScriptPath(installDir, platform);
  writeToml(configPath, {
    notify: ["python", "existing-notify.py"],
    hooks: {
      Stop: [
        {
          matcher: "ignored-by-stop",
          hooks: [
            { type: "command", command: "echo existing" },
            { type: "command", command: buildCommand(script, platform, "codex"), timeout: 30 },
          ],
        },
      ],
    },
  });

  const result = uninstallCodex(configPath);
  const parsed = readToml(configPath);

  assert.ok(result.backupPath && existsSync(result.backupPath));
  assert.deepEqual(parsed.notify, ["python", "existing-notify.py"]);
  assert.equal(parsed.hooks.Stop.length, 1);
  assert.equal(parsed.hooks.Stop[0].matcher, "ignored-by-stop");
  assert.deepEqual(parsed.hooks.Stop[0].hooks, [{ type: "command", command: "echo existing" }]);
  assert.equal(readFileSync(configPath, "utf8").includes(JOB_FINISH_MARKER), false);
});

test("uninstall also cleans an old Job-Finish notify entry", (t) => {
  const { configPath, installDir } = fixture(t);
  writeToml(configPath, {
    model: "gpt-test",
    notify: buildCodexNotifyArgv(notifierScriptPath(installDir, platform), platform),
  });

  uninstallCodex(configPath);

  assert.deepEqual(readToml(configPath), { model: "gpt-test" });
});

/** Install the notifier plus a quiet, log-everything config in a temp dir. */
function notifierFixture(t: TestContext): { root: string; scriptPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "job-finish-notifier-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, "job-finish-notify.ps1");
  copyFileSync(path.resolve("templates", "notify.win.ps1"), scriptPath);
  writeFileSync(
    path.join(root, "job-finish.config.json"),
    JSON.stringify({
      modes: [],
      flashTimeout: "30s",
      sound: { enabled: false },
      suppressWhenFocused: false,
      clearToastOnFocus: true,
      debug: true,
      watchApp: "",
    }),
    "utf8",
  );
  return { root, scriptPath };
}

test("the notifier accepts the current Codex Stop payload on stdin", (t) => {
  const { root, scriptPath } = notifierFixture(t);
  const transcriptPath = path.join(root, "rollout.jsonl");
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "finished immediately" }],
      },
    }) + "\n",
    "utf8",
  );

  const child = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Event", "codex", "-Test"],
    {
      input: JSON.stringify({
        session_id: "test-session",
        turn_id: "test-turn",
        hook_event_name: "Stop",
        cwd: root,
        transcript_path: transcriptPath,
      }),
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.stdout, "");
  const log = readFileSync(path.join(root, "job-finish.log"), "utf8");
  assert.match(log, /notifier start event=codex/);
  assert.match(log, new RegExp(`project=${path.basename(root)}`));
  assert.match(log, /notifier exit/);
});

/** Code page of the console this test run shares with the processes it spawns. */
function consoleCodePage(): string {
  const { stdout } = spawnSync("cmd", ["/d", "/c", "chcp"], { encoding: "utf8" });
  return (stdout ?? "").match(/(\d+)/)?.[1] ?? "";
}

test("the notifier decodes UTF-8 stdin under a non-UTF-8 console code page", (t) => {
  const { root, scriptPath } = notifierFixture(t);
  const message = "한글 알림 테스트 완료";

  // A hook inherits the console code page, which is the ANSI/OEM page (437, 949,
  // ...) on most Windows installs — not 65001. Decoding the UTF-8 payload with it
  // used to turn the Codex summary into mojibake, so pin the page here. `chcp`
  // hits the console shared with this runner, so put it back afterwards.
  const previousCodePage = consoleCodePage();
  let child;
  try {
    child = spawnSync(
      `chcp 437 >nul && powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -Event codex -Test`,
      {
        shell: true,
        input: JSON.stringify({
          hook_event_name: "Stop",
          cwd: root,
          last_assistant_message: message,
        }),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
  } finally {
    if (previousCodePage) {
      spawnSync("cmd", ["/d", "/c", `chcp ${previousCodePage}`], { stdio: "ignore" });
    }
  }

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const log = readFileSync(path.join(root, "job-finish.log"), "utf8");
  assert.match(log, new RegExp(`notifier text title=Codex text=${message}$`, "m"));
});

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("All Codex notification regression tests passed.");
}
