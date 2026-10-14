using System.Security.Cryptography;
using System.Xml.Linq;

internal static class RegistrationTests
{
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    [STAThread]
    static void Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "job-finish-registration-" + Guid.NewGuid().ToString("N"));
        var programs = Path.Combine(root, "programs"); var backups = Path.Combine(root, "backups");
        var executable = Environment.ProcessPath!; const string app = "JobFinish.RegistrationTest";
        var canonical = Path.Combine(programs, "Job-Finish Native Notifications.lnk");
        var legacy = Path.Combine(programs, "Job-Finish.lnk");
        Directory.CreateDirectory(programs);
        try
        {
            // Migrate the two old shortcuts while preserving their exact contents outside Programs.
            Registration.Write(canonical, app, executable, null);
            Registration.Write(legacy, app, executable, Guid.NewGuid());
            var oldCanonical = Hash(canonical); var oldLegacy = Hash(legacy);
            var result = Registration.Shortcut(app, executable, programs, backups);
            Check(result.Changed && result.LegacyBackup != null, "Both old registrations must migrate");
            Check(!File.Exists(legacy) && Hash(result.LegacyBackup!) == oldLegacy, "Legacy backup must preserve original bytes");
            Check(Directory.GetFiles(backups).Any(path => Hash(path) == oldCanonical), "Native shortcut must also be backed up before replacement");
            var info = Registration.Read(canonical);
            Check(info.AppId == app && info.Activator == Registration.Activator, "Native shortcut requires the correct AUMID and callback CLSID");
            Check(string.Equals(info.Executable, executable, StringComparison.OrdinalIgnoreCase), "Native shortcut must target this helper");
            var lastWrite = File.GetLastWriteTimeUtc(canonical); var hash = Hash(canonical);
            var second = Registration.Shortcut(app, executable, programs, backups);
            Check(!second.Changed && second.LegacyBackup == null, "Repeated registration must be idempotent");
            Check(Hash(canonical) == hash && File.GetLastWriteTimeUtc(canonical) == lastWrite, "Do not rewrite an unchanged shortcut");
            Check(Directory.GetFiles(backups).Length == 2, "Do not create duplicate backups");
            Console.WriteLine("Native registration passed: migration, callback CLSID, exact backups, idempotence");

            var installation = Path.Combine(root, "install"); Directory.CreateDirectory(installation);
            var iconPath = Path.Combine(installation, "Code.exe"); File.WriteAllBytes(iconPath, []);
            var iconMigration = Registration.Shortcut(app, executable, programs, backups, iconPath);
            info = Registration.Read(canonical);
            Check(iconMigration.Changed && info.IconPath == iconPath && info.IconIndex == 0, "An existing shortcut must adopt the VS Code icon");
            Check(info.AppId == app && info.Activator == Registration.Activator && info.Executable == executable, "Changing the icon must preserve helper activation");
            Check(Directory.GetFiles(backups).Length == 3 && Directory.GetFiles(backups).Any(path => Hash(path) == hash), "Icon migration must back up the previous shortcut exactly");
            lastWrite = File.GetLastWriteTimeUtc(canonical); hash = Hash(canonical);
            Check(!Registration.Shortcut(app, executable, programs, backups, iconPath).Changed, "Repeated icon registration must be idempotent");
            Check(Hash(canonical) == hash && File.GetLastWriteTimeUtc(canonical) == lastWrite && Directory.GetFiles(backups).Length == 3, "Do not rewrite or back up an unchanged icon");
            Console.WriteLine("Native registration passed: VS Code icon migration preserves activation and idempotence");

            var resources = Path.Combine(installation, "version", "resources", "app", "resources", "win32");
            Directory.CreateDirectory(resources);
            var image = Path.Combine(resources, "code_70x70.png"); File.WriteAllBytes(image, [1]);
            var relativeImage = Path.GetRelativePath(installation, image);
            new XDocument(new XElement("Application", new XElement("VisualElements", new XAttribute("Square70x70Logo", relativeImage))))
                .Save(Path.ChangeExtension(iconPath, ".VisualElementsManifest.xml"));
            var resolvedIcon = Branding.Resolve(iconPath);
            Check(resolvedIcon?.Executable == iconPath && resolvedIcon.Image == image, "Resolve versioned and portable VS Code images from their visual manifest");
            File.WriteAllBytes(Path.Combine(root, "outside.png"), [1]);
            new XDocument(new XElement("Application", new XElement("VisualElements", new XAttribute("Square70x70Logo", "..\\outside.png"))))
                .Save(Path.ChangeExtension(iconPath, ".VisualElementsManifest.xml"));
            Check(Branding.Image(iconPath) == null, "Manifest resources must remain inside the VS Code install directory");
            Console.WriteLine("Native branding passed: installed image manifest resolution and path boundary");

            var customImage = Path.Combine(root, "사용자 & ' icon.png"); File.WriteAllBytes(customImage, [1]);
            const string title = "작업 제목 <완료> & 이름"; const string message = "AI 응답: <태그> & 글자\n다음 줄"; const string launch = "payload\" & <tag>";
            var content = XDocument.Parse(ToastContent.Build(title, message, launch, customImage));
            var binding = content.Descendants("binding").Single(); var text = binding.Elements("text").ToArray();
            Check(text.Length == 2 && text[0].Value == title && text[1].Value == message, "Toast text must preserve Unicode, markup characters and response line breaks");
            Check((string?)text[0].Attribute("hint-maxLines") == "1" && (string?)text[1].Attribute("hint-maxLines") == "4", "Use one title line and Windows' four description lines");
            Check((string?)content.Root?.Attribute("launch") == launch, "XML escaping must preserve the activation payload");
            var logo = binding.Elements("image").Single();
            Check((string?)logo.Attribute("placement") == "appLogoOverride" && (string?)logo.Attribute("hint-crop") == "none", "Optional icon belongs left of the visual text without circle cropping");
            Check(new Uri((string)logo.Attribute("src")!).LocalPath == customImage, "Custom image paths must be emitted as correctly escaped local file URIs");
            foreach (var disabled in new string?[] { null, "", "relative.png", Path.Combine(root, "missing.png") })
                Check(!XDocument.Parse(ToastContent.Build(title, message, launch, disabled)).Descendants("image").Any(), "Disabled or unavailable icons must preserve text-only delivery");
            Console.WriteLine("Native toast content passed: optional icons, escaped paths/text, title and response line limits");

            // Identical filenames are insufficient evidence of ownership.
            Registration.Write(legacy, "Another.App", executable, null);
            var foreignHash = Hash(legacy);
            Registration.Shortcut(app, executable, programs, backups);
            Check(Hash(legacy) == foreignHash, "Preserve foreign legacy shortcut");
            Registration.Write(canonical, "Another.App", executable, null);
            foreignHash = Hash(canonical);
            try { Registration.Shortcut(app, executable, programs, backups); throw new Exception("Expected ownership rejection"); }
            catch (InvalidOperationException) { }
            Check(Hash(canonical) == foreignHash, "Preserve foreign canonical shortcut");
            Console.WriteLine("Native registration passed: foreign shortcut protection");
        }
        finally
        {
            var resolved = Path.GetFullPath(root);
            if (!resolved.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase)) throw new Exception("Unexpected test cleanup path");
            Directory.Delete(resolved, true);
        }
    }
}
