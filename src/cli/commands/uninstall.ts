// 책임: uninstall 명령 - Claude/Codex hook 항목과 설치 폴더(스크립트·exe·config·로그·백업), 프로토콜 등록을 제거.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { claudeSettingsPath, codexConfigPath, currentPlatform, installDir as resolveInstallDir } from "../detect.js";
import { installDirHasJobFinish, INSTALL_SCOPES, PKG } from "../install-status.js";
import { uninstallClaude } from "../installers/claude.js";
import { uninstallCodex } from "../installers/codex.js";

// notifier 가 토스트 클릭 처리를 위해 HKCU 에 등록하는 URL 프로토콜 키(notify.win.ps1 의 $protocolName).
const FOCUS_PROTOCOL_KEY = "HKCU\\Software\\Classes\\jobfinish-focus";

// 등록돼 있으면 조용히 제거한다(키가 없으면 reg 가 실패해도 무시). Windows 전용 도구라 reg.exe 를 직접 부른다.
function removeFocusProtocol(): boolean {
  try {
    execFileSync("reg", ["delete", FOCUS_PROTOCOL_KEY, "/f"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 두 스코프(전역/프로젝트)의 Claude 설정과 Codex config에서 Job-Finish hook 항목을 제거하고,
// 도구가 생성한 설치 폴더(전역 ~/.job-finish, 프로젝트 .claude/job-finish)까지 통째로 삭제한다.
// hook만 남기고 파일을 보존하려면 --keep-files 를 준다.
export function cmdUninstall(argv: string[] = process.argv.slice(3)): void {
  const keepFiles = argv.includes("--keep-files");
  const cwd = process.cwd();
  const platform = currentPlatform();

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

  // 스크립트·exe·config·로그·백업이 남는 설치 폴더.
  const installDirs = INSTALL_SCOPES.map((scope) => resolveInstallDir(scope, cwd)).filter(
    (dir) => existsSync(dir) && installDirHasJobFinish(dir, platform),
  );

  console.log("hook 항목을 제거했어요.");
  if (keepFiles) {
    if (installDirs.length) {
      console.log("설치 폴더는 --keep-files 로 남겨뒀어요(스크립트·exe·config·로그·백업):");
      for (const dir of installDirs) console.log(`  ${dir}`);
    }
  } else {
    for (const dir of installDirs) {
      rmSync(dir, { recursive: true, force: true });
      console.log(`설치 폴더 삭제: ${dir}`);
    }
    if (removeFocusProtocol()) console.log(`프로토콜 등록 해제: ${FOCUS_PROTOCOL_KEY}`);
  }

  // npm link / 전역 설치로 깔았다면 심볼릭 링크와 래퍼가 별도로 남는다.
  console.log(`전역 설치(npm link / npm i -g)로 깔았다면: npm rm -g ${PKG}`);
}
