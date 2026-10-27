# 확장·Windows 가독성 정리와 구조 분리 근거

2026-10-27 기준. [통합 검토안](../readability-refactor.md)의 Windows 영역 상세 기록이다. 파일 내부 정리 후 사용자가 검토안 전체 적용을 승인했고, W2의 프로세스·클릭 채널 분리와 경계 검증을 완료했다.

## 검토 범위와 현재 흐름

[WindowsToast](../../src/windows/toast.ts#L10), [프로세스 실행기](../../src/windows/toast-process.ts#L12), [클릭 채널](../../src/windows/toast-activation.ts#L16), [WindowIdentity](../../src/windows/native.ts#L55), [FlashController](../../src/windows/flash.ts#L4), [게이트](../../src/windows/gate.ts#L5), C# [Program](../../tools/windows-toast/Program.cs#L13)·[COM 호스팅](../../tools/windows-toast/ComActivator.cs#L4)·[등록](../../tools/windows-toast/Registration.cs#L5)·[전달 관찰](../../tools/windows-toast/ToastDelivery.cs#L5)·[포커스](../../tools/windows-toast/Focus.cs#L4)를 검토했다.

[show](../../src/windows/toast.ts#L37)는 등록 완료와 세대 재검사 → 클릭 pipe 열기 → helper 실행 → 진단을 통한 전송 완료 판정 순서로 처리한다. helper가 종료되어도 클릭 pipe는 살아 있다. 클릭은 ID 대조 → 현재 소유권에 따른 승인 응답 → 승인 socket의 활성화 결과 1회 처리 순서다.

## 적용 내용과 동작 보존

- facade의 [launchToast](../../src/windows/toast.ts#L58)는 전송 진단을 검증하고, [ToastProcessRunner.run](../../src/windows/toast-process.ts#L16)은 helper 입출력과 완료·취소를 소유한다. 반환된 `completion`은 기존 Promise 체인에 바로 연결하며 추가 `await`나 중간 Promise 체인을 만들지 않았다. 동기 launch 오류도 완료 Promise의 거절로 전달한다.
- [클릭 승인](../../src/windows/toast-activation.ts#L59)과 [활성화 결과 처리](../../src/windows/toast-activation.ts#L71)는 클릭 채널이 소유한다. ID 검증과 거절 시 프레임 처리 종료, 승인 socket·결과 1회 처리, 사용자 콜백 오류의 독립적인 기록 경계는 유지했다.
- helper timeout·stderr·진단 상한은 [프로세스 모듈](../../src/windows/toast-process.ts#L7)에, 클릭 pipe 수명·socket·callback 상한은 [활성화 모듈](../../src/windows/toast-activation.ts#L10)에 둔다. 값과 비교 규칙은 바꾸지 않았다. helper 완료는 `exit`가 아닌 stdout/stderr가 배출된 `close`에서 최종 판정한다.
- 교체·stop은 이전 `show` 대기를 먼저 해소한 뒤 채널과 해당 helper를 정리한다. 전체 dispose는 추가로 등록을 포함한 살아 있는 모든 helper를 정리한다. 전송 완료 뒤 클릭 채널의 수명은 별도로 유지한다.
- C#과 `native`·`flash`·`gate`는 변경하지 않았다. 기존 공개 타입은 [toast.ts 재export](../../src/windows/toast.ts#L6)로 유지하고, C# JSON·COM 계약·알고리즘·자료구조도 유지했다.

## 검증 결과와 범위

- `npx tsx --test tests/toast.test.ts tests/toast-process.test.ts tests/toast-activation.test.ts tests/windows.test.ts`: 34개 모두 통과. 기존 23개에 11개 경계 테스트를 보강했다. [프로세스 테스트](../../tests/toast-process.test.ts#L26)는 `close` 대기·분할 진단·부분 JSON 종료·잘못된/초과 진단·15초 timeout·개별/전체 취소·동기 launch 실패를 검증한다. [클릭 채널 테스트](../../tests/toast-activation.test.ts#L21)는 4소켓 상한·실제 5초 idle timeout·가상 5분 만료·클릭 시 소유권 재검사를 검증한다. [기존 toast 테스트](../../tests/toast.test.ts#L70)는 전송 종료 후 클릭·승인 socket·중복 억제·등록 공유와 [진행 중 전송 교체·stop·dispose](../../tests/toast.test.ts#L186)를 보호한다.
- `npm run typecheck`: 통과. 새 테스트는 객체 배치나 메소드 이름을 고정하지 않고 전송·취소·socket의 관측 가능한 계약을 검사한다.
- 실제 설치·등록·배너 표시·사용자 클릭은 실행하지 않았다. 전체 확장 검사 결과는 [통합 검토안](../readability-refactor.md)에 기록한다.

<a id="w1"></a>

## W1 — Application의 세션 수명 관리: 승인·적용 완료

[ApplicationSessions](../../src/application/sessions.ts#L34)가 실행·Session·lease와 연결 중 자원·저장·해제를 함께 소유한다. [확장 조립부](../../src/vscode/application.ts)는 설정·Provider 조회·저장소와 신호·상태·해제 콜백을 주입하며 명령·UI·Windows 객체를 연결한다. 의존 방향은 확장 → 세션 수명 → runtime/core이고 세션 수명 모듈은 VS Code에 의존하지 않는다.

초기 복구 이벤트 전에 Session을 등록하고, 연결 전·후와 저장 중 종료가 늦은 등록·성공 반환을 막는다. 실행 정리 실패 후에도 lease를 해제하며 최초 오류를 유지한다. 이전 선택창 Entry는 같은 ID의 새 연결을 해제할 수 없다. 기존 명령·snapshot/test API·저장 32개 상한은 유지했다.

상세 책임 경계·종료/실패 보완·17개 새 계약 테스트와 검증 범위는 [Application 기록](application.md)에 모았다. 단일·이중 Extension Host의 최종 결과는 [통합 기록](../readability-refactor.md)에 기록한다.

<a id="w2"></a>

## W2 — 프로세스 실행과 클릭 채널의 서로 다른 수명: 승인·적용 완료

사용자의 검토안 전체 적용 지시에 따라 프로세스 실행기와 클릭 채널을 분리했다. 기존에는 `WindowsToast`가 helper와 pipe·socket·timer를 모두 소유했으나, 현재는 각 수명이 자기 자원과 상태를 소유하고 facade가 교체·stop·dispose를 조율한다.

| 적용 위치 | 역할과 상태 | 유지한 계약 |
| --- | --- | --- |
| [toast.ts](../../src/windows/toast.ts#L10) | registration·generation, 현재 알림 선택, 활성 채널과 실행별 취소 핸들의 조율 | 기존 공개 initialize/show/stop/dispose와 타입 export 경로 |
| [toast-process.ts](../../src/windows/toast-process.ts#L12) | 실행별 cancel·completion·pid, stdout 파서, stderr·바이트·시간 상한, 전체 child 집합 | [프로세스 주입 타입](../../src/windows/toast-process.ts#L4), close 뒤 최종 실패 판정 |
| [toast-activation.ts](../../src/windows/toast-activation.ts#L16) | pipe·socket·만료, clicked·authorizedSocket·completed | [ToastRequest](../../src/windows/toast-activation.ts#L6)의 canActivate/onClick과 [네이티브 활성화](../../tools/windows-toast/Program.cs#L121) |

의존 방향은 facade → process/activation이다. 하위 모듈은 서로 또는 facade를 import하지 않는다. 클릭 채널은 현재 알림인지 확인하는 콜백을 받고, 만료를 facade에 통지하며 private 필드를 직접 수정하지 않는다. 실행 핸들의 완료 Promise는 `close` 또는 timeout에서만 결정하고 취소는 해당 helper에만 전달한다. 전송 완료 뒤 pipe는 최대 5분 유지된다. 상한과 프레임별 처리 비용·보관량은 기존과 동일하다.

호출부는 기존 `WindowsToast`와 공개 타입 경로를 그대로 사용하므로 변경하지 않았다. 검증 결과와 미실행 범위는 위에 기록했다. 변경 전후 배치는 [통합 검토안](../readability-refactor.md#변경-전후-배치)에 연결한다.
