---
name: job-finish-build-apply
description: "이 Job-Finish 저장소의 Windows VS Code 확장을 검증·빌드·패키징하고 로컬 VS Code에 적용한다. 이 프로젝트에서 빌드, 빌드 후 적용, 재설치 또는 업데이트를 요청할 때 사용한다."
---

# Job-Finish 빌드 및 적용

이 스킬이 들어 있는 Job-Finish 체크아웃의 현재 작업 내용을 컴파일·빌드하고 Windows x64 VSIX를 만든 뒤 요청한 로컬 VS Code 환경에 적용한다. 사용자가 빌드만 요청하면 패키지 내용 확인까지 수행하고 설치는 생략한다.

## 저장소와 환경 확인

- 이 `SKILL.md`가 있는 `.agents/skills/job-finish-build-apply` 폴더에서 세 단계 위를 저장소 루트로 사용한다. 호출한 작업 폴더가 `docs`나 `tools/installer`여도 모든 명령의 작업 디렉터리는 이 루트로 지정한다. 개인 PC의 고정 경로나 다른 Job-Finish 체크아웃으로 대체하지 않는다.
- 루트 `package.json`의 `name`과 `publisher`가 모두 실제 Marketplace 배포본의 `JobFinish`인지 확인한다. npm 설치 패키지명은 `tools/installer/package.json`의 `job-finish`다. 일치하지 않거나 파일이 없으면 경로와 배포 식별자부터 해결하고 빌드·설치를 시작한다.
- 해당 저장소의 `AGENTS.md`, `package.json`, `tools/installer/package.json`과 Git 변경 상태를 읽는다. 확장 식별자는 `JobFinish.JobFinish`이며, 기존 수정사항을 포함해 빌드한다.
- Windows x64, Node.js 22 이상, 로컬 VS Code가 필요하다. PowerShell에서는 `npm.cmd`와 `code.cmd`를 사용한다. CLI가 PATH에 없으면 실제 설치 경로를 찾는다.
- 사용자 지정 VS Code 실행 파일, 프로필, 사용자 데이터 또는 확장 폴더가 있으면 조회·설치·검증에 같은 대상을 사용한다. 지정이 없으면 기본 사용자 프로필을 대상으로 한다.
- 두 패키지의 의존성이 이미 정상 설치되어 있으면 재사용한다. 누락되었거나 lockfile과 맞지 않으면 해당 패키지만 `npm.cmd ci` 또는 `npm.cmd --prefix tools/installer ci`로 설치한다.

## 빌드 및 패키지 검증

저장소 루트에서 아래 명령을 실행한다. PowerShell의 네이티브 명령은 실패해도 다음 줄로 진행할 수 있으므로 각 명령의 종료 코드를 확인하고, 실패하면 그 뒤의 패키징·설치를 중단한다.

```powershell
npm.cmd run typecheck:product
npm.cmd --prefix tools/installer run typecheck
npm.cmd run build
npm.cmd --prefix tools/installer run build
npm.cmd run package
```

- 사용자가 현재 작업에서 테스트를 명시적으로 요청하지 않았다면 `check`, `test`, `test:*`와 테스트·재현 스크립트를 실행하거나 테스트 코드를 수정하지 않는다. 기본 확인 범위는 컴파일·코드·참조·diff와 빌드/패키지 내용 검토다.
- 기본 `build`와 패키징의 prepublish는 일반 빌드다. `diagnostic:` 라벨의 자동 추적 로그·인수 평가와 Codex 상세 추적기 모듈을 번들에서 제거한다. 오류 보관·수동 진단 스냅샷 및 토스트 helper의 필수 전송/클릭 응답 처리는 유지한다.
- 결과는 `dist/extension.cjs`와 `job-finish-win32-x64.vsix`다. 버전은 저장소의 `package.json`을 따른다.
- 완성된 번들에서 `CodexThreadDiagnostics`, `codex.thread.metadata`, `codex.turn.selection`, `signal.received`, `observer.connection.attached` 같은 자동 추적 코드가 없는지 읽어 확인한다. VSIX의 파일 목록에 `tests/`, `test-artifacts/`, `dist-diagnostics/`와 소스맵이 없는지도 확인한다. 진단에서 쓰는 문자열과 동일한 `toast.submitted` 등의 helper 프로토콜은 제품의 성공 판정에도 필요하므로 제거 대상으로 보지 않는다.
- 진단 로그가 필요한 작업을 명시적으로 요청받았을 때만 `npm.cmd run build:diagnostics`를 사용한다. 진단 번들·소스맵·helper는 `dist-diagnostics/`에 따로 출력되며 일반 `dist/`를 덮어쓰지 않는다. 진단 폴더는 일반 VSIX에서 제외되므로 일반 패키지에 섞거나 자동 설치하지 않는다. 진단 실행용 배치는 [로그 안내](../../../docs/notification-debugging.md)를 따른다.
- 사용자가 패키지 자동 테스트도 명시적으로 요청한 경우에만 `npm.cmd run test:package`를 추가한다. 이 검사는 임시 VS Code 프로필의 설치 확인이며 사용자 프로필에 적용했다는 증거는 아니다. 표준 경로 외 VS Code는 `JOB_FINISH_CODE_EXECUTABLE`에 실제 `Code.exe`를 지정한다.

