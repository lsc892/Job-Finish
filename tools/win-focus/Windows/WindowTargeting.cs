// 책임: 후보 창 중 포커스 대상 결정과 창 등장 대기.
using System.Diagnostics;

internal static partial class Program
{
    // 명시된 hwnd가 유효하면 우선하되, 점수 90 이상인 스코어링 우승 창이 더 강하면 그쪽을 택하고, 둘 다 없으면 창이 하나일 때만 그 창을 쓴다.
    private static IntPtr ResolveTarget(long? explicitHwnd, List<WindowInfo> windows, string targetKind)
    {
        var best = windows.FirstOrDefault(w => w.Score >= 90);

        if (explicitHwnd is > 0)
        {
            var requested = new IntPtr(explicitHwnd.Value);
            if (NativeMethods.IsWindow(requested))
            {
                var explicitWindow = windows.FirstOrDefault(w => w.Hwnd == requested);
                if (explicitWindow.Hwnd != IntPtr.Zero)
                {
                    if (explicitWindow.Score >= 90 || best.Hwnd == IntPtr.Zero || best.Hwnd == requested)
                    {
                        Logger.Log($"using explicit hwnd={requested.ToInt64()} score={explicitWindow.Score}");
                        return requested;
                    }

                    Logger.Log($"explicit hwnd score={explicitWindow.Score} is weaker than scored target hwnd={best.Hwnd.ToInt64()} score={best.Score}");
                    return best.Hwnd;
                }

                if (best.Hwnd != IntPtr.Zero && best.Score >= 90)
                {
                    Logger.Log($"explicit hwnd did not match cwd/title; using scored target hwnd={best.Hwnd.ToInt64()} score={best.Score}");
                    return best.Hwnd;
                }

                if (targetKind == TargetCodexDesktop)
                {
                    var fallback = windows.Count == 1 ? windows[0].Hwnd : IntPtr.Zero;
                    Logger.Log($"explicit hwnd is not a Codex desktop window; fallback={fallback.ToInt64()}");
                    return fallback;
                }

                return requested;
            }
            Logger.Log($"explicit hwnd invalid: {explicitHwnd.Value}");
        }

        if (best.Hwnd != IntPtr.Zero)
        {
            return best.Hwnd;
        }

        return windows.Count == 1 ? windows[0].Hwnd : IntPtr.Zero;
    }

    // 새로 연 창이 뜰 때까지 250ms 간격으로 재탐색하며, 점수 매칭 창→기존에 없던 새 창→유일 창 순으로 잡고 제한 시간이면 0을 돌려준다.
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
            var windows = GetScoredTargetWindows(cwd, titleHint, preferredPid, TargetVSCode);
            var best = windows.FirstOrDefault(w => w.Score >= 90);
            if (best.Hwnd != IntPtr.Zero)
            {
                Logger.Log($"opened.match hwnd={best.Hwnd.ToInt64()} score={best.Score} title=\"{best.Title}\"");
                return best.Hwnd;
            }

            var newWindow = windows.FirstOrDefault(w => !knownHwnds.Contains(w.Hwnd));
            if (newWindow.Hwnd != IntPtr.Zero)
            {
                Logger.Log($"opened.new hwnd={newWindow.Hwnd.ToInt64()} title=\"{newWindow.Title}\"");
                return newWindow.Hwnd;
            }

            if (knownHwnds.Count == 0 && windows.Count == 1)
            {
                Logger.Log($"opened.single hwnd={windows[0].Hwnd.ToInt64()} title=\"{windows[0].Title}\"");
                return windows[0].Hwnd;
            }

            Thread.Sleep(250);
        } while (watch.ElapsedMilliseconds < boundedWaitMs);

        Logger.Log("opened.wait.timeout");
        return IntPtr.Zero;
    }
}
