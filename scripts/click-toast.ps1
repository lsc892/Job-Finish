param([Parameter(Mandatory=$true)][string]$ToastTitle, [string]$DiagnosticFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ToastMouse {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
[ToastMouse]::SetProcessDPIAware() | Out-Null
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$openCenterAt = [DateTime]::UtcNow.AddSeconds(2)
$centerOpened = $false
if ($DiagnosticFile) {
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
  $bitmap.Save("$DiagnosticFile.png")
  $graphics.Dispose(); $bitmap.Dispose()
}
while ([DateTime]::UtcNow -lt $deadline) {
  $element = $null
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $tree = @()
  $centerButton = $null
  foreach ($window in $windows) {
    $processName = (Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
    $tree += @{ name=$window.Current.Name; class=$window.Current.ClassName; process=$processName }
    if ($processName -notin @('ShellExperienceHost', 'ShellHost', 'explorer', 'TextInputHost')) { continue }
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    if ($processName -eq 'explorer' -and -not $centerButton) {
      $centerButton = $elements | Where-Object { $_.Current.ClassName -eq 'TrayButton' } | Select-Object -First 1
    }
    $tree += @($elements | ForEach-Object { @{ name=$_.Current.Name; class=$_.Current.ClassName; offscreen=$_.Current.IsOffscreen } })
    $element = $elements | Where-Object { ([string]$_.Current.Name) -like "*$ToastTitle*" -and -not $_.Current.IsOffscreen } | Select-Object -First 1
    if ($element) { break }
  }
  if ($DiagnosticFile) { $tree | ConvertTo-Json -Depth 3 | Add-Content -Encoding UTF8 $DiagnosticFile }
  if (-not $element -and -not $centerOpened -and [DateTime]::UtcNow -ge $openCenterAt -and $centerButton) {
    $centerRect = $centerButton.Current.BoundingRectangle
    if ($centerRect.Width -gt 0 -and $centerRect.Height -gt 0) {
      [ToastMouse]::SetCursorPos([int]($centerRect.Left + $centerRect.Width / 2), [int]($centerRect.Top + $centerRect.Height / 2)) | Out-Null
      [ToastMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
      [ToastMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      $centerOpened = $true
      if ($DiagnosticFile) { @{ centerOpened=$true; left=$centerRect.Left;top=$centerRect.Top;width=$centerRect.Width;height=$centerRect.Height } | ConvertTo-Json -Compress | Add-Content -Encoding UTF8 $DiagnosticFile }
      Start-Sleep -Milliseconds 300
      continue
    }
  }
  if ($element -and -not $element.Current.IsOffscreen) {
    $rect = $element.Current.BoundingRectangle
    if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
      $x = [int]($rect.Left + $rect.Width / 2)
      $y = [int]($rect.Top + $rect.Height / 2)
      [ToastMouse]::SetCursorPos($x, $y) | Out-Null
      [ToastMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
      [ToastMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      @{ title=$ToastTitle; name=$element.Current.Name; processId=$element.Current.ProcessId; x=$x; y=$y; clicked=$true } | ConvertTo-Json -Compress
      exit 0
    }
  }
  Start-Sleep -Milliseconds 100
}
throw "The exact test toast was not visible: $ToastTitle"