## 로컬 적용

먼저 설치 도구의 상태 미리보기를 확인한다. 사용자 지정 대상이 있으면 `--code`, `--profile`, `--user-data-dir`, `--extensions-dir` 옵션을 일관되게 전달한다.

```powershell
npm.cmd run install:extension -- --vsix ./job-finish-win32-x64.vsix --dry-run
```

- 새 설치 또는 이전 버전 업데이트이고, 미리보기에 레거시 정리 대상이 없다면 아래 설치 명령을 실행한다.
- 레거시 제거가 사용자의 요청에 포함되어 있으면 미리보기의 대상과 백업 동작을 확인하고 설치 도구로 진행한다. 단순히 확장 빌드·적용만 요청했고 별도 C#/PowerShell 레거시가 발견되면 레거시를 보존하고 VS Code CLI로 확장만 설치한다.

```powershell
npm.cmd run install:extension -- --vsix ./job-finish-win32-x64.vsix
```

**같은 버전 재빌드 주의:** 설치 도구의 `install`과 `update`는 설치 버전이 같거나 더 높으면 설치를 생략한다. 같은 버전의 개발 변경분을 적용할 때는 아래 명령으로 새 VSIX를 다시 설치한다. 적용을 위해 버전을 임의로 올리지 않는다. 더 높은 버전이 설치되어 있다면 사용자가 현재 체크아웃으로 교체하도록 요청했는지 확인하고, 요청 범위가 불분명하면 다운그레이드 전에 대상을 확인한다.

```powershell
code.cmd --install-extension ./job-finish-win32-x64.vsix --force
```

조회·설치가 실패하면 원인을 해결한 뒤 필요한 단계부터 재시도한다. 확장 폴더를 수동 삭제하거나 사용자 설정·저장 데이터를 초기화하는 방식으로 우회하지 않는다.

## 적용 결과 확인

```powershell
code.cmd --list-extensions --show-versions
code.cmd --locate-extension JobFinish.JobFinish
```

조회 명령에도 동일한 대상 옵션을 전달한다. 목록에 `jobfinish.jobfinish@<빌드 버전>`이 있는지 확인하고, `--locate-extension`이 반환한 실제 폴더의 `dist/extension.cjs`와 저장소의 `dist/extension.cjs`를 `Get-FileHash -Algorithm SHA256`로 비교한다. 같은 버전 재설치에서는 버전 문자열만으로 성공을 판단하지 않는다. CLI가 위치 조회를 지원하지 않으면 대상 확장 폴더의 `extensions.json`에서 해당 식별자의 등록 위치를 찾는다.

최종 응답에는 검증 결과, VSIX 경로, 실제 설치 여부를 짧게 보고한다. 설치 파일 검증과 실행 중인 Extension Host의 재로딩 여부를 구분한다. 재로딩을 확인하지 못했다면 열린 VS Code에 `Developer: Reload Window`가 필요할 수 있음을 안내한다. 활성 사용자 창이나 진행 중인 작업을 임의로 종료하지 않는다.
