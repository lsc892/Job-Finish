// 책임: 설치 범위(전역/프로젝트) 상태 판별과 잔여 hook·설치본 정리 도메인 로직.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { Platform } from "../shared/config-schema.js";
import { notifierScriptPath } from "./command.js";
import { claudeSettingsPath, codexConfigPath, installDir as resolveInstallDir } from "./detect.js";
import { claudeHasJobFinish, uninstallClaude } from "./installers/claude.js";
import { codexJobFinishTarget, codexUsesInstallDir, uninstallCodex } from "./installers/codex.js";

export const PKG = "job-finish";
export const INSTALL_SCOPES = ["global", "project"] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

export interface CleanupResult {
  claudeSettings: string[];
  codexConfig: string | null;
  installDirs: string[];
}

export interface GlobalInstallStatus {
  claude: boolean;
  codexTarget: string | null;
}

export function emptyCleanup(): CleanupResult {
  return { claudeSettings: [], codexConfig: null, installDirs: [] };
}

export function installDirHasJobFinish(dir: string, platform: Platform): boolean {
  return (
    existsSync(notifierScriptPath(dir, platform)) ||
    existsSync(path.join(dir, "job-finish.config.json")) ||
    existsSync(path.join(dir, "jf-focus-vscode.exe"))
  );
}

// 전역 Claude 설정에 Job-Finish hook이 있는지와, Codex notify가 프로젝트 설치본이 아닌 다른 대상을 가리키는지를 확인해 전역 설치 여부를 판별한다.
export function getGlobalInstallStatus(cwd: string, platform: Platform): GlobalInstallStatus {
  const globalClaudeSettings = claudeSettingsPath("global", cwd);
  const codexTarget = codexJobFinishTarget(codexConfigPath());
  const projectScript = notifierScriptPath(resolveInstallDir("project", cwd), platform);

  return {
    claude: existsSync(globalClaudeSettings) && claudeHasJobFinish(globalClaudeSettings),
    codexTarget: codexTarget && path.resolve(codexTarget) !== path.resolve(projectScript) ? codexTarget : null,
  };
}

export function hasGlobalInstall(status: GlobalInstallStatus): boolean {
  return status.claude || status.codexTarget !== null;
}

export function describeGlobalInstall(
  status: GlobalInstallStatus,
  cwd: string,
  platform: Platform,
  targetKinds = { globalInstall: "global install", globalCodexNotify: "global Codex notify" },
): string[] {
  const lines: string[] = [];
  if (status.claude) {
    lines.push(`Claude:   ${claudeSettingsPath("global", cwd)}`);
  }
  if (status.codexTarget) {
    const globalScript = notifierScriptPath(resolveInstallDir("global", cwd), platform);
    const targetKind =
      path.resolve(status.codexTarget) === path.resolve(globalScript)
        ? targetKinds.globalInstall
        : targetKinds.globalCodexNotify;
    lines.push(`Codex:    ${codexConfigPath()} -> ${status.codexTarget} (${targetKind})`);
  }
  return lines;
}

// 프로젝트 스코프의 Claude hook, 프로젝트 설치본을 가리키는 Codex notify, 설치 폴더를 차례로 지우고 무엇을 정리했는지 기록해 돌려준다.
export function cleanupProjectInstall(cwd: string, platform: Platform): CleanupResult {
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

/**
 * Strip job-finish hooks from every Claude scope except the one we are about to
 * install into. Claude merges user + project settings and runs both sets of
 * hooks, so a leftover entry in the other scope double-fires on every event.
 * Pass `keepScope: null` to clean every scope. Returns the paths actually cleaned.
 */
export function resetClaudeResidue(keepScope: InstallScope | null, cwd: string): string[] {
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
