// 책임: init 명령 - 마법사 실행부터 스크립트/설정 생성·설치·테스트 알림까지 오케스트레이션.
import { confirm, isCancel, log, note, spinner } from "@clack/prompts";
import pc from "picocolors";
import {
  checkDependencies,
  claudeSettingsPath,
  codexConfigPath,
  currentPlatform,
  type DependencyCheck,
  installDir as resolveInstallDir,
} from "../detect.js";
import { generate } from "../generate.js";
import {
  cleanupProjectInstall,
  describeGlobalInstall,
  emptyCleanup,
  getGlobalInstallStatus,
  hasGlobalInstall,
  resetClaudeResidue,
  type CleanupResult,
} from "../install-status.js";
import { installClaude } from "../installers/claude.js";
import { installCodex } from "../installers/codex.js";
import { getInstallCopy, parseInstallLocale } from "../locale.js";
import { primeNotifier, runNotifier } from "../run-notifier.js";
import { finish, runWizard, type WizardResult } from "../wizard.js";

type InitCopy = ReturnType<typeof getInstallCopy>["init"];

function formatCleanupLines(cleaned: CleanupResult, copy: InitCopy): string[] {
  const lines: string[] = [];
  if (cleaned.claudeSettings.length) {
    lines.push(`${copy.cleanup}: ${copy.projectClaudeRemoved} (${cleaned.claudeSettings.join(", ")})`);
  }
  if (cleaned.codexConfig) {
    lines.push(`${copy.cleanup}: ${copy.projectCodexRemoved} (${cleaned.codexConfig})`);
  }
  if (cleaned.installDirs.length) {
    lines.push(`${copy.cleanup}: ${copy.projectInstallRemoved} (${cleaned.installDirs.join(", ")})`);
  }
  return lines;
}

function formatDependency(dependency: DependencyCheck, copy: InitCopy): string {
  const isSound = dependency.name === "default sound file";
  const name = isSound ? copy.defaultSoundFile : dependency.name;
  const detail = dependency.detail === "not found" ? copy.notFound : dependency.detail;
  const hint = dependency.hint
    ? isSound
      ? copy.soundHint
      : dependency.name === "PowerShell"
        ? copy.powerShellHint
        : dependency.hint
    : undefined;
  return `${pc.yellow("!")} ${name}: ${detail}${hint ? `\n  ${pc.dim(hint)}` : ""}`;
}

// 의존성 점검 → 마법사로 설정 수집 → 전역 설치 충돌 처리 → 스크립트/설정 생성 → Claude·Codex hook 설치 → 선택적 테스트 알림까지 설치 전 과정을 순서대로 수행한다.
export async function cmdInit(language?: string): Promise<void> {
  const locale = parseInstallLocale(language);
  if (!locale) {
    throw new Error(`Unsupported installer language: ${language}. Use en, ko, zh, or jp.`);
  }
  const copy = getInstallCopy(locale).init;
  const platform = currentPlatform();
  const cwd = process.cwd();

  const deps = checkDependencies(platform);
  const missing = deps.filter((d) => !d.ok);
  if (missing.length) {
    note(
      missing.map((dependency) => formatDependency(dependency, copy)).join("\n"),
      copy.attentionNeeded,
    );
  }

  const result: WizardResult = await runWizard(platform, locale);
  const { scope, agents, config } = result;

  const globalStatus = getGlobalInstallStatus(cwd, platform);
  if (scope === "project" && hasGlobalInstall(globalStatus)) {
    const cleanedProject = cleanupProjectInstall(cwd, platform);
    note(
      [
        pc.yellow(copy.globalActive),
        ...describeGlobalInstall(globalStatus, cwd, platform, {
          globalInstall: copy.globalInstall,
          globalCodexNotify: copy.globalCodexNotify,
        }),
        ...formatCleanupLines(cleanedProject, copy),
        copy.codexGlobalWarning,
      ].join("\n"),
      copy.keepGlobalTitle,
    );
    finish(copy.globalOnly);
    return;
  }

  const projectCleaned = scope === "global" ? cleanupProjectInstall(cwd, platform) : emptyCleanup();
  const dir = resolveInstallDir(scope, cwd);

  const keepScope = agents.includes("claude") ? scope : null;
  const cleaned = resetClaudeResidue(keepScope, cwd);

  const s = spinner();
  s.start(copy.generating);
  const { scriptPath, configPath } = generate(dir, platform, config);
  // 첫 알림이 시작 메뉴 바로가기를 lazy 생성하면 Windows가 그 첫 토스트를 조용히 삼킨다.
  // 설치 시점에 미리 바로가기·프로토콜을 등록해 두어 첫 알림부터 뜨게 한다.
  await primeNotifier(scriptPath, platform);
  s.stop(copy.generated);

  const lines: string[] = [`${copy.script}: ${scriptPath}`, `${copy.config}: ${configPath}`];
  lines.push(...formatCleanupLines(projectCleaned, copy));
  if (cleaned.length) {
    lines.push(`${copy.reset}: ${copy.previousResidueRemoved} (${cleaned.length}) ${cleaned.join(", ")}`);
  }

  if (agents.includes("claude")) {
    const sp = claudeSettingsPath(scope, cwd);
    const r = installClaude(sp, dir, platform);
    lines.push(`Claude: ${r.settingsPath}${r.backupPath ? pc.dim(` (${copy.backup})`) : ""}`);
  }

  if (agents.includes("codex")) {
    const r = installCodex(codexConfigPath(), dir, platform);
    lines.push(`Codex: ${r.settingsPath}${r.backupPath ? pc.dim(` (${copy.backup})`) : ""}`);
    lines.push(pc.yellow(copy.codexTrust));
  }

  note(lines.join("\n"), copy.installComplete);

  const wantTest = await confirm({ message: copy.testPrompt, initialValue: true });
  if (!isCancel(wantTest) && wantTest) {
    await runNotifier(scriptPath, platform, true);
    log.success(copy.testSent);
  }

  finish(copy.finished);
}
