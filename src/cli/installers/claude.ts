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

/** Tool whose PreToolUse means the agent is about to block waiting on a choice. */
const ASK_TOOLS = "AskUserQuestion";

/**
 * Patch Claude Code's settings.json so the `Stop` (work finished) and
 * `PreToolUse` for AskUserQuestion (waiting on a choice) events invoke our
 * notifier. We deliberately do NOT hook `Notification`: it also fires on input
 * idle, double-notifying right after a question. Existing hooks and other
 * settings are preserved; only our entries are added/replaced.
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
  // Upgrade path: older versions hooked Notification (the double-fire culprit).
  // Strip any stale job-finish Notification entry on re-install.
  if (settings.hooks["Notification"]) {
    const cleaned = removeClaudeHook(settings.hooks["Notification"]);
    if (cleaned.length === 0) delete settings.hooks["Notification"];
    else settings.hooks["Notification"] = cleaned;
  }

  const events: Array<[string, EventKind, string]> = [
    ["Stop", "stop", "*"],
    ["PreToolUse", "notify", ASK_TOOLS],
  ];
  for (const [event, kind, matcher] of events) {
    settings.hooks[event] = upsertClaudeHook(
      settings.hooks[event],
      buildCommand(script, platform, kind),
      matcher,
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
    for (const event of ["Stop", "Notification", "PreToolUse"]) {
      const cleaned = removeClaudeHook(settings.hooks[event]);
      if (cleaned.length === 0) delete settings.hooks[event];
      else settings.hooks[event] = cleaned;
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  writeJson(settingsPath, settings);
  return { settingsPath, backupPath: bak };
}
