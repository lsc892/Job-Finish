# vscode

[extension-host.mjs](extension-host.mjs)가 격리 프로필과 workspace에서 [extension-host.ts](extension-host.ts)를 실행한다.

- `npm run test:extension` — 지원 명령·설정과 제거된 실행 명령의 부재, 실제 Codex·Claude 스트림 관찰, 감지 켜기/끄기와 기존 프로세스 재연결, 비동기 질문·종료와 원본 바이트 보존.
- `npm run test:windows` — 같은 프로젝트와 같은 세션·턴 ID를 사용하는 두 창의 결과가 각 창에만 전달되는지 확인.

두 명령은 확장을 먼저 빌드한다. 테스트 프로필은 사용자 설치와 분리되며 결과는 `test-artifacts`에 저장한다.
