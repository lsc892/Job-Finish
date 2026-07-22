import TOML from "@iarna/toml";
import path from "node:path";
import type { Platform } from "../../shared/config-schema.js";
import { buildCommand, notifierScriptPath } from "../command.js";
import { JOB_FINISH_MARKER } from "../settings-merge.js";
import { backup, readTextSafe, writeText } from "../settings-merge.js";

export interface InstallResult {
  settingsPath: string;
  backupPath: string | null;
}

interface CodexCommandHook {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

interface CodexHookGroup {
  hooks?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jobFinishCommandTarget(command: unknown): string | null {
  if (typeof command !== "string" || !command.includes(JOB_FINISH_MARKER)) return null;

  const fileArg = command.match(/(?:^|\s)-File\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  return fileArg?.[1] ?? fileArg?.[2] ?? fileArg?.[3] ?? null;
}

/** Locate the script used by the legacy top-level Codex `notify` callback. */
function jobFinishNotifyTarget(notify: unknown): string | null {
  if (!Array.isArray(notify)) return null;
  const args = notify.filter((a): a is string => typeof a === "string");
  if (!args.some((a) => a.includes(JOB_FINISH_MARKER))) return null;

  const fileIndex = args.findIndex((a) => a.toLowerCase() === "-file");
  if (fileIndex >= 0 && args[fileIndex + 1]) return args[fileIndex + 1];

  return args.find((a) => a.includes(JOB_FINISH_MARKER)) ?? null;
}

/** Locate the script used by Job-Finish's Codex `Stop` lifecycle hook. */
function jobFinishStopTarget(hooks: unknown): string | null {
  if (!isRecord(hooks) || !Array.isArray(hooks["Stop"])) return null;

  for (const group of hooks["Stop"]) {
    if (!isRecord(group) || !Array.isArray(group["hooks"])) continue;
    for (const handler of group["hooks"]) {
      if (!isRecord(handler)) continue;
      const target = jobFinishCommandTarget(handler["command"]);
      if (target) return target;
    }
  }
  return null;
}

function removeJobFinishStopHooks(parsed: Record<string, unknown>): boolean {
  const hooks = parsed["hooks"];
  if (!isRecord(hooks) || !Array.isArray(hooks["Stop"])) return false;

  let changed = false;
  const stopGroups: CodexHookGroup[] = [];
  for (const value of hooks["Stop"]) {
    if (!isRecord(value) || !Array.isArray(value["hooks"])) {
      stopGroups.push(value as CodexHookGroup);
      continue;
    }

    const handlers = value["hooks"] as unknown[];
    const kept = handlers.filter(
      (handler) => !isRecord(handler) || jobFinishCommandTarget(handler["command"]) === null,
    );
    if (kept.length === handlers.length) {
      stopGroups.push(value as CodexHookGroup);
      continue;
    }

    changed = true;
    if (kept.length > 0) stopGroups.push({ ...value, hooks: kept });
  }

  if (!changed) return false;
  if (stopGroups.length > 0) hooks["Stop"] = stopGroups;
  else delete hooks["Stop"];
  if (Object.keys(hooks).length === 0) delete parsed["hooks"];
  return true;
}

function addJobFinishStopHook(
  parsed: Record<string, unknown>,
  command: string,
): void {
  const existingHooks = parsed["hooks"];
  if (existingHooks !== undefined && !isRecord(existingHooks)) {
    throw new Error("Codex config `hooks` must be a table before Job-Finish can add its Stop hook.");
  }

  const hooks = existingHooks ?? {};
  const existingStop = hooks["Stop"];
  if (existingStop !== undefined && !Array.isArray(existingStop)) {
    throw new Error("Codex config `hooks.Stop` must be an array before Job-Finish can add its Stop hook.");
  }

  const stopGroups = (existingStop ?? []) as CodexHookGroup[];
  stopGroups.push({
    hooks: [
      {
        type: "command",
        command,
        timeout: 30,
      } satisfies CodexCommandHook,
    ],
  });
  hooks["Stop"] = stopGroups;
  parsed["hooks"] = hooks;
}

export function codexJobFinishTarget(configPath: string): string | null {
  const text = readTextSafe(configPath);
  if (!text) return null;
  const parsed = TOML.parse(text) as Record<string, unknown>;
  return jobFinishStopTarget(parsed["hooks"]) ?? jobFinishNotifyTarget(parsed["notify"]);
}

export function codexUsesInstallDir(configPath: string, installDir: string, platform: Platform): boolean {
  const target = codexJobFinishTarget(configPath);
  if (!target) return false;
  return path.resolve(target) === path.resolve(notifierScriptPath(installDir, platform));
}

/**
 * Install a turn-scoped Codex `Stop` lifecycle hook. Unlike the legacy
 * top-level `notify` callback, Stop is dispatched inside the shared Codex agent
 * loop and therefore reaches IDE/app-server turns without waiting for a later
 * client event. Existing user hooks and unrelated `notify` commands are kept.
 * Reinstalling also migrates Job-Finish's old `notify` entry in place.
 */
export function installCodex(
  configPath: string,
  installDir: string,
  platform: Platform,
): InstallResult {
  const script = notifierScriptPath(installDir, platform);
  const text = readTextSafe(configPath);
  const parsed = (text ? TOML.parse(text) : {}) as Record<string, unknown>;

  removeJobFinishStopHooks(parsed);
  if (jobFinishNotifyTarget(parsed["notify"]) !== null) delete parsed["notify"];
  addJobFinishStopHook(parsed, buildCommand(script, platform, "codex"));

  const bak = backup(configPath);
  writeText(configPath, TOML.stringify(parsed as TOML.JsonMap));
  return { settingsPath: configPath, backupPath: bak };
}

/** Remove Job-Finish's current Stop hook and any legacy notify entry. */
export function uninstallCodex(configPath: string): InstallResult {
  const text = readTextSafe(configPath);
  if (!text) return { settingsPath: configPath, backupPath: null };
  const parsed = TOML.parse(text) as Record<string, unknown>;

  let changed = removeJobFinishStopHooks(parsed);
  if (jobFinishNotifyTarget(parsed["notify"]) !== null) {
    delete parsed["notify"];
    changed = true;
  }
  if (!changed) return { settingsPath: configPath, backupPath: null };

  const bak = backup(configPath);
  writeText(configPath, TOML.stringify(parsed as TOML.JsonMap));
  return { settingsPath: configPath, backupPath: bak };
}
