import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Generic helpers for safely reading, backing up, and writing config files
 * (Claude's settings.json and Codex's config.toml). Every write is preceded by
 * a timestamped `.bak` so the user can always recover their previous config.
 */

export function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Create `<file>.<timestamp>.bak` next to an existing file. Returns the backup path or null. */
export function backup(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${filePath}.${ts}.bak`;
  copyFileSync(filePath, bak);
  return bak;
}

export function readJsonSafe(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const text = readFileSync(filePath, "utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Could not parse ${filePath} as JSON (it may have comments or be corrupt). ` +
        `Fix or remove it and re-run. Original error: ${(err as Error).message}`,
    );
  }
}

export function writeJson(filePath: string, data: unknown): void {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function readTextSafe(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

export function writeText(filePath: string, text: string): void {
  ensureDir(filePath);
  writeFileSync(filePath, text, "utf8");
}

/**
 * Identify our hook entries so install is idempotent and uninstall can find
 * them again. We tag the command string with this marker.
 */
export const JOB_FINISH_MARKER = "job-finish-notify";

export interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/**
 * Merge a single command into a Claude hook event array (Stop / Notification),
 * replacing any prior job-finish entry rather than duplicating it.
 */
export function upsertClaudeHook(
  existing: ClaudeHookEntry[] | undefined,
  command: string,
): ClaudeHookEntry[] {
  const others = (existing ?? []).filter(
    (entry) =>
      !entry.hooks?.some((h) => typeof h.command === "string" && h.command.includes(JOB_FINISH_MARKER)),
  );
  others.push({ matcher: "*", hooks: [{ type: "command", command }] });
  return others;
}

/** Remove all job-finish entries from a Claude hook event array. */
export function removeClaudeHook(existing: ClaudeHookEntry[] | undefined): ClaudeHookEntry[] {
  return (existing ?? []).filter(
    (entry) =>
      !entry.hooks?.some((h) => typeof h.command === "string" && h.command.includes(JOB_FINISH_MARKER)),
  );
}
