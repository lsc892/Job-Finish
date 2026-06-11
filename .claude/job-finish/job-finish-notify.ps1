# job-finish-notify (Windows) — focus-aware completion notifier for Claude Code / Codex.
# Invoked by a hook. Reads choices from job-finish.config.json next to this script.
#   -Event stop|notify|codex   which agent event fired
#   -Test                      bypass focus suppression (used by `doctor`)
#   -Watch -Hwnd <n>           internal: watch focus and clear the toast on return
#   -Activate <uri>            internal: protocol handler — focus the host window
# Claude passes a JSON payload on stdin; Codex appends its JSON as the final arg.
param(
  [string]$Event = "stop",
  [switch]$Test,
  [switch]$Watch,
  [long]$Hwnd = 0,
  [string]$Activate = ""
)
$ErrorActionPreference = 'SilentlyContinue'
$extraArgs = $args

# Toast identity. The AppID must match a registered Start-menu shortcut so the
# OS will surface the toast; the group lets us clear all our toasts at once.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$toastGroup = 'job-finish'

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
    suppressWhenFocused = $true; watchApp = ''
  }
}
$modes = @($cfg.modes)

# Map the flash timeout label to seconds (0 = infinite). Shared by flash + watcher.
switch ($cfg.flashTimeout) {
  '30s'      { $timeoutSec = 30 }
  '5m'       { $timeoutSec = 300 }
  '10m'      { $timeoutSec = 600 }
  'infinite' { $timeoutSec = 0 }
  default    { $timeoutSec = 300 }
}

# ----------------------------------------------- native interop (focus/flash)
Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Runtime.InteropServices;
public static class JF {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
}
"@

function Clear-Toast {
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [Windows.UI.Notifications.ToastNotificationManager]::History.RemoveGroup($toastGroup, $appId)
  } catch {}
}

# Count of our toasts still sitting in the Action Center.
function Get-ToastCount {
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    return @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($appId) |
      Where-Object { $_.Group -eq $toastGroup }).Count
  } catch { return 0 }
}

# =====================================================================
# Mode: -Activate  (protocol handler fired when the user clicks a toast)
# The toast's launch URI is "jobfinish:focus?h=<hwnd>"; bring that window up.
# =====================================================================
if ($Activate) {
  if ($Activate -match 'h=(\d+)') {
    $h = [IntPtr][long]$Matches[1]
    if ([JF]::IsWindow($h)) {
      [JF]::ShowWindowAsync($h, 9) | Out-Null   # SW_RESTORE — un-minimize
      [JF]::SetForegroundWindow($h) | Out-Null
    }
  }
  Clear-Toast
  exit 0
}

# =====================================================================
# Mode: -Watch  (detached background watcher spawned by the main run)
# Mirrors the flash behavior: when the host window regains focus, clear the
# toast. Also exits if the host process dies or the (finite) timeout elapses.
# =====================================================================
if ($Watch) {
  $target = [IntPtr]$Hwnd
  if (-not [JF]::IsWindow($target)) { exit 0 }
  $hostPid = 0
  [JF]::GetWindowThreadProcessId($target, [ref]$hostPid) | Out-Null
  $deadline = if ($timeoutSec -gt 0) { (Get-Date).AddSeconds($timeoutSec) } else { $null }
  while ($true) {
    Start-Sleep -Milliseconds 400
    if ((Get-ToastCount) -eq 0) { break }                          # another watcher already cleared it
    if (-not [JF]::IsWindow($target)) { Clear-Toast; break }        # window closed
    if ([JF]::GetForegroundWindow() -eq $target) { Clear-Toast; break } # refocused
    if ($hostPid -ne 0 -and -not (Get-Process -Id $hostPid -ErrorAction SilentlyContinue)) {
      Clear-Toast; break                                            # host process gone
    }
    if ($deadline -and (Get-Date) -gt $deadline) { break }          # finite timeout: stop watching, leave toast
  }
  exit 0
}

# ------------------------------------------------------- read event payload
$payload = $null
if ($Event -eq 'codex') {
  if ($extraArgs.Count -gt 0) { try { $payload = $extraArgs[-1] | ConvertFrom-Json } catch {} }
}
elseif (-not $Test -and [Console]::IsInputRedirected) {
  # Hooks pipe JSON then close stdin; skip in -Test where stdin may stay open.
  try { $stdin = [Console]::In.ReadToEnd(); if ($stdin) { $payload = $stdin | ConvertFrom-Json } } catch {}
}

# ------------------------------------------------------- compose title/text
$project = Split-Path -Leaf (Get-Location).Path
if ($payload -and $payload.cwd) { $project = Split-Path -Leaf $payload.cwd }
switch ($Event) {
  'notify' {
    $title = "Job-Finish · 입력 대기"
    $text  = if ($payload -and $payload.message) { [string]$payload.message } else { "$project · 입력을 기다리는 중" }
  }
  'codex' {
    $title = "Job-Finish · Codex 완료"
    $last  = if ($payload) { [string]$payload.'last-assistant-message' } else { '' }
    $text  = if ($last) { $last } else { "$project · 작업이 끝났어요" }
  }
  default {
    $title = "Job-Finish · 작업 완료"
    $text  = "$project · 작업이 끝났어요"
  }
}
if ($text.Length -gt 180) { $text = $text.Substring(0, 177) + '...' }

