import TOML from "@iarna/toml";
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
  const existingIsOurs =
    Array.isArray(existing) && existing.some((a) => typeof a === "string" && a.includes(JOB_FINISH_MARKER));
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
  const existingIsOurs =
    Array.isArray(existing) && existing.some((a) => typeof a === "string" && a.includes(JOB_FINISH_MARKER));
  if (!existingIsOurs) return { settingsPath: configPath, backupPath: null };

  const bak = backup(configPath);
  delete parsed["notify"];
  writeText(configPath, TOML.stringify(parsed as TOML.JsonMap));
  return { settingsPath: configPath, backupPath: bak };
}
