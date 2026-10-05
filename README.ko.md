# Job-Finish

**[English](README.md) · 한국어 · [中文](README.zh.md) · [日本語](README.jp.md)**

다른 작업을 보고 있는 동안 Codex·Claude 실행이 완료되거나 오류·취소·입력 대기가 발생하면, 실행한 VS Code 창에 Windows 토스트와 작업 표시줄 flash로 알립니다.

Windows x64의 로컬 VS Code 확장입니다. 설치 후 자동으로 켜지며, 같은 창의 기존 Codex·Claude 확장이 주고받는 실행 이벤트를 받아 알립니다. VS Code 설정에서 **Job-Finish: Enabled**를 끄거나 켜면 즉시 적용됩니다. Job-Finish에서 직접 시작한 실행도 지원합니다.

자동 감지는 같은 Extension Host 안에서 실행 중인 Codex App Server의 stdio와 Claude의 SDK JSON 스트림을 읽습니다. 켤 때 이미 실행 중인 프로세스에 연결하고, 이후 시작되는 프로세스도 관찰합니다. 훅 설정 변경·세션 로그 감시·추가 App Server 실행·추가 모델 호출은 없습니다. 기존 채팅창의 승인과 답변은 그 채팅창에서 처리합니다.

현재 설치된 `openai.chatgpt`·`anthropic.claude-code` 확장 경로와 실행 인수를 확인해 연결합니다. Node의 내부 프로세스 API를 사용하므로 확장/VS Code 버전의 통신 방식 변경에 영향을 받을 수 있습니다. 별도 Extension Host, WSL·원격 실행, 다른 프로세스의 터미널 실행은 자동 감지 대상에 포함되지 않습니다. **Job-Finish: Show Diagnostics**의 `automatic.connections`에서 연결 상태를 확인할 수 있습니다.

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
2. 기존 Codex·Claude 채팅창에서 평소처럼 작업을 실행합니다. 상태 표시줄의 `JF · on`은 자동 감지가 켜졌다는 뜻입니다.
3. 다른 앱으로 전환하면 해당 창의 완료·오류·입력 대기를 알립니다. 직접 실행하려면 명령 팔레트의 **Job-Finish: Run Codex** 또는 **Run Claude**를 사용하고, 해당 실행의 승인·답변은 **Answer Pending Request**에서 처리합니다.
4. **Show Results**로 최근 결과를 확인합니다. 같은 창을 보고 있으면 새 토스트·flash를 생략합니다.

**Continue Session**, **Cancel Turn**, **Resume Saved Session**, **Reconnect and Reconcile**, **Release Session**으로 실행을 관리합니다. 창 연결을 확인하려면 해당 창에 포커스를 두고 **Bind This Windows Window**를 실행합니다. HWND를 확정하지 못하면 토스트만 표시합니다.

## 프로젝트 로컬 빌드·적용 스킬

이 저장소에는 Codex용 [job-finish-build-apply](.agents/skills/job-finish-build-apply/SKILL.md) 스킬이 포함되어 있습니다. 이 프로젝트를 연 Codex에서 다음과 같이 요청합니다.

```text
$job-finish-build-apply 이 프로젝트를 빌드하고 로컬 VS Code에 적용해줘.
```

스킬은 자신이 포함된 저장소를 기준으로 타입 검사·테스트·VSIX 검증·설치를 수행하며, 같은 버전으로 다시 빌드한 변경분도 적용합니다. 빌드만 요청하면 설치는 생략합니다. 전역 스킬 설치는 필요하지 않습니다.

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
| `jobFinish.enabled` | `true`; 자동 감지와 알림을 즉시 켜거나 끔 |
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

Codex는 연결 오류 시 최대 3회 재연결하고 기존 턴을 조회합니다. 미확정 작업을 자동 재실행하지 않습니다. SDK가 종료 결과를 확인해 주지 못하는 Claude 실행은 `unknown`으로 남습니다. 알림 센터에서 뒤늦게 클릭하거나 확장을 종료한 뒤 활성화하는 경로는 지원하지 않습니다. 토스트 콜백이 살아 있는 동안 클릭하면 해당 알림의 flash를 멈추고 검증된 VS Code 창을 앞으로 가져옵니다. 최소화된 창은 복원합니다. 창 연결을 확정하지 못했거나 Windows가 전경 전환을 거부하면 **Show Diagnostics**에 원인을 기록합니다.

Codex 복구는 최근 512개 턴의 상태를 페이지별로 조회하고, 필요한 턴의 결과만 읽습니다. 조회 예산을 초과하거나 저장된 미완료 턴의 실제 실행 상태를 확인할 수 없으면 `unknown`을 유지합니다. 권한 승인 UI의 **Allow once**는 요청된 권한만 현재 턴에 허용합니다.

현재 구현과 실제 검증 결과·미검증 항목은 [검증 보고서](docs/verification.md)에 기록합니다. 원래 기준은 [요구사항](docs/requirements-and-verification.md), 과거 실험은 [일지](docs/일지.md)를 참고하세요.

## 라이선스

[MIT](LICENSE). 포함된 외부 런타임과 native 구성요소는 각각의 라이선스를 따릅니다.
