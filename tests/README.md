# tests

세션·제공자·스트림·알림의 회귀와 실제 VS Code·Windows 통합 동작을 검증한다.

- [application-sessions.test.ts](application-sessions.test.ts) — 세션 열기·용량 제한·소유권 등록·실패 정리와 종료 경쟁의 일관성을 검증한다.
- [captured.test.ts](captured.test.ts) — 실제 런타임에서 보존한 Codex·Claude 이벤트가 기대한 세션 상태로 해석되는지 검증한다.
- [claude-execution.test.ts](claude-execution.test.ts) — 제어된 SDK Query로 Claude 실행의 입력·취소·종료·소유권 경계를 검증한다.
- [claude-permissions.test.ts](claude-permissions.test.ts) — Claude 승인 콜백의 응답·철회·상한·체크포인트 실패와 리스너 정리를 검증한다.
- [codex-connection.test.ts](codex-connection.test.ts) — Codex 연결의 초기 이벤트 버퍼·응답 재전송·복구 병합·재시도·종료를 검증한다.
- [codex-history.test.ts](codex-history.test.ts) — Codex 이력의 페이지 상한·커서 검증·최종 응답 선택과 연결 유효성 확인을 검증한다.
- [codex-reconciliation.test.ts](codex-reconciliation.test.ts) — Codex 이력 대조 중 소유권·연결 상실과 충돌 결과·미관찰 실행 처리를 검증한다.
- [event-router.test.ts](event-router.test.ts) — 관찰한 Codex·Claude 이벤트의 알림 변환·격리·중복 제거·입력 수명을 검증한다.
- [extension-host.ts](extension-host.ts) — 실제 VS Code 확장 호스트에서 명령·외부 스트림·창별 결과·독점 소유권을 검증한다.
- [helpers.ts](helpers.ts) — 세션 테스트용 바인딩·진단·알림 수집과 소유권 철회 도우미를 제공한다.
- [integration.test.ts](integration.test.ts) — 실제 stdio 전송과 합성 App Server로 Codex 실행·입력·취소·이력 복원을 통합 검증한다.
- [observe.test.ts](observe.test.ts) — 기존·신규 에이전트 스트림의 비파괴 관찰과 프레임 경계·종료·설정 전환을 검증한다.
- [ownership.test.ts](ownership.test.ts) — 창·연결·런타임별 독점 소유권과 소유자 복구·Windows 파일 잠금을 검증한다.
- [profile-host.ts](profile-host.ts) — 동일 VS Code 프로필의 창별 결과 격리와 재시작·소유권 이전·복구를 검증한다.
- [providers.test.ts](providers.test.ts) — 제3 제공자의 등록·관찰·실행·입력 변환 경계를 검증한다.
  - `SampleProvider` — 독립 합성 프로토콜로 제공자 확장 지점을 검증한다.
  - 익명 등록 검증 제공자 — 별도 ID와 중복 명령의 등록 거부를 검증한다.
  - 익명 경로 검증 제공자 — 런타임 홈 변경으로 경로 정규화와 식별자 분리를 검증한다.
  - 익명 식별자 검증 제공자 — 제공자 ID 변경으로 런타임 식별자 분리를 검증한다.
- [state.test.ts](state.test.ts) — 세션의 종료·중복·체크포인트·입력·소유권·보관 상한과 제공자 상태 변환을 검증한다.
- [toast-activation.test.ts](toast-activation.test.ts) — 알림 활성화 채널의 연결 상한·유휴 종료·만료와 현재 소유권 확인을 검증한다.
- [toast-host.ts](toast-host.ts) — 격리 VS Code 창에서 실제 스트림·네이티브 알림·전경 창 관찰을 제어한다.
- [toast-process.test.ts](toast-process.test.ts) — 네이티브 도우미의 진단 프레임·종료·시간 제한·취소·정리 계약을 검증한다.
- [toast.test.ts](toast.test.ts) — 실제 Windows 파이프와 제어된 도우미로 알림 전송·등록·클릭 승인·취소를 검증한다.
- [toast-image.test.ts](toast-image.test.ts) — 기본 이미지·사용자 지정 경로·이미지 끄기와 잘못된 경로의 대체 동작을 검증한다.
- [transport.test.ts](transport.test.ts) — UTF-8 JSONL 프레임·RPC 봉투·초기 이벤트 큐와 stdio 요청 수명을 검증한다.
- [windows.test.ts](windows.test.ts) — 창 식별·포커스·점멸·알림 정책을 검증하고 `FakeNative`로 창 상태와 점멸 호출을 모사한다.
- [fixtures](fixtures/README.md) — 합성 보조 프로세스와 실제 런타임에서 보존한 이벤트 입력을 제공한다.
- [native-toast](native-toast/README.md) — 네이티브 알림 바로가기 등록과 COM 활성화 계약을 검증한다.
