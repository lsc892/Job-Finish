# 공급자별 관찰 이벤트 처리 분리의 상세 근거

2026-10-24 기준. [통합 검토안 R1](../readability-refactor.md#r1)의 근거다. 새 제품 파일은 만들지 않았고 라우터 분리는 미적용이다.

## 현재 흐름과 문제

[AgentStreamObserver.attach](../../src/runtime/observe.ts#L94)는 실제 stdio 연결마다 [AgentEventRouter](../../src/runtime/event-router.ts#L15)를 하나 만든다. 입력을 관찰한 [outgoing](../../src/runtime/event-router.ts#L28)은 Codex의 ephemeral 시작 요청 또는 Claude의 user/control 요청을 기록한다. 출력은 [incoming](../../src/runtime/event-router.ts#L66)에서 공급자에 따라 전달한다.

- [Codex 처리](../../src/runtime/event-router.ts#L71)는 시작 응답과 thread 알림으로 ephemeral·subagent를 제외하고, 관련 live 이벤트에만 Session을 만든 뒤 [CodexAdapter](../../src/runtime/codex.ts#L43)를 호출한다. history RPC 응답은 알림 경로에 들어오지 않는다.
- [Claude 처리](../../src/runtime/event-router.ts#L97)는 init/result/control 메시지를 구분한다. [결과 처리](../../src/runtime/event-router.ts#L121)는 형식 검증 → 중복 확인 → 사용자 ID 대조 → [임시 턴 상태 이전](../../src/runtime/event-router.ts#L142) → 완료 반영 → 중복 키 저장 → 입력 큐 소비 순서다. [control 응답](../../src/runtime/event-router.ts#L169)은 실제 interrupt 성공 응답에만 취소를 확정한다.
- [공통 세션 관리](../../src/runtime/event-router.ts#L180)는 소유 실행 제외, 32개 상한과 idle 퇴출, 연결별 Session 구성·신호 전달을 담당한다.

메소드별 단계는 분리했지만 두 공급자의 상태는 같은 클래스에 남아 있다. `ignored`는 Codex 전용, `claudeRequests/claudeResults/claudeSessionId`는 Claude 전용이다. `pendingThreads`는 Codex에서는 ephemeral 요청 여부, Claude에서는 interrupt 확인 대기로 사용된다. 새로운 공급자를 추가하면 같은 클래스의 입력·출력 선택과 상태·정리 코드를 함께 수정하게 된다.

## 예상 역할과 호출부

| 위치 | 역할 |
| --- | --- |
| 기존 [event-router.ts](../../src/runtime/event-router.ts#L15) | 외부 facade, connectionId·공통 sessions·소유권·상한·snapshot, 선택한 공급자 처리기의 수명 |
| `src/runtime/events/codex.ts` (생성 예정) | Codex의 입출력 해석, ephemeral/subagent 제외, 전용 요청·제외 상태 |
| `src/runtime/events/claude.ts` (생성 예정) | Claude 입력 큐·결과 중복·임시 ID 이전·control 요청과 interrupt 확인 상태 |

구조 전후는 [통합 배치도](../readability-refactor.md#변경-전후-배치)를 따른다. 처리기는 facade의 세션 접근 콜백을 받고 공급자 상태를 함께 소유한다. 처리기끼리 서로를 호출하거나 외부 stdio에 쓰지 않는다. [Session](../../src/core/session.ts#L5)의 변경·알림 계약과 [직접 실행 Codex](../../src/runtime/codex.ts#L109)·[Claude](../../src/runtime/claude.ts#L18)는 분리 대상이 아니다.

직접 호출부는 [관찰자](../../src/runtime/observe.ts#L96), [라우터 테스트](../../tests/event-router.test.ts#L8)다. [관찰 테스트](../../tests/observe.test.ts#L25)와 [부하 스크립트](../../scripts/router-load.ts#L12)는 관찰자를 통해 간접 영향을 받는다. 기존 constructor/outgoing/incoming/snapshot/dispose 계약은 유지한다.

## 적용 순서·위험·검증

1. Codex 전용 상태·입출력을 먼저 옮기고 history·ephemeral·subagent 제외와 소유 세션 제외를 검증한다.
2. Claude 상태·처리를 옮기고 임시 UUID, 잘못된 결과·재전달, 여러 입력, control 취소·성공·실패 응답을 검증한다.
3. facade 생성·snapshot·dispose가 처리기 하나와 공통 세션을 함께 정리하는지 확인한다. 연결 ID를 처리기마다 새로 만들지 않는다.

[라우터 테스트](../../tests/event-router.test.ts#L14), [관찰 테스트](../../tests/observe.test.ts#L25), [캡처 이벤트](../../tests/captured.test.ts#L9), [세션 상태 테스트](../../tests/state.test.ts#L10)로 이벤트 순서·중복 억제·바이트 보존을 보호한다. 순차 처리를 병렬화하거나 전체 기록을 새로 복사하지 않는다. 큐·중복 키·세션 상한도 유지해야 한다.

확인한 사실은 공급자 상태와 검증·큐 소비 순서다. 공급자 추가 빈도나 파일 분리가 유지보수 시간을 얼마나 줄이는지는 측정하지 않았다. 현재 두 공급자 지원만 유지한다면 파일 내부 정리로도 운영 가능하므로, 이 안은 확장성과 책임 경계를 위한 선택지다. 분리 구현과 새 경계의 검증은 남아 있다.
