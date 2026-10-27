# codex

Codex App Server 실행·관찰·이력 복구를 공통 세션 상태와 연결한다.

- [adapter.ts](adapter.ts) — `CodexAdapter`: 프로토콜 이벤트를 세션 상태로 변환하며 승인 응답 변환 함수도 제공한다.
- [connection.ts](connection.ts) — `CodexConnection`: 연결 세대별 초기화·이벤트 대기·응답 캐시·복구 재시도를 관리한다.
- [events.ts](events.ts) — `CodexEvents`: 관찰 연결의 알림 대상 스레드를 선별하고 실시간 이벤트를 세션에 반영한다.
- [executable.ts](executable.ts) — 설정과 PATH에서 셸을 거치지 않고 실행할 App Server 명령을 결정한다.
- [execution.ts](execution.ts) — `CodexExecution`: 스레드·턴 명령을 세션 상태·연결·이력 복구와 조율한다.
- [history.ts](history.ts) — `CodexHistory`: 연결 유효성과 상한을 검증하며 턴·요청 식별자·최종 본문을 조회한다.
- [index.ts](index.ts) — Codex 실행·프로토콜 변환·제공자의 공개 항목을 내보낸다.
- [provider.ts](provider.ts) — `CodexProvider`: 프로세스 식별·실행·관찰 생성과 승인·질문 응답을 제공한다.
- [reconciliation.ts](reconciliation.ts) — `CodexReconciliation`: 저장 이력을 허용된 실행과 대조해 시작 요청·종료 상태·본문을 복구한다.
