// 책임: init 명령 - 마법사 실행부터 스크립트/설정 생성·설치·테스트 알림까지 오케스트레이션.
import { confirm, isCancel, log, note, spinner } from "@clack/prompts";
import pc from "picocolors";
import { buildCodexNotifyArgv } from "../command.js";
import {
  checkDependencies,
  claudeSettingsPath,
  codexConfigPath,
  currentPlatform,
  installDir as resolveInstallDir,
} from "../detect.js";
import { generate } from "../generate.js";
import {
  cleanupLines,
  cleanupProjectInstall,
  describeGlobalInstall,
  emptyCleanup,
  getGlobalInstallStatus,
  hasGlobalInstall,
  resetClaudeResidue,
} from "../install-status.js";
import { installClaude } from "../installers/claude.js";
import { installCodex } from "../installers/codex.js";
import { runNotifier } from "../run-notifier.js";
import { finish, runWizard, type WizardResult } from "../wizard.js";

// 의존성 점검 → 마법사로 설정 수집 → 전역 설치 충돌 처리 → 스크립트/설정 생성 → Claude·Codex hook 설치 → 선택적 테스트 알림까지 설치 전 과정을 순서대로 수행한다.
export async function cmdInit(): Promise<void> {
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
