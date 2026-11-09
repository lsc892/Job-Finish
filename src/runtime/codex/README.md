# codex

[events.ts](events.ts)의 `CodexEvents`가 기존 Codex App Server의 요청·응답·실시간 이벤트를 해석한다.

[thread-diagnostics.ts](thread-diagnostics.ts)는 진단 빌드에서 메타데이터 수신 경로·부모 관계·제외 목록 상태와 턴 통과 판정을 기록한다. 요청과 메타데이터의 진단 이력은 각각 512개로 제한하며 알림 정책은 변경하지 않는다. 생성·호출의 `diagnostic:` 라벨은 일반 빌드에서 제거되어 이 모듈이 제품 번들에 포함되지 않는다.

- [thread-metadata.ts](thread-metadata.ts)의 공통 조건으로 단일·목록 응답의 임시·하위 스레드를 제외한다. 부모 ID, source의 `subAgent`·`subagent`, `threadSource: subagent`와 snake_case 표기를 인식한다.
- `subAgentActivity`의 `kind: started`와 `collabAgentToolCall`의 `spawnAgent` 항목에서도 자식 ID를 제외한다. 항목 시작·완료와 실시간 턴의 항목 목록을 세션 처리 전에 확인하므로 별도 스레드 메타데이터에만 의존하지 않는다. `interacted`의 상대는 부모·형제일 수도 있으므로 메시지 교환·중단·완료 활동과 일반 메시지 전송의 수신자는 제외 근거로 사용하지 않는다.
- 제외 등록은 `codex.thread.excluded`에 근거·부모 ID를 남긴다. 나머지 스레드의 이름·미리보기·첫 요청으로 제목을 정한다.
- 턴 종료의 completed·failed·interrupted를 완료·오류·취소로 알린다.
- 승인·동기 질문은 입력 대기로 추적하고 실제 해소 이벤트를 반영한다.
- 비동기 질문은 item/started·item/completed에서 한 번만 알리며 최종 본문과 실행 상태를 바꾸지 않는다.
- 저장 이력은 제목만 갱신하고 완료를 다시 알리지 않는다.
