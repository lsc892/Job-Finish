import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Platform } from "../shared/config-schema.js";
import { notifierScriptPath } from "./command.js";
import { writeJson } from "./settings-merge.js";

/**
 * Serialize config for the notifier to read. Windows/PowerShell parses JSON
 * natively, so we keep the canonical config.json next to the generated script.
 */
function configFileName(platform: Platform): string {
  void platform;
  return "job-finish.config.json";
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
  void platform;
  return path.join(templatesDir(), "notify.win.ps1");
}

function focusHelperFor(platform: Platform): string {
  void platform;
  return path.join(templatesDir(), "jf-focus-vscode.exe");
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
  // Windows PowerShell 5.1 reads BOM-less scripts as the ANSI codepage, which
  // corrupts the (UTF-8) Korean strings. Install with a UTF-8 BOM so both
  // Windows PowerShell and PowerShell 7 decode it correctly.
  const src = readFileSync(templateFor(platform), "utf8").replace(/^\uFEFF/, "");
  writeFileSync(scriptPath, `\uFEFF${src}`, "utf8");

  const focusHelper = focusHelperFor(platform);
  if (existsSync(focusHelper)) {
    copyFileSync(focusHelper, path.join(installDir, "jf-focus-vscode.exe"));
  }

  const configPath = path.join(installDir, configFileName(platform));
  writeJson(configPath, config);

  return { scriptPath, configPath };
}
