import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Platform } from "../shared/config-schema.js";
import { notifierScriptPath } from "./command.js";
import { writeJson, writeText } from "./settings-merge.js";

/**
 * Serialize config for the notifier to read. Windows/PowerShell parses JSON
 * natively, so we keep the canonical config.json there. POSIX shells have no
 * built-in JSON parser, so on mac/linux we emit a `source`-able key=value file
 * to keep the notifier dependency-free (no jq/python required).
 */
function shellConfig(config: Config): string {
  const sound = config.sound;
  return [
    "# job-finish config — edit values then save; no re-install needed.",
    `JF_MODES="${config.modes.join(" ")}"`,
    `JF_FLASH_TIMEOUT="${config.flashTimeout}"`,
    `JF_SOUND_ENABLED="${sound.enabled ? 1 : 0}"`,
    `JF_SOUND_PATH=${JSON.stringify(sound.customPath)}`,
    `JF_SUPPRESS_FOCUSED="${config.suppressWhenFocused ? 1 : 0}"`,
    `JF_WATCH_APP=${JSON.stringify(config.watchApp)}`,
    "",
  ].join("\n");
}

function configFileName(platform: Platform): string {
  return platform === "win32" ? "job-finish.config.json" : "job-finish.config.sh";
}

/** Resolve the bundled templates directory (ships at <pkg>/templates). */
function templatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/
  // dist/index.js -> ../templates ; src during dev -> ../../templates
  const candidates = [path.join(here, "..", "templates"), path.join(here, "..", "..", "templates")];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

function templateFor(platform: Platform): string {
  const dir = templatesDir();
  switch (platform) {
    case "win32":
      return path.join(dir, "notify.win.ps1");
    case "darwin":
      return path.join(dir, "notify.mac.sh");
    case "linux":
      return path.join(dir, "notify.linux.sh");
  }
}

export interface GenerateResult {
  scriptPath: string;
  configPath: string;
}

/**
 * Materialize the notifier script and config.json into the install directory.
 * The script itself is OS-specific and read-only logic; all user choices live
 * in config.json so they can be tweaked without re-running the wizard.
 */
export function generate(installDir: string, platform: Platform, config: Config): GenerateResult {
  mkdirSync(installDir, { recursive: true });

  const scriptPath = notifierScriptPath(installDir, platform);
  if (platform === "win32") {
    // Windows PowerShell 5.1 reads BOM-less scripts as the ANSI codepage, which
    // corrupts the (UTF-8) Korean strings. Install with a UTF-8 BOM so both
    // Windows PowerShell and PowerShell 7 decode it correctly.
    const src = readFileSync(templateFor(platform), "utf8").replace(/^﻿/, "");
    writeFileSync(scriptPath, "﻿" + src, "utf8");
  } else {
    // POSIX: copy verbatim (a BOM would break the #! shebang).
    copyFileSync(templateFor(platform), scriptPath);
    try {
      chmodSync(scriptPath, 0o755);
    } catch {
      /* best-effort on filesystems without exec bits */
    }
  }

  const configPath = path.join(installDir, configFileName(platform));
  if (platform === "win32") writeJson(configPath, config);
  else writeText(configPath, shellConfig(config));

  return { scriptPath, configPath };
}
