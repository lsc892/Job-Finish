# Job-Finish

**[English](README.md) · 한국어 · [中文](README.zh.md) · [日本語](README.ja.md)**

AI 에이전트가 끝났는지 확인하려고 터미널을 계속 보고 있을 필요 없습니다.
Claude Code가 입력을 기다리거나 Claude Code/Codex 작업이 끝나는 순간, Windows 알림으로 돌아오세요.

| 토스트 알림 | 작업 표시줄 깜빡임 |
| :---: | :---: |
| ![토스트 알림 데모](resources/Toast.gif) | ![작업 표시줄 깜빡임 데모](resources/Flash.gif) |
| 토스트를 클릭하면 VS Code로 바로 복귀 | 돌아올 때까지 대상 창이 깜빡임 |

![Platform](https://img.shields.io/badge/platform-Windows-0078D4)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![License](https://img.shields.io/badge/license-MIT-blue)

## 주요 기능

- Claude Code + Codex 지원 - Claude Code의 `Stop` / `AskUserQuestion`, Codex의 `notify` 이벤트를 한 번에 연결합니다.
- Windows 네이티브 알림 - 작업 완료, 입력 대기, 마지막 에이전트 메시지를 토스트 알림으로 보여줍니다.
- 비정상 종료 알림 - 토큰·세션 한도 소진이나 API 오류로 Claude Code가 멈출 때도 알림을 띄우고, 제목(`Usage limit reached` / `API error`)을 달리해 정상 완료와 한눈에 구분됩니다.
- 알림 클릭으로 VS Code 복귀 - 토스트를 누르면 기존 VS Code 창을 찾아 전면으로 가져옵니다.
- 창이 없어도 프로젝트 열기 - 대상 VS Code 창이 닫혔으면 `code -n <project>` 방식으로 프로젝트 창을 다시 엽니다.
- 포커스 인식 - 이미 VS Code를 보고 있으면 알림을 생략할 수 있고, 다시 포커스되면 해당 창의 알림만 정리합니다.
- 작업표시줄 깜빡임 - 알림을 놓쳐도 대상 창이 작업표시줄에서 깜빡입니다. `30s`, `5m`, `10m`, `infinite` 중 선택할 수 있습니다.
- 소리 알림 - OS 기본 알림음으로 작업 완료를 들을 수 있습니다.
- global / project 설치 - 전체 계정용 또는 현재 프로젝트용으로 설치 범위를 선택합니다.
- 안전한 설정 병합 - Claude/Codex 설정을 덮어쓰지 않고 필요한 hook만 추가하며, 변경 전 `.bak` 백업을 남깁니다.
- 중복 알림 방지 - 이전 Job-Finish hook 잔여물을 정리하고 Codex notify 충돌을 감지합니다.
- 진단과 미리보기 - `doctor`, `preview` 명령으로 현재 설치와 알림 동작을 빠르게 확인합니다.
- VS Code 환경 전용 - Codex Desktop, Claude Desktop, Orca ADE 같은 데스크톱 클라이언트에는 자체 알림 기능이 있어 Job-Finish와 충돌합니다. 그래서 알림과 작업표시줄 깜빡임은 에이전트가 VS Code 안에서 동작할 때만 뜨고, 그 외 환경에서 실행된 hook은 건너뜁니다.

## 지원 대상

| 대상 | 연결 방식 | 알림 타이밍 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` 또는 `./.claude/settings.json` hooks | 작업 완료, `AskUserQuestion` 입력 대기, 한도 소진·API 오류 중단 |
| Codex | `~/.codex/config.toml` `notify` | 작업 완료, 마지막 assistant 메시지 |

> Job-Finish는 Windows 전용 도구입니다. PowerShell과 Windows toast API, VS Code 창 포커스 처리를 사용합니다.

## 설치

```powershell
npx job-finish init ko
```

설치 마법사는 기본적으로 영어로 표시됩니다. 명령 뒤에 언어 코드를 붙이면 한국어, 중국어 또는 일본어로 실행할 수 있습니다.

```powershell
npx job-finish init     # 영어
npx job-finish init zh  # 중국어
npx job-finish init jp  # 일본어
```

설치 마법사에서 다음을 고릅니다.

| 설정 | 설명 |
| --- | --- |
| 설치 범위 | 현재 프로젝트(`./.claude`) 또는 전역(`~/.claude`, `~/.job-finish`) |
| 에이전트 | Claude Code, Codex 중 연결할 도구 |
| 알림 모드 | Windows 토스트, 작업표시줄 깜빡임 |
| 깜빡임 시간 | `30s`, `5m`, `10m`, `infinite` |
| 소리 | Windows 기본 사운드 사용 여부 |
| 포커스 억제 | 이미 대상 VS Code 창을 보고 있을 때 알림 생략 여부 |

설치가 끝나면 테스트 알림을 바로 보낼 수 있습니다.

## 사용법

```powershell
# 한국어 대화형 설치 (언어 코드를 생략하면 영어)
npx job-finish init ko

# 설치 상태와 의존성 확인 + 테스트 알림
npx job-finish doctor

# 현재 설정으로 알림 미리보기
npx job-finish preview

# hook 과 설치된 파일 제거
npx job-finish uninstall
```

로컬 개발 버전으로 실행하려면:

```powershell
npm install
npm run build
node dist/index.js init ko
```

## 작동 방식

```text
Claude Code Stop / AskUserQuestion
또는 Codex notify
  -> job-finish-notify.ps1 실행
  -> Windows toast / 작업표시줄 flash / sound
  -> toast 클릭 시 jobfinish-focus://open 실행
  -> jf-focus-vscode.exe가 기존 VS Code 창 탐색
  -> 정확한 창을 전면으로 가져오거나 프로젝트를 새 창으로 열기
```

Job-Finish는 단순히 알림만 띄우지 않습니다. 열린 VS Code 창이 여러 개여도 프로젝트명, cwd, window handle, process id를 활용해 가장 적합한 창을 찾습니다. 알림 클릭과 작업표시줄 깜빡임이 같은 창을 가리키도록 설계되어, 여러 프로젝트를 동시에 작업할 때도 헷갈리지 않습니다.

## 설치되는 파일

설치 범위에 따라 아래 위치 중 하나에 파일이 생성됩니다.

| 범위 | 위치 |
| --- | --- |
| project | `./.claude/job-finish/` |
| global | `~/.job-finish/` |

생성 파일:

- `job-finish-notify.ps1`
- `job-finish.config.json`
- `jf-focus-vscode.exe`

또한 Windows에서 토스트 클릭을 처리하기 위해 `jobfinish-focus://` 프로토콜 핸들러가 현재 사용자(`HKCU`)에 등록됩니다.

## 설정 파일

`job-finish.config.json`은 설치 폴더에 저장됩니다. 다시 설치하지 않아도 직접 수정할 수 있습니다.

```json
{
  "version": 1,
  "platform": "win32",
  "modes": ["os", "flash"],
  "flashTimeout": "5m",
  "sound": { "enabled": true },
  "suppressWhenFocused": true,
  "clearToastOnFocus": true,
  "debug": false,
  "watchApp": ""
}
```

디버그 로그는 기본으로 꺼져 있습니다. `job-finish.config.json`에서 `"debug": true`로 바꾸면 `job-finish.log`, `jf-focus-vscode.log`가 생성되고, 그렇지 않으면 로그를 만들지 않습니다.

## 요구사항

- Windows
- Node.js 18+
- PowerShell
- VS Code

`jf-focus-vscode.exe`는 self-contained 바이너리로 배포되므로 별도 .NET 런타임 설치가 필요하지 않습니다.

## 제거

```powershell
# Claude/Codex hook 과 설치 폴더를 함께 제거
npx job-finish uninstall

# hook 만 지우고 생성된 파일은 남기기
npx job-finish uninstall --keep-files
```

## 라이선스

MIT
