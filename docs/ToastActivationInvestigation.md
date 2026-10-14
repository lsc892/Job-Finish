# C# hook 시절과 현재 toast 클릭 경로 비교

최초 확인일: 2026-10-06, 추가 확인일: 2026-10-08·2026-10-09 (Asia/Seoul).

완료 감지는 동작했지만, 수정 전 toast 클릭 이후 Windows 창 활성화는 이전 C# 구현과 같은 경로가 아니었다. 아래 비교와 실패 자료는 보존하며, 사용자 지시로 추가한 C# 구현과 검증 범위도 기록한다.

## 2026-10-09 남은 전경 활성화 실패와 COM callback 전환

사용자는 이전 수정 이후 **Alt+Tab은 정상이고 toast 클릭으로 창이 앞으로 나오지 않는 문제만 남았다**고 확인했다. 설치본 helper와 번들의 SHA256은 작업 디렉터리 빌드와 일치했고, 재시작한 Extension Host에서도 실패했다. 15:19:20.246의 클릭은 대상 VS Code HWND `1247302`에 도달했으나 90ms 뒤 전경은 `ShellExperienceHost`의 `새 알림` HWND `262822`였다. 따라서 구버전 미적용이나 HWND 미연결 문제로 설명되지 않는다.

활성 데스크톱(`QUNS_ACCEPTS_NOTIFICATIONS`)의 격리 창에서 실패 원인을 나눠 검사했다.

