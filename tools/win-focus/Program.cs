// 책임: 진입점 - CLI 인자 라우팅과 포커스/실행 전체 흐름 오케스트레이션.
using System.Diagnostics;
using System.Runtime.Versioning;

[SupportedOSPlatform("windows")]
internal static partial class Program
{
    // URI 쿼리/CLI 인자에서 대상 정보를 뽑아, 후보 스코어링→대상 결정→(없으면 VS Code 실행)→포커스→플래시 정지 순으로 처리하고 성공 여부를 종료 코드로 돌려준다.
    private static int Main(string[] args)
    {
        var uri = Args.GetArg(args, "--uri") ?? (args.Length == 1 && args[0].Contains("://", StringComparison.Ordinal) ? args[0] : null);
        var cwd = Args.GetQueryValue(uri, "cwd") ?? Args.GetArg(args, "--cwd") ?? Environment.CurrentDirectory;
        var titleHint =
            Args.GetQueryValue(uri, "title")
            ?? Args.GetArg(args, "--title")
            ?? Path.GetFileName(cwd.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        var explicitHwnd = Args.TryParseLong(Args.GetQueryValue(uri, "hwnd") ?? Args.GetArg(args, "--hwnd"));
        var preferredPid = Args.TryParseInt(Args.GetQueryValue(uri, "pid") ?? Args.GetArg(args, "--pid"));
        var activationId = Args.GetQueryValue(uri, "id") ?? Args.GetArg(args, "--id");
        var targetKind = NormalizeTargetKind(Args.GetQueryValue(uri, "target") ?? Args.GetArg(args, "--target"));
        var openWhenMissing = Args.HasFlag(args, "--open") || Args.IsTruthy(Args.GetQueryValue(uri, "open"));
        var openInNewWindow = Args.HasFlag(args, "--new-window") || Args.IsTruthy(Args.GetQueryValue(uri, "newWindow"));
        var waitMs = Args.TryParseInt(Args.GetQueryValue(uri, "waitMs") ?? Args.GetArg(args, "--wait-ms")) ?? 6_000;
        var deferred = Args.HasFlag(args, "--deferred");
        var debug = string.Equals(Args.GetQueryValue(uri, "debug"), "1", StringComparison.OrdinalIgnoreCase);
        var listOnly = args.Contains("--list", StringComparer.OrdinalIgnoreCase);

        Logger._debug = debug;
        Logger.Log($"cwd={cwd}");
        Logger.Log($"titleHint={titleHint}");
        Logger.Log($"preferredPid={preferredPid?.ToString() ?? ""}");
        Logger.Log($"explicitHwnd={explicitHwnd?.ToString() ?? ""}");
        Logger.Log($"activationId={activationId ?? ""}");
        Logger.Log($"targetKind={targetKind}");
        Logger.Log($"openWhenMissing={openWhenMissing}");
        Logger.Log($"openInNewWindow={openInNewWindow}");
        Logger.Log($"waitMs={waitMs}");
        Logger.Log($"deferred={deferred}");
        Logger.Log($"debug={debug}");

        if (deferred)
        {
            WaitForNotificationShellToLeave(3_000);
            Logger.Log($"toast.defer.after={Logger.DescribeForeground()}");
        }

        var windows = GetScoredTargetWindows(cwd, titleHint, preferredPid, targetKind);
        LogCandidates(windows);

        if (listOnly)
        {
            return windows.Count > 0 ? 0 : 2;
        }

        WriteFlashStopSignal(activationId);

        var target = ResolveTarget(explicitHwnd, windows, targetKind);
        if ((target == IntPtr.Zero || !NativeMethods.IsWindow(target)) && openWhenMissing && targetKind == TargetVSCode)
        {
            var knownHwnds = windows.Select(w => w.Hwnd).ToHashSet();
            if (VSCodeLauncher.TryLaunchVSCode(cwd, openInNewWindow, windows))
            {
                target = WaitForCodeWindow(cwd, titleHint, preferredPid, knownHwnds, waitMs);
            }
        }

        if (target == IntPtr.Zero || !NativeMethods.IsWindow(target))
        {
            Logger.Log("target=0 or invalid");
            return 2;
        }

        Logger.Log($"target={target.ToInt64()}");
        var before = Logger.DescribeForeground();
        Logger.Log($"foreground.before={before}");

        var ok = FocusWindowWithRetry(target);
        var stopped = ok && StopFlashingWithRetry(target);
        Thread.Sleep(50);

        var after = Logger.DescribeForeground();
        Logger.Log($"foreground.after={after}");
        Logger.Log($"flash.stop={stopped}");
        Logger.Log($"success={ok || NativeMethods.GetForegroundWindow() == target}");

        return NativeMethods.GetForegroundWindow() == target ? 0 : 1;
    }

    // 알림 셸이 물러날 때까지 막히지 않도록, 같은 exe를 --deferred로 재실행해 포커스 작업을 별도 프로세스에 넘긴다.
    private static bool StartDeferredActivation(string uri)
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(exe) || !File.Exists(exe))
            {
                Logger.Log("toast.defer.start.failed=missing process path");
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
            Logger.Log("toast.defer.start=ok");
            return true;
        }
        catch (Exception ex)
        {
            Logger.Log($"toast.defer.start.failed={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }
}
