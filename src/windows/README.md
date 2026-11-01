# windows

검증된 Windows 창의 작업표시줄 깜박임과 네이티브 토스트·클릭 활성화를 처리한다.

- [flash.ts](flash.ts) — `FlashController`: 창 깜박임을 시작하고 포커스·만료·중지 요청에 따라 해제한다.
- [gate.ts](gate.ts) — 운영체제가 회수하는 배타적 파일 핸들로 소유권 변경 작업을 직렬화한다.
- [native.ts](native.ts) — `Win32`는 창 조회·깜박임 API를 제공하고 `WindowIdentity`는 현재 Code 창의 바인딩을 검증한다.
- [toast-activation.ts](toast-activation.ts) — `ToastActivation`: 알림별 클릭 채널과 활성화 권한·결과를 검증한다.
- [toast-process.ts](toast-process.ts) — `ToastProcessRunner`: 도우미 입출력·시간 제한을 처리하고 스트림 종료까지 프로세스를 관리한다.
- [toast.ts](toast.ts) — `WindowsToast`: 도우미 등록·전달 확인과 현재 알림의 클릭 채널 수명을 조율한다.
- [toast-image.ts](toast-image.ts) — 기본·사용자 지정 이미지와 비활성화·잘못된 경로의 대체 동작을 결정한다.
