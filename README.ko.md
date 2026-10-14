# Job-Finish

**[English](README.md) · 한국어 · [中文](README.zh.md) · [日本語](README.jp.md)**

AI 에이전트가 끝났는지 확인하려고 채팅창을 계속 보고 있을 필요 없습니다.
**Claude Code·Codex의 작업 완료, 입력 대기, 오류**를 알리고, 클릭 한 번으로 해당 VS Code 창에 돌아오는 확장입니다.

| Windows 토스트 알림 | 작업 표시줄 깜빡임 |
| :---: | :---: |
| <img src="https://raw.githubusercontent.com/lsc892/Job-Finish/877024beb5f86c390c1beec4992cf64c862dbc67/resources/Toast.gif" alt="Windows 토스트 알림을 클릭해 VS Code로 돌아오는 동작 예시" width="380"> | <img src="https://raw.githubusercontent.com/lsc892/Job-Finish/877024beb5f86c390c1beec4992cf64c862dbc67/resources/Flash.gif" alt="VS Code 작업 표시줄 버튼이 깜빡이는 동작 예시" width="380"> |
| 알림을 클릭하면 작업하던 VS Code 창으로 복귀 | 토스트를 놓쳐도 입력·완료를 기다리는 창을 확인 |

*GIF는 이전 버전의 알림 동작 예시입니다. 현재 확장의 토스트 모양은 다를 수 있습니다.*

