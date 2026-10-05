# Job-Finish 설치 도구

VS Code 확장 설치·업데이트와 예전 PowerShell/C# 레거시 제거를 담당하는 독립 패키지입니다. 토스트 확장의 실행 코드에 의존하지 않으며 VSIX에도 포함되지 않습니다. Windows, Node.js 22 이상, 로컬 VS Code가 필요합니다.

`install`과 `update`는 다음 흐름을 동일하게 사용합니다.

| 발견한 상태 | 처리 |
| --- | --- |
| 설치된 버전 없음 | 새로 설치 |
| C# 레거시 있음 | 설정 백업 → 레거시 제거 → 새 확장 설치 |
| 현재 확장 있음 | 버전 비교 → 이전 버전이면 업데이트 |
| 레거시와 현재 확장 모두 있음 | 설정 백업 → 레거시 제거 → 현재 확장 업데이트 |

같거나 더 최신인 확장은 재설치·다운그레이드하지 않습니다. 레거시가 남아 있으면 확장 버전과 별개로 정리합니다. 비교 대상은 실제 VSIX의 확장 버전이며 npm CLI의 버전이 아닙니다. VSIX와 VS Code 호환성을 먼저 확인하고, 레거시 정리에 실패하면 설치를 중단합니다. 설치 후 버전도 다시 확인합니다.

저장소 루트에서 VSIX를 생성한 후 실행합니다.

```powershell
npm --prefix tools/installer ci
npm run package

# 설치 계획 미리보기
npm run install:extension -- --vsix ./job-finish-win32-x64.vsix --dry-run

# 설치·업데이트
npm run install:extension -- --vsix ./job-finish-win32-x64.vsix
npm run update:extension -- --vsix ./job-finish-win32-x64.vsix

# 제거 대상 미리보기
npm run uninstall:legacy -- --dry-run

# 기존 훅, 설치 폴더, Windows 포커스 프로토콜과 바로가기 제거
npm run uninstall:legacy

# 훅만 제거하고 설치 파일과 Windows 등록 유지
npm run uninstall:legacy -- --keep-files

# 특정 프로젝트 설치본 정리
npm run uninstall:legacy -- --project "C:\Projects\MyProject"
```

루트의 설치·업데이트·제거 명령은 이 패키지에 인수를 전달합니다. 도구 폴더에서 직접 실행하려면 `npm ci` 후 해당 npm 스크립트를 사용합니다. 기본 프로젝트와 상대 경로는 명령을 호출한 폴더 기준입니다. VSIX는 `--vsix`로 지정하거나 배포 패키지에 포함할 수 있습니다. VS Code가 PATH에 없다면 `--code "C:\...\Code.exe"`로 지정합니다. 특정 프로필은 `--profile "프로필 이름"`으로 선택합니다. 조회와 설치에 동일한 프로필을 적용합니다.

전역 설치와 지정 프로젝트의 설치본을 정리합니다. 설치 폴더는 `~/.job-finish`와 `<프로젝트>/.claude/job-finish`입니다. 기본 Claude/Codex 설정에 더해 `CLAUDE_CONFIG_DIR`·`CODEX_HOME`의 설정도 확인합니다. 변경한 설정은 같은 폴더에 `.bak`으로 백업하며, 삭제할 설치 폴더의 `job-finish.config.json`은 폴더 밖에 백업합니다. 다른 훅과 현재 확장 설정·저장 데이터는 보존합니다. Codex TOML을 변경하면 주석과 서식은 다시 생성되고, 원본은 백업에 남습니다. 다른 프로젝트의 설치본은 각각 `--project`로 지정합니다.

예전 npm 전역 패키지는 `npm rm -g job-finish`로 별도 제거합니다. C# 소스 프로젝트와 현재 VS Code 확장은 삭제 대상이 아닙니다.

검증은 이 패키지 안에서 별도로 실행합니다.

```powershell
npm --prefix tools/installer run check
```

npm 배포용 패키지는 빌드한 JavaScript CLI와 VSIX를 포함합니다. 아래는 저장소 루트에서 패키지를 준비하는 명령이며 npm 게시를 수행하지 않습니다.

```powershell
npm run package
npm run build:installer
npm pack ./tools/installer
```

`job-finish-installer`를 npm에 게시한 뒤에는 `npx job-finish-installer@latest install` 또는 `npx job-finish-installer@latest update`로 실행할 수 있습니다. 기본 VSIX는 패키지에 포함된 파일입니다. CLI와 확장 버전은 각각 관리하며, 배포할 VSIX를 `build:installer`로 함께 갱신해야 합니다. `install`, `update`를 생략하면 `install`을 실행합니다. 현재 작업은 배포 준비까지이며 npm 게시나 실제 사용자 설치 변경은 수행하지 않습니다.
