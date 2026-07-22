export const INSTALL_LOCALES = ["en", "ko", "zh", "jp"] as const;
export type InstallLocale = (typeof INSTALL_LOCALES)[number];

interface WizardCopy {
  cancelled: string;
  intro: string;
  project: string;
  recommended: string;
  global: string;
  scopePrompt: string;
  agentPrompt: string;
  osMode: string;
  osModeHint: string;
  flashMode: string;
  flashModeHint: string;
  modePrompt: string;
  seconds30: string;
  minutes5: string;
  minutes10: string;
  infinite: string;
  flashTimeoutPrompt: string;
  soundPrompt: string;
  focusPrompt: string;
  summaryTitle: string;
  scope: string;
  agents: string;
  modes: string;
  flash: string;
  maximum: string;
  sound: string;
  soundOn: string;
  soundOff: string;
  focus: string;
  focusSkip: string;
  focusAlways: string;
}

interface InitCopy {
  attentionNeeded: string;
  notFound: string;
  defaultSoundFile: string;
  powerShellHint: string;
  soundHint: string;
  globalActive: string;
  codexGlobalWarning: string;
  keepGlobalTitle: string;
  globalOnly: string;
  globalInstall: string;
  globalCodexNotify: string;
  generating: string;
  generated: string;
  script: string;
  config: string;
  cleanup: string;
  projectClaudeRemoved: string;
  projectCodexRemoved: string;
  projectInstallRemoved: string;
  reset: string;
  previousResidueRemoved: string;
  backup: string;
  codexTrust: string;
  installComplete: string;
  testPrompt: string;
  testSent: string;
  finished: string;
}

export interface InstallCopy {
  wizard: WizardCopy;
  init: InitCopy;
}

