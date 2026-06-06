import { z } from "zod";

/**
 * Shared config shape written to `job-finish.config.json` and read by the
 * generated notifier script at runtime. Keeping it as a plain JSON file lets
 * users tweak behavior without re-running the wizard.
 */

export const NOTIFY_MODES = ["toast", "os", "flash"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

/** Max taskbar/dock flashing duration. "infinite" flashes until refocused. */
export const FLASH_TIMEOUTS = ["30s", "5m", "10m", "infinite"] as const;
export type FlashTimeout = (typeof FLASH_TIMEOUTS)[number];

export const AGENTS = ["claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

export const PLATFORMS = ["win32", "darwin", "linux"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const SoundConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Absolute path to a custom sound file. Empty = OS default system sound. */
  customPath: z.string().default(""),
});

export const ConfigSchema = z.object({
  /** Schema version for forward-compat migrations. */
  version: z.literal(1).default(1),
  platform: z.enum(PLATFORMS),
  /** Which visual notification modes are enabled. */
  modes: z.array(z.enum(NOTIFY_MODES)).default(["toast", "flash"]),
  flashTimeout: z.enum(FLASH_TIMEOUTS).default("5m"),
  sound: SoundConfigSchema.default({ enabled: true, customPath: "" }),
  /**
   * When true, suppress all notifications if the host window (the GUI app that
   * launched the agent, e.g. VSCode) is currently focused.
   */
  suppressWhenFocused: z.boolean().default(true),
  /**
   * Hint for focus detection on macOS/Linux where parent-process walking is
   * unreliable. "" = auto-detect. Example: "Code" / "com.microsoft.VSCode".
   */
  watchApp: z.string().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Timeout label -> milliseconds. null means "infinite". */
export const FLASH_TIMEOUT_MS: Record<FlashTimeout, number | null> = {
  "30s": 30_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  infinite: null,
};

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw);
}
