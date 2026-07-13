# job-finish-notify (Windows) - focus-aware completion notifier for Claude Code / Codex.
# Invoked by a hook. Reads choices from job-finish.config.json next to this script.
#   -Event stop|notify|codex   which agent event fired
#   -Test                      bypass focus suppression (used by `doctor`)
# Claude passes a JSON payload on stdin; Codex appends its JSON as the final arg.
param(
  [string]$Event = "stop",
  [switch]$Test,
  [switch]$Prime,
  [switch]$WatchToast,
  [switch]$WatchFlash,
  [string]$ToastTag = "",
  [string]$ToastAppId = "",
  [Int64]$WatchHwnd = 0,
  [string]$WatchTitle = "",
  [Int64]$WatchFlashHwnd = 0,
  [string]$WatchFlashId = "",
  [int]$WatchFlashTimeoutSec = 0,
  [int]$WatchTimeoutSec = 600
)
$ErrorActionPreference = 'SilentlyContinue'
$extraArgs = $args

$defaultToastAppId = 'JobFinish.VisualStudioCode'
$appDisplayName = 'Visual Studio Code'
$toastGroup = 'job-finish'
$protocolName = 'jobfinish-focus'
$toastShortcutFolderName = 'Job-Finish'
$toastShortcutFileName = 'Visual Studio Code.lnk'
$maxToastTextLength = 180
$recentNotificationWindowSec = 10
$defaultFlashIntervalMs = 500
$defaultToastWatchTimeoutSec = 600
$toastRetryDelayMs = 300
$balloonFallbackWaitSec = 12

# Toast identity. Windows desktop toasts are most reliable with a Start Menu
# shortcut whose AppUserModelID matches this value.
$appId = if ($ToastAppId) { $ToastAppId } else { $defaultToastAppId }

# ----------------------------------------------- native interop (window lookup/flash)
Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class JF {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public uint cbSize;
    public IntPtr hwnd;
    public uint dwFlags;
    public uint uCount;
    public uint dwTimeout;
  }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
  [DllImport("user32.dll")] public static extern bool FlashWindow(IntPtr hWnd, bool bInvert);

  public static string GetTitle(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    int len = GetWindowTextW(hWnd, sb, sb.Capacity);
    return len > 0 ? sb.ToString() : "";
  }

  public static IntPtr FindWindowForPids(int[] pids, string titleHint, bool requireTitleHint) {
    if (pids == null || pids.Length == 0) return IntPtr.Zero;
    var wanted = new HashSet<int>(pids);
    string hint = (titleHint ?? "").ToLowerInvariant();
    IntPtr first = IntPtr.Zero;
    IntPtr best = IntPtr.Zero;

    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (!wanted.Contains((int)pid)) return true;

      string title = GetTitle(hWnd);
      if (String.IsNullOrWhiteSpace(title)) return true;
      if (first == IntPtr.Zero) first = hWnd;
      if (best == IntPtr.Zero && hint.Length > 0 && title.ToLowerInvariant().Contains(hint)) {
        best = hWnd;
      }
      return true;
    }, IntPtr.Zero);

    if (best != IntPtr.Zero) return best;
    return requireTitleHint && hint.Length > 0 ? IntPtr.Zero : first;
  }

  public static IntPtr FindCodeWindow(string titleHint, bool allowSingleFallback) {
    string hint = (titleHint ?? "").ToLowerInvariant();
    IntPtr first = IntPtr.Zero;
    IntPtr best = IntPtr.Zero;
    int count = 0;

    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);

      try {
        var process = Process.GetProcessById((int)pid);
        if (!String.Equals(process.ProcessName, "Code", StringComparison.OrdinalIgnoreCase)) return true;
      } catch {
        return true;
      }

      string title = GetTitle(hWnd);
      if (String.IsNullOrWhiteSpace(title)) return true;

      count++;
      if (first == IntPtr.Zero) first = hWnd;
      if (best == IntPtr.Zero && hint.Length > 0 && title.ToLowerInvariant().Contains(hint)) {
        best = hWnd;
      }
      return true;
    }, IntPtr.Zero);

    if (best != IntPtr.Zero) return best;
    return allowSingleFallback && count == 1 ? first : IntPtr.Zero;
  }
}
"@

# ================================================================= classes
# Pure-logic / stateful responsibilities live in classes. Native interop
# ([JF], WinRT toast, COM shortcut, WinForms balloon) stays in the script-scope
# functions below: PowerShell compiles class-method bodies BEFORE Add-Type runs,
# so an Add-Type type literal (e.g. [JF]::) inside a class method fails to parse.
# Interop therefore stays procedural, exactly as the original ran it.

# 책임: PSObject 프로퍼티 존재 확인·조회 헬퍼.
class JfUtil {
  static [bool] HasProperty($value, [string]$name) {
    return $null -ne $value -and @($value.PSObject.Properties.Name) -contains $name
  }

  static [object] GetProperty($value, [string]$name, $default) {
    if ([JfUtil]::HasProperty($value, $name)) { return $value.$name }
    return $default
  }
}

# 책임: config.json 로드·기본값·flashTimeout 변환과 디버그 로깅.
class JfConfig {
  [string]$ScriptRoot
  $Cfg
  [string[]]$Modes
  [bool]$ClearToastOnFocus
  [int]$TimeoutSec

  # config.json을 읽되 없거나 깨졌으면 안전한 기본값으로 채우고, flashTimeout 문자열을 초 단위로 환산해 보관한다.
  JfConfig([string]$scriptRoot) {
    $this.ScriptRoot = $scriptRoot
    $cfgPath = Join-Path $scriptRoot 'job-finish.config.json'
    $c = $null
    if (Test-Path -LiteralPath $cfgPath) {
      try { $c = Get-Content -Raw -Encoding UTF8 -LiteralPath $cfgPath | ConvertFrom-Json } catch {}
    }
    if ($null -eq $c) {
      $c = [pscustomobject]@{
        modes = @('os', 'flash'); flashTimeout = '5m';
        sound = [pscustomobject]@{ enabled = $true };
        suppressWhenFocused = $true; clearToastOnFocus = $true; debug = $false; watchApp = ''
      }
    }
    $this.Cfg = $c
    $this.Modes = @($c.modes)
    $this.ClearToastOnFocus = if ([JfUtil]::HasProperty($c, 'clearToastOnFocus')) { [bool]$c.clearToastOnFocus } else { $true }
    switch ($c.flashTimeout) {
      '30s'      { $this.TimeoutSec = 30 }
      '5m'       { $this.TimeoutSec = 300 }
      '10m'      { $this.TimeoutSec = 600 }
      'infinite' { $this.TimeoutSec = 0 }
      default    { $this.TimeoutSec = 300 }
    }
  }

  [void] Debug([string]$message) {
    if (-not $this.Cfg.debug) { return }
    try {
      $logPath = Join-Path $this.ScriptRoot 'job-finish.log'
      $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
      Add-Content -LiteralPath $logPath -Value "[$ts] $message"
    } catch {}
  }
}

# 책임: 최근 알림 기록 읽기/쓰기로 중복 알림 방지.
class JfDedup {
  [string]$AppId

  JfDedup([string]$appId) { $this.AppId = $appId }

  [string] Path() {
    return Join-Path ([IO.Path]::GetTempPath()) 'job-finish-recent-notification.json'
  }

  # 같은 appId로 직전에 남긴 알림 기록의 시각을 읽어, 지정 초 안이면 중복으로 보고 알림을 건너뛰게 한다.
  [bool] TestRecent([int]$withinSeconds) {
    try {
      $path = $this.Path()
      if (-not (Test-Path -LiteralPath $path)) { return $false }
      $recent = Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json
      if (-not $recent -or -not $recent.whenUtc -or $recent.appId -ne $this.AppId) { return $false }
      $when = [DateTime]::Parse([string]$recent.whenUtc, $null, [Globalization.DateTimeStyles]::RoundtripKind)
      return (([DateTime]::UtcNow - $when).TotalSeconds -lt $withinSeconds)
    } catch {
      return $false
    }
  }

  [void] SaveRecent([string]$eventName, [string]$project) {
    try {
      $path = $this.Path()
      $recent = [pscustomobject]@{
        appId = $this.AppId
        event = $eventName
        project = $project
        whenUtc = [DateTime]::UtcNow.ToString('o')
      }
      $recent | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 -LiteralPath $path
    } catch {}
  }
}

# 책임: 이벤트 페이로드(Claude transcript/Codex 세션) → 토스트 제목·본문 구성.
class JfSummary {
  [int]$MaxLen

