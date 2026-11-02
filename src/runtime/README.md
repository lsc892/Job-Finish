# runtime

제공자별 실행과 기존 프로세스 관찰을 공통 세션 상태에 연결한다.

- [agent-provider.ts](agent-provider.ts) — `AgentProvider`는 실행·관찰·입력 응답 계약을 제공하고 `AgentProviderRegistry`는 등록 검증·조회를 담당한다.
- [claude](claude/README.md) — Claude SDK 실행과 기존 Claude 연결의 이벤트를 세션에 반영한다.
- [codex](codex/README.md) — Codex App Server 실행·관찰·이력 복구를 처리한다.
- [event-router.ts](event-router.ts) — `AgentEventRouter`: 관찰 연결의 세션 수명을 관리하고 메시지 해석을 제공자에 위임한다.
- [execution.ts](execution.ts) — `AgentRuntime`: 공통 실행 계약을 제공하고 세션 소유권을 검증한다.
- [message.ts](message.ts) — 관찰 메시지의 객체·식별자를 검증하고 중복 추적 크기를 제한한다.
- [observe.ts](observe.ts) — `AgentStreamObserver`: Extension Host 자식 프로세스를 찾아 관찰 연결을 시작하고 실행 신호를 전달한다.
- [observed-connection.ts](observed-connection.ts) — `ObservedConnection`: 연결 하나의 스트림 구독·수신/송신 처리·해제를 관리한다. `Frames`는 JSONL 프레임을 분리하며, `start()`에는 이벤트와 처리기 이름의 연결만 둔다.
- [providers.ts](providers.ts) — 기본 Claude·Codex 제공자를 등록하고 실행 환경 식별자를 조회한다.
- [transport.ts](transport.ts) — 기존 JSONL·RPC 공개 import 경로를 유지한다. 구현은 [transport](transport/README.md)의 메시지 형식·JSONL 해석·초기 이벤트 큐·대기 요청·stdio 통신 모듈로 나눈다.

자동 관찰의 수신 경로는 `AgentStreamObserver.attach()` → `ObservedConnection.start()`에서 구독 등록 → 데이터 도착 시 `handleStdoutData()` → `Frames.push()` → `AgentEventRouter.incoming()` 순서다. `start()`의 `.on()`·`.once()`는 처리기를 등록하며 파싱은 수신 콜백에서 동기적으로 수행한다. 등록부에는 이름 있는 처리기를 연결하고, 해제할 구독은 등록 때 바인딩한 동일 함수 객체를 사용한다.
