# claude

[events.ts](events.ts)의 `ClaudeEvents`가 기존 Claude Code 확장의 JSON 스트림을 해석한다. Claude SDK 의존성은 없다.

사용자 요청·초기화·결과·도구 승인·질문·중단 확인을 관찰한다. 결과의 세션·요청 UUID와 본문을 확인하고, 늦게 부여된 사용자 UUID는 임시 턴에서 이전한다. 실제 result 또는 interrupt 승인으로 종료를 판정하며 프로세스 종료만으로 완료를 추정하지 않는다. 응답은 원래 Claude UI에서 처리한다.
