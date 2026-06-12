import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const project = join(root, "tools", "win-focus", "JFFocusVSCode.csproj");
const publishDir = join(root, "tools", "win-focus", "publish");
const sourceExe = join(publishDir, "jf-focus-vscode.exe");
const targetExe = join(root, "templates", "jf-focus-vscode.exe");

const result = spawnSync(
  "dotnet",
  [
    "publish",
    project,
    "-c",
    "Release",
    "-r",
    "win-x64",
    "--self-contained",
    "true",
    "-p:PublishSingleFile=true",
    "-p:PublishTrimmed=true",
    "-p:EnableCompressionInSingleFile=true",
    "-o",
    publishDir,
  ],
  { cwd: root, stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(sourceExe)) {
  console.error(`Missing published focus helper: ${sourceExe}`);
  process.exit(1);
}

mkdirSync(dirname(targetExe), { recursive: true });
copyFileSync(sourceExe, targetExe);
console.log(`Copied ${sourceExe} -> ${targetExe}`);
