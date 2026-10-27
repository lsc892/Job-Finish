# core

제공자와 UI에 공통인 세션 상태·소유권·알림 전달 규칙을 제공한다.

- [model.ts](model.ts) — 공통 타입·용량 상한·텍스트 제한을 정의하며 `Diagnostics`는 진단 메시지·이벤트를 기록한다.
- [notifications.ts](notifications.ts) — `Notifications`: 실행 결과를 보관하고 포커스·설정에 맞춰 깜박임과 토스트를 전달한다.
- [ownership.ts](ownership.ts) — `Ownership`은 창 사이 세션 소유권을 조율하고 `Lease`는 토큰 검증·체크포인트·해제를 관리한다.
- [session.ts](session.ts) — `Session`: 소유한 실행의 상태·입력 요청·체크포인트와 완료 신호 중복을 관리한다.
