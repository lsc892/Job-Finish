// 책임: Windows 알림 셸(토스트 UI) 포그라운드 감지·해제·복구.
using System.Diagnostics;

internal static partial class Program
{
    private static void WaitForNotificationShellToLeave(int timeoutMs)
    {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs && IsNotificationShellForeground())
        {
            Thread.Sleep(80);
        }
    }

    // 알림 셸이 앞에 있으면 WM_CLOSE→ESC→Win+N→창 숨김→프로세스 재시작 순으로 단계별 강도를 높여 셸을 치워 포커스 경로를 연다.
    private static void DismissNotificationShellIfForeground(IntPtr targetHwnd)
    {
        if (!IsNotificationShellForeground())
        {
            return;
        }

        var shellHwnd = NativeMethods.GetForegroundWindow();
        Logger.Log($"shell.dismiss before={Logger.DescribeForeground()}");
        var closePosted = NativeMethods.PostMessage(shellHwnd, NativeMethods.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        Thread.Sleep(20);
        var sent = SendKey(NativeMethods.VK_ESCAPE);

        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 180 && IsNotificationShellForeground())
        {
            Thread.Sleep(20);
        }

        uint chordSent = 0;
        if (IsNotificationShellForeground())
        {
            chordSent = SendKeyChord(NativeMethods.VK_LWIN, NativeMethods.VK_N);
            var chordWatch = Stopwatch.StartNew();
            while (chordWatch.ElapsedMilliseconds < 180 && IsNotificationShellForeground())
            {
                Thread.Sleep(20);
            }
        }

        var hidden = false;
        if (IsNotificationShellForeground())
        {
            hidden = NativeMethods.ShowWindowAsync(shellHwnd, NativeMethods.SW_HIDE);
            var hideWatch = Stopwatch.StartNew();
            while (hideWatch.ElapsedMilliseconds < 80 && IsNotificationShellForeground())
            {
                Thread.Sleep(20);
            }
        }

        var restarted = false;
        if (IsNotificationShellForeground())
        {
            restarted = RestartStuckNotificationShell(shellHwnd);
        }

        Logger.Log($"shell.dismiss closePosted={closePosted} escapeSent={sent}/2 winN={chordSent}/4 hidden={hidden} restarted={restarted} after={Logger.DescribeForeground()}");
    }

    // 끝까지 안 물러나면 ShellExperienceHost 프로세스인지 확인하고 Kill해, 포그라운드 pid가 바뀔 때까지 최대 600ms 대기한다.
    private static bool RestartStuckNotificationShell(IntPtr shellHwnd)
    {
        if (shellHwnd == IntPtr.Zero || NativeMethods.GetForegroundWindow() != shellHwnd || !IsNotificationShellForeground())
        {
            return false;
        }

        NativeMethods.GetWindowThreadProcessId(shellHwnd, out var pid);
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
            process.WaitForExit(350);

            var watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 600)
            {
                var foreground = NativeMethods.GetForegroundWindow();
                NativeMethods.GetWindowThreadProcessId(foreground, out var foregroundPid);
                if (foregroundPid != pid)
                {
                    Thread.Sleep(40);
                    Logger.Log($"shell.restart pid={pid} after={Logger.DescribeForeground()}");
                    return true;
                }

                Thread.Sleep(40);
            }

            Logger.Log($"shell.restart pid={pid} stillForeground={Logger.DescribeForeground()}");
            return true;
        }
        catch (Exception ex)
        {
            Logger.Log($"shell.restart.failed pid={pid} error={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    // 포그라운드 창이 ShellExperienceHost이고 제목에 "알림"/"notification"이 들어갈 때만 알림 셸로 판정한다.
    private static bool IsNotificationShellForeground()
    {
        var hwnd = NativeMethods.GetForegroundWindow();
        if (hwnd == IntPtr.Zero)
        {
            return false;
        }

        var processName = Logger.GetWindowProcessName(hwnd);
        if (!string.Equals(processName, "ShellExperienceHost", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var title = Logger.GetWindowTitle(hwnd);
        return title.Contains("알림", StringComparison.OrdinalIgnoreCase)
            || title.Contains("notification", StringComparison.OrdinalIgnoreCase);
    }
}
