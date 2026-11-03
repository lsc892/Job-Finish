# fixtures

- [observed-agent.cjs](observed-agent.cjs) — 기존 Codex·Claude 프로세스를 대신해 제어된 JSONL을 송수신한다. 제품은 이 프로세스를 실행하지 않는다.
- `codex-*.json` — 실제 기록의 완료·오류·질문·승인·권한·취소·사용량 한도 이벤트.
- `claude-*.json` — 실제 기록의 정상·인증 오류·턴 제한 결과. 외부 Claude에서 발생한 제한도 오류로 분류한다.
- [capture-codex-input.mjs](capture-codex-input.mjs) — 보존된 실제 기록에서 Codex 입력 이벤트의 식별자와 임시 경로를 치환한다.

이벤트 fixture는 현재 자동 관찰 경로로 검사하며 별도 App Server나 Claude SDK를 띄우지 않는다.
