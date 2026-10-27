# Readability 적용 결과와 구조 변경 기록

2026-10-27 기준. 세션 수명(W1)·toast 자원 수명(W2), Codex 직접 실행(C1)과 확장 진입점·UI(E1)에 이어 Codex·Claude 런타임 폴더와 공통 실행 계층(R2)을 정리했다. 기존 명령·snapshot/test API·Provider 계약·C# JSON/COM 계약은 유지했다.

## 적용 상태

| 후보 | 적용 결과 | 상세 기록 |
| --- | --- | --- |
| [W1](#w1) | 승인·적용 완료 — 실행·Session·lease와 연결 중 자원을 ApplicationSessions로 이동 | [확장·세션 수명](readability-analysis/application.md) |
| [W2](#w2) | 승인·적용 완료 — helper 실행기와 클릭 채널이 각 자원 수명을 소유 | [Windows](readability-analysis/windows.md#w2) |
| [R1](#r1) | 기존 Provider 구조로 충족 — 추가 분리 불필요 | [런타임 관측](readability-analysis/runtime.md#r1) |
| [C1](#c1) | 적용 완료 — Codex 프로토콜·연결·이력 대조의 책임과 상태 분리 | [직접 실행·전송](readability-analysis/execution.md) |
| [E1](#e1) | 적용 완료 — 확장 조립·명령·입력·결과·알림·창 관리 분리 | [확장·세션 수명](readability-analysis/application.md) |
| [R2](#r2) | 적용 완료 — 런타임별 폴더와 공통 실행 계층, Claude 권한 대기 분리 | [런타임 구조](agent-providers.md) |

검토안의 미적용 후보는 없다. 직접 실행·전송의 내부 정리와 후속 파일 분리 근거는 [실행·전송 기록](readability-analysis/execution.md)에 있다.

## 변경 전후 배치

```text
분리 전                              적용 후
src/                                 src/
  extension.ts                         extension.ts
                                       vscode/
                                         application.ts
                                         commands.ts
                                         interaction.ts
                                         results.ts
                                         notifications.ts
                                         window.ts
                                       application/
                                         sessions.ts
  windows/                             windows/
    toast.ts                             toast.ts
                                         toast-process.ts
                                         toast-activation.ts
  runtime/                             runtime/
    codex.ts                             codex/
    codex-history.ts                       index.ts · provider.ts · events.ts
                                          execution.ts · adapter.ts
                                          connection.ts · history.ts
                                          reconciliation.ts · executable.ts
    claude.ts                            claude/
                                          index.ts · provider.ts · events.ts
                                          execution.ts · adapter.ts
                                          permissions.ts
    agent-provider.ts                    agent-provider.ts
                                         execution.ts
    event-router.ts                      event-router.ts
    providers/                           providers.ts
      index.ts · codex.ts · claude.ts     message.ts
```

현재 파일: [확장 진입점](../src/extension.ts), [확장 조립부](../src/vscode/application.ts), [세션 수명](../src/application/sessions.ts#L34), [toast facade](../src/windows/toast.ts#L10), [helper 실행기](../src/windows/toast-process.ts#L12), [클릭 채널](../src/windows/toast-activation.ts#L16), [Provider 계약](../src/runtime/agent-provider.ts#L47), [등록 목록](../src/runtime/providers.ts).

<a id="w1"></a>

## W1 — 세션 수명 관리 분리: 적용 완료

[ApplicationSessions](../src/application/sessions.ts#L34)가 entries·연결 중 작업과 실행·Session·lease의 생성·조기 등록·저장·해제를 함께 소유한다. 확장은 설정·명령·창 이벤트·입력 UI를 조립하고, 목록·lookup·snapshot·소유권·open·detach·dispose API를 호출한다. 저장소·설정·Provider 조회·신호·상태 변경·해제 콜백은 주입하며 세션 수명 모듈은 VS Code에 의존하지 않는다.

의존 방향은 확장 → 세션 수명 → runtime/core다. Codex의 초기 복구 이벤트 전에 Session을 등록하며, 동기 factory의 Session 생성도 지원한다. 신뢰·두 상한·중복 검사, Provider 선택, 실행 생성·연결, 저장과 상태 갱신의 정상 순서를 유지했다.

수명 소유권 분리에 맞춰 종료·실패 경계도 보완했다. 연결 전·후와 저장 중 dispose가 실행·lease를 정리하고 늦은 open의 등록·성공 반환을 거부한다. 실패 정리에서 execution.dispose가 실패해도 등록 제거·lease 해제를 계속하며 최초 오류를 보존한다. 이전 선택창의 Entry로 같은 ID의 새 연결을 해제하지 않도록 자원 정체성을 확인하고 조기 등록 Entry는 재사용한다.

[세션 경계 테스트](../tests/application-sessions.test.ts)는 17개다. 초기 이벤트의 소유권·동기 생성·동시 상한·claim/load/factory/open/save 실패·Session 누락·dispose 실패·연결/저장 중 종료·중복 정리·이전 Entry를 검증한다. 기존 [소유권](../tests/ownership.test.ts#L13)과 [직접 실행 통합 테스트](../tests/integration.test.ts#L20)도 유지한다.

<a id="w2"></a>

## W2 — toast 프로세스와 클릭 채널 분리: 적용 완료

[WindowsToast](../src/windows/toast.ts#L10)는 등록 Promise·세대·현재 알림 선택과 교체·stop·dispose를 조율한다. [ToastProcessRunner](../src/windows/toast-process.ts#L12)는 helper별 입출력·진단·timeout·close 판정과 완료 Promise·취소 핸들·전체 child 집합을 소유한다. [ToastActivation](../src/windows/toast-activation.ts#L16)은 pipe·socket·만료 타이머와 승인 socket·클릭·결과의 1회 처리 상태를 소유한다.

의존 방향은 facade → process/activation이며 하위 객체가 facade나 서로를 import하지 않는다. 현재 알림 판정과 만료는 콜백으로 연결한다. 기존 `ToastRequest`·`ToastTarget`·`ToastProcessPorts`의 import 경로는 facade의 type 재export로 유지했다.

등록 공유와 실패 후 재시도, 등록 뒤 generation·설정 재검사, 전송 종료 후 클릭 pipe 유지, 교체 시 이전 show 대기 해소와 자원 정리 순서를 유지했다. helper 완료는 stdout/stderr가 배출된 `close`에서 판정하고 기존 Promise 체인에 바로 연결한다. 기존 timeout·크기·개수 상한과 C# JSON·COM 계약은 바꾸지 않았다.

새 경계 테스트는 11개다. [프로세스](../tests/toast-process.test.ts)는 close 대기·부분 JSON·잘못된/초과 진단·15초 timeout·개별/전체 취소·동기 launch 실패를, [클릭 채널](../tests/toast-activation.test.ts)은 4소켓 상한·실제 5초 idle timeout·가상 5분 만료·현재 소유권을 검사한다. [전달 중 교체·stop·dispose](../tests/toast.test.ts#L186)와 기존 전송 뒤 클릭·중복 억제·등록 경합 검증도 통과했다.

<a id="r1"></a>

## R1 — 공급자별 관찰 이벤트 처리: 기존 Provider 구조로 충족

10월 24일 제안은 공급자 전용 상태·프로토콜을 공통 라우터에서 분리하는 것이었다. 현재 [공통 라우터](../src/runtime/event-router.ts#L11)는 `AgentProvider.createEvents`로 연결별 처리기를 선택하고, [CodexProvider](../src/runtime/codex/provider.ts)와 [ClaudeProvider](../src/runtime/claude/provider.ts)가 전용 상태·프로토콜을 소유한다.

이 구조는 이번 리팩토링 전에 구현되어 있었다. 과거 예정 경로 `runtime/events/codex.ts`·`claude.ts`는 중복 생성하지 않았다. 이번에는 같은 파일 안의 처리 단계와 상태 이름을 정리했다.

<a id="c1"></a>

## C1 — Codex 프로토콜·연결·이력 대조 분리

[CodexExecution](../src/runtime/codex/execution.ts)은 thread·turn 명령을 조율한다. [CodexAdapter](../src/runtime/codex/adapter.ts)는 프로토콜에서 Session으로의 변환, [CodexConnection](../src/runtime/codex/connection.ts)은 stdio·준비 전 큐·응답 캐시·재접속 Promise·타이머, [CodexReconciliation](../src/runtime/codex/reconciliation.ts)은 이력 대조·관측된 실행 검증·충돌 재검증을 맡는다. 하위 모듈은 facade를 import하지 않고 현재 연결 판정과 복구·메시지 콜백으로 연결된다. 기존 facade의 adapter·상태·승인 응답 export는 유지했다.

새 [연결](../tests/codex-connection.test.ts) 5개·[이력 대조](../tests/codex-reconciliation.test.ts) 4개 경계 테스트로 큐 순서·캐시 상한과 세대·재접속 공유·1/2/4초 복구·dispose·조회 중 연결/소유권 상실·관측하지 않은 활성 실행·충돌 중복을 확인했다. 상세는 [직접 실행 기록](readability-analysis/execution.md)에 있다.

<a id="e1"></a>

## E1 — 확장 진입점·명령·UI·알림·창 관리 분리

[extension.ts](../src/extension.ts)는 지원 환경 확인과 activate·deactivate만 담당한다. [Application](../src/vscode/application.ts)은 객체 조립·공개 API·구독·진단·상태 표시를, [SessionCommands](../src/vscode/commands.ts)는 명령과 세션별 busy 상태를, [AgentInput](../src/vscode/interaction.ts)은 입력·승인·질문을, [showResults](../src/vscode/results.ts)는 결과 선택과 본문 표시를 맡는다. [WindowNotifications](../src/vscode/notifications.ts)가 observer·toast와 [CodeWindow](../src/vscode/window.ts)를 소유하고 설정·신호 전달을 조율하며, CodeWindow는 native 창 식별·포커스·flash를 담당한다.

하위 모듈은 Application을 import하지 않는다. 세션 수명은 계속 VS Code에 의존하지 않는다. 명령 ID·입력 형식·snapshot/test API·저장 형식·알림 정책과 종료 순서는 유지했다. 상세는 [확장 기록](readability-analysis/application.md)에 있다.

<a id="r2"></a>

## R2 — Codex·Claude 런타임 폴더와 공통 실행 계층

각 런타임의 `provider.ts`·`events.ts`·`execution.ts`·`adapter.ts`를 `runtime/codex/`와 `runtime/claude/` 아래에 모았다. 두 실행체는 [AgentRuntime](../src/runtime/execution.ts)을 상속해 소유권 검사를 공유하고 공통 옵션·구조적 실행 계약을 사용한다. [providers.ts](../src/runtime/providers.ts) 한 곳에서 등록하며, 기존 디렉터리 import는 각 `index.ts`에서 제공한다. 폴더 간 직접 의존과 모듈 순환은 없다.

Claude의 pending 콜백·abort listener·응답과 일괄 거절은 [ClaudePermissions](../src/runtime/claude/permissions.ts)가 소유한다. query·문맥·결과·취소 확인은 실행체에 남기며 결과 이후 대기 정리와 interrupt/result 경합 순서를 유지했다. 실행·권한 대기·관찰 처리기는 서로 다른 수명을 유지한다. 파일별 책임과 새 런타임 추가 절차는 [Provider 확장](agent-providers.md), 세부 판단과 검증은 [실행 기록](readability-analysis/execution.md)에 정리했다.

전체 타입 검사·147개 테스트·확장/C# 빌드와 최종 격리 Extension Host의 명령 등록·fixture 완료·취소·해제·자동 관찰 설정 전환이 통과했다. Claude 권한 경계 테스트 4개를 추가했으며 runtime의 두 폴더와 22개 모듈의 상대 import·순환 의존도 확인했다. 실제 모델 호출·승인/질문 UI·배너 클릭·사용자 설치본 교체는 수행하지 않았다.

## W1·W2 분리 당시 검증

- 최종 `npm run check`: 타입 검사·134개 테스트·확장/C# 빌드 모두 통과. 앞선 내부 정리의 106개에서 W1 17개·W2 11개 계약 테스트를 추가했다.
- 최종 빌드의 `node scripts/extension-host.mjs`: 격리 VS Code 1.143.1에서 명령 등록·fixture 실행 완료·취소·해제·외부 프로세스 관찰·설정 끄기/켜기 통과. 원자료는 로컬 `test-artifacts/extension-host.json`에 있다.
- `node scripts/extension-host.mjs --dual`: A/B 창의 UUID·결과 분리와 같은 세션의 두 번째 소유자 거부 통과. 두 창 모두 OS 전경 전환이 거부되어 native flash·포커스 복귀 검사는 SKIPPED다. 원자료는 로컬 `test-artifacts/dual-host.json`에 있다.
- `git diff --check`: 통과. 문서의 상대 파일 링크와 줄 위치 범위도 확인했다.
- 세션 Map·프레임 버퍼·이력 조회의 핵심 자료구조·상한·알고리즘은 유지한다. 연결 중 카운터는 자원을 추적하는 Set으로 바꿨다. 추가 객체와 추적은 수명 소유권을 위한 것이며 성능 개선이나 메모리 절감률을 측정한 것은 아니다.
- 실제 모델 호출·질문 UI 조작·Windows 배너·사용자 클릭은 이번에 실행하지 않았다. C# helper와 설치 도구 소스는 수정하지 않았고 사용자 설치본 교체도 수행하지 않았다.

## C1·E1 검증 결과와 범위

- `npm run check`: 타입 검사·143개 테스트·확장/C# 빌드 통과. 기존 134개 테스트에 연결·이력 대조 경계 테스트 9개를 추가했다.
- 최종 `node scripts/extension-host.mjs`: 격리 VS Code 1.143.1에서 전체 명령 등록·stopFlash/diagnostics 실행·fixture 완료·취소·해제·외부 프로세스 관찰·설정 끄기/켜기 통과. 원자료는 로컬 `test-artifacts/extension-host.json`에 있다. 최종 실행의 `nativeBound`는 false였다.
- 최종 `node scripts/extension-host.mjs --dual`: 두 창의 UUID·결과 분리와 같은 세션의 두 번째 소유자 거부가 통과했다. 두 창 모두 OS 전경 전환 거부로 native flash·포커스 복귀 검사는 SKIPPED다. 원자료는 로컬 `test-artifacts/dual-host.json`에 있다.
- `git diff --check`와 변경 문서의 상대 링크·줄 위치 범위를 확인했다. 새 Codex 모듈과 VS Code UI·알림·창 모듈은 각 조립부를 역참조하지 않는다.
- 실제 모델 호출·승인/질문 UI 조작·Windows 배너 클릭·사용자 설치본 교체는 수행하지 않았다. 기능 정책이나 성능 개선을 위한 변경은 포함하지 않았다.
