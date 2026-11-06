# runtime

- [observe.ts](observe.ts) — 같은 Extension Host의 기존·신규 Codex·Claude 프로세스를 식별하고 연결을 관찰한다.
- [observed-connection.ts](observed-connection.ts) — 원래 stdin write를 보존하며 송신·수신 JSONL을 해석하고 종료 시 구독을 해제한다.
- [frames.ts](frames.ts) — 긴 JSON 문자열을 제한된 미리보기로 읽고, 구조가 너무 큰 프레임 이후에는 다음 줄부터 관찰을 이어간다.
- [event-router.ts](event-router.ts) — 연결별 세션과 이벤트 해석기를 소유한다. 이력 응답은 알림을 만들지 않는다.
- [providers.ts](providers.ts) — 지원하는 두 확장의 ID·프로세스 인수·해석기 생성 목록.
- [agent-provider.ts](agent-provider.ts) — 관찰 해석기의 타입 계약.
- [message.ts](message.ts) — 객체·식별자 검사와 추적 컬렉션 상한.
- [codex](codex/README.md) · [claude](claude/README.md) — 각 스트림의 이벤트 해석.

관찰 → 연결 → 라우터 → 해석기 → 공통 세션 → 알림 순서로 처리한다. 감지를 위한 별도 에이전트 실행·RPC 송신·SDK·이력 조회는 없다.
