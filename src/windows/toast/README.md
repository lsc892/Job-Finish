# toast

토스트에만 쓰는 모듈을 모은다. 전송 helper가 종료된 뒤에도 클릭 채널은 살아 있어 두 자원의 수명을 별도로 유지한다.

- [index.ts](index.ts) — `WindowsToast`: 공유 등록·재시도와 현재 알림의 세대·전달·교체를 조율한다. `windows/toast`의 기존 공개 진입점이다.
- [process.ts](process.ts) — `ToastProcessRunner`: helper별 입출력·시간 제한·취소·스트림 종료 판정과 전체 child 집합을 소유한다.
- [activation.ts](activation.ts) — `ToastActivation`: 클릭 pipe·socket·만료와 현재 소유권·최초 클릭 승인·활성화 결과를 관리한다.
- [image.ts](image.ts) — 기본·사용자 지정 이미지 선택과 잘못된 경로의 대체 동작을 결정한다.

각 자원 안의 한 번만 쓰는 검증·등록·완료 단계는 해당 메소드나 콜백에서 이어 읽는다. 구독 해제에 같은 함수 객체가 필요하거나 자원 정리·상태 검사를 공유하는 메소드는 유지한다. 하위 모듈은 조립부를 import하지 않는다.
