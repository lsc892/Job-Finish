using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;

internal static class ComActivationTests
{
    static readonly Guid Activator = new("903FBE91-746B-4BB5-84A8-DBAA32C34F42");
    const string RegistryParent = @"Software\Classes\CLSID\{903FBE91-746B-4BB5-84A8-DBAA32C34F42}";
    const string RegistryLeaf = RegistryParent + @"\LocalServer32";

    static Process[] Helpers(string binary) => Process.GetProcessesByName(Path.GetFileNameWithoutExtension(binary))
        .Where(process => string.Equals(process.MainModule!.FileName, binary, StringComparison.OrdinalIgnoreCase)).ToArray();

    static int Main(string[] args)
    {
        var binary = Path.GetFullPath(args[0]);
        var existing = Helpers(binary);
        var existingIds = existing.Select(process => process.Id).ToHashSet();
        foreach (var process in existing) process.Dispose();
        using var parentBefore = Registry.CurrentUser.OpenSubKey(RegistryParent);
        using var leafBefore = Registry.CurrentUser.OpenSubKey(RegistryLeaf);
        var values = new[] { "", "ServerExecutable" }.ToDictionary(name => name, name =>
        {
            var stored = leafBefore?.GetValueNames().FirstOrDefault(value => string.Equals(value, name, StringComparison.OrdinalIgnoreCase));
            return stored != null
                ? (Name: stored, Value: leafBefore!.GetValue(stored, null, RegistryValueOptions.DoNotExpandEnvironmentNames), Kind: leafBefore.GetValueKind(stored))
                : (Name: name, Value: (object?)null, Kind: RegistryValueKind.None);
        });
        try
        {
            using (var leaf = Registry.CurrentUser.CreateSubKey(RegistryLeaf))
            {
                leaf.SetValue("", $"\"{binary}\" --activate", RegistryValueKind.String);
                leaf.SetValue("ServerExecutable", binary, RegistryValueKind.String);
            }
            // Keep registry restoration outside the RPC call, even if activation gets stuck.
            var invocation = Task.Run(() => Invoke(binary, existingIds, args[1], args[2], int.Parse(args[3]), uint.Parse(args[4])));
            if (!invocation.Wait(TimeSpan.FromSeconds(12))) throw new TimeoutException("COM callback did not finish");
            invocation.GetAwaiter().GetResult();
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally
        {
            foreach (var process in Helpers(binary))
            {
                using (process)
                    if (!existingIds.Contains(process.Id) && !process.HasExited) { process.Kill(); process.WaitForExit(2000); }
            }
            if (leafBefore == null) Registry.CurrentUser.DeleteSubKey(RegistryLeaf, false);
            else
            {
                using var leaf = Registry.CurrentUser.OpenSubKey(RegistryLeaf, true)!;
                foreach (var (name, saved) in values)
                    if (saved.Value == null) leaf.DeleteValue(name, false);
                    else leaf.SetValue(saved.Name, saved.Value, saved.Kind);
            }
            if (parentBefore == null)
            {
                using var parent = Registry.CurrentUser.OpenSubKey(RegistryParent);
                if (parent is { SubKeyCount: 0, ValueCount: 0 }) Registry.CurrentUser.DeleteSubKey(RegistryParent, false);
            }
        }
    }

    static void Invoke(string binary, HashSet<int> existingIds, string appId, string payload, int expectedExit, uint expectedHResult)
    {
        Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero, 0));
        object? callback = null;
        try
        {
            var clsid = Activator;
            var iid = typeof(INotificationActivationCallback).GUID;
            Marshal.ThrowExceptionForHR(CoCreateInstance(ref clsid, IntPtr.Zero, 4, ref iid, out var pointer));
            try { callback = Marshal.GetObjectForIUnknown(pointer); }
            finally { Marshal.Release(pointer); }
            var started = Helpers(binary).Where(process => !existingIds.Contains(process.Id)).ToArray();
            if (started.Length != 1) throw new Exception($"Expected one COM server process, found {started.Length}");
            using var host = started[0];
            // COM starts the host; retain its OS handle before the callback can exit it.
            var hostHandle = host.SafeHandle;
            var helperPid = host.Id;
            var result = ((INotificationActivationCallback)callback).Activate(appId, payload, IntPtr.Zero, 0);
            if (unchecked((uint)result) != expectedHResult) throw new Exception($"Unexpected callback HRESULT: 0x{result:X8}");
            if (!host.WaitForExit(5000)) throw new Exception("COM helper remained running after callback");
            if (!GetExitCodeProcess(hostHandle, out var helperExit)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (helperExit != expectedExit) throw new Exception($"Unexpected COM helper exit code: {helperExit}");
            Console.WriteLine(JsonSerializer.Serialize(new { hresult = unchecked((uint)result), helperPid, helperExit }));
        }
        finally
        {
            if (callback != null) Marshal.FinalReleaseComObject(callback);
            CoUninitialize();
        }
    }

    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, uint mode);
    [DllImport("ole32.dll")] static extern void CoUninitialize();
    [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, out IntPtr instance);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(Microsoft.Win32.SafeHandles.SafeProcessHandle process, out uint exitCode);
}

[ComImport, Guid("53E31837-6600-4A81-9395-75CFFE746F94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface INotificationActivationCallback
{
    [PreserveSig] int Activate([MarshalAs(UnmanagedType.LPWStr)] string appId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments, IntPtr data, uint count);
}