const COPIES: Record<InstallLocale, InstallCopy> = {
  en: {
    wizard: {
      cancelled: "Installation cancelled.",
      intro: "Task completion notification setup",
      project: "This project only",
      recommended: "Recommended",
      global: "All projects",
      scopePrompt: "Choose an install scope",
      agentPrompt: "Which agents do you want to connect? (Press space to select)",
      osMode: "OS notification",
      osModeHint: "Saved in Notification Center",
      flashMode: "Taskbar flashing",
      flashModeHint: "Only when unfocused / stops when you return",
      modePrompt: "Notification modes (Press space to select)",
      seconds30: "30 seconds",
      minutes5: "5 minutes",
      minutes10: "10 minutes",
      infinite: "Infinite (until you return to the window)",
      flashTimeoutPrompt: "Maximum taskbar flashing duration",
      soundPrompt: "Play a sound when a task finishes? (OS default sound)",
      focusPrompt: "Skip notifications while viewing the agent window (VS Code)?",
      summaryTitle: "Configuration summary",
      scope: "Scope",
      agents: "Agents",
      modes: "Modes",
      flash: "Flashing",
      maximum: "maximum",
      sound: "Sound",
      soundOn: "On (OS default)",
      soundOff: "Off",
      focus: "Focus",
      focusSkip: "Skip while focused",
      focusAlways: "Always notify",
    },
    init: {
      attentionNeeded: "Attention needed",
      notFound: "not found",
      defaultSoundFile: "default sound file",
      powerShellHint: "PowerShell ships with Windows; ensure it is on PATH.",
      soundHint: "Default sound missing; set a custom path.",
      globalActive: "A global Job-Finish install is already active, so the project install will be skipped.",
      codexGlobalWarning: "Codex lifecycle hooks are configured globally, so a project install can also change the global Codex setting.",
      keepGlobalTitle: "Keeping global install",
      globalOnly: "Only the global install remains.",
      globalInstall: "global install",
      globalCodexNotify: "global Codex hook",
      generating: "Generating the script and configuration",
      generated: "Notifier created",
      script: "Script",
      config: "Config",
      cleanup: "Cleanup",
      projectClaudeRemoved: "removed project Claude hook",
      projectCodexRemoved: "removed Codex hook that pointed to the project install",
      projectInstallRemoved: "removed project install folder",
      reset: "Reset",
      previousResidueRemoved: "removed previous install residue",
      backup: "backup ✓",
      codexTrust: "After restarting Codex, open /hooks and trust the new Job-Finish Stop hook.",
      installComplete: "Installation complete",
      testPrompt: "Send a test notification now?",
      testSent: "Test notification sent. Check the notification and sound.",
      finished: "Done! Restart the agent to receive notifications when tasks finish.",
    },
  },
  ko: {
    wizard: {
      cancelled: "설치를 취소했어요.",
      intro: "작업 완료 알림 설정",
      project: "이 프로젝트만",
      recommended: "권장",
      global: "모든 프로젝트",
      scopePrompt: "설치 범위를 고르세요",
      agentPrompt: "어떤 에이전트에 연결할까요? (스페이스로 체크)",
      osMode: "OS 알림창",
      osModeHint: "알림 센터에 기록",
      flashMode: "작업표시줄 깜빡임",
      flashModeHint: "창을 안 볼 때만 / 다시 보면 멈춤",
      modePrompt: "알림 모드 (스페이스로 체크)",
      seconds30: "30초",
      minutes5: "5분",
      minutes10: "10분",
      infinite: "무한 (창을 다시 볼 때까지)",
      flashTimeoutPrompt: "작업표시줄 최대 깜빡임 시간",
      soundPrompt: "작업 완료 때 소리를 켤까요? (OS 기본음)",
      focusPrompt: "에이전트 창(VS Code)을 보고 있을 때 알림을 생략할까요?",
      summaryTitle: "설정 요약",
      scope: "범위",
      agents: "에이전트",
      modes: "모드",
      flash: "깜빡임",
      maximum: "최대",
      sound: "소리",
      soundOn: "켬 (OS 기본음)",
      soundOff: "끔",
      focus: "포커스",
      focusSkip: "보고 있으면 생략",
      focusAlways: "항상 알림",
    },
    init: {
      attentionNeeded: "확인 필요",
      notFound: "찾을 수 없음",
      defaultSoundFile: "기본 사운드 파일",
      powerShellHint: "PowerShell은 Windows에 포함되어 있습니다. PATH에 등록되어 있는지 확인하세요.",
      soundHint: "기본 사운드가 없습니다. 사용자 지정 경로를 설정하세요.",
      globalActive: "전역 Job-Finish가 이미 활성이라 프로젝트 설치를 건너뜁니다.",
      codexGlobalWarning: "Codex 생명주기 hook은 전역으로 설정되므로 프로젝트 설치도 전역 Codex 설정을 바꿀 수 있어요.",
      keepGlobalTitle: "전역 설치 유지",
      globalOnly: "전역 설치만 남도록 처리했어요.",
      globalInstall: "전역 설치",
      globalCodexNotify: "전역 Codex hook",
      generating: "스크립트와 설정을 생성하는 중",
      generated: "notifier 생성 완료",
      script: "스크립트",
      config: "설정",
      cleanup: "정리",
      projectClaudeRemoved: "프로젝트 Claude hook 제거",
      projectCodexRemoved: "프로젝트 설치본을 가리키던 Codex hook 제거",
      projectInstallRemoved: "프로젝트 설치 폴더 삭제",
      reset: "리셋",
      previousResidueRemoved: "이전 설치 잔여 정리",
      backup: "백업 ✓",
      codexTrust: "Codex를 다시 시작한 뒤 /hooks를 열어 새 Job-Finish Stop hook을 신뢰해 주세요.",
      installComplete: "설치 완료",
      testPrompt: "지금 테스트 알림을 보내볼까요?",
      testSent: "테스트 알림을 보냈어요. 알림/소리를 확인하세요.",
      finished: "끝났어요! 에이전트를 다시 시작하면 작업 완료 때 알림이 뜹니다.",
    },
  },
  zh: {
    wizard: {
      cancelled: "已取消安装。",
      intro: "任务完成通知设置",
      project: "仅当前项目",
      recommended: "推荐",
      global: "所有项目",
      scopePrompt: "请选择安装范围",
      agentPrompt: "要连接哪些智能体？（按空格键选择）",
      osMode: "操作系统通知",
      osModeHint: "保存到通知中心",
      flashMode: "任务栏闪烁",
      flashModeHint: "仅在窗口未聚焦时 / 返回窗口后停止",
      modePrompt: "通知模式（按空格键选择）",
      seconds30: "30 秒",
      minutes5: "5 分钟",
      minutes10: "10 分钟",
      infinite: "无限（直到返回窗口）",
      flashTimeoutPrompt: "任务栏最长闪烁时间",
      soundPrompt: "任务完成时播放声音吗？（操作系统默认提示音）",
      focusPrompt: "正在查看智能体窗口（VS Code）时跳过通知吗？",
      summaryTitle: "配置摘要",
      scope: "范围",
      agents: "智能体",
      modes: "模式",
      flash: "闪烁",
      maximum: "最长",
      sound: "声音",
      soundOn: "开启（操作系统默认提示音）",
      soundOff: "关闭",
      focus: "焦点",
      focusSkip: "聚焦时跳过",
      focusAlways: "始终通知",
    },
    init: {
      attentionNeeded: "需要注意",
      notFound: "未找到",
      defaultSoundFile: "默认声音文件",
      powerShellHint: "Windows 已自带 PowerShell，请确认它已加入 PATH。",
      soundHint: "缺少默认声音，请设置自定义路径。",
      globalActive: "全局 Job-Finish 已启用，因此将跳过项目安装。",
      codexGlobalWarning: "Codex 生命周期 hook 为全局设置，因此项目安装也可能更改全局 Codex 设置。",
      keepGlobalTitle: "保留全局安装",
      globalOnly: "已处理为仅保留全局安装。",
      globalInstall: "全局安装",
      globalCodexNotify: "全局 Codex hook",
      generating: "正在生成脚本和配置",
      generated: "Notifier 已生成",
      script: "脚本",
      config: "配置",
      cleanup: "清理",
      projectClaudeRemoved: "已移除项目 Claude hook",
      projectCodexRemoved: "已移除指向项目安装的 Codex hook",
      projectInstallRemoved: "已删除项目安装文件夹",
      reset: "重置",
      previousResidueRemoved: "已清理之前的安装残留",
      backup: "已备份 ✓",
      codexTrust: "重启 Codex 后，请打开 /hooks 并信任新的 Job-Finish Stop hook。",
      installComplete: "安装完成",
      testPrompt: "现在发送一条测试通知吗？",
      testSent: "测试通知已发送，请检查通知和声音。",
      finished: "完成！重启智能体后，任务完成时就会显示通知。",
    },
  },
  jp: {
    wizard: {
      cancelled: "インストールをキャンセルしました。",
      intro: "タスク完了通知の設定",
      project: "このプロジェクトのみ",
      recommended: "推奨",
      global: "すべてのプロジェクト",
      scopePrompt: "インストール範囲を選択してください",
      agentPrompt: "どのエージェントに連携しますか？（スペースキーで選択）",
      osMode: "OS通知",
      osModeHint: "通知センターに保存",
      flashMode: "タスクバーの点滅",
      flashModeHint: "ウィンドウを見ていないときのみ / 戻ると停止",
      modePrompt: "通知モード（スペースキーで選択）",
      seconds30: "30秒",
      minutes5: "5分",
      minutes10: "10分",
      infinite: "無制限（ウィンドウに戻るまで）",
      flashTimeoutPrompt: "タスクバーの最大点滅時間",
      soundPrompt: "タスク完了時にサウンドを鳴らしますか？（OS標準音）",
      focusPrompt: "エージェントのウィンドウ（VS Code）を見ているときは通知を省略しますか？",
      summaryTitle: "設定の概要",
      scope: "範囲",
      agents: "エージェント",
      modes: "モード",
      flash: "点滅",
      maximum: "最大",
      sound: "サウンド",
      soundOn: "オン（OS標準音）",
      soundOff: "オフ",
      focus: "フォーカス",
      focusSkip: "フォーカス中は省略",
      focusAlways: "常に通知",
    },
    init: {
      attentionNeeded: "確認が必要です",
      notFound: "見つかりません",
      defaultSoundFile: "標準サウンドファイル",
      powerShellHint: "PowerShellはWindowsに含まれています。PATHに登録されているか確認してください。",
      soundHint: "標準サウンドがありません。カスタムパスを設定してください。",
      globalActive: "グローバルのJob-Finishがすでに有効なため、プロジェクトへのインストールをスキップします。",
      codexGlobalWarning: "Codexのライフサイクルhookはグローバル設定のため、プロジェクトへのインストールでもグローバル設定が変更される場合があります。",
      keepGlobalTitle: "グローバルインストールを維持",
      globalOnly: "グローバルインストールだけを残しました。",
      globalInstall: "グローバルインストール",
      globalCodexNotify: "グローバルCodex hook",
      generating: "スクリプトと設定を生成しています",
      generated: "Notifierを生成しました",
      script: "スクリプト",
      config: "設定",
      cleanup: "クリーンアップ",
      projectClaudeRemoved: "プロジェクトのClaude hookを削除",
      projectCodexRemoved: "プロジェクトのインストールを指していたCodex hookを削除",
      projectInstallRemoved: "プロジェクトのインストールフォルダを削除",
      reset: "リセット",
      previousResidueRemoved: "以前のインストールの残骸を削除",
      backup: "バックアップ ✓",
      codexTrust: "Codexを再起動した後、/hooksを開いて新しいJob-Finish Stop hookを信頼してください。",
      installComplete: "インストール完了",
      testPrompt: "今すぐテスト通知を送信しますか？",
      testSent: "テスト通知を送信しました。通知とサウンドを確認してください。",
      finished: "完了しました！エージェントを再起動すると、タスク完了時に通知が表示されます。",
    },
  },
};

export function parseInstallLocale(value?: string): InstallLocale | null {
  if (value === undefined) return "en";
  return INSTALL_LOCALES.includes(value as InstallLocale) ? (value as InstallLocale) : null;
}

export function getInstallCopy(locale: InstallLocale): InstallCopy {
  return COPIES[locale];
}
