# Codex·Claude 런타임 책임 분리

2026-10-27 기준. Codex의 프로토콜·연결·이력 분리에 이어 두 런타임을 `runtime/codex/`와 `runtime/claude/` 아래로 모았다. 공개 디렉터리 import와 프로토콜·상한은 유지한다. 전체 배치와 새 런타임 추가 절차는 [Provider 확장](../agent-providers.md)을 따른다.

## 공통 추상화와 Claude 책임 경계

[공통 실행 계층](../../src/runtime/execution.ts)은 구조적 `AgentExecution` 계약, 이벤트 타입별 `RuntimeOptions<TEvent>`, 소유권 검사를 공유하는 `AgentRuntime` 추상 클래스를 제공한다. [CodexExecution](../../src/runtime/codex/execution.ts)과 [ClaudeExecution](../../src/runtime/claude/execution.ts)이 이를 상속한다. Provider의 생성·관찰·입력 계약은 기존 `AgentProvider`로 공유하고 [providers.ts](../../src/runtime/providers.ts)에서 등록한다. 각 런타임은 상대 폴더를 import하지 않는다.

| Claude 모듈 | 책임 |
| --- | --- |
| [provider.ts](../../src/runtime/claude/provider.ts) | 프로세스 식별·실행 생성·승인과 질문 응답 변환 |
| [events.ts](../../src/runtime/claude/events.ts) | 관찰 스트림의 입력 큐·임시 ID 이전·중복 결과·interrupt 응답 처리 |
| [execution.ts](../../src/runtime/claude/execution.ts) | SDK query·실행 문맥·결과·취소 확인·스트림 끝까지 소비와 해제 |
| [adapter.ts](../../src/runtime/claude/adapter.ts) | 결과 식별 검증·본문과 완료 상태 변환 |
| [permissions.ts](../../src/runtime/claude/permissions.ts) | pending 승인·질문 콜백, abort listener, 응답·일괄 거절과 listener 해제 |

SDK의 `canUseTool`은 실행 문맥이 아직 활성인지 콜백으로 확인한다. `ClaudePermissions`는 상위 실행체를 import하지 않고 Session과 이 판정만 받는다. 결과·취소·해제 시 pending을 거절하고 구독을 해제하며, 결과보다 늦은 interrupt 확인이 완료를 취소로 바꾸지 않는 동작은 유지한다. Codex의 이력 복구와 Claude의 미확정 실행 보존 정책은 각 구현에서 유지한다.

## Codex의 현재 책임 경계

| 모듈 | 책임과 상태 |
| --- | --- |
| [provider.ts](../../src/runtime/codex/provider.ts) | 생성·프로세스 식별·승인과 질문 응답 변환 |
| [events.ts](../../src/runtime/codex/events.ts) | 관찰한 App Server 이벤트·ephemeral/자식 thread 제외 상태 |
| [execution.ts](../../src/runtime/codex/execution.ts) | thread 생성·재개, 실행·취소·입력 응답 조율, 시작 중 상태와 모델 메타데이터 |
| [adapter.ts](../../src/runtime/codex/adapter.ts) | 프로토콜 검증·상태 변환·입력 요청 변환·Session 갱신; 관찰 실행과 직접 실행에서 공유 |
| [connection.ts](../../src/runtime/codex/connection.ts) | stdio 초기화·연결 세대, 준비 전 이벤트 큐, 연결별 응답 캐시, 재접속 Promise와 지수 지연 타이머 |
| [reconciliation.ts](../../src/runtime/codex/reconciliation.ts) | pending start와 저장 이력 일치, 관측된 실행 소유권 검사, 최종 본문·baseline 적용, 충돌 결과의 단일 읽기 전용 재검증 |
| [history.ts](../../src/runtime/codex/history.ts) | 상한이 있는 페이지별 이력 조회와 cursor·항목 검증 |

`CodexExecution`이 연결과 Session·adapter·reconciliation을 조립한다. 하위 모듈은 실행체를 import하지 않는다. 연결은 메시지·연결 종료·복구 콜백을 받고, 이력 대조는 현재 연결 여부 콜백과 Session을 가진 adapter를 받는다. 하위 모듈이 facade의 비공개 상태를 읽거나 바꾸지 않는다. 기존 `CodexAdapter`·`codexStatus`·`codexApprovalResponse`는 `codex/index.ts`에서 재export한다.

연결 초기화 → 새 Session 생성 또는 기존 Session 등록 후 thread 재개 → 이력 대조 → 준비 완료와 큐 배출 순서를 유지한다. 연결 세대가 바뀌면 응답 캐시를 비우고, 동일 세대의 서버 요청만 재응답한다. 자동 복구는 기존대로 최대 3회, 1·2·4초 간격이며 수동 재접속의 동시 호출은 진행 중인 복구를 공유한다. 시작 응답 전 이벤트도 시작 중인 실행에 연결하고, 미확정 start와 관측하지 않은 활성 실행은 새 실행을 허용하지 않는다.

## Codex 책임 분리 당시 검증

- [연결 경계 테스트](../../tests/codex-connection.test.ts) 5개: 큐 배출 순서, 응답 재전송의 개수·바이트 상한과 연결 세대 초기화, 동시 재접속과 실패 후 재시도, 자동 복구 지연·3회 상한, dispose 시 예약 취소를 검증한다.
- [이력 대조 테스트](../../tests/codex-reconciliation.test.ts) 4개: 조회 대기 중 연결·소유권 상실 후 상태 보존, 관측하지 않은 활성 실행 거부, 충돌 재검증의 단일 조회와 중복 알림 방지를 검증한다.
- 기존 실제 stdio fixture·복구·승인·캡처 프로토콜 테스트도 유지한다. 통합 타입 검사·143개 테스트·확장/C# 빌드가 통과했다. 최종 Extension Host 검증과 미확인 범위는 [통합 기록](../readability-refactor.md)에 기록한다.

