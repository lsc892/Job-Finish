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
    private const uint FLASHW_STOP = 0;
    private const int FOCUS_RETRY_MS = 6_000;

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
        var openWhenMissing = HasFlag(args, "--open") || IsTruthy(GetQueryValue(uri, "open"));
        var openInNewWindow = HasFlag(args, "--new-window") || IsTruthy(GetQueryValue(uri, "newWindow"));
        var waitMs = TryParseInt(GetQueryValue(uri, "waitMs") ?? GetArg(args, "--wait-ms")) ?? 6_000;
        var debug = string.Equals(GetQueryValue(uri, "debug"), "1", StringComparison.OrdinalIgnoreCase);
        var listOnly = args.Contains("--list", StringComparer.OrdinalIgnoreCase);

        _debug = debug;
        Log($"cwd={cwd}");
        Log($"titleHint={titleHint}");
        Log($"preferredPid={preferredPid?.ToString() ?? ""}");
        Log($"explicitHwnd={explicitHwnd?.ToString() ?? ""}");
        Log($"openWhenMissing={openWhenMissing}");
        Log($"openInNewWindow={openInNewWindow}");
        Log($"waitMs={waitMs}");
        Log($"debug={debug}");

        var windows = GetScoredCodeWindows(cwd, titleHint, preferredPid);
        LogCandidates(windows);

        if (listOnly)
        {
            return windows.Count > 0 ? 0 : 2;
        }

        var target = ResolveTarget(explicitHwnd, windows);
        if ((target == IntPtr.Zero || !IsWindow(target)) && openWhenMissing)
        {
            var knownHwnds = windows.Select(w => w.Hwnd).ToHashSet();
            if (TryLaunchVSCode(cwd, openInNewWindow, windows))
            {
                target = WaitForCodeWindow(cwd, titleHint, preferredPid, knownHwnds, waitMs);
            }
        }

        if (target == IntPtr.Zero || !IsWindow(target))
        {
            Log("target=0 or invalid");
            return 2;
        }

        Log($"target={target.ToInt64()}");
        var before = DescribeForeground();
        Log($"foreground.before={before}");

        var ok = FocusWindowWithRetry(target);
        var stopped = StopFlashing(target);
        Thread.Sleep(250);

        var after = DescribeForeground();
        Log($"foreground.after={after}");
        Log($"flash.stop={stopped}");
        Log($"success={ok || GetForegroundWindow() == target}");

        return GetForegroundWindow() == target ? 0 : 1;
    }

    private static List<WindowInfo> GetScoredCodeWindows(string cwd, string? titleHint, int? preferredPid)
    {
        return EnumerateTopLevelWindows()
            .Where(w => string.Equals(w.ProcessName, "Code", StringComparison.OrdinalIgnoreCase))
            .Select(w => w with { Score = ScoreWindow(w, cwd, titleHint, preferredPid) })
            .OrderByDescending(w => w.Score)
            .ThenBy(w => w.ZOrder)
            .ToList();
    }

    private static void LogCandidates(List<WindowInfo> windows)
    {
        foreach (var w in windows)
        {
            Log($"candidate hwnd={w.Hwnd.ToInt64()} pid={w.Pid} score={w.Score} title=\"{w.Title}\" path=\"{w.Path}\"");
        }
    }

    private static IntPtr ResolveTarget(long? explicitHwnd, List<WindowInfo> windows)
    {
        var best = windows.FirstOrDefault(w => w.Score >= 90);

        if (explicitHwnd is > 0)
        {
            var requested = new IntPtr(explicitHwnd.Value);
            if (IsWindow(requested))
            {
                var explicitWindow = windows.FirstOrDefault(w => w.Hwnd == requested);
                if (explicitWindow.Hwnd != IntPtr.Zero)
                {
                    if (explicitWindow.Score >= 90 || best.Hwnd == IntPtr.Zero || best.Hwnd == requested)
                    {
                        Log($"using explicit hwnd={requested.ToInt64()} score={explicitWindow.Score}");
                        return requested;
                    }

                    Log($"explicit hwnd score={explicitWindow.Score} is weaker than scored target hwnd={best.Hwnd.ToInt64()} score={best.Score}");
                    return best.Hwnd;
                }

                if (best.Hwnd != IntPtr.Zero && best.Score >= 90)
                {
                    Log($"explicit hwnd did not match cwd/title; using scored target hwnd={best.Hwnd.ToInt64()} score={best.Score}");
                    return best.Hwnd;
                }

                return requested;
            }
            Log($"explicit hwnd invalid: {explicitHwnd.Value}");
        }

        if (best.Hwnd != IntPtr.Zero)
        {
            return best.Hwnd;
        }

        return windows.Count == 1 ? windows[0].Hwnd : IntPtr.Zero;
    }

    private static IntPtr WaitForCodeWindow(
        string cwd,
        string? titleHint,
        int? preferredPid,
        HashSet<IntPtr> knownHwnds,
        int waitMs)
    {
        var boundedWaitMs = Math.Clamp(waitMs, 0, 30_000);
        var watch = Stopwatch.StartNew();

        do
        {
            var windows = GetScoredCodeWindows(cwd, titleHint, preferredPid);
            var best = windows.FirstOrDefault(w => w.Score >= 90);
            if (best.Hwnd != IntPtr.Zero)
            {
                Log($"opened.match hwnd={best.Hwnd.ToInt64()} score={best.Score} title=\"{best.Title}\"");
                return best.Hwnd;
            }

            var newWindow = windows.FirstOrDefault(w => !knownHwnds.Contains(w.Hwnd));
            if (newWindow.Hwnd != IntPtr.Zero)
            {
                Log($"opened.new hwnd={newWindow.Hwnd.ToInt64()} title=\"{newWindow.Title}\"");
                return newWindow.Hwnd;
            }

            if (knownHwnds.Count == 0 && windows.Count == 1)
            {
                Log($"opened.single hwnd={windows[0].Hwnd.ToInt64()} title=\"{windows[0].Title}\"");
                return windows[0].Hwnd;
            }

            Thread.Sleep(250);
        } while (watch.ElapsedMilliseconds < boundedWaitMs);

        Log("opened.wait.timeout");
        return IntPtr.Zero;
    }

    private static bool TryLaunchVSCode(string cwd, bool newWindow, List<WindowInfo> knownWindows)
    {
        var command = ResolveVSCodeCommand(knownWindows);
        if (string.IsNullOrWhiteSpace(command))
        {
            Log("open.failed=no-code-command");
            return false;
        }

        try
        {
            var workingDirectory = Directory.Exists(cwd) ? cwd : Environment.CurrentDirectory;
            var extension = Path.GetExtension(command);

            if (string.Equals(extension, ".cmd", StringComparison.OrdinalIgnoreCase)
                || string.Equals(extension, ".bat", StringComparison.OrdinalIgnoreCase))
            {
                var comSpec = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
                var batchArgs = new List<string>();
                if (newWindow) batchArgs.Add("-n");
                batchArgs.Add(cwd);

                var psi = new ProcessStartInfo
                {
                    FileName = comSpec,
                    WorkingDirectory = workingDirectory,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    UseShellExecute = false,
                    Arguments = $"/d /c \"{QuoteForCommandLine(command)} {string.Join(" ", batchArgs.Select(QuoteForCommandLine))}\"",
                };
                Process.Start(psi);
            }
            else
            {
                var psi = new ProcessStartInfo
                {
                    FileName = command,
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = false,
                };
                if (newWindow) psi.ArgumentList.Add("-n");
                psi.ArgumentList.Add(cwd);
                Process.Start(psi);
            }

            Log($"open.started command=\"{command}\" newWindow={newWindow} cwd=\"{cwd}\"");
            return true;
        }
        catch (Exception ex)
        {
            Log($"open.failed={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private static string? ResolveVSCodeCommand(List<WindowInfo> knownWindows)
    {
        var fromRunningWindow = knownWindows
            .Select(w => w.Path)
            .FirstOrDefault(p => !string.IsNullOrWhiteSpace(p)
                && string.Equals(Path.GetFileName(p), "Code.exe", StringComparison.OrdinalIgnoreCase)
                && File.Exists(p));
        if (!string.IsNullOrWhiteSpace(fromRunningWindow))
        {
            return fromRunningWindow;
        }

        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var candidates = new[]
        {
            Path.Combine(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft VS Code", "Code.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft VS Code", "Code.exe"),
            FindOnPath("code.exe"),
            FindOnPath("code.cmd"),
        };

        return candidates.FirstOrDefault(p => !string.IsNullOrWhiteSpace(p) && File.Exists(p));
    }

    private static string? FindOnPath(string fileName)
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(path)) return null;

        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(dir.Trim('"'), fileName);
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // Ignore malformed PATH entries.
            }
        }

        return null;
    }

    private static string QuoteForCommandLine(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static int ScoreWindow(WindowInfo window, string cwd, string? titleHint, int? preferredPid)
    {
        var score = 0;
        if (preferredPid is > 0 && window.Pid == preferredPid.Value)
        {
            score += 10;
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

    private static bool FocusWindowWithRetry(IntPtr hwnd)
    {
        var watch = Stopwatch.StartNew();
        var attempt = 0;

        do
        {
            attempt++;
            var ok = FocusWindowOnce(hwnd);
            var foreground = GetForegroundWindow();
            Log($"focus.attempt={attempt} ok={ok} foreground={DescribeForeground()}");
            if (ok || foreground == hwnd)
            {
                return true;
            }

            Thread.Sleep(attempt == 1 ? 300 : 150);
        } while (watch.ElapsedMilliseconds < FOCUS_RETRY_MS);

        return GetForegroundWindow() == hwnd;
    }

    private static bool FocusWindowOnce(IntPtr hwnd)
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
            StopFlashing(hwnd);

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

    private static bool StopFlashing(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
        {
            return false;
        }

        var info = new FLASHWINFO
        {
            cbSize = (uint)Marshal.SizeOf<FLASHWINFO>(),
            hwnd = hwnd,
            dwFlags = FLASHW_STOP,
            uCount = 0,
            dwTimeout = 0,
        };
        return FlashWindowEx(ref info);
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

    private static bool HasFlag(string[] args, string name)
    {
        return args.Any(arg => string.Equals(arg, name, StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsTruthy(string? value)
    {
        if (value is null) return false;
        return value.Length == 0
            || string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);
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

    private static bool _debug = false;

    private static void Log(string message)
    {
        if (!_debug) { return; }
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

    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

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

    [StructLayout(LayoutKind.Sequential)]
    private struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }
}
