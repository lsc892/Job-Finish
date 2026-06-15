import TOML from "@iarna/toml";
import path from "node:path";
import type { Platform } from "../../shared/config-schema.js";
import { buildCodexNotifyArgv, notifierScriptPath } from "../command.js";
import { JOB_FINISH_MARKER } from "../settings-merge.js";
import { backup, readTextSafe, writeText } from "../settings-merge.js";

export interface InstallResult {
  settingsPath: string;
  backupPath: string | null;
  /** True when an unrelated `notify` already existed and we declined to clobber it. */
  conflict?: boolean;
}

function jobFinishNotifyTarget(notify: unknown): string | null {
  if (!Array.isArray(notify)) return null;
  const args = notify.filter((a): a is string => typeof a === "string");
  if (!args.some((a) => a.includes(JOB_FINISH_MARKER))) return null;

  const fileIndex = args.findIndex((a) => a.toLowerCase() === "-file");
  if (fileIndex >= 0 && args[fileIndex + 1]) return args[fileIndex + 1];

  return args.find((a) => a.includes(JOB_FINISH_MARKER)) ?? null;
}

export function codexJobFinishTarget(configPath: string): string | null {
  const text = readTextSafe(configPath);
  if (!text) return null;
  const parsed = TOML.parse(text) as Record<string, unknown>;
  return jobFinishNotifyTarget(parsed["notify"]);
}

export function codexUsesInstallDir(configPath: string, installDir: string, platform: Platform): boolean {
  const target = codexJobFinishTarget(configPath);
  if (!target) return false;
  return path.resolve(target) === path.resolve(notifierScriptPath(installDir, platform));
}

/**
 * Patch Codex's ~/.codex/config.toml `notify` program. Codex supports a single
 * `notify` array, so if the user already has a non-job-finish notify hook we do
 * NOT overwrite it — we report a conflict and leave their config untouched.
 */
export function installCodex(
  configPath: string,
  installDir: string,
  platform: Platform,
): InstallResult {
  const script = notifierScriptPath(installDir, platform);
  const text = readTextSafe(configPath);
  const parsed = (text ? TOML.parse(text) : {}) as Record<string, unknown>;

  const existing = parsed["notify"];
  const existingIsOurs = jobFinishNotifyTarget(existing) !== null;
  if (Array.isArray(existing) && existing.length > 0 && !existingIsOurs) {
    return { settingsPath: configPath, backupPath: null, conflict: true };
  }

  const bak = backup(configPath);
  parsed["notify"] = buildCodexNotifyArgv(script, platform);
  writeText(configPath, TOML.stringify(parsed as TOML.JsonMap));
  return { settingsPath: configPath, backupPath: bak };
}

/** Remove our notify entry from Codex config (only if it is ours). */
export function uninstallCodex(configPath: string): InstallResult {
  const text = readTextSafe(configPath);
  if (!text) return { settingsPath: configPath, backupPath: null };
  const parsed = TOML.parse(text) as Record<string, unknown>;
  const existing = parsed["notify"];
  const existingIsOurs = jobFinishNotifyTarget(existing) !== null;
  if (!existingIsOurs) return { settingsPath: configPath, backupPath: null };

  const bak = backup(configPath);
  delete parsed["notify"];
  writeText(configPath, TOML.stringify(parsed as TOML.JsonMap));
  return { settingsPath: configPath, backupPath: bak };
}
