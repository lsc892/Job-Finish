# 확장 진입점·UI·알림과 세션 수명 분리

세션 수명 분리(W1)에 이어 사용자 요청으로 `extension.ts`의 명령·입력·결과·알림·창 처리를 책임별 파일로 분리했다. 현재 세션 모듈 배치는 [2026-11-03의 폴더 분리 결정](#sessions-modules-2026-11-03)을 따른다.

<a id="consolidation-2026-11-02"></a>

## 2026-11-02 — 사용자: 단일 사용 단계 통합

- **의사결정**: 세션 수명과 VS Code 조립 책임은 유지하고 한 번만 쓰는 연결 조건·실행 인자 구성·저장 목록 갱신·명시적 해제 마무리를 해당 진입점으로 통합한다. 짧은 진단·flash·클릭 정책 콜백도 등록 위치에서 읽는다.
- **근거**: `open()`·`detach()`의 앞뒤 처리와 오류 전파를 파악하는 데 여러 보조 메소드를 오갈 필요가 없도록 한다. 조기 등록·최초 오류 보존·자원 정체성 확인은 재사용되는 수명 규칙이므로 유지한다. 200줄을 넘는 `ApplicationSessions`도 실행·Session·lease의 한 수명을 소유하므로 파일을 더 나누지 않는다.
- **결과**: 공개 API·소유권·상한·저장 형식과 연결/저장 중 종료·이중 정리 실패의 동작을 유지했다. 전체 193개 테스트, 타입 검사·빌드와 격리 Extension Host의 완료·취소·해제·설정 전환·native 바인딩 검증이 통과했다. 공통 기준과 검증 범위는 [전체 통합 기록](../readability-refactor.md#consolidation-2026-11-02)을 따른다.

## 적용한 책임 경계

| 위치 | 소유하는 책임 |
| --- | --- |
| [extension.ts](../../src/extension.ts) | 로컬 Windows 지원 확인, activate·deactivate 진입점 |
| [Application](../../src/vscode/application.ts) | 객체 조립과 구독 등록, 공개 API, 진단 출력·상태 표시, 전체 종료 순서 |
| [SessionCommands](../../src/vscode/commands.ts) | 명령 ID 등록, 실행·재개·세션 선택·입력 응답 조율, 세션별 명령 중복 실행 방지 |
| [AgentInput](../../src/vscode/interaction.ts) | 작업·경로 입력, 승인 전문 표시와 승인 선택, 질문의 단일·복수·비밀·자유 입력 |
| [showResults](../../src/vscode/results.ts) | 최근 결과 선택, 잘린 본문 조회·실패 안내, 결과 문서 표시 |
| [WindowNotifications](../../src/vscode/notifications.ts) | 자동 관찰자·toast·창 자원 수명, 신호 소유권 분기·전달, 설정 적용 |
| [CodeWindow](../../src/vscode/window.ts) | native 창 식별·포커스 관찰·바인딩과 flash |
| [ApplicationSessions](../../src/application/sessions/index.ts) | entries·연결 중 작업, 신뢰·연결 상한·중복 확인, 저장 세션, 해제·dispose 조율 |
| [SessionResources](../../src/application/sessions/resources.ts) | 연결 하나의 실행·Session·lease 생성과 조기 등록, 활성 확인, 명시적 해제·실패 정리 |
| [ApplicationSessionPorts](../../src/application/sessions/types.ts) | Provider·설정·신뢰·lease 획득·저장소·signal·상태·알림 종료의 주입 계약과 공개 세션 타입 |

```text
src/extension.ts                       활성화·해제
src/vscode/application.ts              객체 조립·API·상태·구독
src/vscode/commands.ts                 명령과 세션 선택
src/vscode/interaction.ts              작업·승인·질문 입력
src/vscode/results.ts                  결과 표시
src/vscode/notifications.ts            관찰·신호·알림·설정
src/vscode/window.ts                   창 식별·포커스·flash
src/application/sessions/index.ts      세션 목록·연결·저장·종료 조율
src/application/sessions/resources.ts  개별 실행·Session·lease 수명
src/application/sessions/types.ts      공개 타입·주입 계약
```

의존 방향은 진입점 → VS Code 조립부·UI → 세션 수명·runtime/core/windows다. 세션 내부는 `ApplicationSessions` → `SessionResources` → runtime/core로 이어지고, 자원 객체는 활성 여부·등록·제거 콜백만 받으며 조율부를 import하지 않는다. UI·알림·창 모듈은 `Application`을 import하지 않고 필요한 서비스나 콜백을 받는다. 명령은 입력 UI를 사용하고, 알림은 `CodeWindow`와 observer·toast를 소유한다. 세션 모듈은 `vscode`를 가져오지 않고 lease의 저장 위치나 HWND·flash를 알지 못한다. [조립부](../../src/vscode/application.ts)가 Ownership·workspaceState·Provider와 콜백을 연결한다.

## 보존한 실행·UI 계약

- [open](../../src/application/sessions/index.ts)은 신뢰·상한·중복 확인 → Provider 선택 → 연결 중 등록 → 실행 생성 → 연결 완료 → 저장 목록 갱신 → 상태 갱신 순서를 따른다. 상한 계산은 기존의 `entries.size + opening`을 그대로 유지하며, 연결 중 Set의 크기로 기존 카운터를 대체했다. 완료·실패 모두 finally에서 해당 연결 중 작업을 제거한다.
- [createSession](../../src/application/sessions/resources.ts)은 lease 획득·checkpoint 로드·Session 구성 후, execution이 이미 반환된 비동기 open에서는 entries에 즉시 등록한다. Codex의 연결 완료 전 재조정 결과가 소유권을 확인할 수 있다. 동기 Claude factory는 Session을 만든 뒤 execution을 반환하며, factory 내부의 생성 시점에는 완성 Entry가 없다는 기존 경계를 유지했다. constructor에서 연결 이벤트를 시작하는 방식으로 계약을 넓히지 않았다.
- [snapshot·test API](../../src/vscode/application.ts)의 반환 모양, [명령 ID·세션 선택·재개·응답](../../src/vscode/commands.ts), [결과 조회](../../src/vscode/results.ts)와 상태 표시를 유지했다. 세션 수명 객체가 lease를 내부에 보관하며 UI는 목록과 실행·Session만 읽는다.
- [detach](../../src/application/sessions/index.ts)는 실행 정리 → lease 해제 → 등록 제거·flash 종료 순서와 중첩 finally의 정리를 유지한다. 실패한 open은 실행 정리 → 등록 제거 → lease 해제 순서다. 저장 목록은 sessionId 중복을 제거하고 최신 32개를 유지한다.
- [flash·toast 전달](../../src/vscode/notifications.ts)과 [창 이벤트](../../src/vscode/window.ts)를 분리하되 focused 관찰과 HWND 검증을 유지했다. 비활성화 시 observer → flash → toast, 전체 종료 시 observer → flash·identity → toast → sessions 순서로 정리한다. 명령 오류는 진단과 오류 알림에 기록하고 finally에서 상태를 갱신하며, 세션별 busy 상태도 finally에서 해제한다.
- [입력 UI](../../src/vscode/interaction.ts)는 Provider의 기존 `AgentInteraction` 계약을 구현한다. 승인 전문 표시 후 승인 선택, 비밀 입력 시 선택지를 표시하지 않는 규칙, 취소 시 응답 생략, 단일·복수·자유 입력의 기존 반환 형식을 유지한다.

## 종료·실패 처리의 최소 보완

수명을 맡은 객체가 생성 중 자원까지 정리하도록 다음 경로를 보완했다.

1. **연결·저장 중 dispose**: 기존 확장은 entries만 순회해서 등록 전 execution을 정리하지 못하거나, 저장 대기 뒤 open이 늦게 성공할 수 있었다. 이제 연결 중 레코드가 execution·lease를 소유하고 [dispose](../../src/application/sessions/index.ts)가 등록 전·후 자원을 함께 정리한다. 종료한 작업은 다음 continuation에서 거부되어 등록이나 성공 반환을 하지 않는다. 실행·lease는 반복 정리하지 않는다. 이미 시작한 workspaceState 저장 자체를 취소하거나 롤백하지는 않는다.
2. **실패 정리 중 dispose 오류**: 기존 open의 catch는 execution.dispose가 던지면 등록 제거·lease 해제가 생략되고 최초 오류가 바뀔 수 있었다. [cleanupOpening](../../src/application/sessions/resources.ts)은 정리 오류를 진단에 남기고 나머지 정리를 계속하며 호출자에게 최초 open 오류를 전달한다. claim 성공 후 checkpoint load·Session 구성에서 실패해도 같은 경계를 사용한다.
3. **오래된 Entry의 해제**: 같은 sessionId를 다시 연결한 뒤 이전 picker가 가진 Entry를 해제하면 새 자원을 닫지 않도록 현재 Entry 정체성을 확인한다. 조기 등록과 open 완료는 같은 자원의 Entry를 재사용한다.

세션 종료 이후 새 open도 거부한다. 정상 실행의 프로토콜·알림 판정·저장 형식이나 질문 UI 알고리즘은 변경하지 않았다.

## 세션 수명 분리 당시 검증

- [신규 경계 검사](../../tests/application-sessions.test.ts#L68) 17개 통과: 비동기 초기 결과의 소유권, 동기 factory 경계·snapshot·대기 수·저장 상한, maxSessions/maxConnections의 동시 open과 실패 후 용량 반환, 신뢰 검사, claim/load/factory/open/save/Session 누락 실패, dispose 오류 후 정리, 등록 전·후와 저장 중 dispose, 반복 dispose와 detach의 finally 정리, 오래된 Entry의 새 연결 해제 방지.
- `npx tsx --test tests/application-sessions.test.ts tests/integration.test.ts tests/ownership.test.ts tests/providers.test.ts`: 최종 코드에서 총 41개 통과. 기존 실제 stdio fixture·paged 복구·승인·소유권·Provider 계약도 함께 확인했다.
- `npm run typecheck`와 담당 파일의 `git diff --check`가 통과했다. 통합 후 최종 `npm run check`의 타입 검사·134개 테스트·확장/C# 빌드도 모두 통과했다.
- 최종 빌드의 `node tests/vscode/extension-host.mjs`와 `node tests/vscode/extension-host.mjs --dual`이 통과했다. 단일 창의 명령 등록·fixture 실행 완료·취소·해제·자동 관찰 설정 전환, 두 창의 결과 분리·같은 세션의 두 번째 소유자 거부를 확인했다. 두 창의 native flash·포커스 복귀는 OS 전경 전환 거부로 SKIPPED다. 원자료는 로컬 `test-artifacts/extension-host.json`과 `test-artifacts/dual-host.json`에 있다.
- 앞선 파일 내부 정리 당시 루트 check의 106개 테스트·확장/C# 빌드와 단일 격리 Extension Host 검사는 통과했으나, 그 결과를 이번 W1 구조 분리의 검증으로 대체하지 않는다.
- 실제 모델 호출·질문 UI 조작·Windows 배너 클릭과 기본 VS Code 설치는 이 담당 검증에 포함하지 않았다. W1의 미적용 구조 제안은 남지 않았다.

## 후속 진입점·UI·알림 분리 검증

- `npm run check`: 기존 테스트와 Codex 경계 테스트를 합한 143개, 타입 검사·확장/C# 빌드가 통과했다.
- Extension Host 검사는 제품 API와 명령 등록, fixture 완료·취소·해제, 자동 관찰 설정 끄기·켜기를 확인한다. 모든 공개 명령 등록과 `stopFlash`·`diagnostics` 실행도 확인하도록 보강했다. 최종 단일·이중 창 결과와 미확인 범위는 [통합 기록](../readability-refactor.md)에 기록한다.

## 변경 일지

### 2026-11-03 — 사용자

<a id="sessions-modules-2026-11-03"></a>

#### 세션 조율·개별 자원·계약의 모듈 분리

- **의사결정**: `application/sessions.ts`를 책임별 스크립트로 나눈다. Codex는 `sessions/index.ts`에 공개 진입점과 세션 목록·연결 상한·저장·전체 종료 조율을, `resources.ts`의 `SessionResources`에 개별 실행·Session·lease의 생성·조기 등록·활성 확인·해제·실패 정리를, `types.ts`에 공개 타입과 주입 계약을 배치했다. 2026-11-02의 단일 파일 유지 판단은 이번 분리 결정으로 대체한다.
- **근거**: 창 전체의 연결 정책과 연결 하나의 자원 수명을 서로 다른 소유자에서 읽을 수 있어야 한다. 자원 객체는 조율부의 필드나 구현을 import하지 않고 활성 여부·등록·제거 콜백을 받는다. 명시적 해제의 오류 전파·lease 해제 후 등록 제거와 실패한 open의 최초 오류 보존·등록 제거 후 lease 해제는 서로 다른 경로로 유지한다.
- **결과**: 기존 `application/sessions` import와 공개 API·타입, 동기 factory와 비동기 open의 등록 시점, Entry 재사용·자원 정체성 확인, 신뢰·상한·중복 확인 순서, 저장 대기 위치와 최신 32개 형식, 종료·실패 시 자원 초기화·오류 우선순위를 유지했다. 분리 전 세션 테스트 19개와 분리 후 관련 테스트 46개가 통과했다. 저장 중 해제한 연결의 늦은 실패 정리가 같은 ID의 새 연결·lease를 지우거나 중복 해제하지 않는 회귀 테스트 1개를 추가했고 최종 타입 검사·전체 194개 테스트·`git diff --check`가 통과했다. 통합 검사는 기존 stdio fixture·테스트 자식 프로세스를 사용했으며 확장 빌드·Extension Host UI·실제 모델 호출·설치는 수행하지 않았다.

### 2026-11-02 — 사용자

<a id="sessions-readability-2026-11-02"></a>

#### 세션 연결·저장·해제 흐름의 가독성 개선

- **의사결정**: `ApplicationSessions`의 공개 API와 자원 소유권을 유지하며 내부 단계를 구분한다. Codex는 `assertCanOpen()`에 기존 연결 조건을, `createExecution()`에 제공자 실행 문맥 구성을, `saveSession()`에 저장 목록 갱신을, `finishDetach()`에 lease 해제와 등록 제거·종료 통지를 모았다. 공개 조회·연결·해제·종료 메소드를 앞에 두고 타입·snapshot·Session 생성 인자와 정리 코드를 풀어 썼다.
- **근거**: `open()`에서 연결의 진행 순서와 옵션·목록 구성이 섞여 있었고, 중첩된 한 줄 `try/finally`는 해제 중 오류가 발생해도 반드시 수행할 정리를 숨겼다. 실패한 open은 실행 정리 → 등록 제거 → lease 해제를 수행하며 정리 오류를 기록하고 최초 오류를 보존한다. 명시적 detach는 실행 정리 → lease 해제 → 등록 제거·종료 통지 순서로 오류를 전파하므로 두 경로를 공통 정리 함수로 합치지 않는다.
- **결과**: 신뢰·용량·중복 검증 순서, 비동기 open의 초기 소유권 등록과 Entry 재사용, 저장 목록의 sessionId 중복 제거·최신 32개 상한, 연결/저장 뒤 활성 재검사와 기존 await 위치를 유지했다. 분리한 저장 메소드는 저장소의 PromiseLike를 그대로 반환하며 추가 비동기 대기를 만들지 않는다. 변경 전 기존 세션 테스트 17개가 통과했고, 실행 정리·lease 해제의 이중 실패에서 최초 연결 오류·진단 순서 보존과 detach의 오류 우선순위·자원 초기화·등록 제거·종료 통지·중복 정리 방지를 검사하는 회귀 테스트 2개를 추가해 변경 전후 세션 테스트 19개도 통과했다. 최종 `npm run typecheck`, `npm exec -- tsx --test tests/application-sessions.test.ts tests/integration.test.ts tests/ownership.test.ts tests/providers.test.ts`의 46개 테스트, `git diff --check`가 통과했다. 통합 검사는 기존 stdio fixture와 테스트용 자식 프로세스를 사용했으며, 확장 빌드·Extension Host UI·실제 모델 호출·설치는 수행하지 않았다.