# Walk up the parent-process chain to find the GUI window that hosts the agent
# (VSCode's Code.exe, WindowsTerminal.exe, a console host, ...).
function Get-HostWindow {
  $cur = $PID
  for ($i = 0; $i -lt 12; $i++) {
    $p = Get-Process -Id $cur -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { return $p.MainWindowHandle }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $cur" -ErrorAction SilentlyContinue
    if (-not $proc -or -not $proc.ParentProcessId -or $proc.ParentProcessId -le 4) { break }
    $cur = [int]$proc.ParentProcessId
  }
  $con = [JF]::GetConsoleWindow()
  if ($con -ne [IntPtr]::Zero) { return $con }
  return [IntPtr]::Zero
}

# NB: must NOT be named $hwnd — that aliases the [long]$Hwnd param (PowerShell
# is case-insensitive), which would coerce this IntPtr to a long and break .ToInt64().
$hostHwnd = Get-HostWindow

# Focus gate: if we are looking at the host window, stay silent (unless -Test).
if (-not $Test -and $cfg.suppressWhenFocused -and $hostHwnd -ne [IntPtr]::Zero) {
  if ([JF]::GetForegroundWindow() -eq $hostHwnd) { exit 0 }
}

# ------------------------------------------------------------------- notify
# Register a tiny HKCU URL protocol so a toast click can re-launch this script
# in -Activate mode and focus the host window. Idempotent; cheap to repeat.
function Register-Protocol {
  try {
    $base = 'HKCU:\Software\Classes\jobfinish'
    New-Item -Path $base -Force | Out-Null
    Set-ItemProperty -Path $base -Name '(Default)' -Value 'URL:Job-Finish Protocol'
    Set-ItemProperty -Path $base -Name 'URL Protocol' -Value ''
    $cmdKey = Join-Path $base 'shell\open\command'
    New-Item -Path $cmdKey -Force | Out-Null
    $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Activate `"%1`""
    Set-ItemProperty -Path $cmdKey -Name '(Default)' -Value $cmd
  } catch {}
}

# Returns $true if the toast was shown, so the caller can spawn the watcher.
function Show-Toast($title, $text, $winHandle) {
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $launch = "jobfinish:focus?h=$($winHandle.ToInt64())"
    $eTitle = [Security.SecurityElement]::Escape([string]$title)
    $eText  = [Security.SecurityElement]::Escape([string]$text)
    $xmlText = @"
<toast launch="$launch" activationType="protocol">
  <visual>
    <binding template="ToastGeneric">
      <text>$eTitle</text>
      <text>$eText</text>
    </binding>
  </visual>
</toast>
"@
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $toast.Tag = 'jf'
    $toast.Group = $toastGroup
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    return $true
  } catch { return $false }
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
  $shown = $false
  if ($hostHwnd -ne [IntPtr]::Zero) { Register-Protocol }
  if ($hostHwnd -ne [IntPtr]::Zero) { $shown = Show-Toast $title $text $hostHwnd }
  if (-not $shown) {
    if (-not (Show-Toast $title $text ([IntPtr]::Zero))) { Show-Balloon $title $text }
    else { $shown = $true }
  }
  # Spawn the detached watcher so the toast clears when the host regains focus
  # (mirrors the flash auto-stop). Skip under -Test so the toast stays visible.
  if ($shown -and -not $Test -and $hostHwnd -ne [IntPtr]::Zero) {
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
      '-Watch', '-Hwnd', [string]$hostHwnd.ToInt64()
    ) | Out-Null
  }
}

# ------------------------------------------------------------------- flash
if (($modes -contains 'flash') -and $hostHwnd -ne [IntPtr]::Zero) {
  $interval = 500
  $count = if ($timeoutSec -gt 0) { [int]($timeoutSec * 1000 / $interval) } else { 0 }
  $fw = New-Object JF+FLASHWINFO
  $fw.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'JF+FLASHWINFO')
  $fw.hwnd = $hostHwnd
  $fw.dwFlags = 15   # FLASHW_ALL | FLASHW_TIMERNOFG -> auto-stops when refocused
  $fw.uCount = $count
  $fw.dwTimeout = $interval
  [JF]::FlashWindowEx([ref]$fw) | Out-Null
}

# ------------------------------------------------------------------- sound
if ($cfg.sound.enabled) {
  $sp = 'C:\Windows\Media\chimes.wav'
  try {
    if (Test-Path -LiteralPath $sp) { (New-Object Media.SoundPlayer $sp).PlaySync() }
    else { [System.Media.SystemSounds]::Asterisk.Play() }
  } catch { try { [System.Media.SystemSounds]::Asterisk.Play() } catch {} }
}

exit 0
