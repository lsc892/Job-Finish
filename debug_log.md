# Debug Log: Windows Toast Click Focus

## 2026-06-13 추가 일지: 다중 VS Code 창에서 알림 클릭 대상 오인 수정

### 문제

- Windows toast 알림 자체는 표시되지만, 사용자가 다른 VS Code 창을 보고 있을 때 알림을 클릭하면 `Job-Finish` 창이 아니라 방금 보고 있던 다른 VS Code 창으로 포커스가 이동했다.
- 재현 당시 실제 창은 다음처럼 분리되어 있었다.
  - `Job-Finish`: `hwnd=1573752`, title=`Debug notification system - Job-Finish - Visual Studio Code`
  - 다른 창: `hwnd=4327068`, title=`... - DsTurn_Temp - Visual Studio Code`
  - 두 창 모두 같은 `Code.exe` PID `20916`을 공유했다.

### 원인

- VS Code는 여러 창을 띄워도 같은 `Code.exe` 프로세스/PID를 공유할 수 있다.
- 기존 helper는 toast URL에 포함된 `pid`를 강한 식별자로 점수화했다.
- 그래서 `pid=20916`만 맞는 다른 VS Code 창도 높은 점수를 받아, 명시적 `hwnd` 또는 현재 foreground 창이 잘못 전달되면 잘못된 창으로 포커스가 이동했다.

### 해결

- `tools/win-focus/Program.cs`의 창 선택 점수에서 `pid` 가중치를 `1000`에서 `10`으로 낮췄다.
- `cwd`, `titleHint`, 프로젝트 폴더명처럼 실제 작업 창을 식별할 수 있는 title 기반 점수만 유효한 강한 신호로 사용한다.
- 명시적 `hwnd`가 넘어와도 해당 창 점수가 기준치(`>= 90`)에 못 미치면 무조건 믿지 않고, 점수가 충분한 후보 창으로 교정한다.
- 새 로그를 추가해 교정 여부를 확인할 수 있게 했다.
  - `explicit hwnd did not match cwd/title; using scored target hwnd=...`

### 검증

- 일부러 다른 VS Code 창의 `hwnd=4327068`을 넣어 helper를 실행했다.
- 새 helper는 `Job-Finish` 창을 더 높은 점수로 선택했다.

```text
candidate hwnd=1573752 pid=20916 score=110 title="Debug notification system - Job-Finish - Visual Studio Code"
candidate hwnd=4327068 pid=20916 score=10 title="... - DsTurn_Temp - Visual Studio Code"
explicit hwnd did not match cwd/title; using scored target hwnd=1573752 score=110
foreground.after=hwnd=1573752 pid=20916 process=Code title="Debug notification system - Job-Finish - Visual Studio Code"
success=True
```

### 같이 처리한 기반 작업

- `.claude/settings.json`의 Claude hook이 비어 있던 상태를 복구했다.
- `templates/notify.win.ps1`와 설치본 `.claude/job-finish/job-finish-notify.ps1`에 toast 생성 단계별 debug log를 추가했다.
- PowerShell 함수 인자명이 자동 변수 `$PID`와 충돌하던 문제를 `$targetPid`로 변경해 `Show-Toast`가 조용히 실패하지 않게 했다.
- `JobFinish.Notifier` AppID와 Start Menu shortcut 생성 흐름을 정리했다.
- `templates/jf-focus-vscode.exe`, `.claude/job-finish/jf-focus-vscode.exe`, `C:\Users\safi2\.job-finish\jf-focus-vscode.exe`를 새 helper로 갱신했다.

## Goal

Windows 알림을 클릭하면 기존 VS Code 창이 맨 앞으로 올라와야 한다.

우선순위:

1. 기존 VS Code 창을 프로그래밍 방식으로 맨 위로 띄우는 것부터 성공시킨다.
2. 그 다음 Windows 토스트 클릭 프로토콜에 연결한다.
3. PowerShell이 부족하면 C#/C++ 같은 Win32 API에 가까운 실행 파일로 처리한다.

## Current Facts

- Codex notify는 `C:\Users\safi2\.job-finish\job-finish-notify.ps1`를 실행한다.
- 프로젝트 Claude hook은 `.claude/job-finish/job-finish-notify.ps1`를 실행한다.
- 현재 보이는 VS Code 프로세스 중 `Code` PID `9620`이 `Job-Finish - Visual Studio Code` 창을 가지고 있다.
- `MainWindowHandle`은 `132854`로 잡힌다.
- 이 시스템에서 현재 바로 사용 가능한 빌드 도구는 `dotnet`이다. `cl`, `g++`, `clang++`, `csc`는 PATH에서 발견되지 않았다.

