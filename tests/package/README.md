# package

생성한 VSIX의 설치와 배포 파일 포함 여부를 검증한다.

- [verify-package.mjs](verify-package.mjs) — 격리 VS Code 프로필에 VSIX를 설치해 빌드 최신성·런타임 의존성·이미지·라이선스·네이티브 도우미 포함을 확인한다.

저장소 루트에서 `npm run build` → `npm run package` → `npm run test:package` 순서로 실행한다. 검증에는 사용자 VS Code 프로필과 별도의 임시 프로필을 사용한다.
