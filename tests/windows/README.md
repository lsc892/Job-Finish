# windows

Windows 알림과 클릭·창 활성화, C# 도우미의 프로세스 계약을 검증한다.

- [native-toast-contract.mjs](native-toast-contract.mjs) — 등록·입력 검증·실제 pipe·프로토콜·COM 승인 계약을 검증한다. 빌드 후 `npm run test:native`로 실행하며 창을 활성화하지 않는다.
- [native-toast.ts](native-toast.ts) — 실제 알림 전송과 선택한 VS Code 창의 클릭 활성화 결과를 기록한다. 빌드 후 `npm run test:toast`로 실행하며 `--activate-hwnd`·`--expect-click` 옵션을 지원한다.
- [toast-routing.mjs](toast-routing.mjs) — 격리한 두 VS Code 창에서 알림 클릭의 원래 창 복귀와 창 상태 보존을 검증한다.
- [toast-host.ts](toast-host.ts) — 라우팅 실행기에서 사용하는 격리 VS Code 테스트 진입점으로, 실제 스트림·알림·전경 창 관찰을 제어한다.
- [activate-test-toast.ps1](activate-test-toast.ps1) — 등록된 격리 테스트 알림의 프로토콜 URI를 찾아 실행한다.
- [click-toast.ps1](click-toast.ps1) — 격리 테스트 알림을 찾아 클릭하고 선택적으로 진단 자료를 저장한다.
- [focus-test-window.ps1](focus-test-window.ps1) — 제목으로 확인한 격리 알림 테스트 창에 포커스를 옮기고 전경 상태를 보고한다.

저장소 루트에서 실행한다. 라우팅 검증의 직접 실행 경로는 `node tests/windows/toast-routing.mjs`이며 같은 폴더의 테스트 진입점과 PowerShell 보조 스크립트를 사용한다.
