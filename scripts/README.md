# scripts

빌드·패키지와 합성·실제 런타임·Windows 창 동작 검증을 실행한다.

- [activate-test-toast.ps1](activate-test-toast.ps1) — 등록된 격리 테스트 알림의 프로토콜 URI를 찾아 네이티브 활성화를 실행한다.
- [build.mjs](build.mjs) — Windows 알림 도우미를 게시하고 VS Code 확장 진입점을 번들링한다.
- [capture-codex-input.mjs](capture-codex-input.mjs) — 실제 Codex 입력 검증 기록에서 필요한 이벤트를 추려 식별자와 임시 경로를 치환한 fixture를 저장한다.
- [capture-fixtures.mjs](capture-fixtures.mjs) — 실제 런타임 검증 기록에서 종료 이벤트와 Claude 입력 계약을 추려 fixture로 저장한다.
- [click-toast.ps1](click-toast.ps1) — 격리 테스트 알림을 Windows UI 자동화로 찾아 클릭하고 선택적으로 진단 자료를 저장한다.
- [extension-host.mjs](extension-host.mjs) — 격리된 단일·이중 VS Code 확장 호스트를 실행하고 창별 검증 결과를 수집한다.
- [focus-test-window.ps1](focus-test-window.ps1) — 제목으로 확인한 격리 알림 테스트 창에 포커스를 옮기고 전경 창 상태를 보고한다.
- [live-claude-input.ts](live-claude-input.ts) — 실제 Claude SDK의 질문·승인·취소·턴 제한 경로를 임시 작업 공간에서 검증한다.
- [live-codex-history.ts](live-codex-history.ts) — 완료된 실제 Codex 검증 세션의 이력 복원과 결과 조회·재알림 방지를 검증한다.
- [live-codex-input.ts](live-codex-input.ts) — 실제 Codex App Server의 질문·승인·권한·취소와 재연결 경로를 검증한다.
- [live.ts](live.ts) — 실제 Codex·Claude 실행의 완료 결과와 Codex 재연결 시 중복 알림 방지를 검증한다.
- [load.ts](load.ts) — 대량 세션 이벤트와 JSONL 디코딩 후 보관 상태와 힙 증가가 제한되는지 검증한다.
- [native-toast-contract.mjs](native-toast-contract.mjs) — 컴파일된 네이티브 알림 도우미의 등록·입력 검증·프로토콜·COM 승인 계약을 검증한다.
- [native-toast.ts](native-toast.ts) — 실제 Windows 알림 전송과 선택한 VS Code 창의 클릭 활성화 결과를 기록한다.
- [profile-host.mjs](profile-host.mjs) — 동일 프로필의 격리 VS Code 창에서 소유권·재시작·강제 종료 복구 검증을 조율한다.
- [router-load.ts](router-load.ts) — 합성 에이전트 스트림의 대량 이벤트로 관찰·라우팅 성능과 보관 상태를 측정한다.
- [toast-routing.mjs](toast-routing.mjs) — 격리된 두 VS Code 창에서 알림 클릭의 원래 창 복귀와 창 상태 보존을 검증한다.
- [vendor-protocol.mjs](vendor-protocol.mjs) — 지정한 Codex 생성 타입과 전이 의존 타입을 프로토콜 원본 폴더로 복사한다.
- [verify-package.mjs](verify-package.mjs) — VSIX를 격리 프로필에 설치해 번들 최신성·런타임 의존성·네이티브 도우미 포함을 검증한다.
