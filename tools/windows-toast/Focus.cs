using System.Diagnostics;
using System.Runtime.InteropServices;

internal static class Focus
{
    internal static bool Valid(Target target)
    {
        if (!long.TryParse(target.Hwnd, out var value) || value <= 0) return false;
        var hwnd = new IntPtr(value);
        if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || GetAncestor(hwnd, 2) != hwnd) return false;
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid != target.Pid) return false;
        try
        {
            using var process = Process.GetProcessById(target.Pid);
            return string.Equals(Path.GetFullPath(process.MainModule!.FileName), Path.GetFullPath(target.Executable), StringComparison.OrdinalIgnoreCase)
                && (target.Started == 0 || process.StartTime.ToUniversalTime().Ticks == target.Started);
        }
        catch { return false; }
    }

    internal static bool Activate(Target? target, out string reason)
    {
        reason = "missing-binding";
        if (target == null) return false;
        reason = "invalid-binding";
        if (!Valid(target)) return false;
        var hwnd = new IntPtr(long.Parse(target.Hwnd));
        // Activate the bound window; VS Code manages its own input focus.
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        SetForegroundWindow(hwnd);
        Thread.Sleep(60);
        var active = GetForegroundWindow() == hwnd;
        reason = active ? "activated" : "foreground-refused";
        return active;
    }

    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
}
