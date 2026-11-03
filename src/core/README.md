# core

- [model.ts](model.ts) — Codex·Claude 식별자, 신호·턴·입력 요청 타입, 보관 상한과 진단.
- [session.ts](session.ts) — 연결 안의 턴·요청 ID 추적, 제목·본문·입력 대기·종료 반영과 중복 제거. 입력 요청은 턴 ID만 보관하며 디스크에 저장하지 않는다.
- [notifications.ts](notifications.ts) — 현재 창의 신호 권한·활성화 설정·포커스를 확인해 결과를 보관하고 토스트·flash를 전달한다. 비동기 질문 뒤 5초 이내 정상 완료는 결과만 추가한다.
