# vscode

세션·알림 기능을 VS Code 창의 설정·명령·입력·표시에 연결한다.

- [application.ts](application.ts) — `Application`: 창별 서비스를 구성하고 확장 API·진단·상태바와 활성화·해제를 관리한다.
- [commands.ts](commands.ts) — `SessionCommands`: 세션 명령을 등록하고 사용자 입력 중 같은 세션의 명령 중복을 막는다.
- [interaction.ts](interaction.ts) — `AgentInput`: 작업·폴더·승인·질문을 VS Code 대화상자로 제공한다.
- [notifications.ts](notifications.ts) — `WindowNotifications`: 자동 관찰·결과 알림·토스트를 현재 창의 설정과 소유권에 연결한다.
- [results.ts](results.ts) — 최근 결과를 표시하고 잘린 미리보기의 전체 본문을 실행 제공자에서 조회한다.
- [window.ts](window.ts) — `CodeWindow`: 네이티브 창 식별·포커스 관찰·깜박임 수명을 관리한다.
