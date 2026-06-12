# Job-Finish Development Notes

## 목적

Job-Finish는 Windows 환경에서 Claude Code, Codex, 향후 Gemini CLI 등의 작업 완료 시 다음 알림을 제공합니다.

- Windows 토스트 알림
- 작업표시줄 깜빡임
- 사운드
- 토스트 클릭 시 해당 VS Code 창에 포커스
- 여러 VS Code 창을 별도로 처리
- 디버그 모드에서만 로그 기록

## 기능 요약

### 사용자 선택 방식

설치 시 다음 옵션을 선택할 수 있습니다.

- 설치 범위: 프로젝트(`./.claude`) 또는 전역(`~/.claude`)
- 연결 대상: Claude Code, Codex
- 알림 모드: `os` (Windows toast), `flash` (taskbar flash)
- 깜빡임 최대 시간: 30s, 5m, 10m, infinite
- 소리: 켜기/끄기
- 창 포커스 중 생략: on/off
- 디버그 로그: on/off

### 동작 원리

1. 설치 시 `job-finish-notify.ps1`과 `job-finish.config.json`을 생성.
2. Claude Code/ Codex hook을 추가하여 이벤트가 발생하면 PowerShell 스크립트를 실행.
3. 스크립트가 현재 포커스 대상 VS Code 창을 찾고:
   - `os` 모드일 때 토스트를 생성
   - `flash` 모드일 때 작업표시줄을 플래시
   - `sound` 옵션이 켜져 있고 `os` 모드만 아니면 기본 사운드를 재생
4. 토스트 클릭 시 `jobfinish-focus://open?...` 프로토콜이 실행.
5. 프로토콜은 `jf-focus-vscode.exe`를 호출해 적절한 VS Code 창을 찾아 포커스를 전환.

### 창별 동작 분리

- 토스트에 `hwnd`와 `pid`를 포함하여 특정 창을 구분.
- 여러 VS Code 창이 존재할 때, 작업이 완료된 창에 해당하는 토스트/깜빡임만 활성화.
- 클릭 시 해당 `hwnd` 또는 `pid`를 우선적으로 사용하여 같은 창을 포커스.

### 사운드 우선순위

- `os` 모드가 포함된 경우, 토스트의 설치된 기본 알림 소리를 우선 사용.
- `flash`만 선택된 경우에는 PowerShell이 기본 시스템 사운드를 재생.
- `sound` 옵션이 꺼져 있으면 어떤 소리도 재생되지 않음.

### 디버그 로그

- `job-finish.config.json`의 `debug: true`일 때만 로그가 생성.
- 로그 파일 위치:
  - `job-finish.log` (notifier 스크립트 옆)
  - `jf-focus-vscode.log` (focus helper 옆)
- 일반 모드에서는 로그가 남지 않음.

## 주요 파일

- `src/cli/index.ts`: CLI entry point 및 명령 처리
- `src/cli/wizard.ts`: 설치 대화형 옵션
- `src/cli/generate.ts`: 스크립트/설정 생성
- `src/shared/config-schema.ts`: 설정 스키마 및 기본값
- `templates/notify.win.ps1`: 실제 알림 동작 PowerShell 스크립트
- `tools/win-focus/Program.cs`: VS Code 창 포커스 helper
- `scripts/build-focus-exe.mjs`: `jf-focus-vscode.exe` 빌드 및 복사

## 빌드

```powershell
npm install
npm run build
```

빌드 결과:

- `dist/index.js`
- `templates/jf-focus-vscode.exe`

## 디버그 케이스

### 토스트가 뜨지만 클릭 시 포커스가 안 되는 경우

1. `job-finish.config.json`에서 `debug: true` 설정
2. `templates/jf-focus-vscode.exe` 옆의 `jf-focus-vscode.log` 확인
3. `job-finish.log`에서 토스트 생성 및 창 선택 상태 확인

### 깜빡임이 멈추지 않는 경우

- `flashTimeout` 값과 `SetForegroundWindow` 성공 여부를 확인.
- `jf-focus-vscode.log`가 `success=true`인지 확인.

## 향후 추가 기능

- Gemini CLI 지원 hook 생성
- 알림 모드에 `toast only`, `flash only`, `both`를 명시적으로 분리
- 사용자 지정 소리 파일 경로 지원
- Windows toast action buttons 추가
