import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Platform } from "../shared/config-schema.js";

export interface DependencyCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Optional hint shown when missing. */
  hint?: string;
}

export function currentPlatform(): Platform {
  if (process.platform !== "win32") {
    throw new Error("job-finish is Windows-only.");
  }
  return "win32";
}

export function homeDir(): string {
  return os.homedir();
}

/** OS system sound the notifier plays when sound is enabled. */
export function defaultSoundPath(platform: Platform): string {
  void platform;
  return "C:\\Windows\\Media\\chimes.wav";
}

function which(cmd: string): string | null {
  try {
    const out = execFileSync("where", [cmd], { encoding: "utf8" });
    const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Inspect the environment and report which runtime tools the notifier will
 * rely on. Surfaced by `job-finish doctor` and shown as warnings in the wizard.
 */
export function checkDependencies(platform: Platform): DependencyCheck[] {
  void platform;
  const checks: DependencyCheck[] = [];

  const ps = which("powershell") ?? which("pwsh");
  checks.push({
    name: "PowerShell",
    ok: !!ps,
    detail: ps ?? "not found",
    hint: "PowerShell ships with Windows; ensure it is on PATH.",
  });

  // Default sound file presence (informational only).
  const snd = defaultSoundPath(platform);
  checks.push({
    name: "default sound file",
    ok: existsSync(snd),
    detail: snd,
    hint: existsSync(snd) ? undefined : "Default sound missing; set a custom path.",
  });

  return checks;
}

/** Where Claude Code keeps its settings. */
export function claudeSettingsPath(scope: "global" | "project", cwd: string): string {
  return scope === "global"
    ? path.join(homeDir(), ".claude", "settings.json")
    : path.join(cwd, ".claude", "settings.json");
}

/** Codex always uses a single global config. */
export function codexConfigPath(): string {
  return path.join(homeDir(), ".codex", "config.toml");
}

/** Directory where the generated notifier script + config live. */
export function installDir(scope: "global" | "project", cwd: string): string {
  return scope === "global"
    ? path.join(homeDir(), ".job-finish")
    : path.join(cwd, ".claude", "job-finish");
}
