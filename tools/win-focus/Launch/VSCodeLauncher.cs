// 책임: VS Code 실행 파일 탐색과 창/프로젝트 새 창 실행.
using System.Diagnostics;

internal static class VSCodeLauncher
{
    // Code 실행 파일을 찾아 `code [-n] <cwd>`로 프로젝트를 여는데, .cmd/.bat 런처는 cmd.exe로 감싸고 실패는 로그로만 삼킨다.
    internal static bool TryLaunchVSCode(string cwd, bool newWindow, List<WindowInfo> knownWindows)
    {
        var command = ResolveVSCodeCommand(knownWindows);
        if (string.IsNullOrWhiteSpace(command))
        {
            Logger.Log("open.failed=no-code-command");
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

            Logger.Log($"open.started command=\"{command}\" newWindow={newWindow} cwd=\"{cwd}\"");
            return true;
        }
        catch (Exception ex)
        {
            Logger.Log($"open.failed={ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    // 실행 중인 Code 창의 실제 경로를 1순위로 쓰고, 없으면 표준 설치 경로와 PATH 후보를 순서대로 훑어 첫 실존 파일을 고른다.
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
}
