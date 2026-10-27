// 토스트 클릭을 수신하는 COM 서버와 활성화 콜백의 수명을 관리한다.
using System.ComponentModel;
using System.Runtime.InteropServices;

/** 토스트 COM 서버를 등록하고 STA 메시지 루프의 수명을 관리한다. */
public static class ComActivator
{
    internal static int Run()
    {
        Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero, 2));
        try
        {
            var factory = new ToastFactory();
            var unknown = Marshal.GetIUnknownForObject(factory);
            uint cookie;
            try
            {
                var clsid = Registration.Activator;
                // Publish one local-server activation on this STA.
                Marshal.ThrowExceptionForHR(CoRegisterClassObject(ref clsid, unknown, 4, 0, out cookie));
            }
            finally { Marshal.Release(unknown); }
            try
            {
                Message message;
                int received;
                while ((received = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0)
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
                if (received < 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                return unchecked((int)message.WParam.ToUInt64());
            }
            finally { CoRevokeClassObject(cookie); GC.KeepAlive(factory); }
        }
        finally { CoUninitialize(); }
    }

    /** Windows가 요청한 토스트 활성화 콜백의 COM 인스턴스를 생성한다. */
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class ToastFactory : StandardOleMarshalObject, IClassFactory
    {
        public int CreateInstance(IntPtr outer, ref Guid iid, out IntPtr instance)
        {
            instance = IntPtr.Zero;
            if (outer != IntPtr.Zero) return unchecked((int)0x80040110);
            var unknown = Marshal.GetIUnknownForObject(new ToastCallback());
            try { return Marshal.QueryInterface(unknown, ref iid, out instance); }
            finally { Marshal.Release(unknown); }
        }
        public int LockServer(bool locked) => 0;
    }

    // Standard marshaling keeps the callback and its quit message on the host STA.
    /** COM 토스트 활성화를 클릭 처리에 전달하고 서버 종료를 요청한다. */
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class ToastCallback : StandardOleMarshalObject, INotificationActivationCallback
    {
        public int Activate(string appId, string arguments, IntPtr data, uint count)
        {
            var exitCode = 2;
            try
            {
                if (appId != Program.AppId) return unchecked((int)0x80070057);
                exitCode = Program.ClickPayload(arguments);
                return 0;
            }
            catch (Exception error) { exitCode = 1; return error.HResult; }
            finally { PostQuitMessage(exitCode); }
        }
    }

    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Hwnd; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Private; }
    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, uint mode);
    [DllImport("ole32.dll")] static extern void CoUninitialize();
    [DllImport("ole32.dll")] static extern int CoRegisterClassObject(ref Guid clsid, IntPtr factory, uint context, uint flags, out uint cookie);
    [DllImport("ole32.dll")] static extern int CoRevokeClassObject(uint cookie);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern int GetMessage(out Message message, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll")] static extern void PostQuitMessage(int exitCode);
}

[ComVisible(true), Guid("00000001-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IClassFactory
{
    [PreserveSig] int CreateInstance(IntPtr outer, ref Guid iid, out IntPtr instance);
    [PreserveSig] int LockServer([MarshalAs(UnmanagedType.Bool)] bool locked);
}

[ComVisible(true), Guid("53E31837-6600-4A81-9395-75CFFE746F94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface INotificationActivationCallback
{
    [PreserveSig] int Activate([MarshalAs(UnmanagedType.LPWStr)] string appId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments, IntPtr data, uint count);
}
