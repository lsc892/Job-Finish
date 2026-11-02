# Claude 결과와 입력 요청의 처리 단계 정리

2026-11-02. [Claude 관찰 이벤트](../../src/runtime/claude/events.ts)의 `acceptResult()`와 `acceptToolRequest()`를 같은 파일 안에서 정리한다.

## 책임과 확인한 문제

두 메소드는 관찰한 프로토콜을 세션 상태로 바꾸지만 책임은 다르다. `acceptResult()`는 최종 결과를 검증하고 실제 실행 ID에 연결해 종료 상태를 반영한 뒤 중복 기록과 입력 큐를 정리한다. `acceptToolRequest()`는 승인·질문 요청을 실행 중인 턴에 연결하고 표시 정보를 만들어 입력 대기를 등록한다. 도구를 실행하거나 승인 답변을 보내지는 않는다.

기존 메소드에는 형식 검증·식별자 선택·상태 변경·본문 변환·큐 정리가 함께 들어 있어 정상 처리의 단계와 거부 시점을 다시 해석해야 했다. 결과 검증, 결과와 턴 연결, 수락한 결과 기록, 도구 요청의 턴 시작, 입력 요청과 질문 문구 변환을 이름 있는 비공개 메소드로 구분한다. 클래스·파일·공개 계약·자료구조와 알고리즘은 유지하며 별도 구조 변경 후보는 없다.

## 보존할 계약과 검증 계획

- 결과 본문 검증 → 중복 확인 → 세션 조회 → 사용자 ID 일치 확인 → 제목 반영 → 임시 턴 이전·시작 → adapter 종료 반영 → 결과 중복 기록·큐 소비 순서를 보존한다.
- 원본 `user_message_uuid`의 유효성·fallback과 adapter의 추가 검증, 대기 입력과 유일한 활성 턴을 이용하는 이전 규칙을 유지한다. adapter가 거부하면 결과 ID와 입력 큐를 소비하지 않는다.
- 도구 요청의 envelope 검증 뒤 세션을 조회하고, 대기 입력 → 첫 활성 턴 → 요청 ID 기반 임시 턴 순으로 선택·시작한 다음 표시 정보를 만든다. 질문 문자열의 순서·공백·빈 문자열, 승인/질문 fallback과 `payload: null`을 유지한다.
- [관찰 라우터 테스트](../../tests/event-router.test.ts), [세션 제목 테스트](../../tests/session-title.test.ts), [스트림 관찰 테스트](../../tests/observe.test.ts)와 타입 검사를 실행한다.

## 적용 결과

- [결과 처리 진입점](../../src/runtime/claude/events.ts#L94)은 `validateResult()` → 중복·세션 확인 → `bindResultToTurn()` → 기존 `acceptClaudeResult()` → `recordAcceptedResult()` 순서로 읽힌다. [검증](../../src/runtime/claude/events.ts#L106), [실행 연결](../../src/runtime/claude/events.ts#L122), [수락 기록과 큐 소비](../../src/runtime/claude/events.ts#L134)를 구분했다. 검증의 초기 조건과 예외를 여러 줄로 펼쳐 거부 조건이 바로 보이게 했다.
- [도구 요청 진입점](../../src/runtime/claude/events.ts#L154)은 envelope·세션 확인 → `startToolRequestTurn()` → `createToolInputRequest()` → `session.waiting()` 순서로 읽힌다. [턴 선택·시작](../../src/runtime/claude/events.ts#L165), [입력 요청 변환](../../src/runtime/claude/events.ts#L171), [질문 문구 추출](../../src/runtime/claude/events.ts#L187)을 구분했다. 입력 요청은 필드마다 줄을 나눠 종류·제목·payload의 대응을 표시했다. 두 진입점은 종료 결과와 입력 대기라는 서로 다른 책임을 같은 이벤트 처리기 안에서 유지한다.
- `bindResultToTurn()`은 원래 대기 입력의 존재 여부를 반환하므로 adapter 처리 중 큐 상태가 바뀌더라도 원래 코드와 같은 조건으로 큐를 소비한다. 잘못된 원본 사용자 ID가 identifier 단계의 fallback을 통과한 뒤 adapter에서 거부되는 기존 경계도 유지했다.
- 도구 승인은 질문이 아니어도 원래처럼 입력·질문 문구를 먼저 읽는다. 질문은 문자열 항목만 원래 순서로 연결하며 빈 문자열과 공백을 정리하지 않는다. 도구 시작과 표시 정보 해석의 순서, 요청 fallback·`payload: null`도 유지했다.
- `node --import tsx --test tests/event-router.test.ts tests/session-title.test.ts tests/observe.test.ts`: 30개 통과. 승인·질문 제목과 입력 대기 → 종료, 빈 질문·공백 보존, 잘못된 결과 거부 뒤 같은 ID 재시도, 중복 결과, 임시 UUID 이전, 첫 요청 제목, 실제 자식 프로세스의 스트림 관찰을 확인했다.
- `npm run typecheck`와 `git diff --check` 통과. 실제 계정·모델 호출·공식 확장 UI 조작은 이번 파일 내부 리팩터링의 검증 범위에 포함하지 않았다.
- 메인 검토 후 `npm run check`의 타입 검사·전체 171개 테스트·확장/C# 빌드가 통과했다. 실행 종료와 입력 대기의 책임 차이는 [Claude 안내](../../src/runtime/claude/README.md)에도 반영했다.
