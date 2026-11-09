# codex

[events.ts](events.ts)의 `CodexEvents`가 기존 Codex App Server의 요청·응답·실시간 이벤트를 해석한다.

[thread-diagnostics.ts](thread-diagnostics.ts)는 메타데이터 수신 경로·부모 관계·제외 목록 상태와 턴 통과 판정을 기록한다. 요청과 메타데이터의 진단 이력은 각각 512개로 제한하며 알림 정책은 변경하지 않는다.

- 임시·하위 스레드를 제외하고 이름·미리보기·첫 요청으로 제목을 정한다.
- 턴 종료의 completed·failed·interrupted를 완료·오류·취소로 알린다.
- 승인·동기 질문은 입력 대기로 추적하고 실제 해소 이벤트를 반영한다.
- 비동기 질문은 item/started·item/completed에서 한 번만 알리며 최종 본문과 실행 상태를 바꾸지 않는다.
- 저장 이력은 제목만 갱신하고 완료를 다시 알리지 않는다.
