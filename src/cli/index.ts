import pc from "picocolors";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdInit } from "./commands/init.js";
import { cmdPreview } from "./commands/preview.js";
import { cmdUninstall } from "./commands/uninstall.js";
import { PKG } from "./install-status.js";

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