## 앞선 파일 내부 정리

## 검토 범위와 현재 흐름

- [Codex open](../../src/runtime/codex/execution.ts)은 연결 초기화 후 새 thread 생성 또는 저장 thread 재개를 선택하고, 준비 전 이벤트를 큐에 보관한 뒤 순서대로 전달한다. [복구 이력 대조](../../src/runtime/codex/reconciliation.ts)는 thread 재개 → 저장 이력 대조 → 이벤트 큐 배출 순서다.
- [Claude 실행](../../src/runtime/claude/execution.ts)은 foreground query 하나를 소유하며, [승인 대기](../../src/runtime/claude/permissions.ts)는 결과·취소·해제마다 정리한다.
- [stdio 전송](../../src/runtime/transport.ts#L12)은 바이트 제한 JSON 행 해석, [RPC 요청](../../src/runtime/transport.ts#L93) 대기·timeout, [EOF·프로세스 종료 정리](../../src/runtime/transport.ts#L142)를 맡는다. [이력 조회](../../src/runtime/codex/history.ts#L32)는 조회별 페이지 예산과 항목·메타데이터 상한을 유지한다.
- [실행 파일 선택](../../src/runtime/codex/executable.ts)은 설정 경로 또는 PATH를 순서대로 조사한다. 현재 책임이 좁아 별도 추출 대상으로 삼지 않는다.

## 문제와 바로 적용할 정리

- Codex의 open 분기에서 요청 변수와 준비 완료·큐 배출 순서를 명확하게 썼다. 새 thread와 재개 thread는 Session 생성 시점이 다르므로 분기 자체와 기존 await 위치를 유지했다.
- 관측된 실행 소유권 검사와 충돌 결과의 읽기 전용 재검증을 비공개 메소드로 추출했고, 후속 분리에서 [CodexReconciliation](../../src/runtime/codex/reconciliation.ts)으로 옮겼다. 이력 대조의 pending start 일치·소유권 검사·최종 본문·완료·baseline 적용 순서와 조건식의 단락 평가를 유지했다.
- Claude의 도구 승인 콜백과 승인 대기 기록을 구분한 뒤 [권한 대기 모듈](../../src/runtime/claude/permissions.ts)로 옮겼다. callback은 기존 async 함수로 유지하고, Promise 생성·abort 구독·Session 기록을 동기적으로 시작해 기존 응답 시점을 보존한다. 결과와 advisory 분기는 switch로 드러냈다.
- RPC의 [응답 판정](../../src/runtime/transport.ts#L117)과 [종료 정리](../../src/runtime/transport.ts#L142)를 조기 반환으로 정리하고, 프로세스 EOF 전달·강제 종료 대기를 같은 클래스의 메소드로 분리했다. timeout·종료 유예·버퍼 초기 크기·이력 페이지 크기에 이름을 붙였으며 기존 값과 자료구조·조회 횟수는 유지했다.

앞선 내부 정리에서는 추가 파일 분리를 보류했다. 이후 사용자 요청에 따라 프로토콜 처리·연결 세대와 복구 타이머·이력 대조 상태의 소유자를 구분해 위 구조를 적용했다.

## 검증 결과와 미확인 범위

- `npx tsx --test tests/transport.test.ts tests/codex-history.test.ts tests/integration.test.ts tests/claude-execution.test.ts tests/captured.test.ts tests/state.test.ts`: 56개 통과. UTF-8/프레임·실제 stdio EOF·요청 응답·event-before-response·paged 복구·pending start·소유권·승인 철회·interrupt/result 경합을 확인했다.
- `npm run typecheck`와 담당 파일의 `git diff --check`가 통과했다. 변경 전후 diff에서 호출 횟수·await 위치·소유권 검사·입력 대기 정리 순서를 대조했다. 후속 구조 분리를 포함한 전체 필수 검사 결과는 [통합 기록](../readability-refactor.md)에 정리했다.
- 새 분할 모양을 고정하는 테스트는 추가하지 않았다. 실제 모델 호출과 Windows UI는 이 내부 정리의 검증에 포함하지 않았다.

## 런타임 폴더·공통 실행 계층·Claude 권한 분리 검증

- `npm run check`: 타입 검사·147개 테스트·확장/C# 빌드 통과. 기존 캡처 메시지·SDK callback·interrupt/result 경합·이력 복구·소유권·추가 Provider 계약을 유지했다.
- 새 [Claude 권한 경계 테스트](../../tests/claude-permissions.test.ts) 4개로 응답·일괄 거절 후 abort listener 해제, 중복/과대/상한 초과 요청, 이미 철회된 요청의 무기록 거절, 응답 checkpoint 실패 시 SDK에 거절 반환을 확인했다. Provider factory 테스트는 두 실행체의 공통 추상 클래스 사용도 확인한다.
- 최종 `node scripts/extension-host.mjs`: VS Code 1.143.1의 격리 프로필에서 전체 명령 등록·stopFlash/diagnostics·fixture 완료·취소·해제·자동 관찰 설정 전환이 통과했다. `nativeBound`도 true였다. 원자료는 로컬 `test-artifacts/extension-host.json`이다.
- runtime 하위 디렉터리는 codex·claude 두 개이며 22개 런타임 모듈의 상대 import와 순환 의존을 확인했다. 문서 상대 링크와 `git diff --check`도 확인했다. 실제 모델 호출·승인/질문 UI 조작·Windows 배너 클릭·사용자 설치본 교체는 수행하지 않았다.
