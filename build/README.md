# build

[extension.mjs](extension.mjs)가 C# 알림 도우미를 `dist/native`에 게시하고 VS Code 확장을 `dist/extension.cjs`로 번들링한다.

저장소 루트에서 `npm run build`로 빌드하고 `npm run package`로 Windows x64 VSIX를 만든다. 런타임 의존성은 Windows API 호출용 `koffi`다. [패키지 검증](../tests/package/README.md)은 `npm run test:package`로 실행한다. 빌드 도구와 제품·검증 소스는 VSIX에 포함하지 않는다.