  JfSummary([int]$maxLen) { $this.MaxLen = $maxLen }

  [string] LimitText([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return '' }
    if ($value.Length -le $this.MaxLen) { return $value }
    return $value.Substring(0, $this.MaxLen - 3) + '...'
  }

  static [bool] TestCodexEnvironment() {
    if ($env:CODEX_THREAD_ID) { return $true }
    if ($env:CODEX_INTERNAL_ORIGINATOR_OVERRIDE -like 'codex*') { return $true }
    return $false
  }

  static [string] GetEffectiveEvent([string]$eventName) {
    if ($eventName -eq 'stop' -and [JfSummary]::TestCodexEnvironment()) { return 'codex' }
    return $eventName
  }

  [bool] TestVSCodeInstallDirectory([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }

    try {
      $fullPath = [IO.Path]::GetFullPath($path).TrimEnd('\', '/')
      $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code'),
        (Join-Path $env:ProgramFiles 'Microsoft VS Code'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code')
      )

      foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $candidatePath = [IO.Path]::GetFullPath($candidate).TrimEnd('\', '/')
        if ($fullPath.Equals($candidatePath, [System.StringComparison]::OrdinalIgnoreCase)) {
          return $true
        }
      }
    } catch {}

    return $false
  }

  [bool] TestUsableProjectCwd([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return $false }
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { return $false }
    if ($this.TestVSCodeInstallDirectory($path)) { return $false }
    return $true
  }

  [string] GetCodexCwdFromSessionFile($session) {
    if (-not $session -or -not (Test-Path -LiteralPath $session.FullName)) { return '' }

    foreach ($line in @(Get-Content -LiteralPath $session.FullName -Encoding UTF8 -TotalCount 20)) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try { $entry = $line | ConvertFrom-Json } catch { continue }
      $cwd = [JfUtil]::GetProperty(([JfUtil]::GetProperty($entry, 'payload', $null)), 'cwd', '')
      if ($this.TestUsableProjectCwd([string]$cwd)) {
        return [string]$cwd
      }
    }

    $recent = @(Get-Content -LiteralPath $session.FullName -Encoding UTF8 -Tail 500)
    for ($i = $recent.Count - 1; $i -ge 0; $i--) {
      $line = [string]$recent[$i]
      if ($line.IndexOf('"workdir"', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
      try { $entry = $line | ConvertFrom-Json } catch { continue }
      $payload = [JfUtil]::GetProperty($entry, 'payload', $null)
      if (-not $payload -or ([JfUtil]::GetProperty($payload, 'type', '')) -ne 'function_call') { continue }
      $arguments = [JfUtil]::GetProperty($payload, 'arguments', '')
      if (-not $arguments) { continue }
      try { $argsObj = ([string]$arguments) | ConvertFrom-Json } catch { continue }
      $workdir = [JfUtil]::GetProperty($argsObj, 'workdir', '')
      if ($this.TestUsableProjectCwd([string]$workdir)) {
        return [string]$workdir
      }
    }

    return ''
  }

  [object] GetCodexSessionFiles() {
    try {
      $sessionRoot = Join-Path $env:USERPROFILE '.codex\sessions'
      if (-not (Test-Path -LiteralPath $sessionRoot)) { return @() }

      $sessions = @()
      if ($env:CODEX_THREAD_ID) {
        $sessions = @(Get-ChildItem -LiteralPath $sessionRoot -Recurse -File -Filter "*$($env:CODEX_THREAD_ID)*.jsonl" -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending)
      }

      if ($sessions.Count -eq 0) {
        $sessions = @(Get-ChildItem -LiteralPath $sessionRoot -Recurse -File -Filter '*.jsonl' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending |
          Select-Object -First 5)
      }

      return @($sessions)
    } catch {
      return @()
    }
  }

  [string] GetCodexSessionCwd() {
    try {
      foreach ($session in @($this.GetCodexSessionFiles())) {
        $cwd = $this.GetCodexCwdFromSessionFile($session)
        if ($cwd) { return $cwd }
      }

      if ($this.TestUsableProjectCwd([string]$env:VSCODE_CWD)) {
        return [string]$env:VSCODE_CWD
      }
    } catch {}

    return ''
  }

  [string] FormatToastSummary([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return '' }
    $clean = $value -replace '\s+', ' '
    $clean = $clean.Trim()
    return $this.LimitText($clean)
  }

  [string] GetContentText($content) {
    if ($null -eq $content) { return '' }
    if ($content -is [string]) { return [string]$content }

    $parts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($item in @($content)) {
      if ($null -eq $item) { continue }
      if ($item -is [string]) {
        if (-not [string]::IsNullOrWhiteSpace($item)) { $parts.Add([string]$item) }
        continue
      }

      if (([JfUtil]::HasProperty($item, 'text')) -and -not [string]::IsNullOrWhiteSpace([string]$item.text)) {
        $parts.Add([string]$item.text)
      } elseif ([JfUtil]::HasProperty($item, 'content')) {
        $nested = $this.GetContentText($item.content)
        if (-not [string]::IsNullOrWhiteSpace($nested)) { $parts.Add($nested) }
      }
    }

    return ($parts -join ' ')
  }

  # Claude가 stdin으로 준 페이로드에서 transcript 경로를 찾아 마지막 assistant 메시지를 뽑아 토스트 본문으로 요약한다.
  [string] GetClaudeTranscriptSummary($payload) {
    if (-not ([JfUtil]::HasProperty($payload, 'transcript_path'))) { return '' }
    $path = [string]([JfUtil]::GetProperty($payload, 'transcript_path', ''))
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) { return '' }

    try {
      $lines = @(Get-Content -LiteralPath $path -Encoding UTF8 -Tail 200)
      for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $line = [string]$lines[$i]
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $entry = $line | ConvertFrom-Json } catch { continue }

        $role = ''
        if ([JfUtil]::HasProperty($entry, 'role')) { $role = [string]$entry.role }
        if (-not $role -and ([JfUtil]::HasProperty($entry, 'message')) -and $entry.message) {
          if ([JfUtil]::HasProperty($entry.message, 'role')) { $role = [string]$entry.message.role }
        }
        $type = if ([JfUtil]::HasProperty($entry, 'type')) { [string]$entry.type } else { '' }
        if ($role -ne 'assistant' -and $type -ne 'assistant') { continue }

        $content = ''
        if (([JfUtil]::HasProperty($entry, 'message')) -and $entry.message -and ([JfUtil]::HasProperty($entry.message, 'content'))) {
          $content = $this.GetContentText($entry.message.content)
        }
        if (-not $content -and ([JfUtil]::HasProperty($entry, 'content'))) {
          $content = $this.GetContentText($entry.content)
        }

        $summary = $this.FormatToastSummary($content)
        if ($summary) { return $summary }
      }
    } catch {}