![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4)
![VS Code](https://img.shields.io/badge/VS%20Code-1.99%2B-007ACC)
![License](https://img.shields.io/badge/license-MIT-blue)

## 주요 기능 한눈에 보기

| 기능 | 설명 |
| --- | --- |
| **Claude Code + Codex** | 기존 VS Code 확장에서 실행하는 지원 대상 작업을 자동으로 감지합니다. |
| **완료·입력 대기·오류 알림** | 작업 완료·오류와 선택지 선택·질문 답변·승인 대기를 알립니다. |
| **클릭으로 해당 창 복귀** | 여러 VS Code 창을 열어도 알림을 보낸 작업의 창으로 돌아갑니다. |
| **작업 표시줄 깜빡임** | 창으로 돌아오거나 설정 시간이 지날 때까지 작업 창을 강조합니다. |
| **포커스 인식** | 이미 해당 창을 보고 있으면 새 토스트와 깜빡임을 생략합니다. |
| **최근 결과 확인** | **Job-Finish: Show Results**에서 에이전트의 응답을 다시 봅니다. |

## 설치 및 업데이트

**Windows x64, VS Code 1.99 이상, Node.js 22 이상, 신뢰된 로컬 작업 폴더**에서 사용합니다. 사용할 Codex 또는 Claude Code VS Code 확장을 설치하고 로그인한 뒤 실행하세요.

```powershell
npx job-finish@latest install
```

패키지에 포함된 VS Code 확장을 설치하고, 발견한 예전 PowerShell/C# 설치본은 백업 후 정리합니다. 프로젝트 폴더에서 실행하면 해당 프로젝트의 예전 설치본도 정리합니다. VS Code 다시 로드 안내가 나오면 실행하세요. Job-Finish는 자동으로 켜지며 .NET은 별도로 설치할 필요가 없습니다.

업데이트할 때는 다음 명령을 사용합니다.

```powershell
npx job-finish@latest update
```

미리보기는 `--dry-run`, 특정 VS Code 프로필은 `--profile "프로필 이름"`을 추가합니다. 같은 버전이나 더 최신인 확장은 유지합니다. 자세한 내용은 [설치 도구 안내](tools/installer/README.md)를 참고하세요.

<details>
<summary>CLI를 전역 설치해서 사용하기</summary>

```powershell
npm install -g job-finish@latest
job-finish install
```

최신 CLI 설치 후 `job-finish update`, `job-finish uninstall`도 사용할 수 있습니다.

</details>

<details>
<summary>VSIX 파일로 직접 설치하기</summary>

1. 아래 소스 빌드 안내로 `job-finish-win32-x64.vsix`를 준비합니다.
2. VS Code에서 `Ctrl+Shift+P` → **Extensions: Install from VSIX…**를 선택합니다.
3. VSIX 파일을 선택하고, 다시 로드 안내가 나오면 실행합니다.

업데이트도 새 VSIX를 같은 방법으로 설치하면 됩니다. 직접 설치하면 예전 PowerShell/C# 설치본은 정리하지 않습니다.

</details>

<details>
<summary>소스에서 VSIX 빌드하기</summary>

**Node.js 22 이상과 .NET SDK 8 이상**에서 저장소 루트를 열고 실행합니다.

```powershell
npm ci
npm run check
npm run package
```

`job-finish-win32-x64.vsix`가 생성됩니다. 개발용 창을 열려면 `F5`를 사용합니다.

예전 PowerShell/C# 버전을 사용했다면, 설치 도구로 기존 설치를 백업·정리하면서 확장을 설치할 수 있습니다.

```powershell
npm --prefix tools/installer ci
npm run install:extension -- --vsix ./job-finish-win32-x64.vsix
```

</details>

## 확장 사용법

1. VS Code의 기존 Codex·Claude Code 채팅창에서 평소처럼 작업합니다. Job-Finish는 기본으로 켜져 있습니다.
2. 작업 창이 비활성일 때 완료·오류·선택지/질문/승인 대기를 토스트와 작업 표시줄 깜빡임으로 알려줍니다.
3. 토스트를 클릭해 해당 창으로 돌아와 원래 채팅창에서 선택하거나 답변·승인합니다.

`Ctrl+Shift+P`로 명령 팔레트를 열고 **Job-Finish**를 검색합니다.

| 명령 | 용도 |
| --- | --- |
| **Show Results** | 최근 에이전트 응답 확인 |
| **Stop Flash** | 작업 표시줄 깜빡임 즉시 정지 |
| **Show Diagnostics** | 자동 감지·알림 연결 상태 확인 |
| **Run Codex / Run Claude** | Job-Finish에서 직접 작업 시작 |
| **Answer Pending Request** | Job-Finish에서 직접 시작한 작업의 질문·승인 처리 |

직접 실행에는 설치·인증된 Codex CLI 또는 포함된 Claude SDK CLI의 유효한 인증이 필요합니다. Codex가 PATH에 없다면 `jobFinish.codexExecutable`을 지정하세요.

자동 감지는 같은 VS Code Extension Host에서 실행되는 로컬 에이전트를 지원합니다. WSL·원격 작업 폴더·외부 터미널·데스크톱 에이전트 앱은 대상에 포함되지 않습니다. 에이전트 확장 업데이트 후 감지가 안 되면 **Show Diagnostics**에서 상태를 확인하세요.

## 기본 설정 한눈에 보기

VS Code 설정(`Ctrl+,`)에서 **Job-Finish**를 검색합니다.

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `jobFinish.enabled` | `true` | 자동 감지와 알림을 즉시 켜거나 끕니다. |
| `jobFinish.toast` | `true` | Windows 토스트 알림을 표시합니다. |
| `jobFinish.flash` | `true` | 작업하던 VS Code 창의 작업 표시줄 버튼을 깜빡입니다. |
| `jobFinish.flashMode` | `manual` | `manual`: 0.5초마다 직접 깜빡임. `system`: Windows 기본 깜빡임 방식 사용. |
| `jobFinish.flashTimeoutSeconds` | `300` | 깜빡임 유지 시간(초). `0`이면 창 복귀·토스트 클릭·**Stop Flash**까지 유지합니다. |

## 삭제

VS Code 확장과 발견한 예전 설치본을 함께 삭제합니다.

```powershell
npx job-finish@latest uninstall
```

VS Code 다시 로드 안내가 나오면 실행하세요. 삭제 대상 미리보기는 `--dry-run`, 특정 VS Code 프로필은 `--profile "프로필 이름"`, 다른 프로젝트의 예전 설치본은 `--project "C:\Projects\MyProject"`를 추가합니다.

CLI를 전역 설치했다면 확장을 삭제한 뒤 CLI도 제거합니다.

```powershell
npm uninstall -g job-finish
```

마지막 명령은 npm CLI만 삭제하며 VS Code 확장은 삭제하지 않습니다.

<details>
<summary>VS Code 확장만 직접 삭제하기</summary>

VS Code 확장 목록(`Ctrl+Shift+X`)에서 **Job-Finish** → **제거(Uninstall)**를 선택하고, 다시 로드 안내가 나오면 실행합니다. 명령으로 삭제할 수도 있습니다.

```powershell
code --uninstall-extension lsc892.job-finish
```

</details>

<details>
<summary>예전 PowerShell/C# 버전만 삭제하기</summary>

`npx job-finish@latest uninstall-legacy`를 사용하거나, 저장소 루트에서 다음 명령을 실행합니다.

```powershell
npm --prefix tools/installer ci
npm run uninstall:legacy -- --dry-run
npm run uninstall:legacy
```

예전 Job-Finish 훅과 설치 파일을 제거하는 명령이며, 현재 VS Code 확장은 삭제하지 않습니다. 다른 프로젝트의 설치본은 각각 `--project "C:\Projects\MyProject"`로 지정합니다. 백업 동작과 추가 옵션은 [설치 도구 안내](tools/installer/README.md)를 참고하세요.

</details>

내부 동작과 검증 결과는 [개발 문서](docs/requirements-and-verification.md)와 [검증 보고서](docs/verification.md)에서 확인할 수 있습니다.

## 라이선스

[MIT](LICENSE). 포함된 외부 구성요소는 각각의 라이선스를 따릅니다.
