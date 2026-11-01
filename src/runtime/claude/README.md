# claude

Claude SDK 실행과 기존 연결의 이벤트를 공통 세션·입력 요청으로 변환한다.

- [adapter.ts](adapter.ts) — SDK 결과의 실행 식별자를 검증하고 세션 본문·종료 상태로 변환한다.
- [events.ts](events.ts) — `ClaudeEvents`: 관찰 연결의 요청·입력 대기·결과·중단 확인을 세션에 반영한다.
- [execution.ts](execution.ts) — `ClaudeExecution`: 소유한 SDK 질의·결과·도구 권한·중단 수명을 관리한다.
- [index.ts](index.ts) — Claude 실행·결과 변환·제공자의 공개 항목을 내보낸다.
- [permissions.ts](permissions.ts) — `ClaudePermissions`: 현재 실행의 SDK 권한 요청과 사용자 응답·철회를 관리한다.
- [provider.ts](provider.ts) — `ClaudeProvider`: 프로세스 식별·실행·관찰 생성과 승인·질문 응답을 제공한다.
