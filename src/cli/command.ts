import path from "node:path";
import type { Platform } from "../shared/config-schema.js";

export type EventKind = "stop" | "notify" | "codex";

/** Absolute path of the generated notifier script for a platform. */
export function notifierScriptPath(installDir: string, platform: Platform): string {
  return platform === "win32"
    ? path.join(installDir, "job-finish-notify.ps1")
    : path.join(installDir, "job-finish-notify.sh");
}

/**
 * Build the shell command a hook/notify entry should run. The `-Event`/positional
 * arg tells the notifier which event fired so it can pick the right wording.
 */
export function buildCommand(scriptPath: string, platform: Platform, event: EventKind): string {
  if (platform === "win32") {
    // Quote the path; PowerShell reads the agent's JSON from stdin.
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -Event ${event}`;
  }
  return `bash "${scriptPath}" ${event}`;
}

/**
 * Codex's `notify` is an argv array, not a shell string. pwsh is preferred on
 * Windows but falls back to powershell; the agent appends the event JSON as the
 * final argument automatically.
 */
export function buildCodexNotifyArgv(scriptPath: string, platform: Platform): string[] {
  if (platform === "win32") {
    return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Event", "codex"];
  }
  return ["bash", scriptPath, "codex"];
}
