import type { Platform } from "../../shared/config-schema.js";
import { buildCommand, notifierScriptPath, type EventKind } from "../command.js";
import {
  backup,
  readJsonSafe,
  removeClaudeHook,
  upsertClaudeHook,
  writeJson,
  type ClaudeHookEntry,
} from "../settings-merge.js";

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [k: string]: unknown;
}

export interface InstallResult {
  settingsPath: string;
  backupPath: string | null;
}

/**
 * Patch Claude Code's settings.json so the `Stop` (work finished) and
 * `Notification` (needs input) events invoke our notifier. Existing hooks and
 * other settings are preserved; only our entries are added/replaced.
 */
export function installClaude(
  settingsPath: string,
  installDir: string,
  platform: Platform,
): InstallResult {
  const script = notifierScriptPath(installDir, platform);
  const settings = readJsonSafe(settingsPath) as ClaudeSettings;
  const bak = backup(settingsPath);

  settings.hooks ??= {};
  const events: Array<[string, EventKind]> = [
    ["Stop", "stop"],
    ["Notification", "notify"],
  ];
  for (const [event, kind] of events) {
    settings.hooks[event] = upsertClaudeHook(
      settings.hooks[event],
      buildCommand(script, platform, kind),
    );
  }

  writeJson(settingsPath, settings);
  return { settingsPath, backupPath: bak };
}

/** Remove job-finish entries from Claude settings, pruning empty arrays. */
export function uninstallClaude(settingsPath: string): InstallResult {
  const settings = readJsonSafe(settingsPath) as ClaudeSettings;
  const bak = backup(settingsPath);
  if (settings.hooks) {
    for (const event of ["Stop", "Notification"]) {
      const cleaned = removeClaudeHook(settings.hooks[event]);
      if (cleaned.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = cleaned;
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  writeJson(settingsPath, settings);
  return { settingsPath, backupPath: bak };
}
