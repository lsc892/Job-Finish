// 책임: uninstall 명령 - Claude/Codex hook 항목 제거.
import { existsSync } from "node:fs";
import { claudeSettingsPath, codexConfigPath } from "../detect.js";
import { INSTALL_SCOPES } from "../install-status.js";
import { uninstallClaude } from "../installers/claude.js";
import { uninstallCodex } from "../installers/codex.js";

// 두 스코프(전역/프로젝트)의 Claude 설정과 Codex config에서 Job-Finish hook 항목만 제거하고, 생성된 스크립트 폴더는 사용자 몫으로 남긴다.
export function cmdUninstall(): void {
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
