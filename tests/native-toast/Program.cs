using System.Security.Cryptography;

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
