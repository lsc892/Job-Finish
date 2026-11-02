# build

제품 빌드와 프로토콜 타입 생성을 관리한다. 소스코드는 [src/](../src/README.md), 테스트는 [tests/](../tests/README.md)에 있다.

- [extension.mjs](extension.mjs) — C# 알림 도우미를 `dist/native`에 게시하고 VS Code 확장을 `dist/extension.cjs`로 번들링한다. 저장소 루트에서 `npm run build`로 실행한다.
- [protocol/](protocol/README.md) — 생성한 Codex App Server 타입에서 필요한 선언과 전이 의존 타입을 선별한다.

`npm run package`는 빌드 후 VSIX를 생성한다. 패키지 검증은 [tests/package/](../tests/package/README.md)의 `npm run test:package`로 실행한다. 생성물은 `dist`와 루트 VSIX이며 빌드 도구 자체는 VSIX에 포함하지 않는다.
