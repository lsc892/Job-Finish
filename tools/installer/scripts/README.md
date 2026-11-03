# scripts

설치 도구의 배포용 CLI와 포함할 확장 패키지를 준비한다.

- [build.mjs](build.mjs): CLI를 Node.js 실행 파일로 번들링하고 지정한 VSIX를 복사하거나 배포 전 포함 여부를 확인한다.
- [package.mjs](package.mjs): 배포 식별자·버전을 확인하고 현재 CLI·VSIX와 저장소 루트 README를 임시 배포 폴더에 모아 npm tarball을 만든다. README의 상대 링크는 npm 페이지용 절대주소로 바꾸고, 저장소 전용 npm 스크립트는 배포 manifest에서 제외한다. 루트의 `npm run package:npm`으로 실행한다.
