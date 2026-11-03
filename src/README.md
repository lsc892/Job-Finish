# src

기존 Codex·Claude Code 확장의 이벤트를 관찰해 같은 VS Code 창의 Windows 알림으로 연결하는 제품 코드다.

- [extension.ts](extension.ts) — 로컬 Windows 환경 확인과 활성화·해제.
- [core](core/README.md) — 관찰 세션 상태·중복 제거·알림 정책.
- [runtime](runtime/README.md) — 기존 프로세스 관찰과 Codex·Claude 이벤트 해석.
- [vscode](vscode/README.md) — 설정·4개 명령·결과 표시·창별 서비스.
- [windows](windows/README.md) — HWND 검증·작업 표시줄 깜박임·네이티브 토스트.

제품 코드는 [tests](../tests/README.md)와 [build](../build/README.md)를 가져오지 않는다. 타입 검사는 제품과 테스트를 구분한다.
