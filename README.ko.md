# Job-Finish

**[English](README.md) · 한국어 · [中文](README.zh.md) · [日本語](README.jp.md)**

다른 작업을 보고 있는 동안 Codex·Claude 실행이 완료되거나 오류·취소·입력 대기가 발생하면, 실행한 VS Code 창에 Windows 토스트와 작업 표시줄 flash로 알립니다.

Windows x64의 로컬 VS Code 확장입니다. Job-Finish에서 시작한 Codex App Server·Claude Agent SDK 실행을 지원합니다. 다른 확장이나 터미널에서 실행한 세션을 자동으로 감시하는 기능은 제공하지 않습니다.

## 설치와 실행

Node.js 22 이상에서 다음 명령을 실행합니다.

```powershell
npm ci
npm --prefix tools/installer ci
npm run check
npm run package
```

다음 명령으로 설치·업데이트합니다. 설치 도구는 토스트 확장과 분리된 [tools/installer](tools/installer/README.md) 패키지입니다.

```powershell
# 상태와 처리 계획 미리보기
npm run install:extension -- --vsix ./job-finish-win32-x64.vsix --dry-run

# 설치 또는 업데이트 (두 명령은 같은 상태 확인 로직 사용)
npm run install:extension -- --vsix ./job-finish-win32-x64.vsix
npm run update:extension -- --vsix ./job-finish-win32-x64.vsix
```

| 발견한 상태 | 처리 |
| --- | --- |
| 설치된 버전 없음 | 새로 설치 |
| C# 레거시 있음 | 설정 백업 → 레거시 제거 → 새 확장 설치 |
| 현재 확장 있음 | 버전 비교 → 이전 버전이면 업데이트 |
| 레거시와 현재 확장 모두 있음 | 설정 백업 → 레거시 제거 → 현재 확장 업데이트 |

현재 확장이 같은 버전이거나 더 최신이면 재설치·다운그레이드를 생략합니다. 레거시가 함께 있으면 레거시만 정리합니다. 실제 VSIX의 확장 버전을 비교하며, 삭제 전에 VSIX와 VS Code 호환성을 확인합니다. 업데이트는 현재 확장의 설정·저장 데이터를 유지합니다. 특정 VS Code 프로필에는 `--profile "프로필 이름"`을 추가하세요.

개발 중에는 `F5`로 확장 개발 창을 엽니다. **Extensions: Install from VSIX…**로 직접 설치할 수도 있지만, 이 경우 독립 설치 도구의 레거시 정리 과정은 실행되지 않습니다.

1. Codex CLI를 설치·로그인합니다. 검증에 사용한 버전은 `0.160.0`입니다. Claude는 포함된 SDK CLI가 사용 가능한 로그인 또는 인증 환경을 필요로 합니다.
2. 프로젝트를 열고 명령 팔레트에서 **Job-Finish: Run Codex** 또는 **Run Claude**를 실행합니다.
3. 작업을 입력합니다. 상태 표시줄에 질문 표시가 생기면 **Answer Pending Request**에서 승인·거절·답변을 전달합니다.
4. **Show Results**로 최근 결과를 확인합니다. 같은 창을 보고 있으면 새 토스트·flash를 생략합니다.

**Continue Session**, **Cancel Turn**, **Resume Saved Session**, **Reconnect and Reconcile**, **Release Session**으로 실행을 관리합니다. 창 연결을 확인하려면 해당 창에 포커스를 두고 **Bind This Windows Window**를 실행합니다. HWND를 확정하지 못하면 토스트만 표시합니다.

## 기존 PowerShell/C# 버전 제거

설치 도구의 `uninstall` 명령은 레거시만 따로 정리합니다. 아래 명령은 저장소 루트 기준입니다.

```powershell
# 제거 도구의 의존성만 설치
npm --prefix tools/installer ci

# 제거 대상 미리보기
npm run uninstall:legacy -- --dry-run

# 기존 훅, 설치 폴더, Windows 포커스 프로토콜과 바로가기 제거
npm run uninstall:legacy

# 훅만 제거하고 설치 파일과 Windows 등록 유지
npm run uninstall:legacy -- --keep-files

# 다른 프로젝트의 설치본도 정리하려면 프로젝트 경로 지정
npm run uninstall:legacy -- --project "C:\Projects\MyProject"
```

