# vscode

- [application.ts](application.ts) — 창 UUID와 관찰·알림 서비스를 구성하고 설정·상태 표시줄·결과/창 연결/flash 정지/진단 명령을 연결한다. 공개 API는 읽기 전용이며 테스트 모드에만 native 바인딩 도우미를 노출한다.
- [notifications.ts](notifications.ts) — 설치된 두 확장의 경로로 관찰 범위를 정하고 신호를 Windows 알림에 전달한다.
- [results.ts](results.ts) — 최근 응답을 표시하고 16 KiB 상한으로 잘린 본문을 안내한다.
- [window.ts](window.ts) — HWND 관측·유효성 검사·포커스 구독·flash 수명.

질문 답변·승인·취소와 대화 관리는 기존 Codex·Claude UI가 담당한다.
