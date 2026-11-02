# live

실제 Codex App Server와 Claude Agent SDK를 사용해 실행·입력·이력 동작을 검증한다.

- [live.ts](live.ts) — 완료 결과와 Codex 재연결 시 중복 알림 방지를 검증한다. `npm run test:live`로 실행한다.
- [live-codex-input.ts](live-codex-input.ts) — Codex 질문·승인·권한·취소·재연결을 검증한다. `npm run test:live:codex-input`으로 실행한다.
- [live-claude-input.ts](live-claude-input.ts) — Claude 질문·승인·취소·턴 제한을 검증한다. `npm run test:live:claude-input`으로 실행한다.
- [live-codex-history.ts](live-codex-history.ts) — 완료된 실제 검증 세션의 이력 복원·결과 조회·재알림 방지를 검증한다. `npm run test:live:codex-history`로 실행하며 새 모델 턴을 시작하지 않는다.

저장소 루트에서 명시적으로 실행하며 기본 `npm test`에는 포함되지 않는다. 이력 검증을 제외한 스크립트는 로그인된 실제 런타임으로 모델을 호출한다. 기록은 `test-artifacts`에 남긴다.
