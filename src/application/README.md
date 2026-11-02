# application

실행 제공자와 세션 소유권을 조율하며 창에 연결된 세션의 수명을 관리한다.

- [sessions/index.ts](sessions/index.ts) — `ApplicationSessions`: 세션 목록·연결 상한·저장 기록과 전체 종료를 조율한다. 기존 `application/sessions` import 경로를 유지한다.
- [sessions/resources.ts](sessions/resources.ts) — `SessionResources`: 연결 하나의 실행·Session·소유권 임대를 생성하고 조기 등록·해제·실패 정리를 맡는다.
- [sessions/types.ts](sessions/types.ts) — 공개 세션·저장 형식과 주입 서비스 계약을 정의한다.

의존 방향은 세션 조율부 → 개별 자원 → runtime/core다. 자원 객체는 조율부를 import하지 않고 활성 여부·등록·제거 콜백을 받는다. 비동기 연결의 초기 소유권 등록, 저장 대기 위치와 최근 32개 상한, 명시적 해제와 연결 실패의 서로 다른 정리 순서를 유지한다.