    return ''
  }

  # 토큰/세션 한도, API 오류처럼 Claude Code가 비정상 종료할 때 남기는 합성(assistant)
  # 메시지 텍스트를 분류한다. 'usage-limit' | 'api-error' | 'error' 중 하나.
  [string] ClassifyStopError([string]$content) {
    $c = ([string]$content).ToLowerInvariant()
    if ($c -match 'limit') { return 'usage-limit' }   # session/usage limit, limit reached 등
    if ($c -match 'api error') { return 'api-error' }
    return 'error'                                     # not logged in, prompt too long 등
  }

  # Stop 훅으로 들어온 Claude transcript의 마지막 assistant 항목을 보고 종료 유형을 판정한다.
  # 한도 소진·API 오류 같은 비정상 종료는 Claude가 isApiErrorMessage 플래그가 붙은 합성
  # assistant 메시지로 남기므로, 이를 정상 완료와 구분해 알림 제목을 다르게 줄 수 있게 한다.
  # 반환: @{ Kind = 'normal'|'usage-limit'|'api-error'|'error'; Text = <토스트 본문 요약> }
  [hashtable] GetClaudeStopInfo($payload) {
    $result = @{ Kind = 'normal'; Text = '' }
    if (-not ([JfUtil]::HasProperty($payload, 'transcript_path'))) { return $result }
    $path = [string]([JfUtil]::GetProperty($payload, 'transcript_path', ''))
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) { return $result }

    try {
      $lines = @(Get-Content -LiteralPath $path -Encoding UTF8 -Tail 200)
      for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $line = [string]$lines[$i]
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $entry = $line | ConvertFrom-Json } catch { continue }

        $role = ''
        if ([JfUtil]::HasProperty($entry, 'role')) { $role = [string]$entry.role }
        if (-not $role -and ([JfUtil]::HasProperty($entry, 'message')) -and $entry.message) {
          if ([JfUtil]::HasProperty($entry.message, 'role')) { $role = [string]$entry.message.role }
        }
        $type = if ([JfUtil]::HasProperty($entry, 'type')) { [string]$entry.type } else { '' }
        if ($role -ne 'assistant' -and $type -ne 'assistant') { continue }

        $content = ''
        if (([JfUtil]::HasProperty($entry, 'message')) -and $entry.message -and ([JfUtil]::HasProperty($entry.message, 'content'))) {
          $content = $this.GetContentText($entry.message.content)
        }
        if (-not $content -and ([JfUtil]::HasProperty($entry, 'content'))) {
          $content = $this.GetContentText($entry.content)
        }

        # 마지막 assistant 항목을 찾았으므로 여기서 분류하고 종료한다.
        $result.Text = $this.FormatToastSummary($content)
        if (([JfUtil]::HasProperty($entry, 'isApiErrorMessage')) -and [bool]$entry.isApiErrorMessage) {
          $result.Kind = $this.ClassifyStopError($content)
        }
        return $result
      }
    } catch {}

    return $result
  }

  # Claude가 백그라운드 서브에이전트를 띄우면 메인 에이전트 턴이 끝나 Stop 훅이 먼저 터진다.
  # 서브에이전트 실행은 tool_result가 즉시 "Async agent launched..." 형태로 돌아오고,
  # 실제 완료는 나중에 <task-notification> 사용자 메시지로 온다. 따라서 "런치 확인(ack)은
  # 있는데 아직 완료 알림이 없는" 서브에이전트가 있으면 여전히 돌아가는 중이므로 참을 반환한다.
  # (동기 서브에이전트는 런치 ack가 없어 여기에 걸리지 않는다 → 정상 알림.)
  [bool] HasPendingSubagentTask($payload) {
    if (-not ([JfUtil]::HasProperty($payload, 'transcript_path'))) { return $false }
    $path = [string]([JfUtil]::GetProperty($payload, 'transcript_path', ''))
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) { return $false }

    try {
      $lines = @(Get-Content -LiteralPath $path -Encoding UTF8 -Tail 800)
      $agentUseIds = New-Object 'System.Collections.Generic.HashSet[string]'  # tool_use name=Agent ids
      $ackedIds = New-Object 'System.Collections.Generic.HashSet[string]'     # tool_result carrying a bg-launch ack
      $stopped = New-Object 'System.Collections.Generic.HashSet[string]'      # ids named by a completion notification
      foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }

        # Completion/stop signal: a task-notification names the finished subagent.
        if ($line.IndexOf('task-notification', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
          foreach ($m in [regex]::Matches($line, '<tool-use-id>(toolu_[^<]+)</tool-use-id>')) {
            [void]$stopped.Add($m.Groups[1].Value)
          }
        }

        if ($line.IndexOf('tool_use', [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -and
            $line.IndexOf('tool_result', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        try { $entry = $line | ConvertFrom-Json } catch { continue }
        $message = [JfUtil]::GetProperty($entry, 'message', $null)
        if (-not $message) { continue }
        $content = [JfUtil]::GetProperty($message, 'content', $null)
        if ($null -eq $content) { continue }
        foreach ($block in @($content)) {
          if ($null -eq $block) { continue }
          $btype = [string]([JfUtil]::GetProperty($block, 'type', ''))
          if ($btype -eq 'tool_use') {
            if (([string]([JfUtil]::GetProperty($block, 'name', ''))) -eq 'Agent') {
              $id = [string]([JfUtil]::GetProperty($block, 'id', ''))
              if ($id) { [void]$agentUseIds.Add($id) }
            }
          } elseif ($btype -eq 'tool_result') {
            $rid = [string]([JfUtil]::GetProperty($block, 'tool_use_id', ''))
            if (-not $rid) { continue }
            $rtext = $this.GetContentText([JfUtil]::GetProperty($block, 'content', ''))
            if ($rtext -match 'Async agent launched' -or $rtext -match 'working in the background') {
              [void]$ackedIds.Add($rid)
            }
          }
        }
      }
      # A background subagent is still running when its launch was acked but no
      # completion notification has arrived yet. Gating on Agent tool_use ids keeps
      # stray marker text in unrelated tool output from producing false positives.
      foreach ($id in $agentUseIds) {
        if ($ackedIds.Contains($id) -and -not $stopped.Contains($id)) { return $true }
      }
    } catch {}

    return $false
  }

  # Codex 세션 로그 파일을 최신순으로 훑어 마지막 assistant 메시지를 찾아 토스트 본문으로 요약한다.
  [string] GetCodexSessionSummary() {
    try {
      foreach ($session in @($this.GetCodexSessionFiles())) {
        if (-not $session -or -not (Test-Path -LiteralPath $session.FullName)) { continue }

        $fallback = ''
        $lines = @(Get-Content -LiteralPath $session.FullName -Encoding UTF8 -Tail 500)
        for ($i = $lines.Count - 1; $i -ge 0; $i--) {
          $line = [string]$lines[$i]
          if ([string]::IsNullOrWhiteSpace($line)) { continue }
          if ($line.IndexOf('"role"', [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -and
              $line.IndexOf('"assistant"', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }

          try { $entry = $line | ConvertFrom-Json } catch { continue }
          $payload = [JfUtil]::GetProperty($entry, 'payload', $null)
          if (-not $payload) { continue }
          if (([JfUtil]::GetProperty($payload, 'type', '')) -ne 'message') { continue }
          if (([JfUtil]::GetProperty($payload, 'role', '')) -ne 'assistant') { continue }

          $content = ''
          if ([JfUtil]::HasProperty($payload, 'content')) {
            $content = $this.GetContentText($payload.content)
          }

          $summary = $this.FormatToastSummary($content)
          if (-not $summary) { continue }

          if (([JfUtil]::GetProperty($payload, 'phase', '')) -eq 'final_answer') {
            return $summary
          }

          if (-not $fallback) {
            $fallback = $summary
          }
        }

        if ($fallback) { return $fallback }
      }
    } catch {}

    return ''
  }

  [string] GetAgentName([string]$eventName) {
    if ($eventName -eq 'codex') { return 'Codex' }
    return 'Claude Code'
  }

  # 이벤트 종류(stop/notify/codex)에 따라 에이전트 이름과 요약 소스를 골라 최종 토스트 제목·본문 문자열을 조립한다.
  [string] GetEventToastText([string]$eventName, $eventPayload, [string]$projectName) {
    switch ($eventName) {
      'notify' {
        $message = [JfUtil]::GetProperty($eventPayload, 'message', '')
        $summary = $this.FormatToastSummary([string]$message)
        if ($summary) { return $summary }
        return "$projectName waiting for input"
      }
      'codex' {
        $last = [JfUtil]::GetProperty($eventPayload, 'last-assistant-message', '')
        $summary = $this.FormatToastSummary([string]$last)
        if ($summary) { return $summary }
        $summary = $this.GetCodexSessionSummary()
        if ($summary) { return $summary }
        return "$projectName work finished"
      }
      default {
        $summary = $this.GetClaudeTranscriptSummary($eventPayload)
        if ($summary) { return $summary }
        return "$projectName work finished"
      }
    }
    return "$projectName work finished"
  }
}

# 책임: 토스트 클릭용 포커스 스크립트 생성과 jobfinish-focus:// 프로토콜 등록.
class JfFocusProtocol {
  [string]$ScriptRoot
  [string]$ProtocolName

  JfFocusProtocol([string]$scriptRoot, [string]$protocolName) {
    $this.ScriptRoot = $scriptRoot
    $this.ProtocolName = $protocolName
  }

  # 토스트 클릭 시 실행될 포커스 스크립트를 설치 폴더에 써 두고, 그 경로를 프로토콜 등록에서 재사용하도록 반환한다.
  [string] InstallFocusScript() {
    $scriptPath = Join-Path $this.ScriptRoot 'Focus-VSCode.ps1'
    $script = @'
param([string]$Uri = "")
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FocusVSCode {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public uint cbSize;
    public IntPtr hwnd;
    public uint dwFlags;
    public uint uCount;
    public uint dwTimeout;
  }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

  public static string GetTitle(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    int len = GetWindowTextW(hWnd, sb, sb.Capacity);
    return len > 0 ? sb.ToString() : "";
  }

  public static IntPtr FindCodeWindow(int[] pids, string titleHint, bool requireTitleHint) {
    if (pids == null || pids.Length == 0) return IntPtr.Zero;
    var wanted = new HashSet<int>(pids);
    string hint = (titleHint ?? "").ToLowerInvariant();
    IntPtr first = IntPtr.Zero;
    IntPtr best = IntPtr.Zero;

    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (!wanted.Contains((int)pid)) return true;

      string title = GetTitle(hWnd);
      if (String.IsNullOrWhiteSpace(title)) return true;
      if (first == IntPtr.Zero) first = hWnd;
      if (best == IntPtr.Zero && hint.Length > 0 && title.ToLowerInvariant().Contains(hint)) {
        best = hWnd;
      }
      return true;
    }, IntPtr.Zero);

    if (best != IntPtr.Zero) return best;
    return requireTitleHint && hint.Length > 0 ? IntPtr.Zero : first;
  }
}
"@

function Get-QueryValue([string]$uri, [string]$name) {
  if ($uri -match "(?:[?&])$([Regex]::Escape($name))=([^&]+)") {
    return [Uri]::UnescapeDataString($Matches[1].Replace('+', '%20'))
  }
  return ''
}

function Set-FlashStopSignal([string]$id) {
  if ([string]::IsNullOrWhiteSpace($id)) { return }
  $safeId = $id -replace '[^A-Za-z0-9_-]', ''
  if ([string]::IsNullOrWhiteSpace($safeId)) { return }
  $path = Join-Path ([IO.Path]::GetTempPath()) "job-finish-flash-stop-$safeId.signal"
  try { Set-Content -LiteralPath $path -Value ([DateTime]::UtcNow.ToString('o')) -Encoding UTF8 } catch {}
}

function Get-VSCodeWindow([string]$cwd) {
  $project = if ($cwd) { Split-Path -Leaf $cwd } else { '' }
  $pidValue = Get-QueryValue $Uri 'pid'
  if ($pidValue -match '^\d+$') {
    $p = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'Code') {
      $fromPid = [FocusVSCode]::FindCodeWindow(@([int]$p.Id), $project, $true)
      if ($fromPid -ne [IntPtr]::Zero) { return $fromPid }
    }
  }

  $code = @(Get-Process Code -ErrorAction SilentlyContinue)
  if ($code.Count -eq 0) { return [IntPtr]::Zero }

  $main = @($code | Where-Object { $_.MainWindowHandle -ne 0 })
  $mainMatch = $main | Where-Object { [string]$_.MainWindowTitle -and [string]$project -and $_.MainWindowTitle.IndexOf([string]$project, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
  if ($mainMatch) { return [IntPtr]$mainMatch.MainWindowHandle }

  $ids = @($code | ForEach-Object { [int]$_.Id })
  $titleMatch = [FocusVSCode]::FindCodeWindow($ids, $project, $true)
  if ($titleMatch -ne [IntPtr]::Zero) { return $titleMatch }

  if ($main.Count -eq 1) { return [IntPtr]$main[0].MainWindowHandle }
  return [IntPtr]::Zero
}

function Test-CodexDesktopProcessName([string]$processName) {
  return $processName -ieq 'Codex' -or $processName -ieq 'Orca'
}

function Get-CodexDesktopWindow {
  $pidValue = Get-QueryValue $Uri 'pid'
  if ($pidValue -match '^\d+$') {
    $p = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if ($p -and (Test-CodexDesktopProcessName ([string]$p.ProcessName))) {
      $fromPid = [FocusVSCode]::FindCodeWindow(@([int]$p.Id), '', $false)
      if ($fromPid -ne [IntPtr]::Zero) { return $fromPid }
    }
  }

  $desktop = @(Get-Process Codex,Orca -ErrorAction SilentlyContinue)
  if ($desktop.Count -eq 0) { return [IntPtr]::Zero }

  $main = @($desktop | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($main.Count -eq 1) { return [IntPtr]$main[0].MainWindowHandle }

  $ids = @($desktop | ForEach-Object { [int]$_.Id })
  return [FocusVSCode]::FindCodeWindow($ids, '', $false)
}

function Stop-Flashing([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero -or -not [FocusVSCode]::IsWindow($h)) { return }
  $fw = New-Object FocusVSCode+FLASHWINFO
  $fw.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'FocusVSCode+FLASHWINFO')
  $fw.hwnd = $h
  $fw.dwFlags = 0
  $fw.uCount = 0
  $fw.dwTimeout = 0
  [FocusVSCode]::FlashWindowEx([ref]$fw) | Out-Null
}

function Focus-Window([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero -or -not [FocusVSCode]::IsWindow($h)) { return }
  if ([FocusVSCode]::IsIconic($h)) { [FocusVSCode]::ShowWindowAsync($h, 9) | Out-Null }

  # Give this protocol-launched PowerShell recent input, then bring VS Code up.
  [FocusVSCode]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [FocusVSCode]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [FocusVSCode]::ShowWindowAsync($h, 5) | Out-Null
  [FocusVSCode]::BringWindowToTop($h) | Out-Null
  [FocusVSCode]::SetForegroundWindow($h) | Out-Null
  Stop-Flashing $h
}

$cwd = Get-QueryValue $Uri 'cwd'
$activationId = Get-QueryValue $Uri 'id'
Set-FlashStopSignal $activationId
$targetKind = Get-QueryValue $Uri 'target'
$hwndValue = Get-QueryValue $Uri 'hwnd'
$h = if ($hwndValue -match '^\d+$') { [IntPtr]([int64]$hwndValue) } else { [IntPtr]::Zero }
if ($h -eq [IntPtr]::Zero -or -not [FocusVSCode]::IsWindow($h)) {
  $h = if ($targetKind -eq 'codex-desktop') { Get-CodexDesktopWindow } else { Get-VSCodeWindow $cwd }
}
Focus-Window $h
'@
    try {
      $enc = New-Object System.Text.UTF8Encoding($true)
      [System.IO.File]::WriteAllText($scriptPath, $script, $enc)
    } catch {}
    return $scriptPath
  }

  # HKCU에 jobfinish-focus:// URL 프로토콜을 등록해, 토스트 클릭이 포커스 exe(없으면 스크립트)를 호출하도록 연결한다.
  [void] RegisterFocusProtocol() {
    try {
      $scriptPath = ''
      $focusExe = Join-Path $this.ScriptRoot 'jf-focus-vscode.exe'
      if (-not (Test-Path -LiteralPath $focusExe)) {
        $scriptPath = $this.InstallFocusScript()
      }
      $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $base = "HKCU:\Software\Classes\$($this.ProtocolName)"
      New-Item -Path $base -Force | Out-Null
      Set-ItemProperty -Path $base -Name '(Default)' -Value 'URL:Job-Finish Focus'
      Set-ItemProperty -Path $base -Name 'URL Protocol' -Value ''
      $cmdKey = Join-Path $base 'shell\open\command'
      New-Item -Path $cmdKey -Force | Out-Null
      if (Test-Path -LiteralPath $focusExe) {
        Set-ItemProperty -Path $cmdKey -Name '(Default)' -Value "`"$focusExe`" --uri `"%1`""
      } else {
        Set-ItemProperty -Path $cmdKey -Name '(Default)' -Value "`"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" `"%1`""
      }
    } catch {}
  }
}

# 책임: 알림 사운드 재생.
class JfSound {
  $Config

  JfSound($config) { $this.Config = $config }

  # chimes.wav가 있으면 그것을, 없으면 OS 기본 사운드를 재생해 알림음을 낸다.
  [void] Play() {
    if ($this.Config.Cfg.sound.enabled) {
      if ($this.Config.Modes -contains 'os') {
        $this.Config.Debug('sound enabled but toast mode present, skipping explicit flash sound to let toast sound play')
      } elseif ($this.Config.Modes -contains 'flash') {
        $this.Config.Debug('playing flash sound for taskbar flash only')
        $sp = 'C:\Windows\Media\chimes.wav'
        try {
          if (Test-Path -LiteralPath $sp) { (New-Object Media.SoundPlayer $sp).PlaySync() }
          else { [System.Media.SystemSounds]::Asterisk.Play() }
        } catch { try { [System.Media.SystemSounds]::Asterisk.Play() } catch {} }
      }
    }
  }
}

# ============================================ interop: flash ([JF] window flashing)
# Kept procedural: class-method bodies cannot reference the Add-Type [JF] type
# literal at parse time (compiled before Add-Type runs). Functions bind it at call
# time, exactly as the original did.
function Stop-FlashWindow([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero -or -not [JF]::IsWindow($hwnd)) { return $false }
  $fw = New-Object JF+FLASHWINFO
  $fw.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'JF+FLASHWINFO')
  $fw.hwnd = $hwnd
  $fw.dwFlags = 0
  $fw.uCount = 0
  $fw.dwTimeout = 0
  return [JF]::FlashWindowEx([ref]$fw)
}

function Get-FlashStopSignalPath([string]$id) {
  if ([string]::IsNullOrWhiteSpace($id)) { return '' }
  $safeId = $id -replace '[^A-Za-z0-9_-]', ''
  if ([string]::IsNullOrWhiteSpace($safeId)) { return '' }
  return Join-Path ([IO.Path]::GetTempPath()) "job-finish-flash-stop-$safeId.signal"
}

function Test-FlashStopSignal([string]$id) {
  $path = Get-FlashStopSignalPath $id
  return $path -and (Test-Path -LiteralPath $path)
}

function Remove-FlashStopSignal([string]$id) {
  $path = Get-FlashStopSignalPath $id
  if ($path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

function Watch-FlashWindow {
  $hwnd = if ($WatchFlashHwnd -gt 0) { [IntPtr]$WatchFlashHwnd } else { [IntPtr]::Zero }
  if ($hwnd -eq [IntPtr]::Zero -or -not [JF]::IsWindow($hwnd)) { return }

  $interval = $defaultFlashIntervalMs
  $started = [JF]::FlashWindow($hwnd, $true)
  $config.Debug("flash worker started hwnd=$($hwnd.ToInt64()) mode=manual timeoutSec=$WatchFlashTimeoutSec result=$started")

  $deadline = if ($WatchFlashTimeoutSec -gt 0) { (Get-Date).AddSeconds($WatchFlashTimeoutSec) } else { [DateTime]::MaxValue }
  while ((Get-Date) -lt $deadline) {
    if (-not [JF]::IsWindow($hwnd)) { break }
    if (Test-FlashStopSignal $WatchFlashId) {
      $config.Debug("flash worker stop signal received id=$WatchFlashId hwnd=$($hwnd.ToInt64())")
      break
    }
    if ([JF]::GetForegroundWindow() -eq $hwnd) { break }
    [JF]::FlashWindow($hwnd, $true) | Out-Null
    Start-Sleep -Milliseconds $interval
  }

  [JF]::FlashWindow($hwnd, $false) | Out-Null
  $stopped = Stop-FlashWindow $hwnd
  Remove-FlashStopSignal $WatchFlashId
  $config.Debug("flash worker stopped hwnd=$($hwnd.ToInt64()) result=$stopped foreground=$([JF]::GetForegroundWindow().ToInt64())")
}

# ======================================= interop: window locator ([JF] window lookup)
function Get-ProcessTree {
  $cur = $PID
  $ids = New-Object 'System.Collections.Generic.List[int]'
  for ($i = 0; $i -lt 12; $i++) {
    if (-not $ids.Contains([int]$cur)) { $ids.Add([int]$cur) }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $cur" -ErrorAction SilentlyContinue
    if (-not $proc -or -not $proc.ParentProcessId -or $proc.ParentProcessId -le 4) { break }
    $cur = [int]$proc.ParentProcessId
  }
  return $ids.ToArray()
}

function Test-CodexDesktopProcessName([string]$processName) {
  return $processName -ieq 'Codex' -or $processName -ieq 'Orca'
}

# Codex Desktop starts the agent below its desktop process. Resolve only a
# desktop ancestor so an unrelated open Codex/Orca window is never selected for
# a Codex CLI session running in VS Code or a standalone terminal.
function Get-CodexDesktopHostWindow {
  $tree = Get-ProcessTree
  foreach ($id in $tree) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p -or -not (Test-CodexDesktopProcessName ([string]$p.ProcessName))) { continue }

    $fromPid = [JF]::FindWindowForPids(@([int]$p.Id), '', $false)
    if ($fromPid -ne [IntPtr]::Zero) {
      $config.Debug("using Codex desktop ancestor hwnd=$($fromPid.ToInt64()) pid=$($p.Id) process=$($p.ProcessName)")
      return $fromPid
    }
  }

  return [IntPtr]::Zero
}

function Get-HostWindow {
  $tree = Get-ProcessTree
  $fromTree = if ($cwdIsReliable) { [JF]::FindWindowForPids($tree, [string]$project, $true) } else { [IntPtr]::Zero }
  if ($fromTree -ne [IntPtr]::Zero) { return $fromTree }

  foreach ($id in $tree) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    if ($p.ProcessName -eq 'Code') {
      $singleCodeWindow = [JF]::FindCodeWindow('', $true)
      if ($singleCodeWindow -ne [IntPtr]::Zero) { return $singleCodeWindow }
      continue
    }
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { return $p.MainWindowHandle }
  }

  $con = [JF]::GetConsoleWindow()
  if ($con -ne [IntPtr]::Zero) { return $con }
  return [IntPtr]::Zero
}

function Get-VSCodeWindow {
  if ($cwdIsReliable) {
    $fromTitle = [JF]::FindCodeWindow([string]$project, $true)
    if ($fromTitle -ne [IntPtr]::Zero) { return $fromTitle }
  } else {
    $singleCodeWindow = [JF]::FindCodeWindow('', $true)
    if ($singleCodeWindow -ne [IntPtr]::Zero) { return $singleCodeWindow }
    return [IntPtr]::Zero
  }

  if ($env:VSCODE_PID -match '^\d+$') {
    $p = Get-Process -Id ([int]$env:VSCODE_PID) -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'Code') {
      $fromPid = [JF]::FindWindowForPids(@([int]$p.Id), [string]$project, $true)
      if ($fromPid -ne [IntPtr]::Zero) { return $fromPid }

      $singleCodeWindow = [JF]::FindCodeWindow('', $true)
      if ($singleCodeWindow -ne [IntPtr]::Zero) {
        $fromPidFallback = [JF]::FindWindowForPids(@([int]$p.Id), '', $false)
        if ($fromPidFallback -eq $singleCodeWindow) {
          $config.Debug("using single VSCODE_PID fallback hwnd=$($fromPidFallback.ToInt64()) pid=$($p.Id)")
          return $fromPidFallback
        }

        if ($p.MainWindowHandle -eq $singleCodeWindow) {
          $config.Debug("using single VSCODE_PID MainWindowHandle hwnd=$($p.MainWindowHandle.ToInt64()) pid=$($p.Id)")
          return $p.MainWindowHandle
        }
      }
    }
  }

  $code = @(Get-Process Code -ErrorAction SilentlyContinue)
  if ($code.Count -eq 0) { return [IntPtr]::Zero }

  $ids = @($code | ForEach-Object { [int]$_.Id })
  $titleMatch = [JF]::FindWindowForPids($ids, [string]$project, $true)
  if ($titleMatch -ne [IntPtr]::Zero) { return $titleMatch }

  return [IntPtr]::Zero
}

function Get-WindowProcessName([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return '' }
  $pidValue = [uint32]0
  [JF]::GetWindowThreadProcessId($hwnd, [ref]$pidValue) | Out-Null
  if ($pidValue -le 0) { return '' }
  try {
    $p = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if ($p) { return [string]$p.ProcessName }
  } catch {}
  return ''
}

function Test-WindowLooksLikeProject([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  $title = [JF]::GetTitle($hwnd)
  if ([string]::IsNullOrWhiteSpace($title) -or [string]::IsNullOrWhiteSpace([string]$project)) { return $false }
  return $title.IndexOf([string]$project, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-WindowMatchesVSCodePid([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero -or -not ($env:VSCODE_PID -match '^\d+$')) { return $false }
  $pidValue = [uint32]0
  [JF]::GetWindowThreadProcessId($hwnd, [ref]$pidValue) | Out-Null
  return $pidValue -eq [uint32]([int]$env:VSCODE_PID)
}

function Test-WindowIsOnlyVSCodeWindow([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  $singleCodeWindow = [JF]::FindCodeWindow('', $true)
  return $singleCodeWindow -ne [IntPtr]::Zero -and $singleCodeWindow -eq $hwnd
}

function Test-WindowIsTrustedVSCodeTarget([IntPtr]$hwnd) {
  return (Test-WindowLooksLikeProject $hwnd) -or ((Test-WindowMatchesVSCodePid $hwnd) -and (Test-WindowIsOnlyVSCodeWindow $hwnd))
}

function Should-SuppressForFocusedTarget([IntPtr]$target) {
  if ($target -eq [IntPtr]::Zero) { return $false }
  $foreground = [JF]::GetForegroundWindow()
  if ($foreground -ne $target) { return $false }

  $processName = Get-WindowProcessName $target
  if (-not $cwdIsReliable) {
    $config.Debug("suppress check foreground=$($foreground.ToInt64()) process=$processName exactTarget=true cwdReliable=false")
    return $true
  }

  if ($processName -eq 'Code') {
    $trustedTarget = Test-WindowIsTrustedVSCodeTarget $target
    $config.Debug("suppress check foreground=$($foreground.ToInt64()) process=$processName trustedTarget=$trustedTarget")
    return $trustedTarget
  }

  $config.Debug("suppress check foreground=$($foreground.ToInt64()) process=$processName exactTarget=true")
  return $true
}

# ======================= interop: toast (WinRT toast / COM shortcut / WinForms balloon)
function Clear-Toast {
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [Windows.UI.Notifications.ToastNotificationManager]::History.RemoveGroup($toastGroup, $appId)
  } catch {}
}

function Get-ToastTag($hwnd) {
  if ($hwnd -and $hwnd -ne [IntPtr]::Zero) { return "jf-$($hwnd.ToInt64())" }
  return 'jf'
}

function Start-ToastFocusWatcher($hwnd, [string]$tag, [string]$titleHint) {
  if (-not $config.ClearToastOnFocus) {
    $config.Debug('toast focus watcher disabled by config')
    return
  }
  if (-not $tag -or -not $hwnd -or $hwnd -eq [IntPtr]::Zero) { return }

  try {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
    $argList = @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', "`"$scriptPath`"",
      '-WatchToast',
      '-ToastTag', "`"$tag`"",
      '-ToastAppId', "`"$appId`"",
      '-WatchHwnd', "$($hwnd.ToInt64())",
      '-WatchTitle', "`"$titleHint`"",
      '-WatchTimeoutSec', "$defaultToastWatchTimeoutSec"
    )
    Start-Process -FilePath $ps -ArgumentList $argList -WindowStyle Hidden | Out-Null
    $config.Debug("toast focus watcher started tag=$tag hwnd=$($hwnd.ToInt64()) title=$titleHint")
  } catch {
    $config.Debug("toast focus watcher start failed tag=$tag error=$($_.Exception.Message)")
  }
}

function Remove-ToastTag([string]$tag) {
  if (-not $tag) { return }
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $history = [Windows.UI.Notifications.ToastNotificationManager]::History
    try { $history.Remove($tag, $toastGroup, $appId) } catch {}
    try { $history.Remove($tag, $toastGroup) } catch {}
    try { $history.Remove($tag) } catch {}
    $config.Debug("toast removed tag=$tag")
  } catch {
    $config.Debug("toast remove failed tag=$tag error=$($_.Exception.Message)")
  }
}

function Watch-ToastFocus {
  if (-not $ToastTag) { return }
  try {
    if (-not ('JFToastFocusWatch' -as [type])) {
      Add-Type -ErrorAction Stop @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class JFToastFocusWatch {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

  public static string GetTitle(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    int len = GetWindowTextW(hWnd, sb, sb.Capacity);
    return len > 0 ? sb.ToString() : "";
  }
}
"@
    }

    $target = if ($WatchHwnd -gt 0) { [IntPtr]$WatchHwnd } else { [IntPtr]::Zero }
    $titleHint = ([string]$WatchTitle).ToLowerInvariant()
    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $WatchTimeoutSec))

    while ((Get-Date) -lt $deadline) {
      if ($target -ne [IntPtr]::Zero -and $titleHint.Length -eq 0 -and -not [JFToastFocusWatch]::IsWindow($target)) {
        $config.Debug("toast watch target closed hwnd=$WatchHwnd tag=$ToastTag")
        return
      }

      $fg = [JFToastFocusWatch]::GetForegroundWindow()
      $fgTitle = [JFToastFocusWatch]::GetTitle($fg)
      $matchesTitle = $titleHint.Length -gt 0 -and $fgTitle.ToLowerInvariant().Contains($titleHint)
      $matchesHwnd = $titleHint.Length -eq 0 -and $target -ne [IntPtr]::Zero -and $fg -eq $target

      if ($matchesTitle -or $matchesHwnd) {
        Remove-ToastTag $ToastTag
        return
      }

      Start-Sleep -Milliseconds 500
    }

    $config.Debug("toast watch timeout hwnd=$WatchHwnd tag=$ToastTag")
  } catch {
    $config.Debug("toast watch failed tag=$ToastTag error=$($_.Exception.Message)")
  }
}

function Ensure-ShortcutAppIdType {
  if ('JFShortcutAppId' -as [type]) { return }
  Add-Type -ErrorAction Stop @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct JFPropertyKey {
  public Guid fmtid;
  public uint pid;
  public JFPropertyKey(Guid fmtid, uint pid) {
    this.fmtid = fmtid;
    this.pid = pid;
  }
}

[StructLayout(LayoutKind.Sequential)]
public struct JFPropVariant {
  public ushort vt;
  public ushort wReserved1;
  public ushort wReserved2;
  public ushort wReserved3;
  public IntPtr p;
  public IntPtr p2;

  public static JFPropVariant FromString(string value) {
    var variant = new JFPropVariant();
    variant.vt = 31; // VT_LPWSTR
    variant.p = Marshal.StringToCoTaskMemUni(value);
    return variant;
  }
}

[ComImport]
[Guid("00021401-0000-0000-C000-000000000046")]
public class JFShellLink { }

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("0000010b-0000-0000-C000-000000000046")]
public interface JFIPersistFile {
  void GetClassID(out Guid pClassID);
  [PreserveSig] int IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
  void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
}

[ComImport]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
public interface JFIPropertyStore {
  void GetCount(out uint cProps);
  void GetAt(uint iProp, out JFPropertyKey pkey);
  void GetValue(ref JFPropertyKey key, out JFPropVariant pv);
  void SetValue(ref JFPropertyKey key, ref JFPropVariant pv);
  void Commit();
}

public static class JFShortcutAppId {
  [DllImport("ole32.dll")]
  private static extern int PropVariantClear(ref JFPropVariant pvar);

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  private static extern int SHGetPropertyStoreFromParsingName(
    string pszPath,
    IntPtr pbc,
    uint flags,
    ref Guid riid,
    out JFIPropertyStore propertyStore);

  public static void SetAppId(string shortcutPath, string appId) {
    JFIPropertyStore propertyStore = null;
    JFIPersistFile persistFile = null;
    object shellLink = null;
    try {
      shellLink = new JFShellLink();
      persistFile = (JFIPersistFile)shellLink;
      persistFile.Load(shortcutPath, 2);
      propertyStore = (JFIPropertyStore)shellLink;
    } catch {
      if (shellLink != null) {
        Marshal.FinalReleaseComObject(shellLink);
        shellLink = null;
      }

      Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
      int hr = SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, 0x00000002, ref iid, out propertyStore);
      if (hr != 0) {
        Marshal.ThrowExceptionForHR(hr);
      }
    }

    var key = new JFPropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    var value = JFPropVariant.FromString(appId);
    try {
      propertyStore.SetValue(ref key, ref value);
      propertyStore.Commit();
      if (persistFile != null) {
        persistFile.Save(shortcutPath, true);
      }
    } finally {
      PropVariantClear(ref value);
      if (propertyStore != null && !Object.ReferenceEquals(propertyStore, shellLink)) {
        Marshal.FinalReleaseComObject(propertyStore);
      }
      if (shellLink != null) {
        Marshal.FinalReleaseComObject(shellLink);
      }
    }
  }
}
"@
}

function Resolve-VSCodeIconPath {
  try {
    $running = @(Get-Process Code -ErrorAction SilentlyContinue)
    foreach ($p in $running) {
      try {
        $path = [string]$p.MainModule.FileName
        if ($path -and (Test-Path -LiteralPath $path) -and ([IO.Path]::GetFileName($path) -ieq 'Code.exe')) {
          return $path
        }
      } catch {}
    }
  } catch {}

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\Code.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }

  try {
    $cmd = Get-Command code.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return [string]$cmd.Source }
  } catch {}

  return ''
}

function Install-ToastShortcut([string]$shortcutAppId, [string]$displayName, [string]$fallbackLaunch) {
  try {
    $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    $shortcutDir = Join-Path $programs $toastShortcutFolderName
    New-Item -ItemType Directory -Force -Path $shortcutDir | Out-Null
    $shortcutPath = Join-Path $shortcutDir $toastShortcutFileName
    $focusExe = Join-Path $PSScriptRoot 'jf-focus-vscode.exe'
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $hasFocusExe = Test-Path -LiteralPath $focusExe
    $target = if ($hasFocusExe) { $focusExe } else { $ps }
    $shortcutArgs = ''
    if ($fallbackLaunch) {
      if ($hasFocusExe) {
        $shortcutArgs = "--uri `"$fallbackLaunch`""
      } else {
        $scriptPath = $focusProtocol.InstallFocusScript()
        $shortcutArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" `"$fallbackLaunch`""
      }
    }
    $iconPath = Resolve-VSCodeIconPath
    if (-not $iconPath) { $iconPath = $target }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $target
    $shortcut.Arguments = $shortcutArgs
    $shortcut.WorkingDirectory = Split-Path -Parent $target
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Save()
    Ensure-ShortcutAppIdType
    [JFShortcutAppId]::SetAppId($shortcutPath, $shortcutAppId)
    $config.Debug("toast shortcut installed: $shortcutPath -> $target args=$shortcutArgs appId=$shortcutAppId displayName=$displayName icon=$iconPath")
  } catch {
    $config.Debug("toast shortcut install failed: $($_.Exception.Message)")
  }
}

function New-FocusLaunchUri([string]$cwd, $hwnd, $targetPid, [bool]$allowOpenFallback, [string]$targetKind, [string]$focusActivationId) {
  $query = New-Object 'System.Collections.Generic.List[string]'
  $query.Add("cwd=$([Uri]::EscapeDataString([string]$cwd))")

  if ($focusActivationId) {
    $query.Add("id=$([Uri]::EscapeDataString([string]$focusActivationId))")
  }
  if ($hwnd -and $hwnd -ne [IntPtr]::Zero) {
    $query.Add("hwnd=$($hwnd.ToInt64())")
  }
  if ($targetPid -and [uint32]$targetPid -gt 0) {
    $query.Add("pid=$targetPid")
  }
  if ($project) {
    $query.Add("title=$([Uri]::EscapeDataString([string]$project))")
  }
  if ($targetKind) {
    $query.Add("target=$([Uri]::EscapeDataString([string]$targetKind))")
  }
  if ($allowOpenFallback) {
    $query.Add('open=1')
    $query.Add('newWindow=1')
    $query.Add('waitMs=6000')
  }
  if ($config.Cfg.debug) {
    $query.Add('debug=1')
  }

  return "${protocolName}://open?$($query -join '&')"
}

function Show-Toast($title, $text, $cwd, $hwnd, $targetPid, [bool]$allowOpenFallback, [string]$targetKind, [string]$focusActivationId) {
  try {
    $config.Debug('toast enter')
    $launch = New-FocusLaunchUri $cwd $hwnd $targetPid $allowOpenFallback $targetKind $focusActivationId
    $focusProtocol.RegisterFocusProtocol()
    $config.Debug('toast after protocol')
    Install-ToastShortcut $appId $appDisplayName $launch
    $config.Debug('toast after shortcut')
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $config.Debug('toast manager type loaded')
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $config.Debug('toast xml type loaded')
    $eLaunch = [Security.SecurityElement]::Escape($launch)
    $eTitle = [Security.SecurityElement]::Escape([string]$title)
    $eText  = [Security.SecurityElement]::Escape([string]$text)
    $xmlText = @"
<toast launch="$eLaunch" activationType="protocol">
  <visual>
    <binding template="ToastGeneric">
      <text>$eTitle</text>
      <text>$eText</text>
    </binding>
  </visual>
</toast>
"@
    $config.Debug('toast xml created')
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    $config.Debug('toast xml loaded')
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $config.Debug('toast object created')
    $toast.Tag = Get-ToastTag $hwnd
    $toast.Group = $toastGroup
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    $config.Debug("toast shown: appId=$appId launch=$launch")
    return $true
  } catch {
    $config.Debug("toast failed: $($_.Exception.Message)")
    if (-not $script:toastRetryInProgress) {
      try {
        $script:toastRetryInProgress = $true
        Start-Sleep -Milliseconds $toastRetryDelayMs
        $config.Debug('toast retrying once after failure')
        return Show-Toast $title $text $cwd $hwnd $targetPid $allowOpenFallback $targetKind $focusActivationId
      } finally {
        $script:toastRetryInProgress = $false
      }
    }
    return $false
  }
}

function Show-Balloon($title, $text, [string]$launch) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $state = @{ clicked = $false }
    $activate = {
      try {
        if ($launch) { Start-Process $launch | Out-Null }
      } catch {}
      $state.clicked = $true
    }

    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Information
    $ni.Visible = $true
    $ni.BalloonTipTitle = $title
    $ni.BalloonTipText = $text
    $ni.add_BalloonTipClicked($activate)
    $ni.add_Click($activate)
    $ni.ShowBalloonTip(5000)

    $deadline = (Get-Date).AddSeconds($balloonFallbackWaitSec)
    while (-not $state.clicked -and (Get-Date) -lt $deadline) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 100
    }

    $ni.Dispose()
  } catch {
    $config.Debug("balloon fallback failed: $($_.Exception.Message)")
  }
}

# ================================================================= main
$config = [JfConfig]::new($PSScriptRoot)
$summary = [JfSummary]::new($maxToastTextLength)
$dedup = [JfDedup]::new($appId)
$focusProtocol = [JfFocusProtocol]::new($PSScriptRoot, $protocolName)

# ---------------------------------------------------------------- prime (install)
# Run once at install time (`-Prime`) to create the Start Menu shortcut and register
# the focus protocol ahead of any notification. Windows silently drops the very first
# toast whose AppUserModelID it hasn't registered yet; lazily creating the shortcut on
# the first real toast is exactly what triggers that drop. Priming here makes the
# shortcut already exist by the time the first notification fires, so it shows.
if ($Prime) {
  $focusProtocol.RegisterFocusProtocol()
  [void](Install-ToastShortcut $appId $appDisplayName '')
  $config.Debug('prime complete: focus protocol registered and toast shortcut installed')
  exit 0
}

# ---------------------------------------------------------------- flash worker
if ($WatchFlash) {
  Watch-FlashWindow
  exit 0
}

$effectiveEvent = [JfSummary]::GetEffectiveEvent($Event)

# ------------------------------------------------------- read event payload
$payload = $null
if ($effectiveEvent -eq 'codex') {
  if ($extraArgs.Count -gt 0) { try { $payload = $extraArgs[-1] | ConvertFrom-Json } catch {} }
}
elseif (-not $Test -and [Console]::IsInputRedirected) {
  try { $stdin = [Console]::In.ReadToEnd(); if ($stdin) { $payload = $stdin | ConvertFrom-Json } } catch {}
}

# ------------------------------------------------------- compose title/text
$agentName = $summary.GetAgentName($effectiveEvent)
$payloadCwd = if (([JfUtil]::HasProperty($payload, 'cwd')) -and $payload.cwd) { [string]$payload.cwd } else { '' }
$hasPayloadCwd = $summary.TestUsableProjectCwd($payloadCwd)
$sessionCwd = if ($hasPayloadCwd) { '' } elseif ($effectiveEvent -eq 'codex') { $summary.GetCodexSessionCwd() } else { '' }
$hasSessionCwd = -not [string]::IsNullOrWhiteSpace($sessionCwd)
$processCwd = (Get-Location).Path
$hasProcessCwd = $summary.TestUsableProjectCwd($processCwd)
$focusCwd = if ($hasPayloadCwd) { $payloadCwd } elseif ($hasSessionCwd) { [string]$sessionCwd } elseif ($hasProcessCwd) { $processCwd } else { '' }
$cwdIsReliable = [bool]$hasPayloadCwd -or $hasSessionCwd -or $hasProcessCwd
$project = if ($focusCwd) { Split-Path -Leaf $focusCwd } else { 'workspace' }
$activationId = [Guid]::NewGuid().ToString('N')
$title = $agentName
# Stop 이벤트는 정상 완료 외에 토큰/세션 한도 소진·API 오류로 인한 비정상 종료도 포함한다.
# 그런 경우 제목을 달리해 한눈에 구분되도록 하고, 본문에는 한도 리셋 시각/오류 내용을 그대로 싣는다.
if ($effectiveEvent -eq 'stop') {
  $stopInfo = $summary.GetClaudeStopInfo($payload)
  switch ($stopInfo.Kind) {
    'usage-limit' { $title = "$agentName · Usage limit reached" }
    'api-error'   { $title = "$agentName · API error" }
    'error'       { $title = "$agentName · Stopped" }
  }
  $stopBody = if ($stopInfo.Text) { $stopInfo.Text } else { "$project work finished" }
  $text = $summary.LimitText($stopBody)
  if ($stopInfo.Kind -ne 'normal') { $config.Debug("abnormal stop detected kind=$($stopInfo.Kind)") }
} else {
  $text = $summary.LimitText($summary.GetEventToastText($effectiveEvent, $payload, $project))
}

$config.Debug("notifier start event=$effectiveEvent rawEvent=$Event modes=$($config.Modes -join ',') flashTimeout=$($config.Cfg.flashTimeout) sound=$($config.Cfg.sound.enabled) suppressWhenFocused=$($config.Cfg.suppressWhenFocused) project=$project cwdReliable=$cwdIsReliable sessionCwd=$hasSessionCwd")

# A background subagent (Task) makes the main agent yield, firing Stop before the
# real work is done. Skip that spurious 'finished' notification; the genuine Stop
# fires again once the subagent completes and its tool_result lands.
if (-not $Test -and $effectiveEvent -eq 'stop' -and $summary.HasPendingSubagentTask($payload)) {
  $config.Debug('suppressing stop notification: a background subagent Task is still running')
  exit 0
}

# ------------------------------------------------------- source window lookup
$hostHwnd = Get-HostWindow
$codexDesktopHwnd = if ($effectiveEvent -eq 'codex') { Get-CodexDesktopHostWindow } else { [IntPtr]::Zero }
$vscodeHwnd = Get-VSCodeWindow
if ($cwdIsReliable -and $vscodeHwnd -ne [IntPtr]::Zero -and (Get-WindowProcessName $vscodeHwnd) -eq 'Code' -and -not (Test-WindowIsTrustedVSCodeTarget $vscodeHwnd)) {
  $config.Debug("discarding vscode target hwnd=$($vscodeHwnd.ToInt64()) because title does not match project=$project")
  $vscodeHwnd = [IntPtr]::Zero
}
# $hostHwnd는 이 notifier의 상위 프로세스 트리에서 찾은 창 — 즉 에이전트가 실제로 돌고 있는
# VS Code 창이다. 제목이 $project(=cwd 말단 폴더명)와 안 맞더라도(에이전트가 이미 열린
# 워크스페이스의 하위 폴더에서 작업한 경우, 창 제목엔 워크스페이스 루트만 뜬다) 이 창이
# 올바른 대상이므로 버리지 않는다. 예전엔 제목 불일치를 '다른 프로젝트'로 오판해 이 창을
# 버렸고, 그 탓에 클릭 시 기존 창을 포커스하지 못하고 하위 폴더를 루트로 새 VS Code 창을
# 여는 버그가 있었다(#6).
$hasCodexDesktopTarget = $codexDesktopHwnd -ne [IntPtr]::Zero
$hasVSCodeTarget = -not $hasCodexDesktopTarget -and $vscodeHwnd -ne [IntPtr]::Zero
$focusTarget = if ($hasCodexDesktopTarget) { $codexDesktopHwnd } elseif ($vscodeHwnd -ne [IntPtr]::Zero) { $vscodeHwnd } else { $hostHwnd }
$focusTargetPid = [uint32]0
if ($focusTarget -ne [IntPtr]::Zero) {
  [JF]::GetWindowThreadProcessId($focusTarget, [ref]$focusTargetPid) | Out-Null
}
$toastTarget = if ($hasCodexDesktopTarget) {
  $codexDesktopHwnd
} elseif ($hasVSCodeTarget) {
  $vscodeHwnd
} elseif ($hostHwnd -ne [IntPtr]::Zero -and (Get-WindowProcessName $hostHwnd) -eq 'Code') {
  # 에이전트가 돌던 VS Code 창(host)을 토스트 대상 hwnd로 넘긴다. cwd가 신뢰 가능하든
  # 아니든, 이 hwnd가 있으면 클릭 시 새 창을 여는 대신 그 창을 포커스한다(#6).
  $hostHwnd
} else {
  [IntPtr]::Zero
}
$toastTargetPid = [uint32]0
if ($toastTarget -ne [IntPtr]::Zero) {
  [JF]::GetWindowThreadProcessId($toastTarget, [ref]$toastTargetPid) | Out-Null
}
$targetKind = if ($hasCodexDesktopTarget) { 'codex-desktop' } else { 'vscode' }
$allowOpenFallback = $cwdIsReliable -and -not $hasCodexDesktopTarget

$config.Debug("window target host=$($hostHwnd.ToInt64()) codexDesktop=$($codexDesktopHwnd.ToInt64()) vscode=$($vscodeHwnd.ToInt64()) kind=$targetKind focus=$($focusTarget.ToInt64()) focusPid=$focusTargetPid toast=$($toastTarget.ToInt64()) toastPid=$toastTargetPid")

if (-not $Test -and $effectiveEvent -eq 'codex' -and -not $cwdIsReliable -and $dedup.TestRecent($recentNotificationWindowSec)) {
  $config.Debug('suppressing unreliable Codex notification because a recent VS Code toast was already shown')
  exit 0
}

if (-not $Test -and $config.Cfg.suppressWhenFocused -and $focusTarget -ne [IntPtr]::Zero) {
  if (Should-SuppressForFocusedTarget $focusTarget) { exit 0 }
}

# ---------------------------------------------------------------- toast worker
if ($WatchToast) {
  Watch-ToastFocus
  exit 0
}

# ------------------------------------------------------------------- notify
if ($config.Modes -contains 'os') {
  $config.Debug('showing toast notification')
  $toastShown = Show-Toast $title $text $focusCwd $toastTarget $toastTargetPid $allowOpenFallback $targetKind $activationId
  if (-not $toastShown) {
    $fallbackLaunch = New-FocusLaunchUri $focusCwd $toastTarget $toastTargetPid $allowOpenFallback $targetKind $activationId
    Show-Balloon $title $text $fallbackLaunch
  } else {
    $toastWatchTitle = if ($hasCodexDesktopTarget) { '' } else { [string]$project }
    Start-ToastFocusWatcher $toastTarget (Get-ToastTag $toastTarget) $toastWatchTitle
  }
}

# ------------------------------------------------------------------- flash
if (($config.Modes -contains 'flash') -and $focusTarget -ne [IntPtr]::Zero) {
  $interval = $defaultFlashIntervalMs
  $count = if ($config.TimeoutSec -gt 0) { [int]($config.TimeoutSec * 1000 / $interval) } else { 0 }
  $foreground = [JF]::GetForegroundWindow()
  $foregroundPid = [uint32]0
  if ($foreground -ne [IntPtr]::Zero) {
    [JF]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) | Out-Null
  }
  $workerStarted = $false

  try {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
    $argList = @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', "`"$scriptPath`"",
      '-WatchFlash',
      '-WatchFlashHwnd', "$($focusTarget.ToInt64())",
      '-WatchFlashId', "$activationId",
      '-WatchFlashTimeoutSec', "$($config.TimeoutSec)"
    )
    Start-Process -FilePath $ps -ArgumentList $argList -WindowStyle Hidden | Out-Null
    $workerStarted = $true
    $config.Debug("flash worker requested hwnd=$($focusTarget.ToInt64()) pid=$focusTargetPid foreground=$($foreground.ToInt64()) foregroundPid=$foregroundPid timeoutSec=$($config.TimeoutSec)")
  } catch {
    $config.Debug("flash worker start failed hwnd=$($focusTarget.ToInt64()) error=$($_.Exception.Message)")
  }

  if (-not $workerStarted) {
    $fw = New-Object JF+FLASHWINFO
    $fw.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'JF+FLASHWINFO')
    $fw.hwnd = $focusTarget
    $fw.dwFlags = 15
    $fw.uCount = $count
    $fw.dwTimeout = $interval
    $flashResult = [JF]::FlashWindowEx([ref]$fw)
    $config.Debug("flash requested hwnd=$($focusTarget.ToInt64()) pid=$focusTargetPid flags=$($fw.dwFlags) count=$count timeoutMs=$interval result=$flashResult foreground=$($foreground.ToInt64()) foregroundPid=$foregroundPid")
  }
}

# ------------------------------------------------------------------- sound
$sound = [JfSound]::new($config)
$sound.Play()

$config.Debug('notifier exit')
$dedup.SaveRecent($effectiveEvent, $project)
exit 0
