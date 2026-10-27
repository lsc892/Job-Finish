# 런타임 관측과 Provider의 가독성 정리

2026-10-27 기준. [통합 검토안](../readability-refactor.md)에 연결되는 작업 문서다. 앞선 파일 내부 정리 후 런타임 폴더 분리에서 Provider와 관찰 해석기를 각각 `provider.ts`와 `events.ts`로 나눴다. 현재 배치와 공통 실행 계층은 [Provider 확장](../agent-providers.md)을 따른다.

## 현재 흐름과 보존할 계약

- [관찰 시작](../../src/runtime/observe.ts#L64)은 Extension Host의 새 프로세스 생성과 기존 핸들을 확인하고, 등록된 Provider와 확장 경로가 일치하는 stdio에 연결한다. [연결별 관찰](../../src/runtime/observe.ts#L112)은 원본 write의 인자·반환값·예외와 stdout 바이트를 그대로 전달하며, 관측 실패는 원본 자식 프로세스에 영향을 주지 않는다.
- [공통 세션 확보](../../src/runtime/event-router.ts#L31)는 연결 ID와 세션 수명·소유 실행 제외·32개 상한을 관리한다. 연결별 메시지 해석은 [Provider 계약](../../src/runtime/agent-provider.ts#L47)을 통해 선택한 처리기가 소유한다.
- [Codex 수신](../../src/runtime/codex/events.ts)은 thread 시작 응답으로 ephemeral·subagent를 제외한 뒤 live 알림만 Session에 전달한다. history 응답은 완료 알림을 만들지 않는다.
- [Claude 결과 수신](../../src/runtime/claude/events.ts)은 입력 큐·interrupt 응답 대기·결과 중복을 연결별로 보관한다. 결과 본문 검증 → 중복 확인 → 사용자 ID 대조 → 임시 턴 이전 → 완료 반영 → 중복 키 저장 → 입력 큐 소비 순서를 유지한다.

## 문제와 바로 적용할 정리

1. 관찰자의 시작 메소드 안에 spawn 교체와 기존 핸들 발견의 독립적인 실패 경계가 섞여 있다. 두 단계의 이름을 드러내고 각 단계의 복구·진단 경계를 유지한다. 프레임 순회와 완성된 JSON 해석도 같은 클래스 안에서 구분한다.
2. 공통 라우터의 Session 조회·생성·상한 처리가 중첩되어 있다. 이미 존재하는 세션의 조기 반환과 신규 세션을 위한 공간 확보 단계를 드러낸다.
3. Provider 분리 이후에도 Claude 처리기의 `pendingThreads`, `claudeRequests` 등 이름이 남아 있다. 실제 보관하는 interrupt 요청·대기 입력·완료 결과의 의미로 이름을 맞춘다. Codex는 thread 분류와 live 알림 처리를 같은 파일의 비공개 메소드로 구분한다.

<a id="r1"></a>

## R1 — 기존 공급자별 이벤트 분리안의 현재 상태

10월 24일 제안의 목적은 이후 도입된 `AgentProvider`·`CodexProvider`·`ClaudeProvider`와 연결별 `AgentEvents`로 이미 충족되어 있다. 당시 제안 경로인 `runtime/events/*`를 새로 만들지 않는다. 공통 라우터는 공급자 이름으로 분기하지 않고, [등록 목록](../../src/runtime/providers.ts)에서 선택한 처리기의 공통 계약을 호출한다. 이번 작업의 추가 구조 변경 제안은 없다.

## 적용 결과와 검증

- [프레임 해석](../../src/runtime/observe.ts#L29), 새 프로세스 관찰·기존 프로세스 발견, [세션 공간 확보](../../src/runtime/event-router.ts#L42), [thread 제외 기록](../../src/runtime/codex/events.ts)을 비공개 메소드로 구분했다. Claude의 상태 이름은 `pendingInterrupts`·`queuedInputs`·`receivedResults`·`sessionId`로 맞췄다. 공개 계약과 자료구조·한도·반복 순서·복구 경계는 유지했다.
- `npx tsx --test tests/event-router.test.ts tests/observe.test.ts tests/providers.test.ts`의 **23개 테스트가 통과**했다. [라우터](../../tests/event-router.test.ts#L14), [관찰](../../tests/observe.test.ts#L25), [Provider](../../tests/providers.test.ts#L77)에서 history 제외·UUID 이전·결과 검증과 중복·실패 interrupt·바이트 보존·연결 해제·세 번째 Provider의 공통 알림 경로를 확인했다.
- [첫 부분 프레임 회귀 테스트](../../tests/observe.test.ts#L110)를 추가했다. 기존 스트림의 첫 비어 있지 않은 불완전 JSON만 허용하고, 이어지는 정상 프레임은 전달하며, 이후 잘못된 JSON에는 관찰만 해제하는 계약과 원본 바이트 보존을 확인했다. 시작 단계의 성공 여부를 반환하도록 최종 정리한 뒤 관찰 테스트 6개도 다시 통과했다.
- 외부 프로세스·UI·네트워크를 새로 추가하지 않는다. 실제 모델 호출과 공식 확장 UI 조작은 이번 내부 정리의 검증 범위 밖이다.
