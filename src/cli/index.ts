import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
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
import { codexJobFinishTarget, codexUsesInstallDir, installCodex, uninstallCodex } from "./installers/codex.js";
import { finish, runWizard, type WizardResult } from "./wizard.js";

const PKG = "job-finish";
const INSTALL_SCOPES = ["global", "project"] as const;
type InstallScope = (typeof INSTALL_SCOPES)[number];

interface CleanupResult {
  claudeSettings: string[];
  codexConfig: string | null;
  installDirs: string[];
}

interface GlobalInstallStatus {
  claude: boolean;
  codexTarget: string | null;
}

function emptyCleanup(): CleanupResult {
  return { claudeSettings: [], codexConfig: null, installDirs: [] };
}

function installDirHasJobFinish(dir: string, platform: Platform): boolean {
  return (
    existsSync(notifierScriptPath(dir, platform)) ||
    existsSync(path.join(dir, "job-finish.config.json")) ||
    existsSync(path.join(dir, "jf-focus-vscode.exe"))
  );
}

function getGlobalInstallStatus(cwd: string, platform: Platform): GlobalInstallStatus {
  const globalClaudeSettings = claudeSettingsPath("global", cwd);
  const codexTarget = codexJobFinishTarget(codexConfigPath());
  const projectScript = notifierScriptPath(resolveInstallDir("project", cwd), platform);

  return {
    claude: existsSync(globalClaudeSettings) && claudeHasJobFinish(globalClaudeSettings),
    codexTarget: codexTarget && path.resolve(codexTarget) !== path.resolve(projectScript) ? codexTarget : null,
  };
}

function hasGlobalInstall(status: GlobalInstallStatus): boolean {
  return status.claude || status.codexTarget !== null;
}

function describeGlobalInstall(status: GlobalInstallStatus, cwd: string, platform: Platform): string[] {
  const lines: string[] = [];
  if (status.claude) {
    lines.push(`Claude:   ${claudeSettingsPath("global", cwd)}`);
  }
  if (status.codexTarget) {
    const globalScript = notifierScriptPath(resolveInstallDir("global", cwd), platform);
    const targetKind =
      path.resolve(status.codexTarget) === path.resolve(globalScript)
        ? "global install"
        : "global Codex notify";
    lines.push(`Codex:    ${codexConfigPath()} -> ${status.codexTarget} (${targetKind})`);
  }
  return lines;
}

function cleanupProjectInstall(cwd: string, platform: Platform): CleanupResult {
  const cleaned = emptyCleanup();
  const projectClaudeSettings = claudeSettingsPath("project", cwd);
  if (existsSync(projectClaudeSettings) && claudeHasJobFinish(projectClaudeSettings)) {
    uninstallClaude(projectClaudeSettings);
    cleaned.claudeSettings.push(projectClaudeSettings);
  }

  if (codexUsesInstallDir(codexConfigPath(), resolveInstallDir("project", cwd), platform)) {
    uninstallCodex(codexConfigPath());
    cleaned.codexConfig = codexConfigPath();
  }

  const projectDir = resolveInstallDir("project", cwd);
  if (installDirHasJobFinish(projectDir, platform)) {
    rmSync(projectDir, { recursive: true, force: true });
    cleaned.installDirs.push(projectDir);
  }

  return cleaned;
}

function cleanupLines(cleaned: CleanupResult): string[] {
  const lines: string[] = [];
  if (cleaned.claudeSettings.length) {
    lines.push(`정리:     프로젝트 Claude hook 제거 (${cleaned.claudeSettings.join(", ")})`);
  }
  if (cleaned.codexConfig) {
    lines.push(`정리:     프로젝트 설치본을 가리키던 Codex notify 제거 (${cleaned.codexConfig})`);
  }
  if (cleaned.installDirs.length) {
    lines.push(`정리:     프로젝트 설치 폴더 삭제 (${cleaned.installDirs.join(", ")})`);
  }
  return lines;
}

/**
 * Strip job-finish hooks from every Claude scope except the one we are about to
 * install into. Claude merges user + project settings and runs both sets of
 * hooks, so a leftover entry in the other scope double-fires on every event.
 * Pass `keepScope: null` to clean every scope. Returns the paths actually cleaned.
 */
