# Claude 런타임 전체 파일의 가독성 정리

2026-11-02. [Claude 런타임](../../src/runtime/claude/README.md)의 TypeScript 6개 파일을 모두 확인하고, 같은 파일 안에서 실행·관찰·권한 요청의 처리 단계를 정리한다.

## 검토 범위와 적용 방향

| 파일 | 확인한 책임과 적용 방향 |
| --- | --- |
| [execution.ts](../../src/runtime/claude/execution.ts) | `consume()`의 턴 준비·SDK 인자 구성·이벤트 반복·정상 정리를 구분하고 취소·dispose의 서로 다른 오류 경계를 펼친다. |
| [permissions.ts](../../src/runtime/claude/permissions.ts) | 반환 람다와 Promise 안에 섞인 유효성/상한 검증·pending 등록·abort 구독·세션 요청 기록·응답 정리를 이름 있는 처리 단계로 구분한다. |
| [events.ts](../../src/runtime/claude/events.ts) | 앞서 분리한 결과·도구 요청 단계를 유지하고 나머지 수신/송신 진입점의 입력·중단·초기화 처리를 확인한다. |
| [provider.ts](../../src/runtime/claude/provider.ts) | 실행 생성·승인 응답·질문 순회를 확인하고 의미를 더하는 내부 정리만 적용한다. |
| [adapter.ts](../../src/runtime/claude/adapter.ts) | 결과의 식별자 검증과 종료 상태 변환은 이미 분리되어 있어 유지한다. |
| [index.ts](../../src/runtime/claude/index.ts) | 단순 공개 재export를 유지한다. |

공개 계약·파일/클래스 배치·상태 자료구조·기본값·오류 정책과 호출 순서를 보존한다. 소스 구조나 알고리즘을 바꾸는 후보는 없다.

## 보존 경계와 검증 계획

- 주입한 SDK factory는 불필요한 await 없이 동기적으로 시작한다. 턴 준비는 기존처럼 `try` 앞에 두고 SDK query 생성과 전체 이벤트 반복은 `try` 안에 둔다.
- 결과 이후에도 스트림의 나머지 이벤트를 소진한다. 정상 정리는 입력 종료 → 권한 정리 → query close → 문맥 초기화/재개 표시 순서이며, 권한 정리 실패가 close를 건너뛰는 기존 경계를 유지한다. dispose는 flags → 권한 정리 → close와 disconnected 순서를 따로 유지한다.
- 취소는 interrupt 확인 뒤 같은 문맥인지 재확인하고, 아직 추적 중인 턴만 취소한 뒤 권한을 정리한다. 이벤트 외부 콜백·식별자 확인·결과 반영 순서도 유지한다.
- 권한 요청의 pending 등록·abort 구독·세션 기록·사후 철회 확인과 응답 시 pending 삭제·리스너 해제·세션 해소·SDK 응답 순서를 유지한다.
- [실행 테스트](../../tests/claude-execution.test.ts)·[권한 테스트](../../tests/claude-permissions.test.ts)에 필요한 경계 검증을 먼저 추가하고 기존 소스에서 확인한 뒤 적용한다. 관찰·Provider 관련 기존 테스트와 타입 검사도 실행한다.

## 적용 결과

- [실행 흐름](../../src/runtime/claude/execution.ts#L54)은 factory 선택 → `beginTurn()` → `createQueryArguments()` → 스트림 순회 → `cleanupQuery()`로 읽힌다. 입력 메시지 생성과 interrupt 확인 뒤 종료 반영도 구분했다. factory 선택과 `for await`는 기존 위치에 두어 불필요한 비동기 대기를 추가하지 않았다.
- [권한 요청](../../src/runtime/claude/permissions.ts#L20)은 이름 있는 SDK 콜백 → 유효성·상한 검사 → pending/철회 구독 등록 → 세션 입력 요청 기록으로 나눴다. 응답 정리의 pending 삭제·리스너 해제·세션 갱신·SDK 응답 순서는 그대로다.
- [관찰 이벤트](../../src/runtime/claude/events.ts#L42)는 사용자 입력 수집·텍스트 추출·첫 대기 입력의 턴 시작을 구분했다. 앞서 분리한 최종 결과·도구 요청과 중단 응답 계약도 유지한다.
- [Provider](../../src/runtime/claude/provider.ts)는 SDK 실행 옵션과 질문 payload 타입·질문별 응답 매핑을 펼쳐 표시했다. `adapter.ts`의 식별자/종료 변환과 `index.ts`의 재내보내기는 이미 명확하여 이번 작업에서 변경하지 않았다.
- 실행 옵션·입력 메시지·동기 factory 시작·후속 실행의 resume, query close 실패 뒤 상태 초기화, 정상/해제 경로의 권한 정리 예외, 요청 기록 도중 철회를 다루는 회귀 테스트 5개를 보강했다. 변경 전 소스에서도 통과한 테스트로 기존 오류 경계를 고정했다.
- 통합 검토에서 동일한 관련 테스트 118개를 변경 전·후 두 코드에 각각 실행해 모두 통과했다. `npm run check`의 타입 검사·전체 191개 테스트·확장/C# 빌드도 통과했다. 전체 파일 검토·검증 범위는 [통합 기록](agent-runtimes.md)에 정리했다.
