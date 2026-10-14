param([Parameter(Mandatory=$true)][long]$Hwnd, [string]$ReadyFile)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TestWindow {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int mode);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$handle = [IntPtr]$Hwnd
[TestWindow]::SetProcessDPIAware() | Out-Null
$title = New-Object System.Text.StringBuilder 2048
[TestWindow]::GetWindowText($handle, $title, 2048) | Out-Null
if (-not $title.ToString().Contains('JF TOAST SAME TITLE')) { throw 'Only an isolated toast test window may be focused' }
[TestWindow]::ShowWindow($handle, 9) | Out-Null
[TestWindow]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, 0x53) | Out-Null
try {
  [TestWindow]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 200
  $rect = New-Object TestWindow+Rect
  [TestWindow]::GetWindowRect($handle, [ref]$rect) | Out-Null
  [TestWindow]::SetCursorPos([int](($rect.Left + $rect.Right) / 2), [int](($rect.Top + $rect.Bottom) / 2)) | Out-Null
  [TestWindow]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [TestWindow]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  if ($ReadyFile) {
    [System.IO.File]::WriteAllText($ReadyFile, ([TestWindow]::GetForegroundWindow().ToInt64().ToString()))
    Start-Sleep -Milliseconds 2000
  }
} finally { [TestWindow]::SetWindowPos($handle, [IntPtr](-2), 0, 0, 0, 0, 0x53) | Out-Null }
@{ target=$Hwnd; foreground=[TestWindow]::GetForegroundWindow().ToInt64(); rect=@{left=$rect.Left;top=$rect.Top;right=$rect.Right;bottom=$rect.Bottom} } | ConvertTo-Json -Compress
