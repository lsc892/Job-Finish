# 토스트 누락 로그 확인

자동 추적 로그는 진단 빌드에서만 제공한다. `npm run build`와 빌드·적용 스킬의 기본 산출물에는 자동 추적 코드와 Codex 상세 추적기가 포함되지 않는다. 일반 빌드의 `Job-Finish: Show Diagnostics`는 현재 연결·최근 결과·보관 오류의 수동 스냅샷을 제공한다.

진단이 필요하면 `npm.cmd run build:diagnostics`로 별도의 `dist-diagnostics/`를 만든다. 기존 `dist/`와 일반 VSIX는 바뀌지 않는다. 진단 실행은 별도로 준비한 개발용 확장 사본에서 이 폴더의 `extension.cjs`·소스맵과 `native/`를 그 사본의 `dist/`에 배치해 수행한다. 개발용 사본에는 같은 `package.json`·리소스·런타임 의존성도 필요하며, 일반 제품 폴더에 진단 파일을 섞지 않는다. 일반 `package` 명령은 일반 빌드를 다시 만들기 때문에 진단 설치 패키지로 사용하지 않는다.

진단용 확장을 실행한 뒤 VS Code에서 `Developer: Reload Window`를 실행한다. 평소 사용하는 Codex·Claude 확장에서 작업을 실행하고 다른 창으로 이동한 상태에서 완료를 기다린다. 해당 VS Code 창을 보고 있으면 알림을 생략하는 것이 현재 정책이다.

누락이 발생하면 그 창에서 `Job-Finish: Show Diagnostics`를 실행하고 출력 패널의 **Job-Finish** 내용을 보관한다. 이 명령은 앞선 로그를 지우지 않고 현재 설정·연결·최근 결과·오류 스냅샷을 뒤에 붙인다. 진단 빌드의 로그는 확장 활성화부터 자동 기록하며 별도 디버그 설정이 필요하지 않다.

디스크의 출력 로그는 `Developer: Open Logs Folder`로 연 VS Code 로그 폴더 아래 `window*/exthost/output_logging_*/*-Job-Finish.log`에 있다. 기본 사용자 데이터 경로는 `%APPDATA%\Code\logs`다. 창이 여러 개면 `windowInstanceId`와 `application.started`의 버전·확장 경로로 구분한다. 다시 로드하면 새 로그 파일에 이어지므로 재현 당시 파일을 보관한다.

| 마지막으로 확인된 기록 | 확인할 내용 |
| --- | --- |
| `application.started`, `notifications.configured` | 실행 중인 빌드 경로·버전, enabled/toast/flash 설정, 제공자 확장 버전 |
| `observer.discovery.complete` | 감지된 연결 수. 0이면 roots·제공자 설치 상태와 같은 Extension Host인지 확인 |
| `observer.candidate.rejected` | 제공자처럼 보이지만 설치 확장 경로를 확인하지 못한 프로세스 |
| `observer.connection.attached/detached` | 관찰 연결의 생성·종료, 프로세스 ID와 연결 ID |
| `observer.frame.truncated`, `observer.frame.skipped` | 긴 문자열 축소 또는 구조 상한 초과 프레임 생략. direction으로 송수신을 구분하며 다음 프레임 관찰은 계속됨 |
| `runtime.lifecycle` | Codex 턴 시작·완료/오류 또는 Claude 결과가 실제 스트림에 도착했는지 확인 |
| `codex.thread.request/response` | 스레드 RPC 요청·응답의 method·requestId, 메타데이터 유무·목록 크기·오류 여부 |
| `codex.thread.metadata` | 단일/목록 메타데이터의 수신 경로, 부모·source·임시 여부, 제외 후보와 실제 등록 상태 |
| `codex.thread.excluded` | 메타데이터 또는 부모의 서브에이전트 활동으로 실제 제외 등록된 자식 ID·근거 |
| `codex.turn.selection` | 시작·완료 턴의 통과/제외 판정과 사유, 마지막 메타데이터·부모·루트 턴 ID |
| `codex.thread.metadata.evicted`, `codex.thread.exclusion.evicted` | 각각 512개 상한으로 진단 이력 또는 실제 제외 목록에서 제거된 세션 ID |
| `signal.received` | 완료·입력 대기 신호 생성 여부. 이후 기록은 notificationId로 연결 |
| `notification.skipped` | focused·disabled·not-owner·recent-question 중 생략 사유와 판정 단계 |
| `toast.skipped`, `toast.cancelled` | 토스트 설정 OFF, 비동기 준비 중 정책 변경·교체·중지·해제 여부 |
| `toast.helper.started/exit`, `diagnostic.error` | helper 경로·PID·종료 코드·stderr·오류와 관련 알림 ID |
| `toast.registration.ready` | Windows 알림 설정 상태(setting) |
| `toast.submitted`, `toast.history.confirmed`, `toast.observation.complete` | Windows 제출·알림 센터 기록·관찰 종료 결과와 notificationState |

