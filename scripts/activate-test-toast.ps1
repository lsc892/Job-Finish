param([Parameter(Mandatory=$true)][string]$NotificationId, [Parameter(Mandatory=$true)][string]$WindowInstanceId)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $history = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]::History.GetHistory('JobFinish.VSCode')
  $toast = $history | Where-Object { $_.Tag -eq $NotificationId.Substring(0, 16) -and $_.Group -eq $WindowInstanceId.Substring(0, 16) } | Select-Object -First 1
  if (-not $toast) { Start-Sleep -Milliseconds 100 }
} while (-not $toast -and [DateTime]::UtcNow -lt $deadline)
if (-not $toast) { throw 'The exact isolated test notification is not registered' }
[xml]$xml = $toast.Content.GetXml()
if ($xml.toast.activationType -ne 'protocol' -or -not $xml.toast.launch.StartsWith('jobfinish-native-focus://focus/')) { throw 'Unexpected native activation protocol' }
Start-Process -FilePath $xml.toast.launch -WindowStyle Hidden
@{ activatedProtocol=$true; source='registered-toast-uri'; notificationId=$NotificationId } | ConvertTo-Json -Compress
