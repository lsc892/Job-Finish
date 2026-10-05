# Job-Finish

**[English](README.md) · 한국어 · [中文](README.zh.md) · [日本語](README.jp.md)**

다른 작업을 보고 있는 동안 Codex·Claude 실행이 완료되거나 오류·취소·입력 대기가 발생하면, 실행한 VS Code 창에 Windows 토스트와 작업 표시줄 flash로 알립니다.

Windows x64의 로컬 VS Code 확장입니다. Job-Finish에서 시작한 Codex App Server·Claude Agent SDK 실행을 지원합니다. 다른 확장이나 터미널에서 실행한 세션을 자동으로 감시하는 기능은 제공하지 않습니다.

## 설치와 실행

Node.js 22 이상에서 다음 명령을 실행합니다.

```powershell
npm ci
npm run check
npm run package
```

VS Code의 **Extensions: Install from VSIX…**에서 생성된 `job-finish-win32-x64.vsix`를 선택합니다. 개발 중에는 `F5`로 확장 개발 창을 엽니다.

1. Codex CLI를 설치·로그인합니다. 검증에 사용한 버전은 `0.160.0`입니다. Claude는 포함된 SDK CLI가 사용 가능한 로그인 또는 인증 환경을 필요로 합니다.
2. 프로젝트를 열고 명령 팔레트에서 **Job-Finish: Run Codex** 또는 **Run Claude**를 실행합니다.
3. 작업을 입력합니다. 상태 표시줄에 질문 표시가 생기면 **Answer Pending Request**에서 승인·거절·답변을 전달합니다.
4. **Show Results**로 최근 결과를 확인합니다. 같은 창을 보고 있으면 새 토스트·flash를 생략합니다.

**Continue Session**, **Cancel Turn**, **Resume Saved Session**, **Reconnect and Reconcile**, **Release Session**으로 실행을 관리합니다. 창 연결을 확인하려면 해당 창에 포커스를 두고 **Bind This Windows Window**를 실행합니다. HWND를 확정하지 못하면 토스트만 표시합니다.

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
