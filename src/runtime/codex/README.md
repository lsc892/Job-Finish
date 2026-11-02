# codex

Codex App Server 실행·관찰·이력 복구를 공통 세션 상태와 연결한다.

관찰 경로의 `CodexEvents`는 **어떤 스레드의 이벤트를 받을지** 결정한다. 임시·하위 스레드를 제외하고 제목을 수집한 뒤 실시간 이벤트만 전달한다. 저장 이력은 제목에만 사용한다.

직접 실행과 관찰이 함께 사용하는 `CodexAdapter`는 **받은 이벤트가 세션 상태에 무엇을 뜻하는지** 해석한다. 최종 응답 본문은 보관하고, 명시적 `turn/completed` 상태로 종료를 확정한다. 일반 `error` 이벤트는 진단으로 남긴다.

- [adapter.ts](adapter.ts) — `CodexAdapter`: 시작·본문·입력 대기·종료 이벤트를 세션 상태로 변환하며 승인 응답 변환 함수도 제공한다.
- [connection.ts](connection.ts) — `CodexConnection`: 연결 세대별 초기화·이벤트 대기·응답 캐시·복구 재시도를 관리한다.
- [events.ts](events.ts) — `CodexEvents`: 제외 대상 기록 → 제목 수집 → 실시간 이벤트 전달 순서로 관찰 연결을 처리한다.
- [executable.ts](executable.ts) — 설정·PATH의 후보 탐색과 발견한 경로의 native·Node 실행 명령 변환을 구분한다.
- [execution.ts](execution.ts) — `CodexExecution`: 스레드·턴 명령을 세션 상태·연결·이력 복구와 조율한다.
- [history.ts](history.ts) — `CodexHistory`: 연결 유효성과 상한을 검증하며 턴·요청 식별자·최종 본문을 조회한다.
- [index.ts](index.ts) — Codex 실행·프로토콜 변환·제공자의 공개 항목을 내보낸다.
- [provider.ts](provider.ts) — `CodexProvider`: 프로세스 식별·실행·관찰 생성과 승인·질문 응답을 제공한다.
- [reconciliation.ts](reconciliation.ts) — `CodexReconciliation`: 저장 이력을 허용된 실행과 대조해 시작 요청·종료 상태·본문을 복구한다.
