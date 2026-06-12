import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { confirm, isCancel, log, note, spinner } from "@clack/prompts";
import pc from "picocolors";
import type { Platform } from "../shared/config-schema.js";
import { buildCodexNotifyArgv, notifierScriptPath } from "./command.js";
import {
  checkDependencies,
  claudeSettingsPath,
  codexConfigPath,
  currentPlatform,
  installDir as resolveInstallDir,
} from "./detect.js";
import { generate } from "./generate.js";
import { claudeHasJobFinish, installClaude, uninstallClaude } from "./installers/claude.js";
import { installCodex, uninstallCodex } from "./installers/codex.js";
import { finish, runWizard, type WizardResult } from "./wizard.js";

const PKG = "job-finish";

/**
 * Strip job-finish hooks from every Claude scope except the one we are about to
 * install into. Claude merges user + project settings and runs *both* sets of
 * hooks, so a leftover entry in the other scope double-fires on every event
 * (the "두 번 알림" bug that survives reboots because it lives in two files).
 * Pass `keepScope: null` to clean every scope. Returns the paths actually cleaned.
 */
function resetClaudeResidue(keepScope: "global" | "project" | null, cwd: string): string[] {
  const cleaned: string[] = [];
  for (const scope of ["global", "project"] as const) {
    if (scope === keepScope) continue;
    const sp = claudeSettingsPath(scope, cwd);
    if (existsSync(sp) && claudeHasJobFinish(sp)) {
      uninstallClaude(sp);
      cleaned.push(sp);
    }
  }
  return cleaned;
}

