// 책임: doctor 명령 - 의존성 점검과 설치본 테스트 알림 발사.
import { existsSync } from "node:fs";
import pc from "picocolors";
import { notifierScriptPath } from "../command.js";
import { checkDependencies, currentPlatform, installDir as resolveInstallDir } from "../detect.js";
import { INSTALL_SCOPES, PKG } from "../install-status.js";
import { runNotifier } from "../run-notifier.js";

// 의존성을 하나씩 점검해 표시하고, 설치된 notifier를 찾으면 테스트 알림을 실제로 발사해 종료 코드로 성공 여부를 알려준다.
export async function cmdDoctor(): Promise<void> {
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
