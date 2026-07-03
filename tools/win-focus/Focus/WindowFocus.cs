// 책임: 대상 창을 전면화하고 입력 포커스를 넣는 활성화 로직.
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Runtime.InteropServices;

internal static partial class Program
{
    private const int FOCUS_RETRY_MS = 6_000;
    private const string ELECTRON_INPUT_CLASS = "Chrome_RenderWidgetHostHWND";

    // 타이핑 대상이 활성화될 때까지 최대 6초 동안 FocusWindowOnce를 재시도하고, 끝내 실패해도 실제 입력 포커스가 들어갔는지로 최종 판정한다.
    private static bool FocusWindowWithRetry(IntPtr hwnd)
    {
        var watch = Stopwatch.StartNew();
        var attempt = 0;

        do
        {
            attempt++;
            var ok = FocusWindowOnce(hwnd);
            Logger.Log($"focus.attempt={attempt} ok={ok} foreground={Logger.DescribeForeground()}");
            if (ok)
            {
                return true;
            }

            Thread.Sleep(attempt == 1 ? 120 : 80);
        } while (watch.ElapsedMilliseconds < FOCUS_RETRY_MS);

        return IsTypingTargetActive(hwnd, FindPreferredInputChild(hwnd));
    }

    // 알림 셸을 치우고 관련 입력 스레드를 붙인 뒤, Alt 키 트릭·AllowSetForegroundWindow·TOPMOST 토글·AppActivate 등 Win32 전면화 기법을 총동원해 창을 앞으로 끌어온다.
    private static bool FocusWindowOnce(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !NativeMethods.IsWindow(hwnd))
        {
            return false;
        }

        DismissNotificationShellIfForeground(hwnd);

        var fg = NativeMethods.GetForegroundWindow();
        var fgThread = NativeMethods.GetWindowThreadProcessId(fg, out _);
        var targetThread = NativeMethods.GetWindowThreadProcessId(hwnd, out _);
        var currentThread = NativeMethods.GetCurrentThreadId();
        var inputTarget = FindPreferredInputChild(hwnd);
        var inputThread = inputTarget != IntPtr.Zero ? NativeMethods.GetWindowThreadProcessId(inputTarget, out _) : 0;

        var attachedThreads = AttachInputThreads(currentThread, fgThread, targetThread, inputThread);

        try
        {
            NativeMethods.AllowSetForegroundWindow(NativeMethods.ASFW_ANY);
            NativeMethods.LockSetForegroundWindow(NativeMethods.LSFW_UNLOCK);
            SendAltKey();

            if (NativeMethods.IsIconic(hwnd))
            {
                NativeMethods.ShowWindowAsync(hwnd, NativeMethods.SW_RESTORE);
                Thread.Sleep(120);
            }
            else
            {
                NativeMethods.ShowWindowAsync(hwnd, NativeMethods.SW_SHOW);
            }

            NativeMethods.BringWindowToTop(hwnd);
            NativeMethods.SetWindowPos(hwnd, NativeMethods.HWND_TOPMOST, 0, 0, 0, 0, NativeMethods.SWP_NOMOVE | NativeMethods.SWP_NOSIZE | NativeMethods.SWP_SHOWWINDOW);
            NativeMethods.SetWindowPos(hwnd, NativeMethods.HWND_NOTOPMOST, 0, 0, 0, 0, NativeMethods.SWP_NOMOVE | NativeMethods.SWP_NOSIZE | NativeMethods.SWP_SHOWWINDOW);
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

    // 포그라운드·대상·입력 스레드를 현재 스레드에 AttachThreadInput으로 묶어 SetForegroundWindow 제한을 우회하고, 나중에 되돌릴 목록을 반환한다.
    private static List<uint> AttachInputThreads(uint currentThread, params uint[] threads)
    {
        var attached = new List<uint>();
        foreach (var thread in threads.Distinct())
        {
            if (thread == 0 || thread == currentThread)
            {
                continue;
            }

            var ok = NativeMethods.AttachThreadInput(currentThread, thread, true);
            Logger.Log($"activation.attach thread={thread} ok={ok}");
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
            NativeMethods.AttachThreadInput(currentThread, attachedThreads[i], false);
        }
    }

    private static void SendAltKey()
    {
        SendKey(NativeMethods.VK_MENU);
    }

    private static uint SendKey(ushort key)
    {
        var inputs = new[]
        {
            new NativeMethods.INPUT { type = NativeMethods.INPUT_KEYBOARD, u = new NativeMethods.INPUTUNION { ki = new NativeMethods.KEYBDINPUT { wVk = key } } },
            new NativeMethods.INPUT { type = NativeMethods.INPUT_KEYBOARD, u = new NativeMethods.INPUTUNION { ki = new NativeMethods.KEYBDINPUT { wVk = key, dwFlags = NativeMethods.KEYEVENTF_KEYUP } } },
        };
        return NativeMethods.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<NativeMethods.INPUT>());
    }