/** Run the generated notifier once (used by doctor/preview). */
function runNotifier(scriptPath: string, platform: Platform, test: boolean): Promise<number> {
  void platform;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Event", "stop", ...(test ? ["-Test"] : [])];
  return new Promise((resolve) => {
    const child = spawn("powershell", args, { stdio: "ignore" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function cmdInit(): Promise<void> {
  const platform = currentPlatform();
  const cwd = process.cwd();

  // Surface dependency warnings up front.
  const deps = checkDependencies(platform);
  const missing = deps.filter((d) => !d.ok);
  if (missing.length) {
    note(
      missing.map((d) => `${pc.yellow("!")} ${d.name}: ${d.detail}${d.hint ? `\n  ${pc.dim(d.hint)}` : ""}`).join("\n"),
      "확인 필요한 의존성",
    );
  }

  const result: WizardResult = await runWizard(platform);
  const { scope, agents, config } = result;

  const dir = resolveInstallDir(scope, cwd);

  // Reset first: purge any previous job-finish hooks from the *other* scope so
  // exactly one install stays active (avoids the double-fire bug). If Claude
  // isn't being (re)installed this round, clean every scope.
  const keepScope = agents.includes("claude") ? scope : null;
  const cleaned = resetClaudeResidue(keepScope, cwd);

  const s = spinner();
  s.start("스크립트와 설정을 생성하는 중");
  const { scriptPath, configPath } = generate(dir, platform, config);
  s.stop("notifier 생성 완료");

  const lines: string[] = [`스크립트: ${scriptPath}`, `설정:     ${configPath}`];
  if (cleaned.length) {
    lines.push(`리셋:     이전 설치 잔재 정리 (${cleaned.length}곳) — ${cleaned.join(", ")}`);
  }

  if (agents.includes("claude")) {
    const sp = claudeSettingsPath(scope, cwd);
    const r = installClaude(sp, dir, platform);
    lines.push(`Claude:   ${r.settingsPath}${r.backupPath ? pc.dim(` (백업 ✓)`) : ""}`);
  }
  if (agents.includes("codex")) {
    const r = installCodex(codexConfigPath(), dir, platform);
    if (r.conflict) {
      lines.push(pc.yellow(`Codex:    기존 notify 설정이 있어 건너뜀 — 수동 설정 필요`));
      log.warn(
        `Codex의 notify는 하나만 가능해요. 기존 설정을 유지했습니다.\n` +
          `  직접 추가하려면 ${codexConfigPath()} 에:\n` +
          `  notify = ${JSON.stringify(buildCodexNotifyArgv(scriptPath, platform))}`,
      );
    } else {
      lines.push(`Codex:    ${r.settingsPath}${r.backupPath ? pc.dim(` (백업 ✓)`) : ""}`);
    }
  }
  note(lines.join("\n"), "설치 완료");

  const wantTest = await confirm({ message: "지금 테스트 알림을 보낼까요?", initialValue: true });
  if (!isCancel(wantTest) && wantTest) {
    await runNotifier(scriptPath, platform, true);
    log.success("테스트 알림을 보냈어요. 알림/소리를 확인하세요.");
  }

  finish("끝났어요! 에이전트를 다시 시작하면 작업 완료 시 알림이 옵니다.");
}

async function cmdDoctor(): Promise<void> {
  const platform = currentPlatform();
  const cwd = process.cwd();
  console.log(pc.bold(`\n${PKG} doctor — ${platform}\n`));
  for (const d of checkDependencies(platform)) {
    console.log(`  ${d.ok ? pc.green("✓") : pc.red("✗")} ${d.name.padEnd(20)} ${pc.dim(d.detail)}`);
    if (!d.ok && d.hint) console.log(`      ${pc.dim(d.hint)}`);
  }

  // Find an installed notifier (project first, then global) and fire a test.
  for (const scope of ["project", "global"] as const) {
    const dir = resolveInstallDir(scope, cwd);
    const script = notifierScriptPath(dir, platform);
    if (existsSync(script)) {
      console.log(`\n  설치 위치: ${dir}`);
      console.log("  테스트 알림 발사 중...");
      const code = await runNotifier(script, platform, true);
      console.log(code === 0 ? pc.green("  ✓ 발사 완료") : pc.red(`  ✗ 종료 코드 ${code}`));
      return;
    }
  }
  console.log(pc.yellow(`\n  설치된 notifier가 없어요. \`npx ${PKG} init\` 을 먼저 실행하세요.`));
}

async function cmdPreview(): Promise<void> {
  const platform = currentPlatform();
  const cwd = process.cwd();
  for (const scope of ["project", "global"] as const) {
    const script = notifierScriptPath(resolveInstallDir(scope, cwd), platform);
    if (existsSync(script)) {
      // No -Test: respects focus suppression so you see real behavior.
      const code = await runNotifier(script, platform, false);
      console.log(code === 0 ? "preview 완료 (포커스 상태에 따라 생략될 수 있어요)" : `종료 코드 ${code}`);
      return;
    }
  }
  console.log(pc.yellow(`설치된 notifier가 없어요. \`npx ${PKG} init\` 을 먼저 실행하세요.`));
}

function cmdUninstall(): void {
  const cwd = process.cwd();
  for (const scope of ["project", "global"] as const) {
    const sp = claudeSettingsPath(scope, cwd);
    if (existsSync(sp)) {
      const r = uninstallClaude(sp);
      console.log(`Claude 정리: ${r.settingsPath}${r.backupPath ? " (백업 ✓)" : ""}`);
    }
  }
  if (existsSync(codexConfigPath())) {
    const r = uninstallCodex(codexConfigPath());
    if (r.backupPath) console.log(`Codex 정리: ${r.settingsPath} (백업 ✓)`);
  }
  console.log("hook 항목을 제거했어요. (생성된 스크립트 폴더는 수동 삭제 가능)");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "init";
  switch (cmd) {
    case "init":
      await cmdInit();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "preview":
      await cmdPreview();
      break;
    case "uninstall":
      cmdUninstall();
      break;
    case "-h":
    case "--help":
    case "help":
      console.log(
        `\n${PKG} — 에이전트 작업 완료 알림\n\n` +
          `  npx ${PKG} init        대화형 설치\n` +
          `  npx ${PKG} doctor      의존성 점검 + 테스트 알림\n` +
          `  npx ${PKG} preview     현재 설정으로 미리보기\n` +
          `  npx ${PKG} uninstall   hook 제거\n`,
      );
      break;
    default:
      console.log(pc.red(`알 수 없는 명령: ${cmd}`));
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(pc.red((err as Error).message));
  process.exit(1);
});
