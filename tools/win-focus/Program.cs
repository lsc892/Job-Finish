using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private const int SW_HIDE = 0;
    private const int SW_SHOWNORMAL = 1;
    private const int SW_SHOW = 5;
    private const int SW_MINIMIZE = 6;
    private const int SW_RESTORE = 9;

    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_SHOWWINDOW = 0x0040;

    private static readonly IntPtr HWND_TOPMOST = new(-1);
    private static readonly IntPtr HWND_NOTOPMOST = new(-2);

    private const int INPUT_KEYBOARD = 1;
    private const ushort VK_MENU = 0x12;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    private static int Main(string[] args)
    {
        var uri = GetArg(args, "--uri") ?? (args.Length == 1 && args[0].Contains("://", StringComparison.Ordinal) ? args[0] : null);
        var cwd = GetQueryValue(uri, "cwd") ?? GetArg(args, "--cwd") ?? Environment.CurrentDirectory;
        var titleHint =
            GetQueryValue(uri, "title")
            ?? GetArg(args, "--title")
            ?? Path.GetFileName(cwd.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        var explicitHwnd = TryParseLong(GetQueryValue(uri, "hwnd") ?? GetArg(args, "--hwnd"));
        var preferredPid = TryParseInt(GetQueryValue(uri, "pid") ?? GetArg(args, "--pid"));
        var listOnly = args.Contains("--list", StringComparer.OrdinalIgnoreCase);

        Log($"cwd={cwd}");
        Log($"titleHint={titleHint}");
        Log($"preferredPid={preferredPid?.ToString() ?? ""}");
        Log($"explicitHwnd={explicitHwnd?.ToString() ?? ""}");

        var windows = EnumerateTopLevelWindows()
            .Where(w => string.Equals(w.ProcessName, "Code", StringComparison.OrdinalIgnoreCase))
            .Select(w => w with { Score = ScoreWindow(w, cwd, titleHint, preferredPid) })
            .OrderByDescending(w => w.Score)
            .ThenBy(w => w.ZOrder)
            .ToList();

        foreach (var w in windows)
        {
            Log($"candidate hwnd={w.Hwnd.ToInt64()} pid={w.Pid} score={w.Score} title=\"{w.Title}\" path=\"{w.Path}\"");
        }

        if (listOnly)
        {
            return windows.Count > 0 ? 0 : 2;
        }

        var target = ResolveTarget(explicitHwnd, windows);
        if (target == IntPtr.Zero || !IsWindow(target))
        {
            Log("target=0 or invalid");
            return 2;
        }

        Log($"target={target.ToInt64()}");
        var before = DescribeForeground();
        Log($"foreground.before={before}");

        var ok = FocusWindow(target);
        Thread.Sleep(250);

        var after = DescribeForeground();
        Log($"foreground.after={after}");
        Log($"success={ok || GetForegroundWindow() == target}");

        return GetForegroundWindow() == target ? 0 : 1;
    }

    private static IntPtr ResolveTarget(long? explicitHwnd, List<WindowInfo> windows)
    {
        if (explicitHwnd is > 0)
        {
            var requested = new IntPtr(explicitHwnd.Value);
            if (IsWindow(requested))
            {
                return requested;
            }
            Log($"explicit hwnd invalid: {explicitHwnd.Value}");
        }

        var best = windows.FirstOrDefault(w => w.Score > 0);
        if (best.Hwnd != IntPtr.Zero)
        {
            return best.Hwnd;
        }

        return windows.Count == 1 ? windows[0].Hwnd : IntPtr.Zero;
    }

    private static int ScoreWindow(WindowInfo window, string cwd, string? titleHint, int? preferredPid)
    {
        var score = 0;
        if (preferredPid is > 0 && window.Pid == preferredPid.Value)
        {
            score += 1_000;
        }

        var normalizedCwd = cwd.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!string.IsNullOrWhiteSpace(normalizedCwd) && window.Title.Contains(normalizedCwd, StringComparison.OrdinalIgnoreCase))
        {
            score += 200;
        }

        if (!string.IsNullOrWhiteSpace(titleHint) && window.Title.Contains(titleHint, StringComparison.OrdinalIgnoreCase))
        {
            score += 100;
        }

        var folder = Path.GetFileName(normalizedCwd);
        if (!string.IsNullOrWhiteSpace(folder) && !string.Equals(folder, titleHint, StringComparison.OrdinalIgnoreCase)
            && window.Title.Contains(folder, StringComparison.OrdinalIgnoreCase))
        {
            score += 90;
        }

        return score;
    }

    private static bool FocusWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
        {
            return false;
        }

        var fg = GetForegroundWindow();
        var fgThread = GetWindowThreadProcessId(fg, out _);
        var targetThread = GetWindowThreadProcessId(hwnd, out _);
        var currentThread = GetCurrentThreadId();

        var attachedFg = fgThread != 0 && fgThread != currentThread && AttachThreadInput(currentThread, fgThread, true);
        var attachedTarget = targetThread != 0 && targetThread != currentThread && AttachThreadInput(currentThread, targetThread, true);

        try
        {
            SendAltKey();

            if (IsIconic(hwnd))
            {
                ShowWindowAsync(hwnd, SW_RESTORE);
                Thread.Sleep(120);
            }
            else
            {
                ShowWindowAsync(hwnd, SW_SHOW);
            }

            BringWindowToTop(hwnd);
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SwitchToThisWindow(hwnd, true);
            SetForegroundWindow(hwnd);

            return GetForegroundWindow() == hwnd;
        }
        finally
        {
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedFg) AttachThreadInput(currentThread, fgThread, false);
        }
    }

    private static void SendAltKey()
    {
        var inputs = new[]
        {
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = VK_MENU } } },
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = VK_MENU, dwFlags = KEYEVENTF_KEYUP } } },
        };
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    private static List<WindowInfo> EnumerateTopLevelWindows()
    {
        var result = new List<WindowInfo>();
        var z = 0;
        EnumWindows((hwnd, lParam) =>
        {
            z++;
            if (!IsWindowVisible(hwnd)) return true;

            var title = GetWindowTitle(hwnd);
            if (string.IsNullOrWhiteSpace(title)) return true;

            GetWindowThreadProcessId(hwnd, out var pid);
            Process? process = null;
            try { process = Process.GetProcessById((int)pid); } catch { }
            if (process is null) return true;

            string path = "";
            try { path = process.MainModule?.FileName ?? ""; } catch { }

            result.Add(new WindowInfo(hwnd, (int)pid, process.ProcessName, title, path, z));
            return true;
        }, IntPtr.Zero);

        return result;
    }

    private static string DescribeForeground()
    {
        var hwnd = GetForegroundWindow();
        _ = GetWindowThreadProcessId(hwnd, out var pid);
        var title = GetWindowTitle(hwnd);
        var name = "";
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        return $"hwnd={hwnd.ToInt64()} pid={pid} process={name} title=\"{title}\"";
    }

    private static string GetWindowTitle(IntPtr hwnd)
    {
        var sb = new StringBuilder(512);
        var len = GetWindowTextW(hwnd, sb, sb.Capacity);
        return len > 0 ? sb.ToString() : "";
    }

    private static string? GetArg(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }
        return null;
    }

    private static string? GetQueryValue(string? uri, string name)
    {
        if (string.IsNullOrWhiteSpace(uri)) return null;
        try
        {
            var parsed = new Uri(uri);
            var query = parsed.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries);
            foreach (var pair in query)
            {
                var parts = pair.Split('=', 2);
                if (parts.Length == 2 && string.Equals(Uri.UnescapeDataString(parts[0]), name, StringComparison.OrdinalIgnoreCase))
                {
                    return Uri.UnescapeDataString(parts[1].Replace("+", "%20"));
                }
            }
        }
        catch
        {
            // Fall through to the lightweight parser below.
        }

        var marker = name + "=";
        var index = uri.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (index < 0) return null;
        var value = uri[(index + marker.Length)..];
        var amp = value.IndexOf('&');
        if (amp >= 0) value = value[..amp];
        return Uri.UnescapeDataString(value.Replace("+", "%20"));
    }

    private static long? TryParseLong(string? value)
    {
        return long.TryParse(value, out var parsed) ? parsed : null;
    }

    private static int? TryParseInt(string? value)
    {
        return int.TryParse(value, out var parsed) ? parsed : null;
    }

    private static void Log(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss.fff}] {message}";
        try { Console.WriteLine(line); } catch { }
        try { File.AppendAllText(Path.Combine(AppContext.BaseDirectory, "jf-focus-vscode.log"), line + Environment.NewLine, Encoding.UTF8); } catch { }
    }

    private readonly record struct WindowInfo(IntPtr Hwnd, int Pid, string ProcessName, string Title, string Path, int ZOrder, int Score = 0);

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hwnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr hwndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern void SwitchToThisWindow(IntPtr hwnd, bool fAltTab);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public int type;
        public INPUTUNION u;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }
}
