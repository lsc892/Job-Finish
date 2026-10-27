# tests

설치·업데이트와 레거시 제거의 동작 및 설정·파일 보존 조건을 검증한다.

- [flow.test.ts](flow.test.ts): 설치 상태·버전에 따른 처리 순서와 실패·미리보기 시 변경 차단을 검증한다.
- [uninstall.test.ts](uninstall.test.ts): 훅·설정 보존과 백업·경로 경계·레거시 제거 CLI를 검증한다.
- [vscode.test.ts](vscode.test.ts): 격리된 VS Code 저장 위치의 실제 설치·업데이트와 잘못된 VSIX 차단을 검증한다.
