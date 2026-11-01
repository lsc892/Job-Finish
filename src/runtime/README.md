# runtime

제공자별 실행과 기존 프로세스 관찰을 공통 세션 상태에 연결한다.

- [agent-provider.ts](agent-provider.ts) — `AgentProvider`는 실행·관찰·입력 응답 계약을 제공하고 `AgentProviderRegistry`는 등록 검증·조회를 담당한다.
- [claude](claude/README.md) — Claude SDK 실행과 기존 Claude 연결의 이벤트를 세션에 반영한다.
- [codex](codex/README.md) — Codex App Server 실행·관찰·이력 복구를 처리한다.
- [event-router.ts](event-router.ts) — `AgentEventRouter`: 관찰 연결의 세션 수명을 관리하고 메시지 해석을 제공자에 위임한다.
- [execution.ts](execution.ts) — `AgentRuntime`: 공통 실행 계약을 제공하고 세션 소유권을 검증한다.
- [message.ts](message.ts) — 관찰 메시지의 객체·식별자를 검증하고 중복 추적 크기를 제한한다.
- [observe.ts](observe.ts) — `Frames`는 관찰 프레임을 분리하고 `AgentStreamObserver`는 Extension Host 자식 프로세스를 관찰해 실행 신호를 전달한다.
- [providers.ts](providers.ts) — 기본 Claude·Codex 제공자를 등록하고 실행 환경 식별자를 조회한다.
- [transport.ts](transport.ts)
  - `RpcError`: RPC 응답의 오류 코드와 메시지를 전달한다.
  - `JsonLines`: 크기가 제한된 JSON Lines 메시지를 분리하고 RPC 형식을 검증한다.
  - `EventQueue`: 초기화 전 RPC 이벤트를 용량 상한 안에서 보관·전달한다.
  - `StdioRpc`: 관리하는 자식 프로세스와 요청·응답·알림·종료를 처리한다.
