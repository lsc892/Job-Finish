# src

설치 CLI의 입력을 검증하고 VS Code 확장 설치와 레거시 제거를 조율한다.

- [cli.ts](cli.ts): 명령 인수를 해석해 설치·업데이트·레거시 제거 서비스를 연결한다.
- [flow.ts](flow.ts): 설치 상태와 버전으로 처리 계획을 정하고 호환성 검사·정리·설치·결과 확인을 조율한다.
- [legacy.ts](legacy.ts): 설정·설치 폴더와 Windows 등록의 레거시 검사·제거를 하나의 작업으로 연결한다.
- [uninstall.ts](uninstall.ts): 레거시 훅과 설치 폴더의 제거 계획을 만들고 경로·변경 여부를 확인해 백업 후 적용한다.
- [vscode.ts](vscode.ts) — `VSCode`: 선택한 저장 범위의 VS Code에서 확장 버전·호환성을 확인하고 설치를 실행하며 VSIX 읽기와 실행 경로 해석을 제공한다.
- [windows.ts](windows.ts): 레거시 소유의 포커스 프로토콜·시작 메뉴 바로가기를 확인하고 제거한다.