- 같은 `Focus.Activate`를 창 소유 프로세스에서 직접 실행하면 일반 전환·최소화 복원·최대화 유지가 성공했다.
- 실제 toast를 화면에서 확인하고 클릭해 실행한 protocol helper는 `SetForegroundWindow`가 즉시 `false`였으며 500ms 뒤에도 알림 셸이 전경이었다. 대상의 `WM_NULL` 응답은 정상이고, 전경의 메뉴·capture 상태는 없었다. 이 실행에서는 클릭 승인 전후 입력 시각도 바뀌지 않았다. 비동기 전환 지연이나 대상의 무응답으로 설명되지 않는다.
- 임시 진단의 `AllowSetForegroundWindow(self)`는 성공했다. 따라서 helper가 전경 자격을 전혀 받지 못했다고 단정하지 않는다. 대상 PID에 권한을 전달하거나 메시지 큐를 만드는 것만으로도 실패했고, 별도 실행의 소유자 직접 호출은 중간 입력으로 권한이 바뀌어 결정적 비교로 사용하지 않았다.
- 실제 `INotificationActivationCallback`을 등록한 foreground toast는 같은 HWND 활성화 함수로 전환됐다. callback은 등록한 STA에서 실행됐으며, helper는 처리 후 정상 종료했다. AUMID의 `CustomActivator` 없이 바로가기와 `LocalServer32`만 바꾼 첫 실험에서는 클릭 callback이 호출되지 않았다. AUMID 등록도 연결한 뒤 실제 클릭이 도달했다. 등록 방식은 [Microsoft Toolkit 구현](https://github.com/CommunityToolkit/WindowsCommunityToolkit/blob/main/Microsoft.Toolkit.Uwp.Notifications/Toasts/Compat/ToastNotificationManagerCompat.cs)을 따른다.

제품은 새 toast를 `activationType="foreground"`로 만들고, 고정 CLSID의 `LocalServer32`를 helper의 `--activate`에 연결한다. `ComActivator`의 STA 메시지 루프가 callback을 받아 기존 `ClickPayload`의 만료·pipe 승인·대상 검증을 수행한다. 창 활성화는 최소화 복원과 `SetForegroundWindow` 한 번을 유지한다. Alt 입력·스레드 연결·알림 셸 조작·재시도는 추가하지 않았다. 기존 알림의 유효 기간을 위해 protocol URI 처리는 유지했다.

95개 테스트·타입 검사·C# 빌드와 실제 COM `CoCreateInstance → Activate → pipe → helper 종료` 계약 검사가 통과했다. COM 계약은 미연결·무효 HWND·소유권 거부·잘못된 AppId를 확인하며 전경을 조작하지 않는다. 제품 helper로 생성한 일반·최소화·최대화 테스트 알림의 실제 callback에서 목표 HWND 전환과 입력 포커스, 복원 및 최대화 유지를 500ms까지 확인했다. 자동 마우스 스크립트가 확인하지 못한 실행은 native callback 검증으로만 집계했다. 마지막 최대화 실행의 Alt 메시지 1회는 관측 기간의 입력이며 제품에 합성 입력 API는 없다.

실제 Job-Finish VS Code 창도 명시적 진단 HWND로 검사했다. 16:16:57의 시작 전경은 브라우저 `66554`였고, 16:17:01의 클릭 결과는 대상 `263816`의 `activated: true`, 실제 전경도 `263816`이었다. 진단 오류는 없었다. 이는 제품의 C# helper와 TypeScript 클릭 채널을 검증하며, 진단 스크립트가 HWND를 명시했으므로 자동 완료 감지·자동 바인딩 전체의 새로운 검증으로 확대하지 않는다. 원자료는 `.generated/native-focus-check/results-com-oct9.jsonl`, `results-com-product-*-oct9.jsonl`, `product-vscode.stdout` 및 `.generated/toast-activation-probe/publish/trace-oct9.jsonl`에 보관했다. 임시 Windows 등록은 각 검사 후 복원했다.

## 2026-10-08 클릭 후 첫 Alt+Tab 이상을 기준으로 재조사

**확인된 실패는 정확한 HWND가 전달된 뒤에도 알림 셸이 전경에 남는 것이다.** 설치본의 15:01:29.435와 15:13:32.218(KST) 클릭은 모두 `toast.click`과 `window.activation.request`까지 도달했다. 대상 HWND `263850`은 PID `20088`의 VS Code 창이고, 결과에 남은 전경 HWND `131934`는 PID `5712`의 `ShellExperienceHost.exe`, 제목 `새 알림`이었다. 실제 Win32 조회로 두 창의 식별을 확인했다. 따라서 이 두 건은 클릭 누락이나 HWND 미연결로 설명되지 않는다.

두 실행에서 확장의 `focused: true` 통지는 활성화 요청 후 164ms·180ms에 도착했지만, 245ms·270ms 뒤의 결과는 여전히 알림 셸 HWND였다. 기존 코드는 `SetForegroundWindow` 결과와 무관하게 연결된 입력 큐에서 `SetActiveWindow`와 `SetFocus`를 호출했다. 이 때문에 VS Code의 내부 포커스 통지 자체를 실제 전경 전환의 증거로 사용할 수 없다.

사용자가 보고한 첫 Alt+Tab 이상과 관련된 구현은 다음과 같다.

- `AttachThreadInput`으로 helper·현재 전경·대상 창의 입력 상태와 포커스를 공유한다. Microsoft는 이 호출이 키 상태를 초기화한다고 명시한다. [AttachThreadInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-attachthreadinput).
- 연결 중 전역 Alt down/up 입력을 합성하고 대상의 내부 포커스를 강제로 바꾼다. 키 입력 두 개가 짝을 이룬다는 사실만으로 각 창의 메시지 처리와 메뉴 상태까지 보장할 수는 없다.
- 입력 큐를 공유한 전경 전환은 기존 전경 창의 비활성화 메시지 처리를 동기적으로 기다릴 수 있다. [Microsoft의 입력 큐 동기화 설명](https://devblogs.microsoft.com/oldnewthing/20130607-00/?p=4143/).

이 조합은 전경·내부 포커스·modifier 상태를 동시에 건드리므로, 키를 놓고 다시 Alt+Tab을 하면 정상화되는 증상과 부합한다. **첫 Alt+Tab 이상이 어느 호출에서 발생하는지까지 재현으로 확정한 것은 아니다.** 확인된 전경/포커스 불일치와 문서화된 키 상태 변경을 근거로 원인 후보를 입력 큐 연결과 Alt 합성으로 좁혔다. 현재 조회 시 실행 중인 `JobFinish.Native.exe`는 없어 지속적으로 멈춘 helper도 확인되지 않았다.

### 최소 구현으로 변경

원래 확장의 클릭 승인과 대상 HWND·PID·실행 파일·시작 시각 검증을 유지한다. 활성화는 최소화된 경우의 `ShowWindow(SW_RESTORE)`와 `SetForegroundWindow(hwnd)` 한 번으로 줄였다. 알림 셸 `WM_CLOSE`, 입력 큐 연결, Alt 합성, 대상 내부 `SetActiveWindow`·`SetFocus`, 중복 대상 검증과 복원 후 임의 대기는 제거했다. 일반 창과 최대화 창은 복원 API를 호출하지 않는다.

기존의 60ms 뒤 전경 HWND 확인은 결과 관측에만 사용한다. 재시도는 하지 않으며, `foreground-refused`는 그 시점의 전경 불일치라는 기존 진단 명칭이다. API의 직접 거부와 비동기 전환 지연을 구분한 오류 코드가 아니다.

타입 검사·95개 테스트·C# 빌드와 컴파일된 helper의 실제 pipe 계약 검사가 통과했다. 기존 VS Code 두 창 마우스 재현은 테스트 창 준비 단계에서 시간 초과가 발생했다. 상속된 `VSCODE_*` 환경 변수를 테스트 자식 프로세스에서 제거해도 같은 단계에서 실패했다. 별도의 WinForms 네이티브 probe도 준비 창을 전경으로 만들지 못해 제품 활성화 호출 전에 중단했다. 당시 `SHQueryUserNotificationState`는 성공 HRESULT와 `1 (QUNS_NOT_PRESENT)`을 반환했다. 이는 화면 보호기·잠금·비활성 사용자 세션 중 하나이며 이 값만으로 어느 상태인지 구분할 수 없다([Microsoft 정의](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state)). probe와 기존 VS Code는 모두 세션 `4`였다. 이 결과들을 toast 클릭이나 최소 구현의 실패로 집계하지 않는다. 자료는 `.generated/native-focus-check/results-final.jsonl`에 보관했다. 임시 helper 등록은 원래 설치본으로 복원했고 테스트 창도 종료했다. 사용자 설치본 적용과 실제 클릭·첫 Alt+Tab 해결 확인은 수행하지 않았다.

## 2026-10-06 설치 후 팝업 미표시 추가 조사

**확인된 실패 범위는 Windows의 toast 표시 단계다.** 아래 실제 완료 건에서는 observe, 소유권 확인, HWND 전달, C# 실행과 Windows 알림 플랫폼 전달까지 진행됐다. 등록 정보의 전환 누락과 진단의 한계는 확인했으나, 원래 배너가 안 뜬 직접 원인을 하나로 확정하지는 못했다.

### 실제 설치본에서 확인한 흐름

`%APPDATA%/Code/logs/20261006T181620/window1/exthost/output_logging_20261006T181623/2-Job-Finish.log`의 알림 `25ab3e23-5442-4f71-b2ed-075aef87332b`를 추적했다. 아래 시간은 한국 시간이다.

| 시각 | 확인한 기록 | 의미 |
| --- | --- | --- |
| 18:18:49.723 | `signal.received`, `completed`, `owned: true`, `focused: false` | 완료 감지와 소유권 확인이 성공했고 포커스 때문에 억제된 건이 아니다. |
| 18:18:51.253 | `toast.launched`, HWND `1116050`, helper PID `20412` | 대상 HWND를 포함한 C# 호출까지 도달했다. |
| 18:18:51.947 | `toast.exit`, code `0`; `toast.registered` | helper가 예외 없이 종료했다. 화면 표시 성공을 검증한 기록은 아니다. |
| 18:18:51 | Windows PushNotification-Platform 이벤트 `3052`, tracking ID `3955`, `JobFinish.VSCode` | Windows 알림 플랫폼에도 전달됐다. |
| 18:18:54 | Windows Shell-Core 이벤트 `28117` | 새 바로가기 정보가 AppResolver 캐시에 반영됐다. 전달보다 늦지만 이것만으로 실패 원인을 단정하지 않는다. |

설치된 `dist/extension.cjs`와 `dist/native/JobFinish.Native.exe`의 SHA256은 작업 디렉터리의 빌드와 각각 일치했다. 최신 로그도 C# 경로이므로 이 완료 건을 구버전 미적용이나 미리로드 문제로 설명할 수 없다. 현재 `ToastNotifier.Setting`은 `Enabled`이며, 알림 DB의 해당 앱 배너·toast 설정도 켜져 있다.

### 확인된 등록 문제와 진단 공백

1. **동일 앱 ID의 이전·신규 등록이 혼재한다.** 시작 메뉴의 `Job-Finish.lnk`와 `Job-Finish Native Notifications.lnk`가 모두 `JobFinish.VSCode`를 사용한다. 이전 바로가기의 `ToastActivatorCLSID`는 `{EB1FDD5B-8F70-4B5A-B230-998A2DC19303}`이며, `HKCU/Software/Classes/CLSID/{…}/LocalServer32`는 설치 확장의 `node_modules/node-notifier/vendor/snoreToast/snoretoast-x64.exe`를 가리킨다. 해당 실행 파일은 실제로 없다. 신규 바로가기의 CLSID는 비어 있다. 새 구현은 다른 이름의 바로가기를 추가하며 이전 등록을 이관하지 않는다. 이 혼재가 이번 배너 누락을 유발했는지는 별도 대조가 필요하다.
2. **등록과 전송이 한 번에 수행된다.** `Program.Show`는 매번 바로가기를 저장하고 곧바로 `CreateToastNotifier`/`Show`를 호출한다. 초기 등록 완료 확인이 없으며, 이전 PowerShell 구현에는 별도의 `-Prime` 절차가 있었다. 새 식별자를 사용한 격리 실험에서는 즉시 전송·4초 사전 등록 및 stub CLSID 유무 네 조건 모두 `Setting` 조회에서 `0x80070490`으로 실패했다. 따라서 이 실험은 등록 완료 확인의 필요성을 보여 주지만 CLSID 유무의 배너 효과를 검증하지 못했다. 이미 등록된 사용자 앱의 정상 종료 건과도 구분한다.
3. **`toast.registered`가 실제 표시를 의미하지 않는다.** `Program.cs`는 `Show()` 직후 `0`으로 종료하고, `toast.ts`는 이 코드만으로 성공 이벤트를 기록한다. `ToastNotification.Failed` 구독이나 알림 이력 확인이 없다. Windows가 표시를 시도하다 실패한 이유는 [Failed 이벤트와 ErrorCode](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotification.failed?view=winrt-26100)로 확인해야 한다. 현재 로그만으로 비동기 표시 실패와 배너 억제를 구별할 수 없다.

### 이번 재현의 결과와 한계

- 설치된 helper를 직접 실행한 진단 알림은 종료 코드 `0`이었고, 종료 후 100ms·추가 500ms·1초·3초의 네 조회에서 모두 Windows 이력에 존재했다. 같은 앱 ID로 PowerShell 및 `Failed` 이벤트를 구독한 C# 전송 프로세스를 유지한 경우에도 이력 등록이 성공했다. C# 실험에서는 관측 시간 동안 `Failed` 이벤트가 발생하지 않았다. **helper의 즉시 종료만으로 모든 알림이 유실된다고 볼 수 없다.**
- UI Automation에서는 진단 배너를 찾지 못했지만, 당시 `SHQueryUserNotificationState`가 `1 (QUNS_NOT_PRESENT)`을 반환했고 18:27:04의 모니터 꺼짐 기록도 있었다. 이 값은 잠금·화면 보호기·비활성 사용자 세션 등을 나타낸다([Microsoft 정의](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state)). 따라서 이번 비대화형 상태의 배너 관측 결과를 18:18:51에 사용자가 겪은 누락의 원인으로 소급하지 않는다.
- 과거 HWND를 재사용한 추가 실험에서도 알림 이력은 생성됐지만, 현재 유효하지 않은 대상이 helper에서 제거됐다. 이 실험은 HWND 클릭 활성화 성공의 증거가 아니다.
- 단위 테스트의 전송 프로세스는 모의 객체이고, `native-toast-contract.mjs`의 `--show` 검사는 잘못된 요청의 거부를 확인한다. 기존 protocol URI 검증 또한 실제 배너 표시를 대신하지 않는다. 이 테스트들만으로 팝업 정상 표시를 보장할 수 없다.

원자료는 `test-artifacts/toast-display-diagnosis.json`, `toast-installed-hwnd-diagnosis.json`, `toast-registration-diagnosis.json`에 남겼고 격리 C# probe는 `.generated/toast-diagnosis`에 있다. 진단 알림과 임시 앱 ID의 바로가기·등록 키는 정리했다. 제품 코드와 기존 알림 등록은 수정하지 않았다.

다음 검증은 활성 데스크톱에서 등록 정보 이관 여부를 대조하고, 동일 알림의 `Failed/ErrorCode`, 이력, 실제 배너를 함께 확인하는 것이다. 기존·신규 앱 등록을 일관되게 만들고 등록 완료와 전송을 분리하는 수정 후보는 명확하지만, 검증 없이 원래 팝업 문제의 해결로 보고하지 않는다.

## 실제로 달라진 부분

| 단계 | 이전 PowerShell/C# 구현 | 수정 전 VS Code 확장 (`a8af3ed` 포함) |
| --- | --- | --- |
| toast 클릭 전달 | WinRT toast의 `activationType="protocol"` → `jobfinish-focus://` → 전용 `jf-focus-vscode.exe` | SnoreToast의 named pipe 또는 helper 종료 코드 → Extension Host callback |
| 대상 창 확보 | toast URI에 HWND·PID·작업 위치·제목 전달; helper에서 대상 재확인 | 해당 창의 안정된 포커스를 150ms 관측한 HWND 바인딩 필요 |
| 알림 셸 처리 | 전경이 알림 셸이면 닫기·Esc·Win+N·숨김 순서로 처리; 끝까지 남으면 ShellExperienceHost 종료 처리도 존재 | 해당 처리 없음 |
| 입력과 전경 전환 | 전경·대상·입력 스레드 연결, Alt 입력, AllowSetForegroundWindow, TOPMOST 전환, AppActivate, 입력 포커스 확인 | SetForegroundWindow; 실패하면 현재 스레드와 전경 스레드만 연결해 재호출 |
| 재시도 | 최대 6초; 실제 전경과 대상 내부 입력 포커스 검사 | 총 4회·최대 850ms; 새로운 입력 시각을 감지하면 중단 |
| 전달 프로세스 종료 후 클릭 | 별도 Windows 프로토콜 handler가 실행됨 | 살아 있는 helper/pipe 동안만 지원; 최대 30초 |

언어와 hook 자체가 창을 활성화한 것이 아니다. hook은 완료 신호를 만들었고, 전용 C# helper가 Windows 창 활성화와 알림 셸 처리를 담당했다. 현재 런타임 이벤트 라우터가 대상 창을 정확히 알아도 이 Windows 단계는 별도로 성공해야 한다.

## 코드와 설치 상태 근거

이전 소스의 기준 revision은 `877024beb5f86c390c1beec4992cf64c862dbc67`이다.

- [notify.win.ps1](https://github.com/lsc892/Job-Finish/blob/877024beb5f86c390c1beec4992cf64c862dbc67/templates/notify.win.ps1): protocol toast 생성과 `jobfinish-focus` 등록.
- [WindowFocus.cs](https://github.com/lsc892/Job-Finish/blob/877024beb5f86c390c1beec4992cf64c862dbc67/tools/win-focus/Focus/WindowFocus.cs): 알림 셸 처리 후 스레드 연결·Alt 입력·창 활성화·6초 재시도.
- [NotificationShell.cs](https://github.com/lsc892/Job-Finish/blob/877024beb5f86c390c1beec4992cf64c862dbc67/tools/win-focus/Focus/NotificationShell.cs): WM_CLOSE·Esc·Win+N·숨김·ShellExperienceHost 종료.
- 조사 당시 `a8af3ed`의 `native.ts`와 `toast.ts`: 위 알림 셸 처리와 protocol 활성화가 없던 경로. 현재 파일은 아래 C# 전환을 반영했다.

로컬 `jobfinish-focus` 등록은 지금도 `C:\Users\safi2\.job-finish\jf-focus-vscode.exe --uri "%1"`를 가리킨다. 설치된 notifier에도 protocol toast 생성 코드가 남아 있다. 설치 exe의 압축된 .NET assembly를 실행하지 않고 추출해 `DismissNotificationShellIfForeground`, `RestartStuckNotificationShell`, `AttachInputThreads`, `SendAltKey` 및 관련 로그 문자열의 존재를 확인했다. 설치 assembly와 Git에 보관된 assembly의 hash는 다르므로 두 binary가 동일한 빌드라고 주장하지 않는다.

기존 C# helper의 debug 설정은 꺼져 있고 실행 로그는 남아 있지 않았다. 따라서 예전 성공 때 어떤 개별 우회가 실제로 필요했는지는 아직 확정하지 않았다. 이번 비교에서 C# helper를 다시 실행하거나 시스템 알림 셸을 종료하지 않았다.

## 이번 실제 클릭 재현

격리 프로필에서 같은 작업 폴더·같은 제목의 VS Code 창 두 개를 열고, 합성 App Server stdio의 `turn/completed`를 실제 자동 감지 경로로 전달했다. 실제 SnoreToast 클릭 callback과 대상 창·전경 HWND를 기록했다. 자동 마우스 입력은 확인하지 못했으며, 합성 pipe 입력만으로 실제 클릭을 통과했다고 집계하지 않았다.

1. **HWND 미연결 조건**: 테스트에서 바인딩을 명시적으로 비웠다. 완료 이벤트와 pipe `clicked` 수신, 알림 소유권은 정상이었지만 대상 HWND가 없어 활성화를 수행하지 못했다. 이 조건은 미연결 시 동작의 재현이며, 사용자 환경의 모든 실패가 미연결 때문에 발생했다는 증거는 아니다.
2. **HWND 연결 조건**: 대상 HWND `1770444`가 확인된 상태에서도 클릭 후 활성화가 실패했다. 전경 HWND는 `526072`로 남았으며, 직접 검사한 이 창의 프로세스는 `ShellExperienceHost`, 제목은 `새 알림`이었다. 대상 창 선택이 성공해도 알림 셸의 전경 상태를 처리하지 못하는 사례를 확인했다.

직전 toast 수정 `a8af3ed`는 pipe callback이 없을 때의 종료 코드 처리와 짧은 재시도를 추가했다. 위 재현에는 이미 정상 pipe 클릭이 있었으므로 종료 코드 보완으로 해결되지 않는다. 미연결 HWND 문제나 기존 C#의 알림 셸 처리도 그 커밋의 구현 범위에 들어 있지 않다. 당시 명시한 HWND를 별도 프로세스에 넣은 성공 실험은 이 실제 Extension Host 경로의 검증을 대신하지 못한다.

Windows는 전경 창 변경을 제한하며 단순 API 호출만으로 항상 성공하지 않는다. [Microsoft SetForegroundWindow 문서](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow).

## 재현과 후속 검증에 남긴 코드

조사 당시에는 `Job-Finish` 출력과 **Show Diagnostics**의 `events`에서 완료 신호 → toast 실행 → pipe/종료 → 클릭 → 활성화 시도 → 실제 전경 상태를 같은 windowInstanceId·notificationId로 추적했다. 최신 100개 이벤트만 보관하고 이벤트 로그에 응답 본문이나 인증 정보를 추가하지 않았다. 당시 활성화 중단은 `missing-binding`, `input-changed`, `invalid-binding`, `attempts-exhausted` 등으로 구분했다. 현재 C# 경로는 `missing-binding`, `invalid-binding`, `foreground-refused`를 사용한다.

```sh
node scripts/toast-routing.mjs --baseline
node scripts/toast-routing.mjs
npm run check
```

`--baseline`은 실패 사례를 관찰·기록하는 모드다. 일반 모드는 대상 HWND의 실제 전경 전환을 검증하고 실패하면 종료 코드 1을 반환한다. 테스트는 격리 창의 Windows 입력을 사용하며, 정확한 toast를 UI Automation으로 찾지 못하는 환경에서는 실제 클릭 callback을 기다린다. 준비 단계에서 다른 창을 조작하거나 클릭 callback 없이 성공을 만들지 않는다.

원자료는 `test-artifacts/toast-routing-baseline.json`, `test-artifacts/legacy-toast-comparison.json`에 보관했다. 원인 비교 후 검증되지 않은 포커스 명령·protocol 교체안은 제품 코드에서 제거하고 현재 동작에 단계 로그만 추가했다. 타입 검사·98개 테스트·빌드를 통과했다. 기존 C#의 여러 우회 중 필요한 최소 조치를 분리하는 검증과 실제 기능 수정은 남아 있다.

## 사용자 지시로 반영한 C# 구현과 확인 범위

확장의 런타임 메모리 observe는 유지했다. 관측한 UUID/HWND와 알림 ID를 C# helper에 전달하고, WinRT toast의 `jobfinish-native-focus` protocol은 클릭할 때 C# helper를 실행한다. 원래 확장이 소유권과 enabled 상태를 승인하면 C#이 해당 HWND의 PID·실행 파일·프로세스 시작 시각을 재확인하고 알림 셸 닫기·입력 스레드 연결·Alt 입력 후 전경 전환을 한 번 수행한다. 스레드는 항상 분리하고 실제 전경 HWND로 결과를 기록한다. SnoreToast·종료 코드 클릭 추정·Extension Host 포커스 재시도·last-input 검사는 제거했다. 이전 C#의 제목 점수·새 창 실행·알림 셸 강제 종료·6초 재시도는 추가하지 않았다.

추가 로그에서는 VS Code의 `focused: true` 통지가 실제 Windows HWND 전환보다 먼저 도착하는 경우도 확인했다. 기존 관측은 첫 HWND가 다른 앱이면 즉시 실패했다. 관측 시작을 통지 후 400ms(초기 활성화 750ms)로 옮기고 같은 HWND/PID가 150ms 유지되는지 검사한다. 변경되거나 종료된 관측을 폐기하며 전경 활성화 재시도는 하지 않는다.

90개 테스트·타입 검사·빌드, 실제 Extension Host의 기존/새 agent 이벤트 감지와 설정 전환, 컴파일된 C#과 실제 pipe의 승인·거부 계약, C# helper 포함 VSIX의 격리 설치·실행이 통과했다. 실제 등록된 toast의 URI를 Windows protocol로 실행한 A/B 창 검사에서 전경 HWND `9176748`로의 전환·최소화 복원·최대화 유지가 통과했고 진단 오류는 없었다. 자료는 `test-artifacts/toast-protocol-routing.json`에 있다. 이 실험은 실제 포커스로 HWND를 관측했지만 protocol URI 실행은 자동 마우스 클릭과 구분한다.

최종 관측 수정 후 테스트는 수동 observe 호출로 바인딩을 보완하지 않고 제품의 포커스 listener가 연결한 HWND를 확인한다. 자동 바인딩은 확인됐지만 후속 실행에서 Windows 이력에 해당 toast가 나타나지 않아 protocol 검사를 끝내지 못한 경우도 있었다. UI Automation에서는 실제 토스트 배너·알림 센터의 대상 알림을 찾지 못했다. 따라서 사용자 설치 환경의 실제 클릭 해결까지 확인했다고 보고하지 않는다. 이전 실패 자료와 직전 커밋의 한계를 이 결과로 덮어쓰지 않는다.

후속 등록 이관·전송 분리에서는 이전 바로가기 백업과 제거, stub CLSID 등록, 초기화의 `--register`와 전송의 `--show` 분리, WinRT 실패·이력 관측을 구현했다. 등록 변경 후에도 실제 전경 전환은 성공과 실패가 함께 있었다. `foreground-refused`는 활성화 처리 후 60ms 뒤 목표가 전경이 아닌 경우의 자체 판정이며 Windows의 거부 오류를 직접 수집한 값이 아니다. API 거부·포커스 재탈취·판정 지연 중 직접 원인은 미확정이다. 최신 검증 범위는 [검증 문서](verification.md)를 따른다.