function resetClaudeResidue(keepScope: InstallScope | null, cwd: string): string[] {
  const cleaned: string[] = [];
  for (const scope of INSTALL_SCOPES) {
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
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Event",
    "stop",
    ...(test ? ["-Test"] : []),
  ];
  return new Promise((resolve) => {
    const child = spawn("powershell", args, { stdio: "ignore" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function cmdInit(): Promise<void> {
  const platform = currentPlatform();
  const cwd = process.cwd();

  const deps = checkDependencies(platform);
  const missing = deps.filter((d) => !d.ok);
  if (missing.length) {
    note(
      missing.map((d) => `${pc.yellow("!")} ${d.name}: ${d.detail}${d.hint ? `\n  ${pc.dim(d.hint)}` : ""}`).join("\n"),
      "확인 필요",
    );
  }

  const result: WizardResult = await runWizard(platform);
  const { scope, agents, config } = result;

  const globalStatus = getGlobalInstallStatus(cwd, platform);
  if (scope === "project" && hasGlobalInstall(globalStatus)) {
    const cleanedProject = cleanupProjectInstall(cwd, platform);
    note(
      [
        pc.yellow("전역 Job-Finish가 이미 활성이라 프로젝트 설치를 건너뜁니다."),
        ...describeGlobalInstall(globalStatus, cwd, platform),
        ...cleanupLines(cleanedProject),
        "Codex notify는 전역 설정이 하나뿐이라 프로젝트 설치도 전역 Codex 설정을 바꿀 수 있어요.",
      ].join("\n"),
      "전역 설치 유지",
    );
    finish("전역 설치만 남도록 처리했어요.");
    return;
  }

  const projectCleaned = scope === "global" ? cleanupProjectInstall(cwd, platform) : emptyCleanup();
  const dir = resolveInstallDir(scope, cwd);

  const keepScope = agents.includes("claude") ? scope : null;
  const cleaned = resetClaudeResidue(keepScope, cwd);

  const s = spinner();
  s.start("스크립트와 설정을 생성하는 중");
  const { scriptPath, configPath } = generate(dir, platform, config);
  s.stop("notifier 생성 완료");

  const lines: string[] = [`스크립트: ${scriptPath}`, `설정:     ${configPath}`];
  lines.push(...cleanupLines(projectCleaned));
  if (cleaned.length) {
    lines.push(`리셋:     이전 설치 잔여 정리 (${cleaned.length}곳) ${cleaned.join(", ")}`);
  }

  if (agents.includes("claude")) {
    const sp = claudeSettingsPath(scope, cwd);
    const r = installClaude(sp, dir, platform);
    lines.push(`Claude:   ${r.settingsPath}${r.backupPath ? pc.dim(" (백업 ✓)") : ""}`);
  }

  if (agents.includes("codex")) {
    const r = installCodex(codexConfigPath(), dir, platform);
    if (r.conflict) {
      lines.push(pc.yellow("Codex:    기존 notify 설정이 있어 건너뜀 - 수동 설정 필요"));
      log.warn(
        `Codex의 notify는 하나만 가능해요. 기존 설정을 유지했습니다.\n` +
          `  직접 추가하려면 ${codexConfigPath()} 에:\n` +
          `  notify = ${JSON.stringify(buildCodexNotifyArgv(scriptPath, platform))}`,
      );
    } else {
      lines.push(`Codex:    ${r.settingsPath}${r.backupPath ? pc.dim(" (백업 ✓)") : ""}`);
    }
  }

  note(lines.join("\n"), "설치 완료");

  const wantTest = await confirm({ message: "지금 테스트 알림을 보내볼까요?", initialValue: true });
  if (!isCancel(wantTest) && wantTest) {
    await runNotifier(scriptPath, platform, true);
    log.success("테스트 알림을 보냈어요. 알림/소리를 확인하세요.");
  }

  finish("끝났어요! 에이전트를 다시 시작하면 작업 완료 때 알림이 뜹니다.");
}

async function cmdDoctor(): Promise<void> {
  const platform = currentPlatform();
  const cwd = process.cwd();
  console.log(pc.bold(`\n${PKG} doctor - ${platform}\n`));
  for (const d of checkDependencies(platform)) {
    console.log(`  ${d.ok ? pc.green("✓") : pc.red("✗")} ${d.name.padEnd(20)} ${pc.dim(d.detail)}`);
    if (!d.ok && d.hint) console.log(`      ${pc.dim(d.hint)}`);
  }

  for (const scope of INSTALL_SCOPES) {
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
  for (const scope of INSTALL_SCOPES) {
    const script = notifierScriptPath(resolveInstallDir(scope, cwd), platform);
    if (existsSync(script)) {
      const code = await runNotifier(script, platform, false);
      console.log(code === 0 ? "preview 완료 (포커스 상태에 따라 생략될 수 있어요)" : `종료 코드 ${code}`);
      return;
    }
  }
  console.log(pc.yellow(`설치된 notifier가 없어요. \`npx ${PKG} init\` 을 먼저 실행하세요.`));
}

function cmdUninstall(): void {
  const cwd = process.cwd();
  for (const scope of INSTALL_SCOPES) {
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
  console.log("hook 항목을 제거했어요. 생성된 스크립트 폴더는 수동 삭제할 수 있어요.");
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
        `\n${PKG} - 에이전트 작업 완료 알림\n\n` +
          `  npx ${PKG} init        대화형 설치\n` +
          `  npx ${PKG} doctor      의존성 검사 + 테스트 알림\n` +
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
