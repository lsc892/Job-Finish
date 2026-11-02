# windows

검증된 Windows 창의 작업표시줄 깜박임과 네이티브 토스트·클릭 활성화를 처리한다.

- [flash.ts](flash.ts) — `FlashController`: 창 깜박임을 시작하고 포커스·만료·중지 요청에 따라 해제한다.
- [gate.ts](gate.ts) — 운영체제가 회수하는 배타적 파일 핸들로 소유권 변경 작업을 직렬화한다.
- [native.ts](native.ts) — `Win32`는 창 조회·깜박임 API를 제공하고 `WindowIdentity`는 현재 Code 창의 바인딩을 검증한다.
- [toast](toast/README.md) — 토스트 등록·전달·클릭 채널·이미지 선택을 한 폴더에서 찾는다. 기존 `windows/toast` import와 공개 타입은 유지한다.
