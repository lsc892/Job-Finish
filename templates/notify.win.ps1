# job-finish-notify (Windows) - focus-aware completion notifier for Claude Code / Codex.
# Invoked by a hook. Reads choices from job-finish.config.json next to this script.
#   -Event stop|notify|codex   which agent event fired
#   -Test                      bypass focus suppression (used by `doctor`)
# Claude passes a JSON payload on stdin; Codex appends its JSON as the final arg.
param(
  [string]$Event = "stop",
  [switch]$Test,
  [switch]$WatchToast,
  [string]$ToastTag = "",
  [string]$ToastAppId = "",
  [Int64]$WatchHwnd = 0,
  [string]$WatchTitle = "",
  [int]$WatchTimeoutSec = 600
)
$ErrorActionPreference = 'SilentlyContinue'
$extraArgs = $args

# Toast identity. Windows desktop toasts are most reliable with a Start Menu
# shortcut whose AppUserModelID matches this value.
$appId = if ($ToastAppId) { $ToastAppId } else { 'JobFinish.VisualStudioCode' }
$appDisplayName = 'Visual Studio Code'
$toastGroup = 'job-finish'
$protocolName = 'jobfinish-focus'

# ---------------------------------------------------------------- load config
$cfgPath = Join-Path $PSScriptRoot 'job-finish.config.json'
$cfg = $null
if (Test-Path -LiteralPath $cfgPath) {
  try { $cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $cfgPath | ConvertFrom-Json } catch {}
}
if ($null -eq $cfg) {
  $cfg = [pscustomobject]@{
    modes = @('os', 'flash'); flashTimeout = '5m';
    sound = [pscustomobject]@{ enabled = $true };
    suppressWhenFocused = $true; clearToastOnFocus = $true; debug = $false; watchApp = ''
  }
}
$modes = @($cfg.modes)
$clearToastOnFocus = if ($cfg.PSObject.Properties.Name -contains 'clearToastOnFocus') { [bool]$cfg.clearToastOnFocus } else { $true }

function Log-IfDebug([string]$message) {
  if (-not $cfg.debug) { return }
  try {
    $logPath = Join-Path $PSScriptRoot 'job-finish.log'
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
    Add-Content -LiteralPath $logPath -Value "[$ts] $message"
  } catch {}
}

switch ($cfg.flashTimeout) {
  '30s'      { $timeoutSec = 30 }
  '5m'       { $timeoutSec = 300 }
  '10m'      { $timeoutSec = 600 }
  'infinite' { $timeoutSec = 0 }
  default    { $timeoutSec = 300 }
}

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

# ------------------------------------------------------- read event payload
$payload = $null
if ($Event -eq 'codex') {
  if ($extraArgs.Count -gt 0) { try { $payload = $extraArgs[-1] | ConvertFrom-Json } catch {} }
}
elseif (-not $Test -and [Console]::IsInputRedirected) {
  try { $stdin = [Console]::In.ReadToEnd(); if ($stdin) { $payload = $stdin | ConvertFrom-Json } } catch {}
}

# ------------------------------------------------------- compose title/text
$agentName = if ($Event -eq 'codex') { 'Codex' } else { 'Claude Code' }
$hasPayloadCwd = $payload -and ($payload.PSObject.Properties.Name -contains 'cwd') -and $payload.cwd
$focusCwd = if ($hasPayloadCwd) { [string]$payload.cwd } else { (Get-Location).Path }
$cwdIsReliable = [bool]$hasPayloadCwd -or $Event -ne 'codex'
$project = Split-Path -Leaf $focusCwd
switch ($Event) {
  'notify' {
    $title = $agentName
    $text  = if ($payload -and $payload.message) { [string]$payload.message } else { "$project - Waiting for input" }
  }
  'codex' {
    $title = $agentName
    $last  = if ($payload) { [string]$payload.'last-assistant-message' } else { '' }
    $text  = if ($last) { $last } else { "$project - Work finished" }
  }
  default {
    $title = $agentName
    $text  = "$project - Work finished"
  }
}
if ($text.Length -gt 180) { $text = $text.Substring(0, 177) + '...' }

Log-IfDebug "notifier start event=$Event modes=$($modes -join ',') flashTimeout=$($cfg.flashTimeout) sound=$($cfg.sound.enabled) suppressWhenFocused=$($cfg.suppressWhenFocused) project=$project cwdReliable=$cwdIsReliable"

# ------------------------------------------------------- source window lookup
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

