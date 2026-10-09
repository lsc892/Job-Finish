using System.Diagnostics;
using System.Runtime.InteropServices;
using Windows.UI.Notifications;

internal static class ToastDelivery
{
    internal static void Show(ToastNotifier notifier, ToastNotification toast, Request request)
    {
        Exception? failure = null;
        var confirmed = false;
        var historyUnavailable = false;
        var state = 0;
        var stateResult = SHQueryUserNotificationState(out state);
        void Report(string name, object? errorCode = null) => Program.Report(new {
            @event = name, request.NotificationId, request.WindowInstanceId,
            errorCode, historyConfirmed = confirmed, notificationState = stateResult == 0 ? (int?)state : null,
            bannerVerified = false
        });
        void Failed(ToastNotification _, ToastFailedEventArgs args) { Interlocked.Exchange(ref failure, args.ErrorCode); }
        toast.Failed += Failed;
        try
        {
            notifier.Show(toast);
            Report("toast.submitted");
            var watch = Stopwatch.StartNew();
            // Keep the STA and toast alive for a bounded delivery observation, pumping WinRT callbacks.
            while (watch.ElapsedMilliseconds < 2000 && Volatile.Read(ref failure) == null)
            {
                while (PeekMessage(out var message, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref message); DispatchMessage(ref message); }
                if (!confirmed && !historyUnavailable)
                {
                    try
                    {
                        confirmed = ToastNotificationManager.History.GetHistory(request.AppId).Any(item => item.Tag == toast.Tag && item.Group == toast.Group);
                        if (confirmed) Report("toast.history.confirmed");
                    }
                    catch (Exception historyError) { historyUnavailable = true; Report("toast.history.error", $"0x{historyError.HResult:X8}"); }
                }
                Thread.Sleep(25);
            }
            if (Volatile.Read(ref failure) is { } error)
            {
                Report("toast.failed", $"0x{error.HResult:X8}");
                throw new InvalidOperationException($"Windows toast failed: 0x{error.HResult:X8}", error);
            }
            Report("toast.observation.complete");
        }
        finally { toast.Failed -= Failed; GC.KeepAlive(toast); }
    }

    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Hwnd; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Private; }
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
}
