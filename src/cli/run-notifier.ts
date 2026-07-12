// 책임: 생성된 notifier 스크립트를 1회 실행(doctor/preview용).
import { spawn } from "node:child_process";
import type { Platform } from "../shared/config-schema.js";

/** Run the generated notifier once (used by doctor/preview). */
export function runNotifier(scriptPath: string, platform: Platform, test: boolean): Promise<number> {
  void platform;
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Event",
    "stop",
    ...(test ? ["-Test"] : []),
  ];
  return new Promise((resolve) => {
    const child = spawn("powershell", args, { stdio: "ignore" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/**
 * Prime the notifier at install time: create the Start Menu shortcut and register
 * the focus protocol up front so the very first notification isn't the one that
 * lazily creates them (Windows silently drops the first toast for an
 * AppUserModelID it hasn't registered yet).
 */
export function primeNotifier(scriptPath: string, platform: Platform): Promise<number> {
  void platform;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Prime"];
  return new Promise((resolve) => {
    const child = spawn("powershell", args, { stdio: "ignore" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
