# fixtures

합성 보조 프로세스와 실제 런타임에서 보존한 이벤트 입력을 제공한다.

- [app-server.cjs](app-server.cjs) — Codex 초기화·실행·입력·취소·페이지 이력을 합성 stdio App Server로 제공한다.
- [claude-auth-error.json](claude-auth-error.json) — 실제 Claude 인증 실패 결과를 상태 변환 검증에 제공한다.
- [claude-input-contracts.json](claude-input-contracts.json) — 실제 Claude 질문·승인·취소·턴 제한 검증에서 보존한 입력 계약을 제공한다.
- [claude-success.json](claude-success.json) — 실제 Claude 완료 결과를 상태 변환 검증에 제공한다.
- [claude-turn-limit.json](claude-turn-limit.json) — 실제 Claude 최대 턴 제한 오류 결과를 상태 변환 검증에 제공한다.
- [codex-api-error.json](codex-api-error.json) — 실제 Codex API 오류 이벤트를 상태 변환 검증에 제공한다.
- [codex-approval.json](codex-approval.json) — 실제 Codex 명령 승인 요청과 종료 이벤트를 제공한다.
- [codex-cancel.json](codex-cancel.json) — 실제 Codex 질문 대기와 취소 종료 이벤트를 제공한다.
- [codex-permissions.json](codex-permissions.json) — 실제 Codex 권한 승인 요청과 종료 이벤트를 제공한다.
- [codex-question.json](codex-question.json) — 실제 Codex 질문 요청·해소·완료 이벤트를 제공한다.
- [codex-success.json](codex-success.json) — 실제 Codex 실행 시작·최종 응답·완료 이벤트를 제공한다.
- [codex-usage-limit.json](codex-usage-limit.json) — 실제 Codex 사용량 한도 초과 종료 이벤트를 제공한다.
- [hold-gate.ts](hold-gate.ts) — 별도 프로세스에서 Windows 파일 잠금을 유지해 배제와 강제 종료 복구 검증을 지원한다.
- [observed-agent.cjs](observed-agent.cjs) — 입력한 이벤트·원시 프레임을 stdout에 전달해 비파괴 관찰 검증을 지원한다.