Windows 제출이나 알림 센터 기록 확인만으로 화면 배너 표시를 보장하지는 않는다. 이 단계까지 성공했다면 Windows 알림 설정·방해 금지 상태도 함께 확인한다. 연결 스냅샷의 incomingMessages/outgoingMessages/lastIncomingEvent는 연결은 있지만 완료 신호가 없는 경우를 조사하는 데 쓴다.

추가한 자동 추적은 응답 본문 대신 식별자·상태·길이를 기록한다. 진단 명령이 덧붙이는 최근 결과 스냅샷에는 기존과 같이 응답 본문이 들어가므로 외부에 공유할 때 내용을 확인한다.

## 2026-11-09 일반·진단 빌드 분리

- **의사결정**: 일반 빌드와 빌드·적용 스킬의 기본 산출물에서 자동 추적 로그 코드를 제외한다. Codex는 로그 전용 문장과 상세 추적기 생성·호출을 `diagnostic:` 라벨로 표시하고, 일반 빌드에서 라벨과 인수 평가를 제거하도록 했다. 진단 빌드는 별도 명령·출력 폴더로 분리한다.
- **근거**: 테스트 소스와 로그 파일만 패키징에서 제외해도 제품 소스의 추적기·로그 출력은 번들에 포함됐다. 일반 실행에서 사용하지 않을 상세 수집 코드와 소스맵을 제거하고 진단 산출물이 일반 패키지에 섞이지 않게 해야 했다. 오류 보관·수동 스냅샷과 helper의 성공/클릭 응답은 제품 동작에 필요하므로 유지한다.
- **결과**: `npm run build`는 `dist/`, `npm run build:diagnostics`는 `dist-diagnostics/`로 출력한다. 일반 번들에는 `CodexThreadDiagnostics`와 자동 추적 호출이 없고 진단 번들에는 남아 있음을 산출물에서 확인했다. 제품 TypeScript 컴파일·빌드 스크립트/두 번들의 구문 확인·일반/진단 확장·C# 빌드가 통과했다. 진단 빌드 전후 일반 번들의 SHA-256이 같았고, VSCE의 패키지 포함 목록 75개에 테스트·진단 폴더·소스맵이 없으며 제품 번들과 helper가 포함됨을 확인했다. 스킬은 기본 컴파일·일반 빌드·패키지 내용 확인을 사용한다. 사용자 지침에 따라 테스트 코드 수정·자동 테스트 실행은 생략했고, 새 VSIX 생성·사용자 설치본 교체와 실제 배너/클릭 검증은 수행하지 않았다.

## 서브에이전트 완료 오알림 추적

진단 빌드를 설치하고 창을 다시 로드한 뒤, 부모 작업에서 서브에이전트를 생성해 재현한다. `codex.thread.metadata`의 `metadataRoute`는 `params.thread`·`result.thread`·`result.data`를 구분한다. `metadataMethod`와 `requestId`는 원래 스레드 요청과 응답을 연결한다. 요청 ID는 숫자와 문자열을 구분하도록 JSON 표기로 기록하며, 관찰 시작 전에 보낸 요청의 응답은 method가 `rpc-response`로 남을 수 있다.

