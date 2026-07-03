// 책임: preview 명령 - 현재 설정으로 알림 동작 미리보기.
import { existsSync } from "node:fs";
import pc from "picocolors";
import { notifierScriptPath } from "../command.js";
import { currentPlatform, installDir as resolveInstallDir } from "../detect.js";
import { INSTALL_SCOPES, PKG } from "../install-status.js";
import { runNotifier } from "../run-notifier.js";

// 설치된 notifier를 test 없이 실행해, 실제 이벤트 때와 같은(포커스 상태에 따라 생략될 수 있는) 알림 동작을 미리 보여준다.
export async function cmdPreview(): Promise<void> {
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
