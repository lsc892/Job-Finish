using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Security;
using Microsoft.Win32;
using System.Runtime.InteropServices;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

internal record Target(string Hwnd, int Pid, string Executable, long Started = 0);
internal record Request(string NotificationId, string WindowInstanceId, string Title, string Message, string AppId, string Pipe, Target? Target, long Expires = 0);
internal static class Program
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    const string AppId = "JobFinish.VSCode";
    const string Scheme = "jobfinish-native-focus";
    static readonly object OutputLock = new();

    internal static void Report(object value)
    {
        lock (OutputLock)
        {
            using var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), leaveOpen: true);
            stdout.WriteLine(JsonSerializer.Serialize(value, Json));
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--register") { Register(); return 0; }
            if (args.Length == 1 && args[0] == "--show")
            {
                // WinExe has no console code page; decode the redirected handle directly.
                using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true));
                var input = stdin.ReadToEnd();
                if (input.Length > 32768) throw new ArgumentException("Toast request too large");
                var request = JsonSerializer.Deserialize<Request>(input, Json) ?? throw new ArgumentException("Missing request");
                Show(request); return 0;
            }
            if (args.Length == 2 && args[0] == "--uri") return Click(args[1]);
            return 2;
        }
        catch (Exception error)
        {
            using var stderr = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
            stderr.WriteLine($"{error.Message} (0x{error.HResult:X8})"); return 1;
        }
    }

    static void Register()
    {
        using var mutex = new Mutex(false, @"Local\JobFinish.Native.Registration");
        var acquired = false;
        try
        {
            try { acquired = mutex.WaitOne(TimeSpan.FromSeconds(8)); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new TimeoutException("Native notification registration is busy");
            var executable = Environment.ProcessPath!;
            var result = Registration.Shortcut(AppId, executable, Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Job-Finish", "notification-backups"));
            using (var protocol = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{Scheme}"))
            {
                protocol.SetValue("", "URL:Job-Finish native focus"); protocol.SetValue("URL Protocol", "");
                using var command = protocol.CreateSubKey(@"shell\open\command");
                var value = $"\"{executable}\" --uri \"%1\"";
                if (!Equals(command.GetValue(""), value)) { command.SetValue("", value); Registration.ProtocolChanged(); }
            }
            using (var app = Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelId\{AppId}"))
            { app.SetValue("DisplayName", "Job-Finish"); app.SetValue("ShowInSettings", 1, RegistryValueKind.DWord); }
            // Shell registration is asynchronous. Retry only the specific not-yet-resolved identity error.
            var deadline = Stopwatch.StartNew();
            NotificationSetting setting;
            while (true)
            {
                try { setting = ToastNotificationManager.CreateToastNotifier(AppId).Setting; break; }
                catch (COMException error) when (error.HResult == unchecked((int)0x80070490) && deadline.ElapsedMilliseconds < 5000) { Thread.Sleep(100); }
            }
            Report(new { @event = "toast.registration.ready", appId = AppId, result.Changed, result.LegacyBackup, setting = setting.ToString() });
        }
        finally { if (acquired) mutex.ReleaseMutex(); }
    }

    static void Show(Request request)
    {
        if (request.AppId != AppId || string.IsNullOrWhiteSpace(request.Title) || string.IsNullOrWhiteSpace(request.Message)
            || string.IsNullOrEmpty(request.NotificationId) || string.IsNullOrEmpty(request.WindowInstanceId))
            throw new ArgumentException("Invalid toast request");
        var target = request.Target;
        if (target != null)
        {
            if (!Focus.Valid(target)) target = null;
            else target = target with { Started = Process.GetProcessById(target.Pid).StartTime.ToUniversalTime().Ticks };
        }
        request = request with { Target = target, Expires = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds() };
        // Do not embed notification text in activation arguments or diagnostics.
        var activation = request with { Title = "", Message = "" };
        var payload = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(activation, Json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var xml = new XmlDocument();
        xml.LoadXml($"<toast activationType=\"protocol\" launch=\"{Scheme}://focus/{payload}\"><visual><binding template=\"ToastGeneric\"><text>{SecurityElement.Escape(request.Title)}</text><text>{SecurityElement.Escape(request.Message)}</text></binding></visual><audio silent=\"true\"/></toast>");
        var notifier = ToastNotificationManager.CreateToastNotifier(AppId);
        if (notifier.Setting != NotificationSetting.Enabled) throw new InvalidOperationException($"Windows notifications disabled: {notifier.Setting}");
        var toast = new ToastNotification(xml) { ExpirationTime = DateTimeOffset.FromUnixTimeSeconds(request.Expires), Tag = request.NotificationId[..Math.Min(16, request.NotificationId.Length)], Group = request.WindowInstanceId[..Math.Min(16, request.WindowInstanceId.Length)] };
        ToastDelivery.Show(notifier, toast, request);
    }

    static int Click(string uriText)
    {
        var uri = new Uri(uriText);
        if (uri.Scheme != Scheme || uri.Host != "focus" || uriText.Length > 16384) return 2;
        var payload = uri.AbsolutePath.Trim('/').Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
        var request = JsonSerializer.Deserialize<Request>(Convert.FromBase64String(payload), Json) ?? throw new ArgumentException("Invalid activation");
        if (request.AppId != AppId || request.Expires < DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            || !request.Pipe.StartsWith("job-finish-", StringComparison.Ordinal) || request.Pipe.Length != 47
            || request.Target is { Started: <= 0 }) return 2;
        using var pipe = new NamedPipeClientStream(".", request.Pipe, PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.Connect(1500);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
        using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
        writer.WriteLine(JsonSerializer.Serialize(new { @event = "toast.click", request.NotificationId, request.WindowInstanceId }, Json));
        using var timeout = new CancellationTokenSource(1500);
        var reply = reader.ReadLineAsync(timeout.Token).AsTask().GetAwaiter().GetResult();
        if (reply == null || reply.Length > 1024 || !JsonDocument.Parse(reply).RootElement.GetProperty("allowed").GetBoolean()) return 3;
        var activated = Focus.Activate(request.Target, out var reason);
        writer.WriteLine(JsonSerializer.Serialize(new { @event = "window.activation.result", request.NotificationId, request.WindowInstanceId, activated, reason, hwnd = request.Target?.Hwnd, foreground = Focus.GetForegroundWindow().ToInt64().ToString() }, Json));
        return activated ? 0 : 4;
    }
}
