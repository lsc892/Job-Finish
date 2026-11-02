# claude

Claude SDK 실행과 기존 연결의 이벤트를 공통 세션·입력 요청으로 변환한다.

- [adapter.ts](adapter.ts) — SDK 결과의 실행 식별자를 검증하고 세션 본문·종료 상태로 변환한다.
- [events.ts](events.ts) — `ClaudeEvents`: 관찰한 사용자 입력·초기화를 턴에 연결하고 최종 결과·승인/질문·중단 확인을 세션에 반영한다.
- [execution.ts](execution.ts) — `ClaudeExecution`: 턴 준비·SDK 인자 구성·이벤트 수신과 정상 종료·취소·해제의 정리 경계를 관리한다.
- [index.ts](index.ts) — Claude 실행·결과 변환·제공자의 공개 항목을 내보낸다.
- [permissions.ts](permissions.ts) — `ClaudePermissions`: SDK 권한 콜백의 유효성 확인·pending/철회 구독·세션 기록·응답 정리를 관리한다.
- [provider.ts](provider.ts) — `ClaudeProvider`: 프로세스 식별·실행·관찰 생성과 승인·질문 응답을 제공한다.
