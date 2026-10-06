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
        // A protocol click can arrive before the notification surface dismisses.
        // Close only the currently foreground Windows notification surface.
        var foreground = GetForegroundWindow();
        GetWindowThreadProcessId(foreground, out var foregroundPid);
        try
        {
            using var process = Process.GetProcessById((int)foregroundPid);
            var image = process.MainModule?.FileName;
            if (image != null && Path.GetFileName(image).Equals("ShellExperienceHost.exe", StringComparison.OrdinalIgnoreCase)
                && Path.GetFullPath(image).StartsWith(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "SystemApps") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                PostMessage(foreground, 0x10, IntPtr.Zero, IntPtr.Zero);
                Thread.Sleep(100);
            }
        }
        catch { /* A process exiting during dismissal does not invalidate the target. */ }
        if (!Valid(target)) return false;
        var current = GetCurrentThreadId();
        var targetThread = GetWindowThreadProcessId(hwnd, out _);
        var foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out _);
        var info = new GuiThreadInfo { Size = Marshal.SizeOf<GuiThreadInfo>() };
        GetGUIThreadInfo(targetThread, ref info);
        var focus = info.Focus != IntPtr.Zero && (info.Focus == hwnd || IsChild(hwnd, info.Focus)) ? info.Focus : hwnd;
        var inputThread = GetWindowThreadProcessId(focus, out _);
        var attached = new List<uint>();
        // Ensure this short-lived protocol process has a Windows input queue.
        PeekMessage(out _, IntPtr.Zero, 0, 0, 0);
        try
        {
            foreach (var thread in new[] { foregroundThread, targetThread, inputThread }.Distinct())
                if (thread != 0 && thread != current && AttachThreadInput(current, thread, true)) attached.Add(thread);
            // Balanced Alt input enables the foreground transition from the explicit click.
            var inputs = new[] { new Input { Type = 1, Key = new Keyboard { Vk = 0x12 } }, new Input { Type = 1, Key = new Keyboard { Vk = 0x12, Flags = 2 } } };
            SendInput(2, inputs, Marshal.SizeOf<Input>());
            if (IsIconic(hwnd)) { ShowWindowAsync(hwnd, 9); Thread.Sleep(100); }
            if (!Valid(target)) return false;
            SetForegroundWindow(hwnd);
            SetActiveWindow(hwnd);
            SetFocus(focus);
        }
        finally
        {
            for (var i = attached.Count - 1; i >= 0; i--) AttachThreadInput(current, attached[i], false);
        }
        Thread.Sleep(60);
        var active = GetForegroundWindow() == hwnd;
        reason = active ? "activated" : "foreground-refused";
        return active;
    }

    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo { public int Size; public uint Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Hwnd; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Private; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort Vk, Scan; public uint Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit, Size = 40)] struct Input { [FieldOffset(0)] public uint Type; [FieldOffset(8)] public Keyboard Key; }
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr SetActiveWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
}