`parentThreadId`, `sourceKind`, `sourceSubAgent`, `sourceSubagentLowercase`, `subAgentParentThreadId`, `agentPath`, `threadSource`, `ephemeral`로 수신한 분류 근거를 확인한다. 프롬프트·제목·응답·전체 이력은 이 로그에 포함하지 않는다. `exclusionCandidate`는 현재 코드의 제외 조건에 해당하는지, `excluded`는 실제 제외 목록에 등록되어 있는지를 나타낸다.

같은 `connectionId`·`sessionId`·`turnId`의 `codex.turn.selection` → `signal.received` → `toast.submitted`를 대조한다. `rootTurnId`는 받은 이벤트에 있을 때 기록한다. `decision: accepted`는 스레드 제외 검사를 통과했다는 뜻이며 실제 알림 전송은 이후 로그에서 확인한다.

| selection의 reason | 의미 |
| --- | --- |
| `excluded-thread` | 실제 제외 목록에 있어 턴 처리를 중단함 |
| `exclusion-not-registered` | 진단으로 본 메타데이터는 제외 조건에 해당하지만 실제 제외 목록에는 없어 통과함 |
| `metadata-unseen` | 현재 연결의 진단 이력에 메타데이터가 없는 상태로 통과함. 활성화 이전 수신·512개 상한 제거 여부도 앞선 로그로 확인 |
| `not-excluded` | 마지막으로 받은 메타데이터가 현재 제외 조건에 해당하지 않아 통과함 |

진단 처리기는 판정을 기록하며, 실제 제외 등록은 이벤트 처리기가 담당한다. 현재 코드는 단일·목록 메타데이터에 같은 제외 조건을 적용하고, `subAgentActivity`의 `kind: started`와 `collabAgentToolCall`의 `spawnAgent`에서도 자식 ID를 등록한다. `interacted`의 상대는 부모·형제일 수도 있으므로 생성 외의 활동은 제외 근거로 사용하지 않는다. 활동으로 먼저 제외하면 `metadataSeen: false`와 `decision: excluded`가 함께 나올 수 있으며, 근거는 앞선 `codex.thread.excluded`에 남는다.

### 2026-11-09 메인 대화 알림 누락 조사

- **확인한 로그**: `%APPDATA%\Code\logs\20261109T122909\window3\exthost\output_logging_20261109T123211\2-Job-Finish.log`. 정상 사용자 대화 세 개가 `subagent-activity`로 제외됐고, 이후 비활성 창에서 받은 정상 완료 8건·오류 종료 2건이 `excluded-thread`로 차단됐다. 별도로 활성 창의 정상 완료·취소 각 1건도 같은 제외 판정을 받았으며, 이 두 건은 기존 포커스 정책으로도 표시 대상이 아니다.
- **방향이 뒤집힌 근거**: 자식 `01a1c033-ce86-7b82-88d5-b89ffc8c6291`의 rollout에서 21:08:34.431(한국 시간)에 `/root`로 `send_message`를 호출했고, 21:08:34.441에 `kind: interacted`·`agent_thread_id: 01a1bfd4-1886-7cb0-b75b-d5425a9d242b`·`agent_path: /root` 활동이 기록됐다. 원본 메타데이터의 부모는 이 상대 ID이며, Job-Finish는 바로 다음 21:08:34.442에 부모를 제외했다. 21:11:48·22:22:39·22:25:22의 부모 완료는 실제로 수신됐지만 알림 신호로 전달되지 않았다.
- **원인**: 설치 번들과 소스의 `recordSubagentItem()`이 모든 `subAgentActivity.agentThreadId`를 자식으로 간주했다. 이미 제외된 자식의 활동도 자식 분류를 위해 먼저 처리하므로 부모에게 보낸 메시지가 부모를 제외 목록에 넣었고, 이후 정상 메타데이터를 받아도 제외 상태가 유지됐다.
- **수정과 확인**: 생성 관계를 나타내는 `kind: started`만 활동 기반 제외에 사용하도록 수정했다. `interacted`·`interrupted`·`completed`·종류가 없는 활동은 제외 등록을 하지 않으며, 항목 시작·완료와 턴 항목 목록 모두 같은 조건을 거친다. 단일·목록 메타데이터와 협업 `spawnAgent`의 기존 제외 경로는 유지한다. 실제 생성/메시지 교환 기록과 프로토콜·코드·참조·diff를 검토했고, 제품 TypeScript 컴파일(`tsc --noEmit -p tsconfig.json`)이 통과했다. 사용자 지침에 따라 테스트 코드와 자동 테스트는 수정·실행하지 않았으며, 수정본의 실제 새 작업·배너 재현과 사용자 설치본 교체는 수행하지 않았다. 수정본 적용 후 관찰 연결을 새로 시작하면 이전 메모리의 잘못된 제외 목록도 정리된다.

