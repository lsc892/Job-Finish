# 설치 도구·지원 스크립트 단순화 검토

- 기준: 2026-10-27, `33f0e4f`에서 시작한 깨끗한 작업 트리.
- 흐름과 계약: CLI 인수 해석 → VSIX·버전·호환성 확인 → 레거시 변경 계획 → 백업·정리 → 설치 결과 확인. 미리보기의 무변경, 다른 도구의 hook 보존, 설정 변경·junction 거부, 사용자 설정 백업을 유지한다.
- 검토 범위: [CLI](../../../tools/installer/src/cli.ts), [설치 계획](../../../tools/installer/src/flow.ts), [VS Code·VSIX](../../../tools/installer/src/vscode.ts), [레거시 조율](../../../tools/installer/src/legacy.ts), [설정·파일 정리](../../../tools/installer/src/uninstall.ts), [Windows 잔여물](../../../tools/installer/src/windows.ts), [설치 도구 빌드](../../../tools/installer/scripts/build.mjs), [사용법](../../../tools/installer/README.md), [설치 일지](../../../tools/installer/일지.md).
- 테스트 확인: [설치 흐름](../../../tools/installer/tests/flow.test.ts), [레거시 제거](../../../tools/installer/tests/uninstall.test.ts), [VSIX·격리 설치](../../../tools/installer/tests/vscode.test.ts).
- 지원 스크립트 확인: [확장 빌드](../../../scripts/build.mjs), [프로토콜 복사](../../../scripts/vendor-protocol.mjs), [패키지 검증](../../../scripts/verify-package.mjs), [동일 프로필 검증](../../../scripts/profile-host.mjs), [상태 부하](../../../scripts/load.ts), [라우터 부하](../../../scripts/router-load.ts), [manifest](../../../package.json), [타입 검사 설정](../../../tsconfig.json), [벤더 타입 안내](../../../src/protocol/README.md).

## 판단

바로 적용할 실익 있는 후보와 승인할 큰 변경 후보를 찾지 못해 이 영역의 제품 소스는 유지했다.

- 설치의 `InstallServices`는 테스트 대역과 VS Code 실행을 분리하고, 계획의 버전·상태는 호출자가 관측한다. 한 구현 또는 적은 참조 수만으로 제거하지 않는다.
- `removeHooks`의 변경 여부와 그룹 정체성 검사는 불변 그룹을 보존하고 변경된 이벤트만 다시 쓰는 역할이 있다. 순회를 바꾸는 제안으로 확대하지 않았다.
- 경로·junction·설정 재검사와 별도 백업은 삭제 전 검증 및 사용자 자료 보존을 담당한다. 비슷한 검사라는 이유로 합치거나 제거하지 않았다.
- `@iarna/toml`·`semver`, 빌드 도구, native 모듈·SDK는 소스·manifest·검증 스크립트에서 실제 사용된다. 벤더 타입은 생성 의존 관계와 외부 프로토콜 계약을 유지한다.
- 부하·프로필·패키지 스크립트는 각각 메모리 상한, 서로 다른 Extension Host, 실제 배포 내용 확인을 담당하므로 중복 테스트로 취급하지 않았다.

## 검증

- 루트 `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`: 통과.
- `npm --prefix tools/installer exec -- tsc --noEmit --noUnusedLocals --noUnusedParameters -p tools/installer/tsconfig.json`: 통과.
- `npm --prefix tools/installer run check`: 타입 검사·기존 20개 테스트·CLI 번들 빌드 통과, 실패·건너뜀 없음. 임시 프로필에서 실제 VS Code CLI 설치·업데이트·동일/상위 버전 유지와 CLI dry-run도 확인했다.
- 성능 변경을 적용하지 않아 소량·대량 비교는 실행하지 않았다. 프로토콜 재생성·배포·실제 사용자 환경 설치·레거시 제거는 실행하지 않았다. 지원 스크립트 전체의 동작을 새로 검증한 결과는 아니다.
