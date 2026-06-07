import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import pc from "picocolors";
import {
  type Agent,
  type Config,
  type FlashTimeout,
  type NotifyMode,
  type Platform,
} from "../shared/config-schema.js";

export interface WizardResult {
  scope: "global" | "project";
  agents: Agent[];
  config: Config;
}

function bail(): never {
  cancel("설치를 취소했어요.");
  process.exit(0);
}

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) bail();
  return value as T;
}

/**
 * Interactive setup. Mirrors cc-statusline's flow: a few spacebar-toggled
 * multiselects and simple prompts, then returns everything generate/install need.
 */
export async function runWizard(platform: Platform): Promise<WizardResult> {
  intro(pc.bgCyan(pc.black(" job-finish ")) + pc.dim(" 작업 완료 알림 설정"));

  type Opt<T> = { value: T; label: string; hint?: string };

  const scopeOptions: Opt<"global" | "project">[] = [
    { value: "project", label: "이 프로젝트 (./.claude)", hint: "권장" },
    { value: "global", label: "전역 (~/.claude)" },
  ];
  const scope = unwrap(
    await select({
      message: "설치 범위를 고르세요",
      options: scopeOptions,
      initialValue: "project" as "global" | "project",
    }),
  ) as "global" | "project";

  const agentOptions: Opt<Agent>[] = [
    { value: "claude", label: "Claude Code", hint: "Stop / Notification 훅" },
    { value: "codex", label: "Codex", hint: "~/.codex/config.toml notify" },
  ];
  const agents = unwrap(
    await multiselect({
      message: "어떤 에이전트에 연결할까요? (스페이스로 체크)",
      options: agentOptions,
      initialValues: ["claude"] as Agent[],
      required: true,
    }),
  ) as Agent[];

  const modeOptions: Opt<NotifyMode>[] = [
    { value: "os", label: "OS 알림창", hint: "알림 센터에 기록" },
    { value: "flash", label: "작업표시줄 깜빡임", hint: "창 안 볼 때만 / 다시 보면 멈춤" },
  ];
  const modes = unwrap(
    await multiselect({
      message: "알림 모드 (스페이스로 체크)",
      options: modeOptions,
      initialValues: ["os", "flash"] as NotifyMode[],
      required: true,
    }),
  ) as NotifyMode[];

  let flashTimeout: FlashTimeout = "5m";
  if (modes.includes("flash")) {
    const timeoutOptions: Opt<FlashTimeout>[] = [
      { value: "30s", label: "30초" },
      { value: "5m", label: "5분" },
      { value: "10m", label: "10분" },
      { value: "infinite", label: "무한 (창 다시 볼 때까지)" },
    ];
    flashTimeout = unwrap(
      await select({
        message: "작업표시줄 최대 깜빡임 시간",
        options: timeoutOptions,
        initialValue: "5m" as FlashTimeout,
      }),
    ) as FlashTimeout;
  }

  const soundOn = unwrap(
    await confirm({ message: "작업 완료 시 소리를 켤까요?", initialValue: true }),
  ) as boolean;

  let customPath = "";
  if (soundOn) {
    customPath = (
      unwrap(
        await text({
          message: "커스텀 사운드 파일 경로 (비워두면 OS 기본음)",
          placeholder: platform === "win32" ? "C:\\sounds\\done.wav" : "/path/to/done.wav",
          defaultValue: "",
        }),
      ) as string
    ).trim();
  }

  const suppressWhenFocused = unwrap(
    await confirm({
      message: "에이전트 창(VSCode 등)을 보고 있을 땐 알림을 생략할까요?",
      initialValue: true,
    }),
  ) as boolean;

  const config: Config = {
    version: 1,
    platform,
    modes,
    flashTimeout,
    sound: { enabled: soundOn, customPath },
    suppressWhenFocused,
    watchApp: "",
  };

  note(
    [
      `범위:   ${scope === "project" ? "프로젝트 (./.claude)" : "전역 (~/.claude)"}`,
      `에이전트: ${agents.join(", ")}`,
      `모드:   ${modes.join(", ")}`,
      modes.includes("flash") ? `깜빡임:  최대 ${flashTimeout}` : null,
      `소리:   ${soundOn ? (customPath ? `켜짐 (${customPath})` : "켜짐 (OS 기본음)") : "꺼짐"}`,
      `포커스: ${suppressWhenFocused ? "보고 있으면 생략" : "항상 알림"}`,
    ]
      .filter(Boolean)
      .join("\n"),
    "설정 요약",
  );

  return { scope, agents, config };
}

export function finish(message: string): void {
  outro(pc.green(message));
}
