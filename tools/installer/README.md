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
npm run package:npm
```

npm 게시에는 `package:npm`이 생성한 `job-finish-<버전>.tgz`를 사용합니다. 설치 도구 폴더의 README는 상세 안내이므로 해당 폴더를 직접 게시하면 공통 소개가 적용되지 않습니다.

기존 npm 패키지 `job-finish`를 사용하며 `npx job-finish@latest install` 또는 `npx job-finish@latest update`로 실행합니다. 기본 VSIX는 패키지에 포함된 파일이고, 배포자 `JobFinish`의 기존 Marketplace 확장 `JobFinish.JobFinish`를 설치·업데이트합니다. v2.3.1 릴리스는 CLI와 확장 버전을 2.3.1로 맞추며, 설치 판단에는 VSIX의 실제 확장 버전을 사용합니다. `package:npm`이 현재 VSIX와 CLI를 함께 준비합니다. `install`, `update`를 생략하면 `install`을 실행합니다.

npm 페이지에는 저장소 루트의 [프로젝트 README](../../README.md)를 표시합니다. `package:npm`은 해당 README의 링크를 절대주소로 바꿔 임시 배포 폴더에 넣습니다. 이 파일은 저장소의 설치 도구 상세 안내로 유지합니다. Marketplace 기본 소개도 같은 루트 README를 사용합니다.

## v2.3.1 변경 사항

- npm과 Marketplace의 기본 소개를 GIF 데모와 버전별 변경 내역이 있는 공통 README로 맞췄습니다.
- GIF를 공개된 원본의 절대주소로 연결해 패키지 페이지에서도 표시하며, npm README의 문서 링크도 절대주소로 변환합니다.
- npm 설치 도구와 수동 업로드용 `JobFinish.JobFinish` VSIX 버전을 2.3.1로 맞췄습니다.

## v2.3.0 변경 사항

- 동봉 확장에서 직접 실행·세션 관리·Claude SDK를 제거하고 기존 Codex·Claude 확장의 자동 알림에 집중했습니다. 명령은 4개, 설정은 7개입니다.
- 비동기 질문은 즉시 알리며 같은 턴의 5초 이내 정상 완료는 추가 토스트·깜박임을 합칩니다. 질문·완료 결과는 모두 보관합니다.
- 동일 질문 재전송과 완료 시점에 따른 네이티브 토스트 동작을 확인하는 저장소 진단 도구를 추가했습니다.
- npm 설치 도구에 Marketplace 수동 배포용과 동일한 `JobFinish.JobFinish` 2.3.0 VSIX를 포함합니다.

자세한 변경 내역은 [프로젝트 README](https://github.com/lsc892/Job-Finish#release-notes)를 참고하세요.

## 코드 책임

- [src/](src/README.md): 명령 입력·설치 계획·VS Code 실행·레거시 제거를 담당한다.
- [scripts/](scripts/README.md): 배포 CLI와 포함할 VSIX를 준비한다.
- [tests/](tests/README.md): 설치 흐름·레거시 제거·격리된 VS Code 설치를 검증한다.
- [package.json](package.json): 독립 설치 패키지의 의존성·명령·배포 파일을 정의한다.
- [package-lock.json](package-lock.json): 설치 도구의 npm 의존성 해석 결과와 무결성을 고정한다.
- [tsconfig.json](tsconfig.json): 설치 소스와 테스트의 TypeScript 검사 규칙을 정의한다.
- [LICENSE](LICENSE): 설치 도구의 배포·사용 허용 조건을 명시한다.
- [일지.md](일지.md): 설치 도구의 구조와 기능 변경에 대한 의사결정을 기록한다.
