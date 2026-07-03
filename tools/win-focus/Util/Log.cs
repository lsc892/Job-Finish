// 책임: 디버그 로깅과 창/포그라운드 상태 서술(진단).
using System.Diagnostics;
using System.Text;

internal static class Logger
{
    internal static bool _debug = false;

    // debug가 켜졌을 때만 타임스탬프를 붙여 콘솔과 jf-focus-vscode.log에 남기고, 실패는 조용히 무시한다.
    internal static void Log(string message)
    {
        if (!_debug) { return; }
        var line = $"[{DateTime.Now:HH:mm:ss.fff}] {message}";
        try { Console.WriteLine(line); } catch { }
        try { File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "jf-focus-vscode.log"), line + Environment.NewLine, Encoding.UTF8); } catch { }
    }

    internal static string DescribeForeground()
    {
        var hwnd = NativeMethods.GetForegroundWindow();
        _ = NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
        var title = GetWindowTitle(hwnd);
        var name = GetWindowProcessName(hwnd);
        return $"hwnd={hwnd.ToInt64()} pid={pid} process={name} title=\"{title}\"";
    }

    internal static string DescribeWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return "hwnd=0";
        }

        var threadId = NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
        var processName = GetWindowProcessName(hwnd);
        var className = GetWindowClassName(hwnd);
        var title = GetWindowTitle(hwnd);
        return $"hwnd={hwnd.ToInt64()} tid={threadId} pid={pid} process={processName} class=\"{className}\" title=\"{title}\"";
    }

    internal static string GetWindowProcessName(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return "";
        }

        _ = NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
    }

    internal static string GetWindowTitle(IntPtr hwnd)
    {
        var sb = new StringBuilder(512);
        var len = NativeMethods.GetWindowTextW(hwnd, sb, sb.Capacity);
        return len > 0 ? sb.ToString() : "";
    }

    internal static string GetWindowClassName(IntPtr hwnd)
    {
        var sb = new StringBuilder(256);
        var len = NativeMethods.GetClassNameW(hwnd, sb, sb.Capacity);
        return len > 0 ? sb.ToString() : "";
    }
}