    private static uint SendKeyChord(ushort modifier, ushort key)
    {
        var inputs = new[]
        {
            new NativeMethods.INPUT { type = NativeMethods.INPUT_KEYBOARD, u = new NativeMethods.INPUTUNION { ki = new NativeMethods.KEYBDINPUT { wVk = modifier } } },
            new NativeMethods.INPUT { type = NativeMethods.INPUT_KEYBOARD, u = new NativeMethods.INPUTUNION { ki = new NativeMethods.KEYBDINPUT { wVk = key } } },
            new NativeMethods.INPUT { type = NativeMethods.INPUT_KEYBOARD, u = new NativeMethods.INPUTUNION { ki = new NativeMethods.KEYBDINPUT { wVk = key, dwFlags = NativeMethods.KEYEVENTF_KEYUP } } },
            new NativeMethods.INPUT { type = NativeMethods.INPUT_KEYBOARD, u = new NativeMethods.INPUTUNION { ki = new NativeMethods.KEYBDINPUT { wVk = modifier, dwFlags = NativeMethods.KEYEVENTF_KEYUP } } },
        };
        return NativeMethods.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<NativeMethods.INPUT>());
    }

    [UnconditionalSuppressMessage("Trimming", "IL2072", Justification = "WScript.Shell is a Windows COM automation object resolved at runtime.")]
    [UnconditionalSuppressMessage("Trimming", "IL2075", Justification = "WScript.Shell AppActivate is invoked through COM automation at runtime.")]
    // 창 제목을 키로 WScript.Shell COM의 AppActivate를 호출해, Win32 API가 막힐 때의 우회 활성화 경로로 삼는다.
    private static bool TryAppActivateWindow(IntPtr hwnd)
    {
        var title = Logger.GetWindowTitle(hwnd);
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
                Thread.Sleep(60);
                Logger.Log($"activation.appActivate result={activated} foreground={NativeMethods.GetForegroundWindow() == hwnd} title=\"{title}\"");
                return activated;
            }
            finally
            {
                try { Marshal.FinalReleaseComObject(shell); } catch { }
            }
        }
        catch (Exception ex)
        {
            Logger.Log($"activation.appActivate.failed={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    // BringWindowToTop·SwitchToThisWindow·SetForegroundWindow·SetActiveWindow·SetFocus를 순서대로 걸어, 창 활성화를 넘어 실제 편집기 입력란까지 포커스가 들어가게 한다.
    private static void ActivateWindowForTyping(IntPtr hwnd, uint targetThread, IntPtr preferredInputTarget)
    {
        if (hwnd == IntPtr.Zero || !NativeMethods.IsWindow(hwnd))
        {
            return;
        }

        var previousFocus = GetThreadFocusWindow(targetThread);
        var inputThread = preferredInputTarget != IntPtr.Zero ? NativeMethods.GetWindowThreadProcessId(preferredInputTarget, out _) : 0;
        var previousInputFocus = GetThreadFocusWindow(inputThread);
        NativeMethods.BringWindowToTop(hwnd);
        NativeMethods.SwitchToThisWindow(hwnd, true);
        var foreground = NativeMethods.SetForegroundWindow(hwnd);
        Thread.Sleep(25);
        var currentFocus = GetThreadFocusWindow(targetThread);
        var active = NativeMethods.SetActiveWindow(hwnd);
        var focusTarget = hwnd;
        var focus = NativeMethods.SetFocus(focusTarget);
        var foregroundAfterFocus = NativeMethods.SetForegroundWindow(hwnd);
        Thread.Sleep(35);
        var ready = IsTypingTargetActive(hwnd, focusTarget);
        var finalTargetFocus = GetThreadFocusWindow(targetThread);
        var finalInputFocus = GetThreadFocusWindow(inputThread);
        Logger.Log($"activation.typing foreground={foreground} foregroundAfterFocus={foregroundAfterFocus} active={active.ToInt64()} previousFocus={Logger.DescribeWindow(previousFocus)} previousInputFocus={Logger.DescribeWindow(previousInputFocus)} currentFocus={Logger.DescribeWindow(currentFocus)} focusTarget={Logger.DescribeWindow(focusTarget)} focus={focus.ToInt64()} finalTargetFocus={Logger.DescribeWindow(finalTargetFocus)} finalInputFocus={Logger.DescribeWindow(finalInputFocus)} ready={ready} currentForeground={NativeMethods.GetForegroundWindow() == hwnd}");
    }

    private static IntPtr ResolveFocusTarget(IntPtr hwnd, params IntPtr[] candidates)
    {
        foreach (var candidate in candidates)
        {
            if (candidate != IntPtr.Zero && NativeMethods.IsWindow(candidate) && (candidate == hwnd || NativeMethods.IsChild(hwnd, candidate)))
            {
                return candidate;
            }
        }

        return hwnd;
    }

    // 대상 창이 포그라운드이면서 그 창(또는 선호 입력 자식) 안으로 GUI 포커스가 들어가 있어야 "바로 타이핑 가능" 상태로 인정한다.
    private static bool IsTypingTargetActive(IntPtr hwnd, IntPtr preferredInputTarget)
    {
        if (hwnd == IntPtr.Zero || NativeMethods.GetForegroundWindow() != hwnd)
        {
            return false;
        }

        var targetThread = NativeMethods.GetWindowThreadProcessId(hwnd, out _);
        if (IsThreadFocusedInsideWindow(hwnd, targetThread))
        {
            return true;
        }

        if (preferredInputTarget != IntPtr.Zero && NativeMethods.IsWindow(preferredInputTarget))
        {
            var inputThread = NativeMethods.GetWindowThreadProcessId(preferredInputTarget, out _);
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
        return focus != IntPtr.Zero && NativeMethods.IsWindow(focus) && (focus == hwnd || NativeMethods.IsChild(hwnd, focus));
    }

    // 자식 창을 열거해 Electron 입력 클래스(Chrome_RenderWidgetHostHWND)·같은 pid에 가중치를 줘, 포커스를 넣을 실제 편집 영역을 골라낸다.
    private static IntPtr FindPreferredInputChild(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !NativeMethods.IsWindow(hwnd))
        {
            return IntPtr.Zero;
        }

        var children = new List<ChildWindowInfo>();
        _ = NativeMethods.GetWindowThreadProcessId(hwnd, out var targetPid);
        NativeMethods.EnumChildWindows(hwnd, (child, lParam) =>
        {
            if (!NativeMethods.IsWindow(child) || !NativeMethods.IsWindowVisible(child) || !NativeMethods.IsWindowEnabled(child))
            {
                return true;
            }

            var className = Logger.GetWindowClassName(child);
            var threadId = NativeMethods.GetWindowThreadProcessId(child, out var pid);
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
        Logger.Log($"activation.inputTarget={Logger.DescribeWindow(result)} candidates={children.Count}");
        return result;
    }

    private static IntPtr GetThreadFocusWindow(uint threadId)
    {
        if (threadId == 0)
        {
            return IntPtr.Zero;
        }

        var info = new NativeMethods.GUITHREADINFO
        {
            cbSize = (uint)Marshal.SizeOf<NativeMethods.GUITHREADINFO>(),
        };
        return NativeMethods.GetGUIThreadInfo(threadId, ref info) ? info.hwndFocus : IntPtr.Zero;
    }
}
