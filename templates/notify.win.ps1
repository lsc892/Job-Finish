# job-finish-notify (Windows) — focus-aware completion notifier for Claude Code / Codex.
# Invoked by a hook. Reads choices from job-finish.config.json next to this script.
#   -Event stop|notify|codex   which agent event fired
#   -Test                      bypass focus suppression (used by `doctor`)
# Claude passes a JSON payload on stdin; Codex appends its JSON as the final arg.
param(
  [string]$Event = "stop",
  [switch]$Test
)
$ErrorActionPreference = 'SilentlyContinue'
$extraArgs = $args

# ---------------------------------------------------------------- load config
$cfgPath = Join-Path $PSScriptRoot 'job-finish.config.json'
$cfg = $null
if (Test-Path -LiteralPath $cfgPath) {
  try { $cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $cfgPath | ConvertFrom-Json } catch {}
}
if ($null -eq $cfg) {
  $cfg = [pscustomobject]@{
    modes = @('toast', 'flash'); flashTimeout = '5m';
    sound = [pscustomobject]@{ enabled = $true; customPath = '' };
    suppressWhenFocused = $true; watchApp = ''
  }
}
$modes = @($cfg.modes)

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

# ----------------------------------------------- native interop (focus/flash)
Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Runtime.InteropServices;
public static class JF {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
}
"@

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

$hwnd = Get-HostWindow

# Focus gate: if we are looking at the host window, stay silent (unless -Test).
if (-not $Test -and $cfg.suppressWhenFocused -and $hwnd -ne [IntPtr]::Zero) {
  if ([JF]::GetForegroundWindow() -eq $hwnd) { exit 0 }
}

# ------------------------------------------------------------------- toast
function Show-Toast($title, $text) {
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $tmpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $nodes = $tmpl.GetElementsByTagName('text')
    $nodes.Item(0).AppendChild($tmpl.CreateTextNode($title)) | Out-Null
    $nodes.Item(1).AppendChild($tmpl.CreateTextNode($text)) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($tmpl)
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
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

if (($modes -contains 'toast') -or ($modes -contains 'os')) {
  if (-not (Show-Toast $title $text)) { Show-Balloon $title $text }
}

# ------------------------------------------------------------------- flash
if (($modes -contains 'flash') -and $hwnd -ne [IntPtr]::Zero) {
  $interval = 500
  switch ($cfg.flashTimeout) {
    '30s'      { $count = 60 }
    '5m'       { $count = 600 }
    '10m'      { $count = 1200 }
    'infinite' { $count = 0 }
    default    { $count = 600 }
  }
  $fw = New-Object JF+FLASHWINFO
  $fw.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'JF+FLASHWINFO')
  $fw.hwnd = $hwnd
  $fw.dwFlags = 15   # FLASHW_ALL | FLASHW_TIMERNOFG -> auto-stops when refocused
  $fw.uCount = $count
  $fw.dwTimeout = $interval
  [JF]::FlashWindowEx([ref]$fw) | Out-Null
}

# ------------------------------------------------------------------- sound
if ($cfg.sound.enabled) {
  $sp = [string]$cfg.sound.customPath
  if ([string]::IsNullOrWhiteSpace($sp)) { $sp = 'C:\Windows\Media\chimes.wav' }
  try {
    if (Test-Path -LiteralPath $sp) { (New-Object Media.SoundPlayer $sp).PlaySync() }
    else { [System.Media.SystemSounds]::Asterisk.Play() }
  } catch { try { [System.Media.SystemSounds]::Asterisk.Play() } catch {} }
}

exit 0
