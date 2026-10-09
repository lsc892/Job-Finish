using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

internal static class Registration
{
    // The shortcut and AUMID registration use this toast callback's CLSID.
    internal static readonly Guid Activator = new("903FBE91-746B-4BB5-84A8-DBAA32C34F42");
    const string ShortcutName = "Job-Finish Native Notifications.lnk";
    static readonly Guid AppProperties = new("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    internal static void ProtocolChanged() => SHChangeNotify(0x08000000, 0x1000, null, IntPtr.Zero);
    internal record Result(bool Changed, string? LegacyBackup);
    internal record ShortcutInfo(string AppId, string Executable, Guid? Activator);

    internal static Result Shortcut(string appId, string executable, string programs, string backupRoot)
    {
        var path = Path.Combine(programs, ShortcutName);
        Directory.CreateDirectory(programs);
        var current = File.Exists(path) ? Read(path) : null;
        if (current != null && current.AppId != appId) throw new InvalidOperationException("Native notification shortcut belongs to another application");
        var changed = current == null || !string.Equals(current.Executable, executable, StringComparison.OrdinalIgnoreCase) || current.Activator != Activator;
        if (changed)
        {
            if (current != null) Backup(path, backupRoot);
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try { Write(temporary, appId, executable, Activator); File.Move(temporary, path, true); }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            SHChangeNotify(current == null ? 2u : 0x2000u, 0x1005, path, IntPtr.Zero);
        }
        // This exact legacy shortcut is ours only when its stored AUMID matches.
        // SnoreToast's shared COM registration may belong to other apps: leave it alone.
        string? legacyBackup = null;
        var legacy = Path.Combine(programs, "Job-Finish.lnk");
        if (File.Exists(legacy) && Read(legacy).AppId == appId)
        {
            legacyBackup = Backup(legacy, backupRoot);
            File.Delete(legacy);
            SHChangeNotify(4, 0x1005, legacy, IntPtr.Zero);
        }
        return new(changed, legacyBackup);
    }

    static string Backup(string path, string root)
    {
        Directory.CreateDirectory(root);
        var backup = Path.Combine(root, Path.GetFileNameWithoutExtension(path) + "-" + Guid.NewGuid().ToString("N") + ".lnk");
        File.Copy(path, backup); return backup;
    }

    internal static ShortcutInfo Read(string path)
    {
        var instance = new ShellLink();
        try
        {
            ((IPersistFile)instance).Load(path, 0);
            var target = new StringBuilder(32768); ((IShellLinkW)instance).GetPath(target, target.Capacity, IntPtr.Zero, 4);
            var store = (IPropertyStore)instance;
            var key = new PropertyKey { Format = AppProperties, Id = 5 };
            store.GetValue(ref key, out var app);
            string appId;
            try { appId = app.Type == 31 ? Marshal.PtrToStringUni(app.Pointer) ?? "" : ""; }
            finally { PropVariantClear(ref app); }
            key.Id = 26; store.GetValue(ref key, out var activator);
            try { return new(appId, target.ToString(), activator.Type == 72 ? Marshal.PtrToStructure<Guid>(activator.Pointer) : null); }
            finally { PropVariantClear(ref activator); }
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }

    internal static void Write(string path, string appId, string executable, Guid? activator)
    {
        var instance = new ShellLink();
        try
        {
            var link = (IShellLinkW)instance;
            link.SetPath(executable);
            link.SetDescription("Job-Finish native Windows notifications");
            link.SetWorkingDirectory(Path.GetDirectoryName(executable)!);
            var store = (IPropertyStore)instance;
            var key = new PropertyKey { Format = AppProperties, Id = 5 };
            var value = new PropVariant { Type = 31, Pointer = Marshal.StringToCoTaskMemUni(appId) };
            try { store.SetValue(ref key, ref value); store.Commit(); }
            finally { Marshal.FreeCoTaskMem(value.Pointer); }
            if (activator.HasValue)
            {
                key.Id = 26;
                value = new PropVariant { Type = 72, Pointer = Marshal.AllocCoTaskMem(16) };
                try { Marshal.StructureToPtr(activator.Value, value.Pointer, false); store.SetValue(ref key, ref value); store.Commit(); }
                finally { PropVariantClear(ref value); }
            }
            ((IPersistFile)instance).Save(path, true);
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }

    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern void SHChangeNotify(uint events, uint flags, string? path, IntPtr other);

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }
    [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Pointer; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int max, IntPtr data, uint flags);
        void GetIDList(out IntPtr id);
        void SetIDList(IntPtr id);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int max);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int max);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int command);
        void SetShowCmd(int command);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int max, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr hwnd, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }
}
