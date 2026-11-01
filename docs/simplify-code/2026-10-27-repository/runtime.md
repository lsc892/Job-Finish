# 런타임 코드 단순화

- 기준: 2026-10-27, `33f0e4f`의 깨끗한 작업 트리에서 검토했다.
- 흐름과 계약: [Provider 등록](../../../src/runtime/providers.ts) → [관찰](../../../src/runtime/observe.ts)·[이벤트 라우터](../../../src/runtime/event-router.ts) 또는 [Codex 실행](../../../src/runtime/codex/execution.ts)·[Claude 실행](../../../src/runtime/claude/execution.ts) → Session 갱신이다. 프로토콜·세대별 큐와 캐시·소유권·재접속·입력 철회와 취소 순서를 보존한다.
- 검토 범위: `src/runtime/`의 22개 수작업 모듈, [Provider 확장 계약](../../agent-providers.md), 앞선 [관측](../../readability-analysis/runtime.md)·[실행 책임 기록](../../readability-analysis/execution.md), 관련 기존 테스트를 읽었다. 생성된 `src/protocol/`은 수정하지 않는다. 실제 모델 서비스·공식 확장 UI는 미검증 범위다.

## 후보 현황

| ID | 상태 | 대상 | 판단 요약 | 검증 |
| --- | --- | --- | --- | --- |
| RUN-01 | 적용 완료 | [EventQueue](../../../src/runtime/transport.ts) | 읽지 않는 항목별 바이트 값과 메시지를 담기만 하는 비공개 항목 래퍼 제거 | 기존 큐 상한·순서·연결 준비 테스트 통과 |
| RUN-02 | 적용 완료 | [StdioRpc.write](../../../src/runtime/transport.ts) | 같은 문자열 바이트 길이를 지역 값으로 한 번 계산 | 기존 전송·UTF-8·실제 stdio 테스트 통과 |
| RUN-03 | 적용 완료 | [CodexConnection.replayAnswer](../../../src/runtime/codex/connection.ts) | 같은 RPC ID의 JSON 직렬화 결과를 재사용 | 기존 재전송 상한·세대 초기화 테스트 통과 |
| RUN-04 | 유지 | [공통 실행](../../../src/runtime/execution.ts), [Codex index](../../../src/runtime/codex/index.ts), [Claude index](../../../src/runtime/claude/index.ts) | 실행 소유권 검증과 공개 import 호환성을 담당하므로 통합·삭제하지 않음 | Provider 및 기존 실행 테스트 통과 |

## RUN-01 — 읽지 않는 큐 항목 메타데이터와 래퍼 제거

- 현재 문제와 근거: 큐의 `push()`는 항목마다 `{ message, bytes }`를 저장하지만 `drain()`은 `message`만 읽고 전체 바이트는 별도 `this.bytes`로 관리한다. 개별 `bytes`와 이를 위한 항목 래퍼는 소비자가 없다.
- 변경 전후: 비공개 배열에 `RpcMessage` 참조를 직접 저장하고 그대로 순회한다. 동일한 배열 자료구조, FIFO 순서, `clear()`로 기존 배열을 분리한 뒤 callback을 실행하는 재진입 동작은 유지한다. 공개 메소드·호출부·파일 경계는 바뀌지 않는다.
- 분류 근거: 읽지 않는 내부 항목 필드와 전달용 래퍼 제거다. 탐색·집계·큐 알고리즘과 메시지 정체성, 상한은 바뀌지 않는 작은 정리다.
- 보존 조건과 비용: push에서 직렬화와 바이트 합산·개수/바이트 검사 순서를 보존한다. n개 항목의 drain은 전후 O(n), 보조 저장 공간은 O(n)이며 항목 래퍼 할당만 사라진다. 속도 향상을 주장하지 않으며 알고리즘 교체가 아니므로 벤치마크를 강제하지 않는다.
- 검증·적용: 작은 내부 표현 정리로 적용했다. 기존 [전송](../../../tests/transport.test.ts)·[연결](../../../tests/codex-connection.test.ts) 테스트의 상한·FIFO·준비 전 큐 배출·세대 초기화가 통과했다. diff에서 `clear()` 호출과 callback 순서·메시지 참조 보존을 확인했다.