$hostHwnd = Get-HostWindow
$vscodeHwnd = Get-VSCodeWindow
if ($cwdIsReliable -and $vscodeHwnd -ne [IntPtr]::Zero -and (Get-WindowProcessName $vscodeHwnd) -eq 'Code' -and -not (Test-WindowLooksLikeProject $vscodeHwnd)) {
  Log-IfDebug "discarding vscode target hwnd=$($vscodeHwnd.ToInt64()) because title does not match project=$project"
  $vscodeHwnd = [IntPtr]::Zero
}
if ($cwdIsReliable -and $vscodeHwnd -eq [IntPtr]::Zero -and $hostHwnd -ne [IntPtr]::Zero -and (Get-WindowProcessName $hostHwnd) -eq 'Code' -and -not (Test-WindowLooksLikeProject $hostHwnd)) {
  Log-IfDebug "discarding host fallback hwnd=$($hostHwnd.ToInt64()) because it is a different VS Code project"
  $hostHwnd = [IntPtr]::Zero
}
$hasVSCodeTarget = $vscodeHwnd -ne [IntPtr]::Zero
$focusTarget = if ($vscodeHwnd -ne [IntPtr]::Zero) { $vscodeHwnd } else { $hostHwnd }
$focusTargetPid = [uint32]0
if ($focusTarget -ne [IntPtr]::Zero) {
  [JF]::GetWindowThreadProcessId($focusTarget, [ref]$focusTargetPid) | Out-Null
}
$toastTarget = if ($hasVSCodeTarget) {
  $vscodeHwnd
} elseif (-not $cwdIsReliable -and $hostHwnd -ne [IntPtr]::Zero -and (Get-WindowProcessName $hostHwnd) -eq 'Code') {
  $hostHwnd
} else {
  [IntPtr]::Zero
}
$toastTargetPid = [uint32]0
if ($toastTarget -ne [IntPtr]::Zero) {
  [JF]::GetWindowThreadProcessId($toastTarget, [ref]$toastTargetPid) | Out-Null
}

Log-IfDebug "window target host=$($hostHwnd.ToInt64()) vscode=$($vscodeHwnd.ToInt64()) focus=$($focusTarget.ToInt64()) focusPid=$focusTargetPid toast=$($toastTarget.ToInt64()) toastPid=$toastTargetPid"

function Should-SuppressForFocusedTarget([IntPtr]$target) {
  if ($target -eq [IntPtr]::Zero) { return $false }
  $foreground = [JF]::GetForegroundWindow()
  if ($foreground -ne $target) { return $false }

  $processName = Get-WindowProcessName $target
  if (-not $cwdIsReliable) {
    Log-IfDebug "suppress check foreground=$($foreground.ToInt64()) process=$processName exactTarget=true cwdReliable=false"
    return $true
  }

  if ($processName -eq 'Code') {
    $matchesProject = Test-WindowLooksLikeProject $target
    Log-IfDebug "suppress check foreground=$($foreground.ToInt64()) process=$processName titleMatchesProject=$matchesProject"
    return $matchesProject
  }

  Log-IfDebug "suppress check foreground=$($foreground.ToInt64()) process=$processName exactTarget=true"
  return $true
}

if (-not $Test -and $cfg.suppressWhenFocused -and $focusTarget -ne [IntPtr]::Zero) {
  if (Should-SuppressForFocusedTarget $focusTarget) { exit 0 }
}

# ---------------------------------------------------------------- focus protocol
function Install-FocusScript {
  $scriptPath = Join-Path $PSScriptRoot 'Focus-VSCode.ps1'
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
$hwndValue = Get-QueryValue $Uri 'hwnd'
$h = if ($hwndValue -match '^\d+$') { [IntPtr]([int64]$hwndValue) } else { [IntPtr]::Zero }
if ($h -eq [IntPtr]::Zero -or -not [FocusVSCode]::IsWindow($h)) {
  $h = Get-VSCodeWindow $cwd
}
Focus-Window $h
'@
  try {
    $enc = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($scriptPath, $script, $enc)
  } catch {}
  return $scriptPath
}

function Register-FocusProtocol {
  try {
    $focusExe = Join-Path $PSScriptRoot 'jf-focus-vscode.exe'
    if (-not (Test-Path -LiteralPath $focusExe)) {
      $scriptPath = Install-FocusScript
    }
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $base = "HKCU:\Software\Classes\$protocolName"
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

# ------------------------------------------------------------------- notify
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
  if (-not $clearToastOnFocus) {
    Log-IfDebug 'toast focus watcher disabled by config'
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
      '-WatchTimeoutSec', '600'
    )
    Start-Process -FilePath $ps -ArgumentList $argList -WindowStyle Hidden | Out-Null
    Log-IfDebug "toast focus watcher started tag=$tag hwnd=$($hwnd.ToInt64()) title=$titleHint"
  } catch {
    Log-IfDebug "toast focus watcher start failed tag=$tag error=$($_.Exception.Message)"
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
    Log-IfDebug "toast removed tag=$tag"
  } catch {
    Log-IfDebug "toast remove failed tag=$tag error=$($_.Exception.Message)"
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
        Log-IfDebug "toast watch target closed hwnd=$WatchHwnd tag=$ToastTag"
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

    Log-IfDebug "toast watch timeout hwnd=$WatchHwnd tag=$ToastTag"
  } catch {
    Log-IfDebug "toast watch failed tag=$ToastTag error=$($_.Exception.Message)"
  }
}

