# 에이전트 Provider 확장

에이전트별 처리는 `src/runtime/agent-provider.ts`의 `AgentProvider`를 상속한다. 기본 구현은 `src/runtime/providers/codex.ts`, `claude.ts`이며, 등록 위치는 `src/runtime/providers/index.ts` 한 곳이다.

```text
등록된 AgentProvider
  ├─ 프로세스 식별 → 연결별 AgentEvents → 공통 Session → Signal → Notifications
  ├─ AgentExecution 생성 → 공통 Session → Signal → Notifications
  └─ 승인·질문 UI 호출 및 에이전트 응답 형식 변환
```

`AgentEventRouter`는 연결·세션 수명, 소유권 검사와 세션 수 상한을 관리한다. 각 Provider의 `AgentEvents`가 프로토콜 메시지를 해석하며, `Session`과 `Notifications`는 특정 에이전트의 메시지 형식을 알지 못한다. 실제 Windows 알림은 기존 C# helper를 사용한다.

## 새 에이전트 추가

1. `src/runtime/providers/<agent>.ts`에 `AgentProvider` 상속 클래스를 만든다.
2. 식별 정보와 아래 메소드를 구현한다.
3. `providers/index.ts`의 `AgentProviderRegistry` 생성 목록에 인스턴스를 추가한다.
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

알림의 근거는 에이전트가 확정한 완료·실패·취소·입력 대기 이벤트다. 중간 텍스트, 프로세스 종료 또는 과거 이력 조회를 성공 완료로 바꾸지 않는다. 프로세스 식별 뒤에도 원본 확장 경로·호출 경로 검증과 직접 실행 제외 검사가 적용된다.

Provider ID는 문자열이며 등록 목록에서 검증한다. 미등록 ID와 중복 ID·실행 명령은 명시적으로 실패하므로 다른 에이전트 처리로 넘어가지 않는다. 기본 Codex·Claude의 ID, 명령 이름과 런타임 ID 계산 방식은 유지한다.

## 검증 참고

`tests/providers.test.ts`의 `SampleProvider`는 세 번째 프로토콜을 구현한 예다. 별도 등록 목록만 주입해 실제 자식 프로세스의 원본 바이트를 유지하면서 공통 알림까지 전달하는지 검사한다. 연결별 상태 분리·중복 결과·소유권·해제, 승인·질문 변환과 실행 생성도 검사한다.

```powershell
npm.cmd run typecheck
npx.cmd tsx --test tests/providers.test.ts
npm.cmd test
```
