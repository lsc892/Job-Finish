# 에이전트 Provider 확장

에이전트별 처리는 `src/runtime/agent-provider.ts`의 `AgentProvider`를 상속한다. 기본 구현은 `src/runtime/codex/provider.ts`와 `src/runtime/claude/provider.ts`이며, 등록 위치는 `src/runtime/providers.ts` 한 곳이다. 실행·관찰 이벤트·입력 변환을 각 런타임 폴더에서 찾을 수 있도록 배치한다.

```text
runtime/
  agent-provider.ts       Provider·관찰·입력 계약과 등록 목록 타입
  execution.ts            AgentExecution 계약·공통 옵션·AgentRuntime 추상 클래스
  providers.ts            Codex·Claude 등록
  event-router.ts         공통 세션 라우팅
  observe.ts              공통 프로세스 관찰
  message.ts              관찰 메시지 검증·상한
  transport.ts            JSON-RPC 전송
  codex/
    index.ts              공개 export
    provider.ts           생성·프로세스 식별·입력 변환
    events.ts             관찰한 App Server 이벤트
    execution.ts          직접 실행 조율
    adapter.ts            프로토콜 → Session 변환
    connection.ts         stdio 연결·복구·큐·응답 캐시
    history.ts            페이지 조회
    reconciliation.ts     이력·충돌 대조
    executable.ts         Codex 실행 파일 선택
  claude/
    index.ts              공개 export
    provider.ts           생성·프로세스 식별·입력 변환
    events.ts             관찰한 SDK JSON 이벤트
    execution.ts          SDK query 실행·결과·취소 수명
    adapter.ts            결과 → Session 변환
    permissions.ts        승인·질문 대기·abort 구독·응답 정리
```

두 실행체는 `execution.ts`의 `AgentRuntime`을 상속해 소유권 검사를 공유하고 `RuntimeOptions<TEvent>`를 사용한다. 프로토콜·이벤트 큐·복구·취소 확인은 각 런타임이 구현한다. `AgentExecution`은 구조적 계약으로 유지하므로 별도 Provider는 상속 없이 계약을 구현해 등록할 수도 있다. 기존 `runtime/codex`·`runtime/claude` import는 각 폴더의 `index.ts`가 제공한다. 구체 모듈끼리는 공개 index를 거치지 않아 순환 의존을 만들지 않는다.

```text
등록된 AgentProvider
  ├─ 프로세스 식별 → 연결별 AgentEvents → 공통 Session → Signal → Notifications
  ├─ AgentExecution 생성 → 공통 Session → Signal → Notifications
  └─ 승인·질문 UI 호출 및 에이전트 응답 형식 변환
```

`AgentEventRouter`는 연결·세션 수명, 소유권 검사와 세션 수 상한을 관리한다. 각 Provider의 `AgentEvents`가 프로토콜 메시지를 해석하며, `Session`과 `Notifications`는 특정 에이전트의 메시지 형식을 알지 못한다. 실제 Windows 알림은 기존 C# helper를 사용한다.

## 새 에이전트 추가

1. `src/runtime/<agent>/provider.ts`에 `AgentProvider` 상속 클래스를 만들고 같은 폴더에 실행·이벤트 해석기를 둔다.
2. 식별 정보와 아래 메소드를 구현한다.
3. `providers.ts`의 `AgentProviderRegistry` 생성 목록에 인스턴스를 추가한다.
4. 명령 팔레트에 실행 명령을 공개하거나 설정을 추가할 때는 `package.json`의 `contributes.commands`와 `contributes.configuration`도 선언한다. VS Code의 정적 선언은 Provider 등록과 별도다.

| 구현 대상 | 책임 |
| --- | --- |
| `id` | 저장된 세션·소유권 키·알림에 사용하는 고유 ID |
| `extensionId` | 자동 관측할 원본 VS Code 확장의 ID |
| `runCommand` | `jobFinish.` 뒤에 붙는 실행 명령 이름 |
| `matchesProcess(args)` | 해당 프로토콜을 사용하는 자식 프로세스 식별 |
| `runtimeDirectory()` | 런타임 ID 계산에 사용하는 설정 디렉터리 |
| `createEvents(context)` | 연결별 메시지 해석기 생성 |
| `createExecution(context)` | 실행·취소·재연결·응답·결과 조회 구현 생성 |
| `approvalResponse(request, allow)` | 승인·거부를 원본 프로토콜 응답으로 변환 |
| `answerQuestions(request, interaction)` | 공통 질문 UI를 사용해 원본 응답 구성 |

Provider 인스턴스는 여러 연결에서 공유하므로 요청 큐·중복 결과·현재 세션 같은 상태는 `createEvents`가 생성하는 해석기에 둔다. 해석기의 `dispose()`에서 상태를 정리한다. `context.session(id)`는 소유권을 확인하고 필요하면 세션을 만들며, `context.existingSession(id)`는 이미 관측 중인 세션만 조회한다.

직접 실행하는 세션은 반드시 `ExecutionContext.createSession`으로 생성한다. 생성자에서 연결을 시작하지 않고, 비동기 연결이나 복구가 필요하면 반환한 실행 객체의 `open(sessionId?)`에서 수행한다. 이렇게 해야 공통 애플리케이션이 실행 객체를 보관한 뒤 복구 이벤트를 처리할 수 있다. 연결 중 실패하면 공통 애플리케이션이 실행 객체와 소유권을 해제한다.

직접 실행의 공통 수명은 [ApplicationSessions](../src/application/sessions.ts)가 소유한다. 실행 생성부터 연결 중 작업·Session·lease·저장 목록·해제까지 함께 관리하며, 연결 완료 전에 Session을 등록해 복구 이벤트의 소유권을 확인한다. 확장 조립부는 VS Code 설정·저장소와 신호·상태 변경 콜백을 주입한다. Provider는 lease나 확장 UI의 내부 상태를 직접 관리하지 않는다.

알림의 근거는 에이전트가 확정한 완료·실패·취소·입력 대기 이벤트다. 중간 텍스트, 프로세스 종료 또는 과거 이력 조회를 성공 완료로 바꾸지 않는다. 프로세스 식별 뒤에도 원본 확장 경로·호출 경로 검증과 직접 실행 제외 검사가 적용된다.

Provider ID는 문자열이며 등록 목록에서 검증한다. 미등록 ID와 중복 ID·실행 명령은 명시적으로 실패하므로 다른 에이전트 처리로 넘어가지 않는다. 기본 Codex·Claude의 ID, 명령 이름과 런타임 ID 계산 방식은 유지한다.

## 검증 참고

`tests/providers.test.ts`의 `SampleProvider`는 세 번째 프로토콜을 구현한 예다. 별도 등록 목록만 주입해 실제 자식 프로세스의 원본 바이트를 유지하면서 공통 알림까지 전달하는지 검사한다. 연결별 상태 분리·중복 결과·소유권·해제, 승인·질문 변환과 실행 생성도 검사한다.

```powershell
npm.cmd run typecheck
npx.cmd tsx --test tests/providers.test.ts
npm.cmd test
```
