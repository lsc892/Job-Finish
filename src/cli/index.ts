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
      await cmdInit(process.argv[3]);
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
        `\n${PKG} - Agent task completion notifications\n\n` +
          `  npx ${PKG} init [ko|zh|jp]  Interactive install (English by default)\n` +
          `  npx ${PKG} doctor           Check dependencies + test notification\n` +
          `  npx ${PKG} preview          Preview with the current settings\n` +
          `  npx ${PKG} uninstall        Remove hooks + install folder (--keep-files preserves files)\n`,
      );
      break;
    default:
      console.log(pc.red(`Unknown command: ${cmd}`));
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(pc.red((err as Error).message));
  process.exit(1);
});
