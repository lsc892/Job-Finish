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
  const p = process.platform;
  if (p === "win32" || p === "darwin" || p === "linux") return p;
  // Unsupported platforms fall back to linux-style shell behavior.
  return "linux";
}

export function homeDir(): string {
  return os.homedir();
}

/** Default OS system sound used when the user has no custom sound. */
export function defaultSoundPath(platform: Platform): string {
  switch (platform) {
    case "win32":
      return "C:\\Windows\\Media\\chimes.wav";
    case "darwin":
      return "/System/Library/Sounds/Glass.aiff";
    case "linux":
      return "/usr/share/sounds/freedesktop/stereo/complete.oga";
  }
}

function which(cmd: string): string | null {
  try {
    const out =
      process.platform === "win32"
        ? execFileSync("where", [cmd], { encoding: "utf8" })
        : execFileSync("which", [cmd], { encoding: "utf8" });
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
  const checks: DependencyCheck[] = [];

  if (platform === "win32") {
    const ps = which("powershell") ?? which("pwsh");
    checks.push({
      name: "PowerShell",
      ok: !!ps,
      detail: ps ?? "not found",
      hint: "PowerShell ships with Windows; ensure it is on PATH.",
    });
  } else if (platform === "darwin") {
    checks.push({
      name: "osascript",
      ok: !!which("osascript"),
      detail: which("osascript") ?? "not found",
    });
    checks.push({
      name: "afplay",
      ok: !!which("afplay"),
      detail: which("afplay") ?? "not found",
    });
  } else {
    const notify = which("notify-send");
    checks.push({
      name: "notify-send",
      ok: !!notify,
      detail: notify ?? "not found",
      hint: "Install libnotify-bin (Debian/Ubuntu) for OS notifications.",
    });
    const wmctrl = which("wmctrl") ?? which("xdotool");
    checks.push({
      name: "wmctrl/xdotool",
      ok: !!wmctrl,
      detail: wmctrl ?? "not found",
      hint: "Needed for taskbar urgency (flash). Install wmctrl or xdotool.",
    });
    const player = which("paplay") ?? which("aplay") ?? which("ffplay");
    checks.push({
      name: "sound player",
      ok: !!player,
      detail: player ?? "not found",
      hint: "Install pulseaudio-utils (paplay) or alsa-utils (aplay).",
    });
  }

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