## RUN-02 — 송신 바이트 길이의 중복 계산 제거

- 현재 문제와 근거: `write()`에서 같은 `data` 문자열에 `Buffer.byteLength()`를 최대 두 번 호출한다.
- 변경 전후: 직렬화 뒤 `const bytes`를 계산하고 메시지 크기와 출력 버퍼 크기 검사에서 공유한다. 검사 단락 평가·오류 문구·실제 stdin write 시점은 유지한다.
- 분류 근거와 비용: 부수효과 없는 동일 계산을 지역 값으로 공유하는 작은 정리다. 문자열 길이 m에 대해 시간 O(m), 보조 공간 O(1)은 전후 동일하다. 두 번째 문자열 순회를 없애지만 실측 속도 개선은 주장하지 않는다.
- 검증·적용: 지역 중복 계산 정리로 적용했다. 기존 [전송 테스트](../../../tests/transport.test.ts)의 UTF-8·프레임·실제 stdio 검사와 타입검사가 통과했다.

## RUN-03 — 응답 재전송 ID 변환 결과 재사용

- 현재 문제와 근거: 응답 캐시의 `has()`와 `get()`에서 같은 string/number ID를 각각 `JSON.stringify()`한다.
- 변경 전후: undefined ID·method의 조기 반환 뒤 직렬화한 `requestId`를 두 조회에 사용한다. `has()` 검사는 유지해 저장된 undefined 결과와 캐시 누락을 구분한다.
- 분류 근거와 보존 조건: 지역 중복 변환 제거이며 캐시 정책·순서·크기·세대 경계와 실제 RPC 응답 횟수는 유지한다.
- 비용: ID의 직렬화 길이를 k라 할 때 변환 시간·임시 문자열 공간은 전후 O(k)다. 일치한 캐시 조회에서 두 번째 직렬화만 생략하며 별도 성능 측정은 하지 않았다.
- 검증·적용: 지역 중복 변환 정리로 적용했다. 기존 [연결 테스트](../../../tests/codex-connection.test.ts)의 응답 재전송 개수/바이트 상한·세대 초기화와 타입검사가 통과했다.

## 실제 검증

- `npx tsx --test tests/transport.test.ts tests/codex-connection.test.ts tests/codex-history.test.ts tests/codex-reconciliation.test.ts tests/claude-execution.test.ts tests/claude-permissions.test.ts tests/captured.test.ts tests/event-router.test.ts tests/observe.test.ts tests/providers.test.ts`: **63개 통과**, 실패·건너뜀 없음. 전송·복구·이력·프로토콜·승인과 취소 경합·원본 바이트 보존·추가 Provider 계약을 확인했다.
- `npm run typecheck`, `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`, 담당 경로의 `git diff --check`: 통과했다.
- 수정 소스는 `src/runtime/transport.ts`와 `src/runtime/codex/connection.ts`다. 기존 테스트로 해당 계약을 검사할 수 있어 표현·함수 모양을 고정하는 새 테스트는 추가하지 않았다. 통합 빌드와 전체 검사는 메인의 통합 결과에 기록한다.

## 유지와 남은 확인

- 관찰용 `Frames`와 직접 실행용 `JsonLines`는 첫 불완전 프레임 허용과 오류 격리·RPC 검증 계약이 다르므로 통합하지 않는다.
- Provider와 AgentRuntime은 실제 확장·소유권 계약을 제공하고, 디렉터리 index는 기존 공개 import를 유지한다. 단순 전달처럼 보여도 제거하지 않는다.
- 이력 조회 예산과 스트림·이벤트 상한, pending permission·abort listener, 응답 캐시는 현재 메모리·재시도·취소 계약의 일부다. 이번 검토에서 교체 근거가 충분한 큰 알고리즘/구조 변경은 확인하지 못했다.
