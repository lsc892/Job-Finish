import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
} from "@clack/prompts";
import pc from "picocolors";
import {
  type Agent,
  type Config,
  type FlashTimeout,
  type NotifyMode,
  type Platform,
} from "../shared/config-schema.js";
import { getInstallCopy, type InstallLocale } from "./locale.js";

export interface WizardResult {
  scope: "global" | "project";
  agents: Agent[];
  config: Config;
}

function bail(locale: InstallLocale): never {
  cancel(getInstallCopy(locale).wizard.cancelled);
  process.exit(0);
}

function unwrap<T>(value: T | symbol, locale: InstallLocale): T {
  if (isCancel(value)) bail(locale);
  return value as T;
}

/**
 * Interactive setup. Mirrors cc-statusline's flow: a few spacebar-toggled
 * multiselects and simple prompts, then returns everything generate/install need.
 */
export async function runWizard(platform: Platform, locale: InstallLocale = "en"): Promise<WizardResult> {
  const copy = getInstallCopy(locale).wizard;
  intro(pc.bgCyan(pc.black(" job-finish ")) + pc.dim(` ${copy.intro}`));

  type Opt<T> = { value: T; label: string; hint?: string };

  const scopeOptions: Opt<"global" | "project">[] = [
    { value: "project", label: copy.project, hint: copy.recommended },
    { value: "global", label: copy.global },
  ];
  const scope = unwrap(
    await select({
      message: copy.scopePrompt,
      options: scopeOptions,
      initialValue: "project" as "global" | "project",
    }),
    locale,
  ) as "global" | "project";

  const agentOptions: Opt<Agent>[] = [
    { value: "claude", label: "Claude Code", hint: "Stop / AskUserQuestion hook" },
    { value: "codex", label: "Codex", hint: "~/.codex/config.toml notify" },
  ];
  const agents = unwrap(
    await multiselect({
      message: copy.agentPrompt,
      options: agentOptions,
      initialValues: ["claude"] as Agent[],
      required: true,
    }),
    locale,
  ) as Agent[];

  const modeOptions: Opt<NotifyMode>[] = [
    { value: "os", label: copy.osMode, hint: copy.osModeHint },
    { value: "flash", label: copy.flashMode, hint: copy.flashModeHint },
  ];
  const modes = unwrap(
    await multiselect({
      message: copy.modePrompt,
      options: modeOptions,
      initialValues: ["os", "flash"] as NotifyMode[],
      required: true,
    }),
    locale,
  ) as NotifyMode[];

  let flashTimeout: FlashTimeout = "5m";
  if (modes.includes("flash")) {
    const timeoutOptions: Opt<FlashTimeout>[] = [
      { value: "30s", label: copy.seconds30 },
      { value: "5m", label: copy.minutes5 },
      { value: "10m", label: copy.minutes10 },
      { value: "infinite", label: copy.infinite },
    ];
    flashTimeout = unwrap(
      await select({
        message: copy.flashTimeoutPrompt,
        options: timeoutOptions,
        initialValue: "5m" as FlashTimeout,
      }),
      locale,
    ) as FlashTimeout;
  }

  const soundOn = unwrap(
    await confirm({ message: copy.soundPrompt, initialValue: true }),
    locale,
  ) as boolean;

  const suppressWhenFocused = unwrap(
    await confirm({
      message: copy.focusPrompt,
      initialValue: true,
    }),
    locale,
  ) as boolean;

  const config: Config = {
    version: 1,
    platform,
    modes,
    flashTimeout,
    sound: { enabled: soundOn },
    suppressWhenFocused,
    clearToastOnFocus: true,
    // Debug logging stays off on install; flip `debug` in job-finish.config.json to troubleshoot.
    debug: false,
    watchApp: "",
  };

  note(
    [
      `${copy.scope}: ${scope === "project" ? copy.project : copy.global}`,
      `${copy.agents}: ${agents.join(", ")}`,
      `${copy.modes}: ${modes.join(", ")}`,
      modes.includes("flash") ? `${copy.flash}: ${copy.maximum} ${flashTimeout}` : null,
      `${copy.sound}: ${soundOn ? copy.soundOn : copy.soundOff}`,
      `${copy.focus}: ${suppressWhenFocused ? copy.focusSkip : copy.focusAlways}`,
    ]
      .filter(Boolean)
      .join("\n"),
    copy.summaryTitle,
  );

  return { scope, agents, config };
}

export function finish(message: string): void {
  outro(pc.green(message));
}
