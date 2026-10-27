# Readability: 큰 구조 변경 검토안

2026-10-24 기준. 파일 내부의 메소드·분기 정리는 코드에 반영했고, 아래 **세 가지 파일 분리안은 문서로만 제안**한다. 새 제품 파일·폴더와 import 변경은 적용하지 않았다.

## 후보와 적용 상태

| 후보 | 현재 문제 | 제안하는 책임 경계 | 상태 |
| --- | --- | --- | --- |
| [W1](#w1) | 확장 조립 객체가 실행·lease·저장 세션 수명까지 소유 | 세션 수명을 별도 객체로 이동 | 구조 변경 승인 없음 · 미적용 |
| [W2](#w2) | 짧게 실행되는 helper와 오래 유지되는 클릭 pipe를 한 객체가 정리 | 프로세스 실행기와 클릭 채널 분리 | 구조 변경 승인 없음 · 미적용 |
| [R1](#r1) | 두 공급자의 입출력 프로토콜과 전용 상태가 같은 라우터에 혼재 | 공급자별 이벤트 처리기를 facade 뒤에 배치 | 구조 변경 승인 없음 · 미적용 |

분석 근거는 [확장·Windows 상세](readability-analysis/windows.md)와 [런타임 상세](readability-analysis/runtime.md)에 있다. 설치 도구와 C# helper는 이미 역할별 경계가 있어 별도의 구조 교체 후보를 추가하지 않았다. 클래스 길이나 if 개수만으로 분리 대상을 정하지 않았다.

## 변경 전후 배치

```text
현재                                 제안
src/                                 src/
  extension.ts                         extension.ts
                                       application/
                                         sessions.ts             (W1, 생성 예정)
  windows/                             windows/
    toast.ts                             toast.ts
                                         toast-process.ts        (W2, 생성 예정)
                                         toast-activation.ts     (W2, 생성 예정)
  runtime/                             runtime/
    event-router.ts                      event-router.ts
                                         events/
                                           codex.ts              (R1, 생성 예정)
                                           claude.ts             (R1, 생성 예정)
```

기존 파일 링크: [확장 진입점](../src/extension.ts#L30), [WindowsToast](../src/windows/toast.ts#L15), [AgentEventRouter](../src/runtime/event-router.ts#L15). 새 경로는 모두 생성 예정이며 링크 대상으로 만들지 않았다.

<a id="w1"></a>

## W1 — 세션 수명 관리 분리

[Application.open](../src/extension.ts#L158)은 연결 수 제한, 공급자별 실행 생성, lease 획득, Session 구성, 조기 등록, 저장 세션 갱신과 실패 정리를 함께 처리한다. [detach](../src/extension.ts#L291)와 [dispose](../src/extension.ts#L299)도 같은 자원을 정리한다.

`src/application/sessions.ts`에 실행·Session·lease를 함께 소유하는 객체를 둔다. 확장은 설정·명령·창 이벤트와 UI를 연결하고, 해당 객체의 생성·선택·해제 API를 호출한다. 입력 UI는 현재 파일 내부 메소드 구성을 유지한다. 영향받는 [소유권 판정](../src/extension.ts#L95), [snapshot·테스트 API](../src/extension.ts#L78), [세션 선택·재개](../src/extension.ts#L189)도 같은 경계를 사용해야 한다.

위험은 Codex의 생성 콜백이 연결 완료 전에 세션을 등록하는 순서를 바꾸는 것이다. 초기 이벤트를 받기 전 등록, 실패 시 실행 정리 → 등록 제거 → lease 해제, 동시 open 제한을 함께 보존해야 한다. [상세 근거와 미확인 경로](readability-analysis/windows.md#w1)를 참고한다.

<a id="w2"></a>

## W2 — toast 프로세스와 클릭 채널 분리

[runNative](../src/windows/toast.ts#L40)는 helper의 입출력·진단·timeout·종료를 관리한다. [show](../src/windows/toast.ts#L76)는 등록·세대 검사와 전달 완료를 조율하고, [createClickServer](../src/windows/toast.ts#L117)는 클릭 승인과 활성화 결과를 처리한다. 메소드가 나뉘어도 자원 소유권은 [clear/stop/dispose](../src/windows/toast.ts#L159)에 모여 있다.

`src/windows/toast-process.ts`에는 실행별 취소와 완료 Promise, 전체 child 집합을 둔다. `src/windows/toast-activation.ts`에는 pipe·socket·만료 타이머와 승인·결과의 1회 처리 상태를 둔다. 기존 facade는 등록 캐시, 세대, 현재 알림 교체와 두 객체의 정리를 조율한다.

전송 helper가 종료돼도 클릭 채널을 유지해야 하며, 교체 시 이전 show 대기를 먼저 해소하는 순서를 보존해야 한다. 기존 [ToastProcessPorts와 공개 요청 타입](../src/windows/toast.ts#L8), C# JSON·COM 계약은 유지하는 안이다. [상세 근거와 검증 공백](readability-analysis/windows.md#w2)을 참고한다.

<a id="r1"></a>

## R1 — 공급자별 관찰 이벤트 처리 분리

[AgentEventRouter](../src/runtime/event-router.ts#L15)는 공통 세션 관리 외에 Codex의 ephemeral/subagent 제외와 Claude의 입력 큐·임시 UUID 이전·결과 중복 억제·interrupt 응답을 함께 소유한다. [outgoing](../src/runtime/event-router.ts#L28)과 [incoming](../src/runtime/event-router.ts#L66)에서 공급자별 경로를 고르고, `pendingThreads`도 공급자마다 다른 의미로 사용한다.

기존 facade와 공통 세션 Map은 유지하고, `src/runtime/events/codex.ts`와 `src/runtime/events/claude.ts`가 각 프로토콜과 전용 상태를 소유하도록 한다. facade는 생성 시 한 처리기를 선택해 세션 접근과 신호 전달을 연결한다. 공통 [Session](../src/core/session.ts#L5)의 상태 규칙과 [관찰자의 stdio 연결](../src/runtime/observe.ts#L94)은 변경 대상이 아니다.

위험은 결과 검증·중복 확인·큐 소비·상태 이전의 순서가 바뀌어 다음 입력을 잃거나 중복 알림이 생기는 것이다. 이득은 새로운 공급자를 추가할 때 다른 공급자의 프로토콜 상태를 함께 수정할 필요가 줄어드는 것이다. [상세 근거와 호출부](readability-analysis/runtime.md)를 참고한다.

## 적용 순서와 검증 계획

후보 사이에 필수 선행 관계는 없다. 작업한다면 독립성이 높은 [W2](#w2) → [R1](#r1) → 확장 조립에 영향이 큰 [W1](#w1) 순서를 권한다. 각 후보를 시작하기 전 현재 diff와 분석 당시 코드를 대조하고 하나씩 검증한다.

| 후보 | 보존할 계약과 검증 | 남은 작업 |
| --- | --- | --- |
| [W2](#w2) | [toast 테스트](../tests/toast.test.ts#L69): 등록 공유·재시도, stdout 배출 후 종료 판정, 전송 후 클릭, 승인 socket, 중복 클릭, 교체·stop·dispose | 새 객체 경계의 timeout·부분 JSON 종료 검증, 실제 배너·클릭 확인 |
| [R1](#r1) | [이벤트 라우터](../tests/event-router.test.ts#L14)와 [관찰 테스트](../tests/observe.test.ts#L25): history·소유 세션 제외, 바이트 보존, UUID 이전·실패 interrupt·중복 결과 | 분리 후에도 연결별 상태·상한·정리 유지 확인 |
| [W1](#w1) | [소유권](../tests/ownership.test.ts#L13)과 [Extension Host](../tests/extension-host.ts#L24): 창별 격리, 시작 전 등록, 재개·해제와 공개 API 유지 | 연결 중 dispose, lease·저장 실패, 동시 open 제한의 경계 테스트 |

이번 파일 내부 개선은 루트 `npm run check`의 타입 검사·98개 테스트·확장/C# 빌드, 설치 도구 `npm run check`의 타입 검사·20개 테스트·빌드로 검증했다. 이 결과가 위의 미적용 구조 변경을 검증한 것은 아니다. 질문 UI의 실제 조작과 실제 Windows 배너·클릭은 이번에 실행하지 않았다.
