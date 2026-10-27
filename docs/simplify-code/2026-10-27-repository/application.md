# 세션·core·VS Code UI 코드 단순화

- 기준: 2026-10-27, `33f0e4f`와 최초 변경 없는 작업 트리.
- 흐름과 계약: [확장 진입점](../../../src/extension.ts) → [Application 조립·상태 표시](../../../src/vscode/application.ts) → [세션 수명](../../../src/application/sessions.ts)·런타임·알림. 명령 ID, API snapshot/test 모양, 소유권과 저장·알림·종료 순서, 설정 적용과 입력 UI를 보존한다.
- 검토 범위: `src/core/`의 [model](../../../src/core/model.ts)·[Session](../../../src/core/session.ts)·[Ownership/Lease](../../../src/core/ownership.ts)·[Notifications](../../../src/core/notifications.ts), `src/vscode/`의 [commands](../../../src/vscode/commands.ts)·[interaction](../../../src/vscode/interaction.ts)·[notifications](../../../src/vscode/notifications.ts)·[results](../../../src/vscode/results.ts)·[window](../../../src/vscode/window.ts), [manifest와 검사 명령](../../../package.json), [기존 책임 분리 기록](../../readability-analysis/application.md), [세션 경계 테스트](../../../tests/application-sessions.test.ts)·[상태 테스트](../../../tests/state.test.ts)·[소유권 테스트](../../../tests/ownership.test.ts)·[stdio 통합 테스트](../../../tests/integration.test.ts)·[Extension Host 검사](../../../tests/extension-host.ts)를 확인했다.

## 후보 현황

| ID | 상태 | 대상 | 판단 요약 | 검증 |
| --- | --- | --- | --- | --- |
| APP-01 | 적용 완료 | [Application.activate](../../../src/vscode/application.ts) | `updateStatus()` 직전의 `status.command` 대입은 같은 동기 흐름에서 반드시 덮어쓰므로 제거했다. | 관련 기존 테스트 50개, 타입 검사, diff 검사 통과 |
| APP-02 | 유지 | [ApplicationSessions 정리 경로](../../../src/application/sessions.ts) | 실패한 open의 진단·최초 오류 보존과 detach의 오류 전파가 달라 하나의 공통 정리 함수로 합치지 않는다. | 기존 세션 수명 경계 17개를 포함한 관련 50개 테스트 통과 |
| APP-03 | 유지 | [Session bounded 상태](../../../src/core/session.ts)·[Ownership](../../../src/core/ownership.ts)·[UI 모듈](../../../src/vscode/application.ts) | 중복 제거 상한·durable 저장·토큰 재검사·파일 gate와 UI 책임 경계는 현재 계약을 지킨다. 실제 미사용 private 값은 컴파일러 검사에서 발견되지 않았다. | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`, 로컬 tsc 직접 실행 모두 통과 |

## APP-01 — 상태 표시 명령의 중복 초기 대입 제거

- 현재 문제와 근거: `activate()`는 `status.command = 'jobFinish.results'`를 실행한 직후 `updateStatus()`를 호출한다. `updateStatus()`는 모든 정상 분기에서 대기 요청 수에 맞춰 `jobFinish.respond` 또는 `jobFinish.results`를 다시 대입한다. 상태 표시줄을 처음 표시하는 `show()`도 그 뒤에 있다.
- 변경 전후: 중복 초기 대입 한 줄을 제거하고 명령 선택은 기존 `updateStatus()`에 맡긴다. 파일·책임·호출부와 API는 그대로다.
- 분류 근거: 사용되기 전에 덮어쓰는 지역 초기화 제거에 해당하는 작은 변경이다. 명령 등록·비동기 경계·표시 시점·설정 조회 횟수를 바꾸지 않는다.
- 보존 조건과 트레이드오프: 입력 대기가 있으면 응답 명령, 없으면 결과 명령으로 이어지는 기존 상태 표시 동작을 유지한다. 시간·공간복잡도는 전후 동일하며 성능 개선을 주장하지 않는다.
- 검증: `node node_modules/tsx/dist/cli.mjs --test tests/application-sessions.test.ts tests/ownership.test.ts tests/state.test.ts tests/integration.test.ts`의 기존 50개 테스트가 모두 통과했다. `npm run typecheck`와 담당 파일 `git diff --check`도 통과했다. dead-write 제거는 제어 흐름으로 확인했고 모양을 고정하는 새 테스트는 추가하지 않았다. 실제 상태 표시줄 클릭·질문 UI·모델 호출은 이 영역 검사에 포함하지 않는다.
- 승인·적용: 스킬이 허용한 작은 변경 범위에서 적용 완료했으며 큰 변경 제안은 없다.

## 유지 근거

- APP-02: `cleanupOpening()`은 dispose/release 오류를 각각 진단하고 최초 open 오류를 유지한다. `detach()`는 finally로 lease와 콜백 정리를 보장하면서 오류를 호출자에게 전달한다. 동일한 자원을 다룬다는 이유로 합치면 오류 계약과 정리 순서가 더 숨겨진다.
- APP-03: 완료 중복 제거와 입력 요청 상한, checkpoint 저장 후 알림 전달, 연결/lease 소유권 재확인, `readResult`의 지연 조회와 공개 test API는 테스트와 제품 경로에서 사용된다. 같은 모양의 상한 루프나 한 줄 전달도 해당 정책과 책임을 드러내므로 유지했다. 파일 통합·알고리즘 교체를 정당화하는 문제가 이 범위에서 확인되지 않았다.
