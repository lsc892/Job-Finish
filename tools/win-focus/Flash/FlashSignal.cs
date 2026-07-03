// 책임: 작업표시줄 플래시 중단 신호 파일 쓰기와 플래시 정지 처리.
using System.Runtime.InteropServices;
using System.Text;

internal static partial class Program
{
    // activationId를 파일명에 안전한 문자로 정제해 temp에 신호 파일을 남겨, 별도 플래시 워커 프로세스가 이를 보고 스스로 멈추게 한다.
    private static void WriteFlashStopSignal(string? activationId)
    {
        if (string.IsNullOrWhiteSpace(activationId))
        {
            return;
        }

        var safeId = new string(activationId.Where(c => char.IsLetterOrDigit(c) || c is '-' or '_').ToArray());
        if (string.IsNullOrWhiteSpace(safeId))
        {
            return;
        }

        try
        {
            var path = Path.Combine(Path.GetTempPath(), $"job-finish-flash-stop-{safeId}.signal");
            File.WriteAllText(path, DateTime.UtcNow.ToString("O"), Encoding.UTF8);
            Logger.Log($"flash.stop.signal={path}");
        }
        catch (Exception ex)
        {
            Logger.Log($"flash.stop.signal.failed={ex.GetType().Name}: {ex.Message}");
        }
    }

    // FlashWindowEx에 FLASHW_STOP을 보내 대상 창의 작업표시줄 깜빡임을 즉시 끈다.
    private static bool StopFlashing(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !NativeMethods.IsWindow(hwnd))
        {
            return false;
        }

        var info = new NativeMethods.FLASHWINFO
        {
            cbSize = (uint)Marshal.SizeOf<NativeMethods.FLASHWINFO>(),
            hwnd = hwnd,
            dwFlags = NativeMethods.FLASHW_STOP,
            uCount = 0,
            dwTimeout = 0,
        };
        return NativeMethods.FlashWindowEx(ref info);
    }

    // 깜빡임이 늦게 걸리는 경우를 대비해 짧은 간격으로 4번 반복 정지시켜 한 번이라도 멈추면 성공으로 본다.
    private static bool StopFlashingWithRetry(IntPtr hwnd)
    {
        var stopped = false;
        for (var i = 0; i < 4; i++)
        {
            stopped = StopFlashing(hwnd) || stopped;
            Thread.Sleep(i == 0 ? 35 : 20);
        }

        return stopped;
    }
}
