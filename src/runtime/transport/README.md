# transport

관리하는 자식 프로세스와 용량이 제한된 JSON Lines RPC 통신을 제공한다. 외부 호출자는 기존 [transport.ts](../transport.ts)에서 공개 타입과 클래스를 가져온다.

- [message.ts](message.ts) — `RpcId`·`RpcMessage`의 공통 형식과 `RpcError`를 정의한다.
- [json-lines.ts](json-lines.ts) — `JsonLines`: 바이트 스트림을 줄 단위로 나누고 UTF-8·JSON·RPC 형식과 메시지 크기를 검증한다.
- [event-queue.ts](event-queue.ts) — `EventQueue`: 초기화 전 이벤트를 개수·바이트 상한 안에서 보관하고 순서대로 전달한다.
- [pending-requests.ts](pending-requests.ts) — `PendingRequests`: 요청 ID·Promise·30초 타이머와 대기 요청 상한·응답 매칭·일괄 거절을 소유한다. 전송과 연결 실패 처리는 주입한 콜백으로 요청한다.
- [stdio-rpc.ts](stdio-rpc.ts) — `StdioRpc`: 자식 프로세스·표준 입출력·송신 버퍼·연결 상태·정상/강제 종료를 소유하며 해석과 요청 추적을 조립한다.

수신은 `StdioRpc` → `JsonLines` → `StdioRpc.dispatch()` 순서다. 서버 요청·알림은 수신 콜백으로, 응답은 `PendingRequests.completeResponse()`로 전달한다. 요청 만료·전송 실패는 `StdioRpc.fail()`로 돌아와 연결을 한 번 닫는다. 종료 시 디코더 초기화 → 대기 요청 거절·타이머 해제 → 자식 stdin 종료와 강제 종료 예약 순서를 유지한다.

하위 모듈은 공개 진입점을 import하지 않는다. `PendingRequests`는 프로세스를 직접 참조하지 않고, `JsonLines`와 `EventQueue`는 요청 추적이나 프로세스 수명에 의존하지 않는다.
