// 책임: 창 정보 값 타입(레코드) 정의.
internal readonly record struct WindowInfo(IntPtr Hwnd, int Pid, string ProcessName, string Title, string Path, int ZOrder, int Score = 0);

internal readonly record struct ChildWindowInfo(IntPtr Hwnd, uint ThreadId, uint Pid, string ClassName, int Score);
