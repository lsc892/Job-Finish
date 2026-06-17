using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

[SupportedOSPlatform("windows")]
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
    private const ushort VK_ESCAPE = 0x1B;
    private const ushort VK_LWIN = 0x5B;
    private const ushort VK_N = 0x4E;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint FLASHW_STOP = 0;
    private const uint WM_CLOSE = 0x0010;
    private const int ASFW_ANY = -1;
    private const uint LSFW_UNLOCK = 2;
    private const uint PROCESS_CREATE_THREAD = 0x0002;
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_OPERATION = 0x0008;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const int FOCUS_RETRY_MS = 6_000;
    private const string ELECTRON_INPUT_CLASS = "Chrome_RenderWidgetHostHWND";

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
        var activationId = GetQueryValue(uri, "id") ?? GetArg(args, "--id");
        var openWhenMissing = HasFlag(args, "--open") || IsTruthy(GetQueryValue(uri, "open"));
        var openInNewWindow = HasFlag(args, "--new-window") || IsTruthy(GetQueryValue(uri, "newWindow"));
        var waitMs = TryParseInt(GetQueryValue(uri, "waitMs") ?? GetArg(args, "--wait-ms")) ?? 6_000;
        var deferred = HasFlag(args, "--deferred");
        var debug = string.Equals(GetQueryValue(uri, "debug"), "1", StringComparison.OrdinalIgnoreCase);
        var listOnly = args.Contains("--list", StringComparer.OrdinalIgnoreCase);

        _debug = debug;
        Log($"cwd={cwd}");
        Log($"titleHint={titleHint}");
        Log($"preferredPid={preferredPid?.ToString() ?? ""}");
        Log($"explicitHwnd={explicitHwnd?.ToString() ?? ""}");
        Log($"activationId={activationId ?? ""}");
        Log($"openWhenMissing={openWhenMissing}");
        Log($"openInNewWindow={openInNewWindow}");
        Log($"waitMs={waitMs}");
        Log($"deferred={deferred}");
        Log($"debug={debug}");

        if (deferred)
        {
            WaitForNotificationShellToLeave(3_000);
            Log($"toast.defer.after={DescribeForeground()}");
        }

        var windows = GetScoredCodeWindows(cwd, titleHint, preferredPid);
        LogCandidates(windows);

        if (listOnly)
        {
            return windows.Count > 0 ? 0 : 2;
        }

        WriteFlashStopSignal(activationId);

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
        var stopped = ok && StopFlashingWithRetry(target);
        Thread.Sleep(250);

        var after = DescribeForeground();
        Log($"foreground.after={after}");
        Log($"flash.stop={stopped}");
        Log($"success={ok || GetForegroundWindow() == target}");

        return GetForegroundWindow() == target ? 0 : 1;
    }

    private static bool StartDeferredActivation(string uri)
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(exe) || !File.Exists(exe))
            {
                Log("toast.defer.start.failed=missing process path");
                return false;
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = exe,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Environment.CurrentDirectory,
            };
            startInfo.ArgumentList.Add("--uri");
            startInfo.ArgumentList.Add(uri);
            startInfo.ArgumentList.Add("--deferred");
            Process.Start(startInfo);
            Log("toast.defer.start=ok");
            return true;
        }
        catch (Exception ex)
        {
            Log($"toast.defer.start.failed={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private static void WaitForNotificationShellToLeave(int timeoutMs)
    {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs && IsNotificationShellForeground())
        {
            Thread.Sleep(80);
        }
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

    private static void WriteFlashStopSignal(string? activationId)
    {
        if (string.IsNullOrWhiteSpace(activationId))
        {
            return;
        }

        var safeId = new string(activationId.Where(c => char.IsLetterOrDigit(c) || c is '-' or '_').ToArray());
        if (string.IsNullOrWhiteSpace(safeId))
        {
            return;
        }

        try
        {
            var path = Path.Combine(Path.GetTempPath(), $"job-finish-flash-stop-{safeId}.signal");
            File.WriteAllText(path, DateTime.UtcNow.ToString("O"), Encoding.UTF8);
            Log($"flash.stop.signal={path}");
        }
        catch (Exception ex)
        {
            Log($"flash.stop.signal.failed={ex.GetType().Name}: {ex.Message}");
        }
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
            Log($"focus.attempt={attempt} ok={ok} foreground={DescribeForeground()}");
            if (ok)
            {
                return true;
            }

            Thread.Sleep(attempt == 1 ? 300 : 150);
        } while (watch.ElapsedMilliseconds < FOCUS_RETRY_MS);

        return IsTypingTargetActive(hwnd, FindPreferredInputChild(hwnd));
    }

    private static bool FocusWindowOnce(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
        {
            return false;
        }

        if (!TryTransferForegroundFromForegroundOwner(hwnd))
        {
            DismissNotificationShellIfForeground(hwnd);
        }

        var fg = GetForegroundWindow();
        var fgThread = GetWindowThreadProcessId(fg, out _);
        var targetThread = GetWindowThreadProcessId(hwnd, out _);
        var currentThread = GetCurrentThreadId();
        var inputTarget = FindPreferredInputChild(hwnd);
        var inputThread = inputTarget != IntPtr.Zero ? GetWindowThreadProcessId(inputTarget, out _) : 0;

        var attachedThreads = AttachInputThreads(currentThread, fgThread, targetThread, inputThread);

        try
        {
            AllowSetForegroundWindow(ASFW_ANY);
            LockSetForegroundWindow(LSFW_UNLOCK);
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
            TryAppActivateWindow(hwnd);
            ActivateWindowForTyping(hwnd, targetThread, inputTarget);
            var ready = IsTypingTargetActive(hwnd, inputTarget);
            if (ready)
            {
                StopFlashingWithRetry(hwnd);
            }

            return ready;
        }
        finally
        {
            DetachInputThreads(currentThread, attachedThreads);
        }
    }

    private static List<uint> AttachInputThreads(uint currentThread, params uint[] threads)
    {
        var attached = new List<uint>();
        foreach (var thread in threads.Distinct())
        {
            if (thread == 0 || thread == currentThread)
            {
                continue;
            }

            var ok = AttachThreadInput(currentThread, thread, true);
            Log($"activation.attach thread={thread} ok={ok}");
            if (ok)
            {
                attached.Add(thread);
            }
        }

        return attached;
    }

    private static void DetachInputThreads(uint currentThread, List<uint> attachedThreads)
    {
        for (var i = attachedThreads.Count - 1; i >= 0; i--)
        {
            AttachThreadInput(currentThread, attachedThreads[i], false);
        }
    }

    private static void SendAltKey()
    {
        SendKey(VK_MENU);
    }

    private static uint SendKey(ushort key)
    {
        var inputs = new[]
        {
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = key } } },
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = key, dwFlags = KEYEVENTF_KEYUP } } },
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    private static uint SendKeyChord(ushort modifier, ushort key)
    {
        var inputs = new[]
        {
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = modifier } } },
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = key } } },
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = key, dwFlags = KEYEVENTF_KEYUP } } },
            new INPUT { type = INPUT_KEYBOARD, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = modifier, dwFlags = KEYEVENTF_KEYUP } } },
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
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

    private static bool StopFlashingWithRetry(IntPtr hwnd)
    {
        var stopped = false;
        for (var i = 0; i < 8; i++)
        {
            stopped = StopFlashing(hwnd) || stopped;
            Thread.Sleep(i == 0 ? 80 : 40);
        }

        return stopped;
    }

    private static void DismissNotificationShellIfForeground(IntPtr targetHwnd)
    {
        if (!IsNotificationShellForeground())
        {
            return;
        }

        var shellHwnd = GetForegroundWindow();
        Log($"shell.dismiss before={DescribeForeground()}");
        var closePosted = PostMessage(shellHwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        Thread.Sleep(120);
        var sent = SendKey(VK_ESCAPE);

        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 350 && IsNotificationShellForeground())
        {
            Thread.Sleep(35);
        }

        uint chordSent = 0;
        if (IsNotificationShellForeground())
        {
            chordSent = SendKeyChord(VK_LWIN, VK_N);
            var chordWatch = Stopwatch.StartNew();
            while (chordWatch.ElapsedMilliseconds < 350 && IsNotificationShellForeground())
            {
                Thread.Sleep(35);
            }
        }

        var hidden = false;
        if (IsNotificationShellForeground())
        {
            hidden = ShowWindowAsync(shellHwnd, SW_HIDE);
            var hideWatch = Stopwatch.StartNew();
            while (hideWatch.ElapsedMilliseconds < 200 && IsNotificationShellForeground())
            {
                Thread.Sleep(25);
            }
        }

        var restarted = false;
        if (IsNotificationShellForeground())
        {
            restarted = RestartStuckNotificationShell(shellHwnd);
        }

        Log($"shell.dismiss closePosted={closePosted} escapeSent={sent}/2 winN={chordSent}/4 hidden={hidden} restarted={restarted} after={DescribeForeground()}");
    }

    private static bool RestartStuckNotificationShell(IntPtr shellHwnd)
    {
        if (shellHwnd == IntPtr.Zero || GetForegroundWindow() != shellHwnd || !IsNotificationShellForeground())
        {
            return false;
        }

        GetWindowThreadProcessId(shellHwnd, out var pid);
        if (pid == 0)
        {
            return false;
        }

        try
        {
            var process = Process.GetProcessById((int)pid);
            if (!string.Equals(process.ProcessName, "ShellExperienceHost", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            process.Kill();
            process.WaitForExit(800);

            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 900)
            {
                var foreground = GetForegroundWindow();
                GetWindowThreadProcessId(foreground, out var foregroundPid);
                if (foregroundPid != pid)
                {
                    Thread.Sleep(120);
                    Log($"shell.restart pid={pid} after={DescribeForeground()}");
                    return true;
                }

                Thread.Sleep(60);
            }

            Log($"shell.restart pid={pid} stillForeground={DescribeForeground()}");
            return true;
        }
        catch (Exception ex)
        {
            Log($"shell.restart.failed pid={pid} error={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private static bool TryTransferForegroundFromForegroundOwner(IntPtr targetHwnd)
    {
        var foregroundHwnd = GetForegroundWindow();
        if (foregroundHwnd == IntPtr.Zero || foregroundHwnd == targetHwnd)
        {
            return false;
        }

        GetWindowThreadProcessId(foregroundHwnd, out var foregroundPid);
        if (foregroundPid == 0)
        {
            return false;
        }

        var processName = GetWindowProcessName(foregroundHwnd);
        if (!string.Equals(processName, "ShellExperienceHost", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var process = OpenProcess(
            PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION,
            false,
            foregroundPid);
        if (process == IntPtr.Zero)
        {
            Log($"foreground.transfer.open.failed pid={foregroundPid} error={Marshal.GetLastWin32Error()}");
            return false;
        }

        try
        {
            var helperPid = Environment.ProcessId;
            GetWindowThreadProcessId(targetHwnd, out var targetPid);
            var allowed = TryCallRemoteUser32(process, "AllowSetForegroundWindow", new IntPtr(helperPid), out var allowExit, out var allowThread, out var allowWait, out var allowError);
            var targetAllowed = TryCallRemoteUser32(process, "AllowSetForegroundWindow", new IntPtr((int)targetPid), out var targetAllowExit, out var targetAllowThread, out var targetAllowWait, out var targetAllowError);
            var anyAllowed = TryCallRemoteUser32(process, "AllowSetForegroundWindow", new IntPtr(ASFW_ANY), out var anyAllowExit, out var anyAllowThread, out var anyAllowWait, out var anyAllowError);
            var unlocked = TryCallRemoteUser32(process, "LockSetForegroundWindow", new IntPtr(LSFW_UNLOCK), out var unlockExit, out var unlockThread, out var unlockWait, out var unlockError);
            var transferred = TryCallRemoteUser32(process, "SetForegroundWindow", targetHwnd, out var transferExit, out var transferThread, out var transferWait, out var transferError);
            Thread.Sleep(120);
            var localForeground = SetForegroundWindow(targetHwnd);
            Thread.Sleep(120);
            var ok = GetForegroundWindow() == targetHwnd;
            Log($"foreground.transfer pid={foregroundPid} process={processName} helperPid={helperPid} targetPid={targetPid} allow={allowed}/{allowExit}/t{allowThread}/w{allowWait}/e{allowError} allowTarget={targetAllowed}/{targetAllowExit}/t{targetAllowThread}/w{targetAllowWait}/e{targetAllowError} allowAny={anyAllowed}/{anyAllowExit}/t{anyAllowThread}/w{anyAllowWait}/e{anyAllowError} unlock={unlocked}/{unlockExit}/t{unlockThread}/w{unlockWait}/e{unlockError} remoteSet={transferred}/{transferExit}/t{transferThread}/w{transferWait}/e{transferError} localSet={localForeground} ok={ok} foreground={DescribeForeground()}");
            return ok;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    private static bool TryCallRemoteUser32(
        IntPtr process,
        string procName,
        IntPtr parameter,
        out uint exitCode,
        out uint threadId,
        out uint waitResult,
        out int error)
    {
        exitCode = 0;
        threadId = 0;
        waitResult = 0;
        error = 0;

        var user32 = GetModuleHandleW("user32.dll");
        var proc = user32 != IntPtr.Zero ? GetProcAddress(user32, procName) : IntPtr.Zero;
        if (proc == IntPtr.Zero)
        {
            error = Marshal.GetLastWin32Error();
            return false;
        }

        var thread = CreateRemoteThread(
            process,
            IntPtr.Zero,
            0,
            proc,
            parameter,
            0,
            out threadId);
        if (thread == IntPtr.Zero)
        {
            error = Marshal.GetLastWin32Error();
            return false;
        }

        try
        {
            waitResult = WaitForSingleObject(thread, 1_000);
            GetExitCodeThread(thread, out exitCode);
            return waitResult == WAIT_OBJECT_0 && exitCode != 0;
        }
        finally
        {
            CloseHandle(thread);
        }
    }

    private static bool IsNotificationShellForeground()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero)
        {
            return false;
        }

        var processName = GetWindowProcessName(hwnd);
        if (!string.Equals(processName, "ShellExperienceHost", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var title = GetWindowTitle(hwnd);
        return title.Contains("알림", StringComparison.OrdinalIgnoreCase)
            || title.Contains("notification", StringComparison.OrdinalIgnoreCase);
    }

    [UnconditionalSuppressMessage("Trimming", "IL2072", Justification = "WScript.Shell is a Windows COM automation object resolved at runtime.")]
    [UnconditionalSuppressMessage("Trimming", "IL2075", Justification = "WScript.Shell AppActivate is invoked through COM automation at runtime.")]
    private static bool TryAppActivateWindow(IntPtr hwnd)
    {
        var title = GetWindowTitle(hwnd);
        if (string.IsNullOrWhiteSpace(title))
        {
            return false;
        }

        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType is null)
            {
                return false;
            }

            var shell = Activator.CreateInstance(shellType);
            if (shell is null)
            {
                return false;
            }

            try
            {
                var result = shellType.InvokeMember("AppActivate", BindingFlags.InvokeMethod, null, shell, new object[] { title });
                var activated = result is bool ok && ok;
                Thread.Sleep(120);
                Log($"activation.appActivate result={activated} foreground={GetForegroundWindow() == hwnd} title=\"{title}\"");
                return activated;
            }
            finally
            {
                try { Marshal.FinalReleaseComObject(shell); } catch { }
            }
        }
        catch (Exception ex)
        {
            Log($"activation.appActivate.failed={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private static void ActivateWindowForTyping(IntPtr hwnd, uint targetThread, IntPtr preferredInputTarget)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
        {
            return;
        }

        var previousFocus = GetThreadFocusWindow(targetThread);
        var inputThread = preferredInputTarget != IntPtr.Zero ? GetWindowThreadProcessId(preferredInputTarget, out _) : 0;
        var previousInputFocus = GetThreadFocusWindow(inputThread);
        BringWindowToTop(hwnd);
        SwitchToThisWindow(hwnd, true);
        var foreground = SetForegroundWindow(hwnd);
        Thread.Sleep(60);
        var currentFocus = GetThreadFocusWindow(targetThread);
        var active = SetActiveWindow(hwnd);
        var focusTarget = hwnd;
        var focus = SetFocus(focusTarget);
        var foregroundAfterFocus = SetForegroundWindow(hwnd);
        Thread.Sleep(80);
        var ready = IsTypingTargetActive(hwnd, focusTarget);
        var finalTargetFocus = GetThreadFocusWindow(targetThread);
        var finalInputFocus = GetThreadFocusWindow(inputThread);
        Log($"activation.typing foreground={foreground} foregroundAfterFocus={foregroundAfterFocus} active={active.ToInt64()} previousFocus={DescribeWindow(previousFocus)} previousInputFocus={DescribeWindow(previousInputFocus)} currentFocus={DescribeWindow(currentFocus)} focusTarget={DescribeWindow(focusTarget)} focus={focus.ToInt64()} finalTargetFocus={DescribeWindow(finalTargetFocus)} finalInputFocus={DescribeWindow(finalInputFocus)} ready={ready} currentForeground={GetForegroundWindow() == hwnd}");
    }

    private static IntPtr ResolveFocusTarget(IntPtr hwnd, params IntPtr[] candidates)
    {
        foreach (var candidate in candidates)
        {
            if (candidate != IntPtr.Zero && IsWindow(candidate) && (candidate == hwnd || IsChild(hwnd, candidate)))
            {
                return candidate;
            }
        }

        return hwnd;
    }

    private static bool IsTypingTargetActive(IntPtr hwnd, IntPtr preferredInputTarget)
    {
        if (hwnd == IntPtr.Zero || GetForegroundWindow() != hwnd)
        {
            return false;
        }

        var targetThread = GetWindowThreadProcessId(hwnd, out _);
        if (IsThreadFocusedInsideWindow(hwnd, targetThread))
        {
            return true;
        }

        if (preferredInputTarget != IntPtr.Zero && IsWindow(preferredInputTarget))
        {
            var inputThread = GetWindowThreadProcessId(preferredInputTarget, out _);
            if (IsThreadFocusedInsideWindow(hwnd, inputThread))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsThreadFocusedInsideWindow(IntPtr hwnd, uint threadId)
    {
        var focus = GetThreadFocusWindow(threadId);
        return focus != IntPtr.Zero && IsWindow(focus) && (focus == hwnd || IsChild(hwnd, focus));
    }

    private static IntPtr FindPreferredInputChild(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
        {
            return IntPtr.Zero;
        }

        var children = new List<ChildWindowInfo>();
        _ = GetWindowThreadProcessId(hwnd, out var targetPid);
        EnumChildWindows(hwnd, (child, lParam) =>
        {
            if (!IsWindow(child) || !IsWindowVisible(child) || !IsWindowEnabled(child))
            {
                return true;
            }

            var className = GetWindowClassName(child);
            var threadId = GetWindowThreadProcessId(child, out var pid);
            var score = 0;
            if (string.Equals(className, ELECTRON_INPUT_CLASS, StringComparison.OrdinalIgnoreCase))
            {
                score += 100;
            }
            else if (className.Contains("Chrome", StringComparison.OrdinalIgnoreCase))
            {
                score += 20;
            }

            if (pid == targetPid)
            {
                score += 10;
            }

            children.Add(new ChildWindowInfo(child, threadId, pid, className, score));
            return true;
        }, IntPtr.Zero);

        var best = children
            .OrderByDescending(child => child.Score)
            .ThenBy(child => child.Pid == targetPid ? 0 : 1)
            .FirstOrDefault();
        var result = best.Hwnd != IntPtr.Zero && best.Score > 0 ? best.Hwnd : IntPtr.Zero;
        Log($"activation.inputTarget={DescribeWindow(result)} candidates={children.Count}");
        return result;
    }

    private static IntPtr GetThreadFocusWindow(uint threadId)
    {
        if (threadId == 0)
        {
            return IntPtr.Zero;
        }

        var info = new GUITHREADINFO
        {
            cbSize = (uint)Marshal.SizeOf<GUITHREADINFO>(),
        };
        return GetGUIThreadInfo(threadId, ref info) ? info.hwndFocus : IntPtr.Zero;
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
        var name = GetWindowProcessName(hwnd);
        return $"hwnd={hwnd.ToInt64()} pid={pid} process={name} title=\"{title}\"";
    }

    private static string DescribeWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return "hwnd=0";
        }

        var threadId = GetWindowThreadProcessId(hwnd, out var pid);
        var processName = GetWindowProcessName(hwnd);
        var className = GetWindowClassName(hwnd);
        var title = GetWindowTitle(hwnd);
        return $"hwnd={hwnd.ToInt64()} tid={threadId} pid={pid} process={processName} class=\"{className}\" title=\"{title}\"";
    }

    private static string GetWindowProcessName(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return "";
        }

        _ = GetWindowThreadProcessId(hwnd, out var pid);
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
    }

    private static string GetWindowTitle(IntPtr hwnd)
    {
        var sb = new StringBuilder(512);
        var len = GetWindowTextW(hwnd, sb, sb.Capacity);
        return len > 0 ? sb.ToString() : "";
    }

    private static string GetWindowClassName(IntPtr hwnd)
    {
        var sb = new StringBuilder(256);
        var len = GetClassNameW(hwnd, sb, sb.Capacity);
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

    private readonly record struct ChildWindowInfo(IntPtr Hwnd, uint ThreadId, uint Pid, string ClassName, int Score);

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hwndParent, EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsChild(IntPtr hwndParent, IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hwnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);

    [DllImport("user32.dll")]
    private static extern bool LockSetForegroundWindow(uint lockCode);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hwnd);

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
    private static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO guiThreadInfo);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string moduleName);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    private static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateRemoteThread(
        IntPtr hProcess,
        IntPtr lpThreadAttributes,
        uint dwStackSize,
        IntPtr lpStartAddress,
        IntPtr lpParameter,
        uint dwCreationFlags,
        out uint lpThreadId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeThread(IntPtr hThread, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

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
        [FieldOffset(0)] public MOUSEINPUT mi;
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
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GUITHREADINFO
    {
        public uint cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
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