### 2026-11-08 실제 오알림 조사

- **확인한 로그**: `%APPDATA%\Code\logs\20261108T103649\window5\exthost\output_logging_20261108T184909\2-Job-Finish.log`. 세션 `01a1bb13-5ac8-7970-a086-d4e91225b59d`의 완료가 21:14:20·21:15:16·21:16:56·21:18:23(한국 시간)에 `signal.received`로 전달됐고, 각 notificationId가 `toast.submitted`까지 이어졌다. 마지막 제출은 21:18:23.333이다. Windows 제출 기록이며 배너의 시각 표시는 별도로 확인하지 않았다.
- **부모 관계 대조**: 같은 날짜 Codex rollout의 첫 `session_meta`에서 해당 세션의 부모는 `01a1ba95-209b-7d61-8293-c3e88fc207b4`, `source.subagent.thread_spawn`과 `thread_source`는 하위 에이전트를 나타냈다. 부모 rollout에는 21:12:50.574에 이 자식 ID의 `sub_agent_activity`가 기록돼 있다. 설치된 Codex 실행 파일이 생성한 프로토콜 정의에서 이 활동의 v2 항목은 `subAgentActivity.agentThreadId`다.
- **코드에서 확인한 누락**: 기존 처리기는 부모의 활동 항목을 제외 근거로 사용하지 않았고, `result.data`의 스레드는 제목만 반영해 제외 등록을 생략했다. 메타데이터 조건도 `parentThreadId`·`source.subAgent` 등에 한정됐다. 자식이 제외 목록에 없으면 실시간 완료만으로 세션을 생성하고 알릴 수 있었다.
- **확정할 수 없는 범위**: 조사한 로그와 실제 설치 번들에는 추가했던 `codex.thread.metadata`·`codex.turn.selection` 진단이 없었다. 따라서 당시 자식의 별도 메타데이터가 없었는지, 목록 경로로만 왔는지까지는 단정할 수 없다. rollout의 `source.subagent`와 v2 프로토콜의 `source.subAgent`는 표기가 다르므로, 원본 세션의 소문자 표기만으로 실제 RPC의 대소문자 문제를 확정하지 않는다.
- **수정과 확인**: 활동 항목의 자식 ID를 세션 처리 전에 제외하고, 목록 메타데이터도 단일 응답과 같은 공통 조건으로 등록한다. 등록 근거를 자동 로그에 남긴다. 제품 TypeScript 컴파일과 코드·참조·diff 검토를 수행했다. 사용자 지침에 따라 테스트 코드와 자동 테스트는 수정·실행하지 않았으며 실제 새 작업·배너 재현과 사용자 설치본 교체는 수행하지 않았다. 기존 진단 테스트 중 목록 오알림의 통과를 기대하는 항목은 이전 진단 전용 동작에 대한 기록으로 남아 있다.

## 긴 본문·한글 표시 검증

빌드된 helper와 기존 `JobFinish.VSCode` 등록이 있는 환경에서 `node --import tsx tests/windows/toast-layout.ts`를 실행한다. 아이콘 켬·끔 토스트의 한글·이모지와 줄 수 제한을 Windows 알림 센터 XML에서 대조하고 자신이 만든 테스트 알림만 제거한다. 이 검사는 배너의 실제 시각 표시나 클릭을 보장하지 않는다.

한글이 포함된 JavaScript를 Windows PowerShell의 here-string 파이프로 `node`에 넘기지 않는다. 기본 `$OutputEncoding`이 US-ASCII이면 실행 전부터 한글이 `?`로 바뀔 수 있다. UTF-8 소스 파일을 직접 실행하는 위 검증 명령을 사용한다.
