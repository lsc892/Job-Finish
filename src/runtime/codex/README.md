# codex

Codex App Server 실행·관찰·이력 복구를 공통 세션 상태와 연결한다.

관찰 경로의 `CodexEvents`는 **어떤 스레드의 이벤트를 받을지** 결정한다. 임시·하위 스레드를 제외하고 제목을 수집한 뒤 실시간 이벤트만 전달한다. 저장 이력은 제목에만 사용한다.

직접 실행과 관찰은 `adapter.ts`의 `codexSessionEvent()`로 지원 이벤트를 선별하고 질문 본문을 한 번 해석한다. `CodexAdapter`는 **해석한 이벤트를 세션 상태에 반영**한다. 직접 실행의 `handle()`은 해석 후 `apply()`를 호출하고, 관찰 경로는 해석 결과로 세션을 선택한 뒤 같은 `apply()`에 전달한다. 최종 응답 본문은 보관하고, 명시적 `turn/completed` 상태로 종료를 확정한다. 일반 `error` 이벤트는 진단으로 남긴다.

`agentMessage.questions`의 비동기 질문은 `item/started`와 `item/completed`를 같은 처리 분기로 받아 실행 상태를 변경하지 않는 별도 알림으로 전달한다. `Session.notifyQuestion()`이 두 이벤트에 같은 중복 제거 키를 사용한다. 질문 메시지는 최종 본문에서 제외하고 저장 이력으로 재알림하지 않는다. 기존 RPC 질문·승인은 입력 대기 상태와 원래 요청 응답을 유지한다.

- [adapter.ts](adapter.ts) — `CodexAdapter`: 시작·본문·입력 대기·종료 이벤트를 세션 상태로 변환하며 승인 응답 변환 함수도 제공한다.
- [connection.ts](connection.ts) — `CodexConnection`: 연결 세대별 초기화·이벤트 대기·응답 캐시·복구 재시도를 관리한다.
- [events.ts](events.ts) — `CodexEvents`: 제외 대상 기록 → 제목 수집 → 실시간 이벤트 전달 순서로 관찰 연결을 처리한다.
- [executable.ts](executable.ts) — 설정·PATH의 후보 탐색과 발견한 경로의 native·Node 실행 명령 변환을 구분한다.
- [execution.ts](execution.ts) — `CodexExecution`: 스레드·턴 명령을 세션 상태·연결·이력 복구와 조율한다.
- [history.ts](history.ts) — `CodexHistory`: 연결 유효성과 상한을 검증하며 턴·요청 식별자·최종 본문을 조회한다.
- [index.ts](index.ts) — Codex 실행·프로토콜 변환·제공자의 공개 항목을 내보낸다.
- [provider.ts](provider.ts) — `CodexProvider`: 프로세스 식별·실행·관찰 생성과 승인·질문 응답을 제공한다.
- [reconciliation.ts](reconciliation.ts) — `CodexReconciliation`: 저장 이력을 허용된 실행과 대조해 시작 요청·종료 상태·본문을 복구한다.
