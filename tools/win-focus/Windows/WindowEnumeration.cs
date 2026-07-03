// 책임: 열린 창 열거와 VS Code 후보 스코어링.
using System.Diagnostics;

internal static partial class Program
{
    // 최상위 창을 열거해 프로세스명이 Code인 것만 남기고, 점수(내림차순)→Z순서(오름차순)로 정렬해 가장 적합한 창을 앞에 둔다.
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
            Logger.Log($"candidate hwnd={w.Hwnd.ToInt64()} pid={w.Pid} score={w.Score} title=\"{w.Title}\" path=\"{w.Path}\"");
        }
    }

    // preferredPid 일치(+10)·제목의 cwd 포함(+200)·titleHint 포함(+100)·폴더명 포함(+90)에 가중치를 더해 창의 적합도를 매긴다.
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

    // EnumWindows 콜백으로 보이는 창을 Z순서대로 훑으며 제목·pid·프로세스 경로를 모아 WindowInfo 목록으로 만든다.
    private static List<WindowInfo> EnumerateTopLevelWindows()
    {
        var result = new List<WindowInfo>();
        var z = 0;
        NativeMethods.EnumWindows((hwnd, lParam) =>
        {
            z++;
            if (!NativeMethods.IsWindowVisible(hwnd)) return true;

            var title = Logger.GetWindowTitle(hwnd);
            if (string.IsNullOrWhiteSpace(title)) return true;

            NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
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
}