루트 명령은 설치 패키지에 인수를 전달합니다. 직접 실행하려면 `npm --prefix tools/installer run uninstall:legacy -- --dry-run`을 사용합니다. 기본 프로젝트 경로는 명령을 호출한 폴더입니다.

전역 설치와 지정 프로젝트의 설치본을 정리합니다. 기본 설치 폴더는 `~/.job-finish`와 `<프로젝트>/.claude/job-finish`입니다. 기본 Claude/Codex 설정에 더해 `CLAUDE_CONFIG_DIR`·`CODEX_HOME`으로 지정한 설정도 확인합니다. Job-Finish 훅만 제거하며, 변경한 설정은 같은 폴더의 `.bak` 파일로 백업합니다. Codex TOML을 변경하면 주석과 서식은 다시 생성됩니다. 기존 파일은 백업에서 확인할 수 있습니다. 다른 프로젝트의 설치본은 각각 `--project`로 지정합니다.

예전 npm 전역 패키지도 설치했다면 `npm rm -g job-finish`로 별도 제거합니다. 이 명령은 C# 소스 프로젝트나 현재 VS Code 확장을 삭제하지 않습니다.

## 설정

| 설정 | 기본값 / 의미 |
| --- | --- |
| `jobFinish.toast`, `jobFinish.flash` | `true` |
| `jobFinish.flashMode` | `manual` — 500ms 간격; `system`도 선택 가능 |
| `jobFinish.flashTimeoutSeconds` | `300`; `0`은 명시적 정지·포커스 복귀까지 유지 |
| `jobFinish.codexExecutable` | 빈 값은 PATH 탐색. `codex.exe` 또는 npm `bin/codex.js` 경로 |
| `jobFinish.codexModel` | 빈 값은 Codex 설정 사용 |
| `jobFinish.codexMode` | `default`; `plan`은 구조화된 질문을 사용하는 계획 모드. 새로 연결할 세션에 적용 |
| `jobFinish.claudeExecutable` | 빈 값은 포함된 SDK CLI 사용 |
| `jobFinish.maxSessions`, `jobFinish.maxConnections` | `8`, `4` |
| `jobFinish.claudeMaxTurns` | `50`; 계정 사용량 한도와 별개의 실행 제한 |

## 검증과 지원 범위

완료 판정은 런타임 이벤트를 사용합니다. 세션 로그 감시나 추가 AI 요약 호출은 사용하지 않습니다. 결과는 창별 20개·각 16 KiB, 토스트는 180자로 제한합니다. 잘린 Codex 결과는 연결된 런타임에 원문을 요청하며, 조회할 수 없으면 화면에 표시합니다.

Codex는 연결 오류 시 최대 3회 재연결하고 기존 턴을 조회합니다. 미확정 작업을 자동 재실행하지 않습니다. SDK가 종료 결과를 확인해 주지 못하는 Claude 실행은 `unknown`으로 남습니다. 알림 센터에서 뒤늦게 클릭하거나 확장을 종료한 뒤 활성화하는 경로는 지원하지 않습니다. 토스트가 표시되는 동안의 클릭만 flash 정지에 연결됩니다.

Codex 복구는 최근 512개 턴의 상태를 페이지별로 조회하고, 필요한 턴의 결과만 읽습니다. 조회 예산을 초과하거나 저장된 미완료 턴의 실제 실행 상태를 확인할 수 없으면 `unknown`을 유지합니다. 권한 승인 UI의 **Allow once**는 요청된 권한만 현재 턴에 허용합니다.

현재 구현과 실제 검증 결과·미검증 항목은 [검증 보고서](docs/verification.md)에 기록합니다. 원래 기준은 [요구사항](docs/requirements-and-verification.md), 과거 실험은 [일지](docs/일지.md)를 참고하세요.

## 라이선스

[MIT](LICENSE). 포함된 외부 런타임과 native 구성요소는 각각의 라이선스를 따릅니다.
