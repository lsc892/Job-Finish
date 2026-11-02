# vscode

격리한 VS Code 프로필·확장 호스트에서 명령과 창별 소유권·복구 동작을 검증한다.

- [extension-host.mjs](extension-host.mjs) — 단일 또는 이중 창의 확장 호스트를 실행하고 결과를 수집한다. `npm run test:extension`은 단일 창, `npm run test:windows`는 `--dual` 이중 창 검증이다. 두 명령은 확장을 먼저 빌드한다.
- [profile-host.mjs](profile-host.mjs) — 같은 프로필의 두 창에서 소유권·재시작·강제 종료 복구를 조율한다. `npm run test:profile`로 실행하며 `--different-projects`·`--native` 옵션을 지원한다.
- [extension-host.ts](extension-host.ts) — 실제 확장 호스트에서 명령·외부 스트림·창별 결과·독점 소유권을 검사하는 테스트 본문이다.
- [profile-host.ts](profile-host.ts) — 같은 프로필에서 실행 결과 격리·소유권 이전·재시작 복구를 검사하는 테스트 진입점이다.

저장소 루트에서 실행한다. 실행기 `.mjs`는 같은 폴더의 테스트 본문 `.ts`를 번들링한다. `.generated`와 임시 VS Code 프로필을 사용하며 결과는 `test-artifacts`에 저장한다.
