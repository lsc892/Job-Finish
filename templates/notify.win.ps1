# job-finish-notify (Windows) - focus-aware completion notifier for Claude Code / Codex.
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

# Toast identity. The AppID matches Windows PowerShell, which can raise WinRT toasts.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
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
    suppressWhenFocused = $true; watchApp = ''
  }
}
$modes = @($cfg.modes)

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
using System.Runtime.InteropServices;
using System.Text;

public static class JF {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
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
$focusCwd = if ($payload -and $payload.cwd) { [string]$payload.cwd } else { (Get-Location).Path }
$project = Split-Path -Leaf $focusCwd
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
  $fromTree = [JF]::FindWindowForPids($tree, [string]$project, $false)
  if ($fromTree -ne [IntPtr]::Zero) { return $fromTree }

  foreach ($id in $tree) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { return $p.MainWindowHandle }
  }

  $con = [JF]::GetConsoleWindow()
  if ($con -ne [IntPtr]::Zero) { return $con }
  return [IntPtr]::Zero
}

function Get-VSCodeWindow {
  if ($env:VSCODE_PID -match '^\d+$') {
    $p = Get-Process -Id ([int]$env:VSCODE_PID) -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'Code') {
      $fromPid = [JF]::FindWindowForPids(@([int]$p.Id), [string]$project, $true)
      if ($fromPid -ne [IntPtr]::Zero) { return $fromPid }
    }
  }

  $code = @(Get-Process Code -ErrorAction SilentlyContinue)
  if ($code.Count -eq 0) { return [IntPtr]::Zero }

  $main = @($code | Where-Object { $_.MainWindowHandle -ne 0 })
  $mainMatch = $main | Where-Object { [string]$_.MainWindowTitle -and [string]$project -and $_.MainWindowTitle.IndexOf([string]$project, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
  if ($mainMatch) { return [IntPtr]$mainMatch.MainWindowHandle }

  $ids = @($code | ForEach-Object { [int]$_.Id })
  $titleMatch = [JF]::FindWindowForPids($ids, [string]$project, $true)
  if ($titleMatch -ne [IntPtr]::Zero) { return $titleMatch }

  if ($main.Count -eq 1) { return [IntPtr]$main[0].MainWindowHandle }
  return [IntPtr]::Zero
}

$hostHwnd = Get-HostWindow
$vscodeHwnd = Get-VSCodeWindow
$focusTarget = if ($vscodeHwnd -ne [IntPtr]::Zero) { $vscodeHwnd } else { $hostHwnd }
$focusTargetPid = [uint32]0
if ($focusTarget -ne [IntPtr]::Zero) {
  [JF]::GetWindowThreadProcessId($focusTarget, [ref]$focusTargetPid) | Out-Null
}

if (-not $Test -and $cfg.suppressWhenFocused -and $focusTarget -ne [IntPtr]::Zero) {
  if ([JF]::GetForegroundWindow() -eq $focusTarget) { exit 0 }
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
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
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

function Show-Toast($title, $text, $cwd, $hwnd, $pid) {
  try {
    Register-FocusProtocol
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $encodedCwd = [Uri]::EscapeDataString([string]$cwd)
    $query = New-Object 'System.Collections.Generic.List[string]'
    $query.Add("cwd=$encodedCwd")
    if ($hwnd -and $hwnd -ne [IntPtr]::Zero) { $query.Add("hwnd=$($hwnd.ToInt64())") }
    if ($pid -and [uint32]$pid -gt 0) { $query.Add("pid=$pid") }
    if ($project) { $query.Add("title=$([Uri]::EscapeDataString([string]$project))") }
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
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $toast.Tag = if ($hwnd -and $hwnd -ne [IntPtr]::Zero) { "jf-$($hwnd.ToInt64())" } else { 'jf' }
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
  if (-not (Show-Toast $title $text $focusCwd $focusTarget $focusTargetPid)) { Show-Balloon $title $text }
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
  $sp = 'C:\Windows\Media\chimes.wav'
  try {
    if (Test-Path -LiteralPath $sp) { (New-Object Media.SoundPlayer $sp).PlaySync() }
    else { [System.Media.SystemSounds]::Asterisk.Play() }
  } catch { try { [System.Media.SystemSounds]::Asterisk.Play() } catch {} }
}

exit 0