## Hypotheses

### H1. PowerShell 프로토콜 핸들러가 실행은 되지만 foreground 권한이 부족해 `SetForegroundWindow`가 실패한다.

Status: partially supported

Test:

- PS가 아닌 별도 .NET 실행 파일에서 Win32 focus 시도를 한다.
- `SendInput(Alt)`, `ShowWindow`, `SetWindowPos`, `AttachThreadInput`, `SetForegroundWindow` 조합을 로그로 확인한다.

Result:

- `tools/win-focus`에 .NET Win32 P/Invoke focus 도구를 만들었다.
- `net8.0`은 이 머신에 런타임이 없어 실행 실패했다. 설치된 런타임은 .NET 10이므로 `net10.0`으로 변경했다.
- 실행 결과:
  - before: `chrome` / `병섭이 - 타임리스 방패 만들기 - CHZZK - Chrome`
  - target: `hwnd=132854`, `pid=9620`, `Debug notify functionali… - Job-Finish - Visual Studio Code`
  - after: `Code` / `Debug notify functionali… - Job-Finish - Visual Studio Code`
  - `success=True`
- 결론: PowerShell 알림/프로토콜 문제와 별개로, 별도 Win32 실행 파일로 VS Code를 맨 위로 올리는 것은 성공했다.

### H2. VS Code HWND 탐지가 틀려서 엉뚱한 창 또는 0 HWND에 focus를 시도한다.

Status: supported and fixed in helper

Test:

- `Code.exe` 프로세스와 top-level visible windows를 모두 열거한다.
- `Job-Finish` 제목이 있는 HWND를 우선 선택한다.

Result:

- `Get-Process Code`에는 `MainWindowHandle=0`인 프로세스가 많다.
- top-level visible window 열거 결과 실제 VS Code 창은:
  - `hwnd=132854`
  - `pid=9620`
  - `title="Debug notify functionali… - Job-Finish - Visual Studio Code"`
- 결론: `Get-Process Code | MainWindowHandle`만 믿으면 실패 가능성이 있다. `EnumWindows`로 visible top-level window를 열거해야 한다.

### H3. Windows 토스트 click activation 자체는 동작하지만, focus 스크립트가 너무 약하다.

Status: supported; replaced with native focus exe

Test:

- 먼저 focus 전용 실행 파일을 직접 실행해 성공시킨다.
- 성공 후 같은 실행 파일을 `jobfinish-focus://` 프로토콜 핸들러로 등록한다.

Result:

- `jobfinish-focus://open?cwd=...` 프로토콜 핸들러를 `jf-focus-vscode.exe --uri "%1"`로 등록했다.
- 직접 실행 테스트:
  - command: `Start-Process 'jobfinish-focus://open?cwd=C%3A%5CUsers%5Csafi2%5CDocuments%5CGitHub%5CJob-Finish'`
  - after: `Code` / `Debug notify functionali… - Job-Finish - Visual Studio Code`
  - `success=True`
- 결론: 토스트 클릭 handler는 PowerShell 스크립트 대신 focus 전용 exe를 직접 실행하는 방향이 맞다.

### H4. 프로토콜 핸들러 exe가 콘솔 앱이라 순간적으로 cmd 창이 보인다.

Status: fixed

Test:

- `tools/win-focus/JFFocusVSCode.csproj`의 `OutputType`을 `Exe`에서 `WinExe`로 변경한다.
- 기존 콘솔 출력은 `jf-focus-vscode.log` 파일 출력으로 대체한다.
- publish 후 전역 설치 위치 `C:\Users\safi2\.job-finish\jf-focus-vscode.exe`를 교체한다.

Result:

- `jobfinish-focus://...` 프로토콜은 여전히 `jf-focus-vscode.exe --uri "%1"`를 직접 실행한다.
- 직접 실행 후 foreground:
  - before: `chrome`
  - after: `Code` / `Debug notify functionali… - Job-Finish - Visual Studio Code`
  - `success=True`
- 로그는 `C:\Users\safi2\.job-finish\jf-focus-vscode.log`에 남는다.
- 결론: 순간적으로 보이던 cmd 창은 콘솔 서브시스템 문제였고, `WinExe` 빌드로 해결했다.
