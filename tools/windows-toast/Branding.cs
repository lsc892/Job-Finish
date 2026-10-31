// 설치된 VS Code의 실행 파일과 토스트 헤더용 앱 이미지를 찾는다.
using Microsoft.Win32;
using System.Xml;
using System.Xml.Linq;

/** VS Code 설치 정보와 시각 리소스 manifest에서 알림 앱 아이콘을 해석한다. */
internal static class Branding
{
    internal record Icon(string Executable, string? Image);

    internal static Icon? Resolve(string? codeExecutable)
    {
        var candidates = new List<string?> { codeExecutable };
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var app = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\Code.exe");
            candidates.Add(app?.GetValue("") as string);
        }
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Microsoft VS Code", "Code.exe"));
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft VS Code", "Code.exe"));
        foreach (var candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate) || !Path.IsPathFullyQualified(candidate) || !File.Exists(candidate)) continue;
            var executable = Path.GetFullPath(candidate);
            return new(executable, Image(executable));
        }
        return null;
    }

    // VS Code can place resources inside a version directory after an update.
    // Its visual manifest is the source of truth for the installed app image.
    internal static string? Image(string executable)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(executable))!;
        var manifest = Path.ChangeExtension(executable, ".VisualElementsManifest.xml");
        if (File.Exists(manifest))
        {
            try
            {
                using var reader = XmlReader.Create(manifest, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 32768 });
                var element = XDocument.Load(reader).Descendants().FirstOrDefault(item => item.Name.LocalName == "VisualElements");
                var relative = element?.Attribute("Square70x70Logo")?.Value;
                if (!string.IsNullOrWhiteSpace(relative) && !Path.IsPathRooted(relative))
                {
                    var path = Path.GetFullPath(Path.Combine(directory, relative));
                    if (path.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                        && File.Exists(path)) return path;
                }
            }
            catch (Exception error) when (error is XmlException or IOException or UnauthorizedAccessException or ArgumentException) { }
        }
        var resource = Path.Combine(directory, "resources", "app", "resources", "win32", "code_70x70.png");
        return File.Exists(resource) ? resource : null;
    }
}
