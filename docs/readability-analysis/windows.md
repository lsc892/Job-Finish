# 확장·Windows 구조 분리의 상세 근거

2026-10-24 기준. [통합 검토안](../readability-refactor.md)의 큰 변경 후보만 다룬다. 아래 새 경로는 모두 생성 예정이며 소스 분리는 적용하지 않았다.

## 검토 범위

[Application](../../src/extension.ts#L30), [WindowsToast](../../src/windows/toast.ts#L15), [WindowIdentity](../../src/windows/native.ts#L55), [FlashController](../../src/windows/flash.ts#L4), [게이트](../../src/windows/gate.ts#L5), C# [Program](../../tools/windows-toast/Program.cs#L13)·[COM 호스팅](../../tools/windows-toast/ComActivator.cs#L4)·[등록](../../tools/windows-toast/Registration.cs#L5)·[전달 관찰](../../tools/windows-toast/ToastDelivery.cs#L5)·[포커스](../../tools/windows-toast/Focus.cs#L4)를 검토했다.

<a id="w1"></a>

## W1 — Application의 세션 수명 관리

현재 [생성자](../../src/extension.ts#L46)는 저장소·관찰자·네이티브 객체·알림 콜백을 구성하고 [activate](../../src/extension.ts#L114)는 명령과 이벤트를 연결한다. 여기에 [open](../../src/extension.ts#L158)의 실행·lease·Session 생성과 저장, [detach](../../src/extension.ts#L291)의 정리까지 모여 있다. 실행 정책 변경과 UI 변경의 이유가 서로 다르지만 같은 클래스의 상태를 따라가야 한다.

[open의 createSession 콜백](../../src/extension.ts#L165)은 lease를 획득하고 Session을 구성한다. Codex 경로는 연결 완료 전에 entries에 등록한다. 따라서 생성자 호출만 옮기는 분리는 초기 이벤트의 소유권 판정을 바꿀 수 있다.

| 제안 위치 | 소유할 책임 | 영향받는 기존 호출부 |
| --- | --- | --- |
| 기존 [extension.ts](../../src/extension.ts#L30) | 확장 조립, 설정·명령·창 이벤트, 입력 UI | [명령 등록](../../src/extension.ts#L114), [질문·승인 UI](../../src/extension.ts#L208) |
| `src/application/sessions.ts` (생성 예정) | entries·opening, 연결 제한, 실행·Session·lease 생성과 정리, 저장 세션 | [owns](../../src/extension.ts#L95), [api](../../src/extension.ts#L78), [resume/withEntry](../../src/extension.ts#L189), [respond](../../src/extension.ts#L201), [updateStatus](../../src/extension.ts#L275), [dispose](../../src/extension.ts#L299) |

의존 방향은 확장 → 세션 수명 객체 → runtime/core로 둔다. 설정값과 신호·상태 변경 콜백은 주입하고, lease 소유권을 두 객체로 나누지 않는다. 기존 명령 ID와 테스트 API 형태를 유지한다. 입력 UI는 같은 파일 내부 메소드로 나뉘었으므로 별도 파일 분리 후보에서 제외했다.

검증은 [Extension Host](../../tests/extension-host.ts#L24), [소유권 테스트](../../tests/ownership.test.ts#L13), [직접 실행 통합 테스트](../../tests/integration.test.ts#L20)를 기반으로 한다. 연결 중 종료, lease 획득 실패, workspaceState 저장 실패, 동시 open 제한의 테스트를 새 경계에 보강해야 한다. 기존 테스트만으로 이 실패 경로가 전부 보호되는지는 확인하지 못했다.

<a id="w2"></a>

## W2 — 프로세스 실행과 클릭 채널의 서로 다른 수명

[runNative](../../src/windows/toast.ts#L40)는 프로세스·진단 프레임·stderr 상한·timeout·close 판정을 맡는다. [show](../../src/windows/toast.ts#L76)는 등록 대기와 세대를 확인해 pipe를 열고, helper의 제출·관찰 완료를 기다린다. [createClickServer](../../src/windows/toast.ts#L117)는 클릭 승인과 활성화 결과를 받고, [clear/stop/dispose](../../src/windows/toast.ts#L159)가 두 수명의 자원을 함께 해제한다.

전송 프로세스는 전달 관찰 후 종료되지만 클릭 pipe는 최대 5분 유지된다. 현재 active 레코드에는 child와 server/socket/timer가 함께 있고, 전체 child 집합도 별도로 있다. 메소드 추출만으로는 이 소유권과 종료 시점 차이가 해소되지 않는다.

| 제안 위치 | 역할과 상태 | 영향받는 계약 |
| --- | --- | --- |
| 기존 [toast.ts](../../src/windows/toast.ts#L15) | registration·generation, 현재 알림 선택과 두 객체의 취소·정리 | [Application 구성](../../src/extension.ts#L47), 기존 공개 show/stop/dispose |
| `src/windows/toast-process.ts` (생성 예정) | 실행별 취소·완료, stdout 파서, stderr·바이트·시간 상한, 전체 child 집합 | [프로세스 주입 타입](../../src/windows/toast.ts#L12), close 뒤 최종 실패 판정 |
| `src/windows/toast-activation.ts` (생성 예정) | pipe·socket·만료, clicked·authorizedSocket·completed | [ToastRequest](../../src/windows/toast.ts#L8)의 canActivate/onClick과 [네이티브 활성화](../../tools/windows-toast/Program.cs#L121) |

프로세스 실행기부터 분리한 뒤 클릭 채널을 분리한다. 승인 여부는 현재 소유권을 확인하는 콜백으로 받고, 자식 객체가 facade의 내부 필드를 직접 바꾸지 않게 한다. 공개 TypeScript 타입과 C#의 JSON·COM 계약은 그대로 두는 안이다.

[toast 계약 테스트](../../tests/toast.test.ts#L69) 전체로 UTF-8 분할, ID·승인 socket, 중복 클릭, 교체, 등록 공유·실패·재시도, 등록 대기 중 focus/dispose를 확인한다. 추가로 소켓 한도·callback timeout·process timeout·부분 JSON 종료를 보호해야 한다. C# 계약까지 영향이 생기면 [네이티브 계약 스크립트](../../scripts/native-toast-contract.mjs#L38)를 실행한다. 실제 배너와 사용자 클릭은 이번에 확인하지 않았다.

## 분리 후보에서 제외한 부분

[flash](../../src/windows/flash.ts#L4)와 [창 식별](../../src/windows/native.ts#L55)은 상태·타이머가 좁은 책임에 모여 있다. C#의 등록·전달·포커스·COM 호스팅도 이미 분리되어 있다. 분기 개수만을 근거로 추가 클래스를 제안하지 않았다. 후보별 배치 전후 구조와 구현 상태는 [통합 검토안](../readability-refactor.md)에 기록한다.
