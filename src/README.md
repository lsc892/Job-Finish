# src

에이전트 실행·자동 관찰·세션 상태를 VS Code 창의 Windows 알림에 연결한다.

- [extension.ts](extension.ts) — 로컬 Windows 환경을 확인하고 애플리케이션을 활성화·해제한다.
- [application](application/README.md) — 실행 제공자와 소유권을 조율하며 연결된 세션 자원을 관리한다.
- [core](core/README.md) — 세션 상태·소유권·알림 전달의 공통 규칙을 제공한다.
- [protocol](protocol/README.md) — 외부 Codex App Server에서 생성한 프로토콜 타입 계약을 보관한다.
- [runtime](runtime/README.md) — 제공자별 실행과 기존 프로세스 관찰을 공통 세션에 연결한다.
- [vscode](vscode/README.md) — VS Code 명령·입력·결과·창별 서비스와 설정을 연결한다.
- [windows](windows/README.md) — Windows 창 식별·깜박임·네이티브 토스트를 처리한다.
