# Windows 알림 코드 단순화 검토

- 기준: 2026-10-27, 시작 기준 `33f0e4f`, 작업 시작 시 사용자 변경 없음.
- 흐름과 계약: VS Code 창 관리 → `WindowsToast` → 등록 공유·세대 검사 → 클릭 채널 준비 → helper 전송이다. 전송 helper가 끝난 뒤에도 승인 pipe는 유지하며, 승인된 socket의 활성화 결과만 한 번 처리한다. HWND 검증·최소화 복원·전경 전환은 C# callback이 담당한다.
- 결과: 제거 근거가 확인된 미사용 코드나 독립적인 작은 단순화 후보를 찾지 못했다. 소스·테스트를 변경하지 않았고 승인 대기 제안도 없다.

## 검토 범위

- TypeScript: [toast](../../../src/windows/toast.ts), [helper 실행기](../../../src/windows/toast-process.ts), [클릭 채널](../../../src/windows/toast-activation.ts), [native ABI와 창 식별](../../../src/windows/native.ts), [flash](../../../src/windows/flash.ts), [소유권 gate](../../../src/windows/gate.ts).
- C#: [진입점과 protocol/COM 공통 클릭 처리](../../../tools/windows-toast/Program.cs), [COM 호스팅](../../../tools/windows-toast/ComActivator.cs), [등록](../../../tools/windows-toast/Registration.cs), [전송 관측](../../../tools/windows-toast/ToastDelivery.cs), [HWND 활성화](../../../tools/windows-toast/Focus.cs), [프로젝트 설정](../../../tools/windows-toast/JobFinish.Native.csproj).
- 호출·검증 경로: [VS Code 창 관리](../../../src/vscode/window.ts), [toast 테스트](../../../tests/toast.test.ts), [helper 테스트](../../../tests/toast-process.test.ts), [클릭 채널 테스트](../../../tests/toast-activation.test.ts), [Windows 테스트](../../../tests/windows.test.ts), [Extension Host의 창 열거](../../../tests/extension-host.ts), [toast host의 창 열거](../../../tests/toast-host.ts), [native 계약 스크립트](../../../scripts/native-toast-contract.mjs), [격리 바로가기 테스트](../../../tests/native-toast/Program.cs), [COM 계약 테스트](../../../tests/native-toast/com-activation/ComActivationTests.cs), [기존 책임 분리 기록](../../readability-analysis/windows.md).

## 유지 판단

| ID | 상태 | 대상 | 근거 |
| --- | --- | --- | --- |
| WIN-01 | 유지 | helper 실행기와 클릭 채널의 별도 상태·취소·정리 | helper는 stdout/stderr가 배출된 `close`까지 소유하며, 클릭 pipe는 전송 종료 후 최대 5분 유지한다. `clicked`, 승인 socket, 결과 완료 상태는 서로 다른 중복·인증 조건을 담당한다. |
| WIN-02 | 유지 | native 창 열거·`includeHidden`·ABI 크기 | 창 열거와 숨김 창 포함 옵션은 Extension Host/toast host 검증에서 사용하고, 구조체 크기는 ABI 검사와 `FlashWindowEx` 호출에 사용한다. 제품 진입점에서 직접 호출하지 않는다는 이유로 제거할 수 없다. |
| WIN-03 | 유지 | protocol URI 처리와 기존 타입 재export | URI는 실제 명령 분기·등록·네이티브 계약 검사와 연결돼 있고 기존 알림 호환 경로로 문서화돼 있다. `ToastProcessPorts`는 기존 공개 import 경로를 통해 테스트가 사용한다. 지원 종료 근거 없이 없애지 않는다. |

`launchToast`의 동기 예외 처리도 유지했다. helper 실행기가 launch 오류를 Promise 거절로 정규화하지만, 그 바깥의 입력 구성·텍스트 변환·진단 callback 실패까지 같은 실패 정리 경로로 연결하는 범위이므로 단순 중복 `catch`로 판정하지 않았다.

## 실제 검증과 한계

- `npx tsx --test tests/toast.test.ts tests/toast-process.test.ts tests/toast-activation.test.ts tests/windows.test.ts`: **34개 통과**, 실패·생략 없음. 실제 Windows pipe I/O, 제어된 helper 경계, 읽기 전용 native ABI 검사와 창 식별·flash 대역 검사를 포함한다.
- `npm run typecheck`: 통과.
- C#을 변경하지 않아 이 영역에서 별도 빌드나 네이티브 계약 스크립트를 실행하지 않았다. 해당 스크립트의 COM 검사는 사용자 레지스트리의 일시 변경을 포함하므로 읽기·호출 경로 확인까지만 수행했다.
- 실제 등록·설치·toast 배너·사용자 클릭·OS 포커스 전환은 검증하지 않았다. 알고리즘·자료구조·캐시·순회 비용을 바꾸지 않았으므로 성능 개선을 주장하거나 벤치마크를 추가하지 않는다.
