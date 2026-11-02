# live

실제 Codex App Server와 Claude Agent SDK를 사용해 실행·입력·이력 동작을 검증한다.

- [live.ts](live.ts) — 완료 결과와 Codex 재연결 시 중복 알림 방지를 검증한다. `npm run test:live`로 실행한다.
- [live-codex-input.ts](live-codex-input.ts) — Codex 질문·승인·권한·취소·재연결을 검증한다. `npm run test:live:codex-input`으로 실행한다.
- [live-claude-input.ts](live-claude-input.ts) — Claude 질문·승인·취소·턴 제한을 검증한다. `npm run test:live:claude-input`으로 실행한다.
- [live-codex-history.ts](live-codex-history.ts) — 완료된 실제 검증 세션의 이력 복원·결과 조회·재알림 방지를 검증한다. `npm run test:live:codex-history`로 실행하며 새 모델 턴을 시작하지 않는다.

`live.ts`의 `LiveProbe`는 시작 → 실행 → 대기 → 결과 기록 → 완료 검증을 공통 흐름으로 조율한다. Codex의 연결 열기·재연결 검증과 Claude의 SDK 실행 구성은 제공자별 생성 메소드에서 정하고, 실패 기록과 자원 정리는 공통 실행 경계에서 처리한다. `main()`은 제공자 순회와 보고서 저장만 맡는다.

입력·이력 검증 스크립트의 `main()`은 시나리오 순회와 보고서 저장을 조율한다. 각 파일의 `ClaudeInputProbe`·`CodexInputProbe`·`CodexHistoryProbe`가 한 시나리오의 상태와 자원 정리를 맡고, 입력 응답·완료 대기·결과 대조·재연결 검증은 역할별 메소드로 구분한다. Codex 이력의 기록 읽기·시나리오 선택도 별도 함수로 분리한다.

저장소 루트에서 명시적으로 실행하며 기본 `npm test`에는 포함되지 않는다. 이력 검증을 제외한 스크립트는 로그인된 실제 런타임으로 모델을 호출한다. 기록은 `test-artifacts`에 남긴다.
