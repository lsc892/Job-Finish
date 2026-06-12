import path from "node:path";
import type { Platform } from "../shared/config-schema.js";

export type EventKind = "stop" | "notify" | "codex";

/** Absolute path of the generated Windows notifier script. */
export function notifierScriptPath(installDir: string, platform: Platform): string {
  void platform;
  return path.join(installDir, "job-finish-notify.ps1");
}

/**
 * Build the shell command a hook/notify entry should run. The `-Event`/positional
 * arg tells the notifier which event fired so it can pick the right wording.
 */
export function buildCommand(scriptPath: string, platform: Platform, event: EventKind): string {
  void platform;
  // Quote the path; PowerShell reads the agent's JSON from stdin.
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -Event ${event}`;
}

/**
 * Codex's `notify` is an argv array, not a shell string. The agent appends the
 * event JSON as the final argument automatically.
 */
export function buildCodexNotifyArgv(scriptPath: string, platform: Platform): string[] {
  void platform;
  return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Event", "codex"];
}