if ($WatchToast) {
  Watch-ToastFocus
  exit 0
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

function Install-ToastShortcut([string]$shortcutAppId, [string]$displayName) {
  try {
    $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    $shortcutDir = Join-Path $programs 'Job-Finish'
    New-Item -ItemType Directory -Force -Path $shortcutDir | Out-Null
    $shortcutPath = Join-Path $shortcutDir 'Visual Studio Code.lnk'
    $focusExe = Join-Path $PSScriptRoot 'jf-focus-vscode.exe'
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $target = if (Test-Path -LiteralPath $focusExe) { $focusExe } else { $ps }
    $iconPath = Resolve-VSCodeIconPath
    if (-not $iconPath) { $iconPath = $target }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $target
    $shortcut.Arguments = ''
    $shortcut.WorkingDirectory = Split-Path -Parent $target
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Save()
    Ensure-ShortcutAppIdType
    [JFShortcutAppId]::SetAppId($shortcutPath, $shortcutAppId)
    Log-IfDebug "toast shortcut installed: $shortcutPath -> $target appId=$shortcutAppId displayName=$displayName icon=$iconPath"
  } catch {
    Log-IfDebug "toast shortcut install failed: $($_.Exception.Message)"
  }
}

function Show-Toast($title, $text, $cwd, $hwnd, $targetPid, [bool]$allowOpenFallback) {
  try {
    Log-IfDebug 'toast enter'
    Register-FocusProtocol
    Log-IfDebug 'toast after protocol'
    Install-ToastShortcut $appId $appDisplayName
    Log-IfDebug 'toast after shortcut'
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    Log-IfDebug 'toast manager type loaded'
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    Log-IfDebug 'toast xml type loaded'
    $encodedCwd = [Uri]::EscapeDataString([string]$cwd)
    $query = New-Object 'System.Collections.Generic.List[string]'
    $query.Add("cwd=$encodedCwd")
    if ($hwnd -and $hwnd -ne [IntPtr]::Zero) { $query.Add("hwnd=$($hwnd.ToInt64())") }
    if ($targetPid -and [uint32]$targetPid -gt 0) { $query.Add("pid=$targetPid") }
    if ($project) { $query.Add("title=$([Uri]::EscapeDataString([string]$project))") }
    if ($allowOpenFallback) {
      $query.Add('open=1')
      $query.Add('newWindow=1')
      $query.Add('waitMs=6000')
    }
    if ($cfg.debug) { $query.Add('debug=1') }
    $launch = "${protocolName}://open?$($query -join '&')"
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
    Log-IfDebug 'toast xml created'
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    Log-IfDebug 'toast xml loaded'
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    Log-IfDebug 'toast object created'
    $toast.Tag = Get-ToastTag $hwnd
    $toast.Group = $toastGroup
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    Log-IfDebug "toast shown: appId=$appId launch=$launch"
    return $true
  } catch {
    Log-IfDebug "toast failed: $($_.Exception.Message)"
    return $false
  }
}

function Show-Balloon($title, $text) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Information
    $ni.Visible = $true
    $ni.BalloonTipTitle = $title
    $ni.BalloonTipText = $text
    $ni.ShowBalloonTip(5000)
    Start-Sleep -Milliseconds 200
    $ni.Dispose()
  } catch {}
}

if ($modes -contains 'os') {
  Log-IfDebug 'showing toast notification'
  $toastShown = Show-Toast $title $text $focusCwd $toastTarget $toastTargetPid $cwdIsReliable
  if (-not $toastShown) {
    Show-Balloon $title $text
  } else {
    Start-ToastFocusWatcher $toastTarget (Get-ToastTag $toastTarget) $project
  }
}

# ------------------------------------------------------------------- flash
if (($modes -contains 'flash') -and $focusTarget -ne [IntPtr]::Zero) {
  $interval = 500
  $count = if ($timeoutSec -gt 0) { [int]($timeoutSec * 1000 / $interval) } else { 0 }
  $fw = New-Object JF+FLASHWINFO
  $fw.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'JF+FLASHWINFO')
  $fw.hwnd = $focusTarget
  $fw.dwFlags = 15
  $fw.uCount = $count
  $fw.dwTimeout = $interval
  [JF]::FlashWindowEx([ref]$fw) | Out-Null
}

# ------------------------------------------------------------------- sound
if ($cfg.sound.enabled) {
  if ($modes -contains 'os') {
    Log-IfDebug 'sound enabled but toast mode present, skipping explicit flash sound to let toast sound play'
  } elseif ($modes -contains 'flash') {
    Log-IfDebug 'playing flash sound for taskbar flash only'
    $sp = 'C:\Windows\Media\chimes.wav'
    try {
      if (Test-Path -LiteralPath $sp) { (New-Object Media.SoundPlayer $sp).PlaySync() }
      else { [System.Media.SystemSounds]::Asterisk.Play() }
    } catch { try { [System.Media.SystemSounds]::Asterisk.Play() } catch {} }
  }
}

Log-IfDebug 'notifier exit'
exit 0
