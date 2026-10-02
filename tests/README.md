# Job-Finish VS Code 검증용 MVP

TypeScript 확장이 실제 VS Code에서 에이전트 신호를 받고 창별로 구분할 수 있는지 확인하는 독립 실험이다. 실측 결과와 지원 한계는 [검증 보고서](../docs/VERIFICATION.md)에 정리했다.

## 실행

이 폴더에서 실행한다.

```powershell
npm ci
npm run build
```

VS Code에서 **이 폴더 자체를 열고 F5**를 누르면 Extension Development Host가 열린다. 명령 팔레트에서 다음 명령을 사용할 수 있다.

- `Job-Finish MVP: Show Window ID`: 현재 확장 활성화의 전체 UUID와 workspace 정보를 표시한다.
- `Job-Finish MVP: Call Codex / Claude`: 선택한 에이전트에 짧은 연결 확인 프롬프트를 보내고 완료 신호를 받는다.
- `Job-Finish MVP: Watch a Session Log`: 현재 창에 `.jsonl` 세션 로그를 연결한다. 연결 후 추가되는 기록만 감시한다.
- `Job-Finish MVP: Show Signals`: 현재 창에서 수신한 신호와 감시 진단을 표시한다.

출력은 `Job-Finish MVP` 채널, 창 UUID 앞 8자리는 상태표시줄에서 확인한다. 일반 실행 모드에서는 신호를 받으면 해당 창의 VS Code 알림도 표시한다.

Codex는 PATH의 네이티브 실행 파일 또는 Windows npm 설치 내부의 `codex.exe`를 찾는다. Claude는 `~/.local/bin/claude.exe`와 PATH에서 찾는다. 다른 위치는 `jobFinishMvp.codexExecutable`, `jobFinishMvp.claudeExecutable`에 절대 경로로 설정한다. Windows에서는 `.cmd`/`.ps1` 대신 `.exe` 경로를 지정한다. 각 에이전트의 로그인은 먼저 완료되어 있어야 한다.

## 자동 검증

```powershell
npm test
npm run test:integration
npm run test:integration -- --live
npm run package
```

`--live`는 실제 모델을 호출한다. 각 provider를 새 세션에서 한 번, 같은 세션을 재개하여 한 번 호출해 런타임 이벤트와 원본 로그의 실시간 변경을 각각 검증한다. 기본 통합 테스트는 모델을 호출하지 않는다.

VS Code 실행 파일을 별도로 지정할 때는 `VSCODE_EXECUTABLE`을 사용한다. 테스트할 에이전트 실행 파일은 다음 환경 변수로 지정할 수 있다. 이 값은 격리된 테스트 프로필의 설정에만 반영된다.

```powershell
$env:JF_MVP_CODEX_EXECUTABLE = 'C:\path\to\codex.exe'
$env:JF_MVP_CLAUDE_EXECUTABLE = 'C:\path\to\claude.exe'
npm run test:integration -- --live
```

테스트는 격리된 VS Code 프로필 두 개와 공통 조정 디렉터리를 사용한다. 같은 workspace / 다른 workspace / 종료 후 재실행을 확인하고 `.verification/<실행시각>/summary.json`에 원본 증거를 남긴다. 이 폴더와 생성된 VSIX는 Git에서 제외한다. 최초 실측의 요약 증거는 [verification-result.json](../docs/verification-result.json)에 보관했다.

## 판정 범위

직접 호출의 Codex `turn.completed`, Claude `result/success`는 응답 완료로 처리한다. 원본 로그에서는 Codex `task_complete`를 턴 완료로, Claude `end_turn`을 최종 응답 감지(`responseObserved`)로 처리한다. Claude 원본 로그만으로 hook 처리나 백그라운드 작업의 종료까지 확정하지 않는다.

`windowInstanceId`는 창 안에서 활성화된 이 확장의 UUID다. 세션 로그의 `cwd`만으로 원래 창을 추정하지 않으며, 직접 실행한 요청이나 사용자가 연결한 로그를 현재 창에 귀속시킨다. 재실행 시 UUID는 바뀐다.

소유권 lock은 정상 종료 시 해제된다. 비정상 종료 후 lock 자동 만료·이전, 버전별 adapter, 원격 환경, 기존 AI 채팅 화면의 자동 구독은 이 MVP에서 구현하지 않았다. 테스트 모드에서는 팝업을 생략하고 수신 기록을 검사한다.

## 라이선스

[MIT](../README.md#license)
