# 구현 및 검증 기록

검증일: 2026-10-05, 토스트 클릭 추가 검증 2026-10-06 (Asia/Seoul). 원래 인수 기준은 [requirements-and-verification.md](requirements-and-verification.md)에 유지한다. 이 문서는 구현된 경로와 확인한 증거를 구분한다. 모든 실제 런타임·Windows 시각 검증이 완료되었다고 주장하지 않는다.

## 구현

| 구성 | 파일 / 동작 |
| --- | --- |
| 확장 | `src/extension.ts` — 시작 시 새 UUID, 로컬 Windows 실행, 명령·결과·승인 UI, 신뢰된 workspace, 종료 정리 |
| Codex | `src/runtime/codex.ts`, `src/runtime/codex-history.ts` — stdio 실행·취소, 계획 모드 질문, 명령·파일·추가 권한 승인, 페이지별 상태·결과 조회, 최대 3회 지수 지연 재연결 |
| Claude | `src/runtime/claude.ts` — SDK query/result, canUseTool 질문·승인 중계, interrupt 확인, 후속 스트림 정리 |
| 전송 | `src/runtime/transport.ts` — UTF-8 분할·JSON 경계, 요청 ID 대응, 수신 1 MiB·queue 512개/4 MiB·대기 RPC 128개·30초 timeout |
| 상태 | `src/core/session.ts` — 명시적으로 관측한 턴만 완료 알림, 본문/종료 분리, 연결 세대 검사, 충돌 진단·조회, 복구 checkpoint |
| 소유권 | `src/core/ownership.ts`, `src/windows/gate.ts` — SHA-256 키, wx lock, PID 생존 확인, token 검증, 다른 runtime의 같은 저장 세션도 별도 lock으로 배제. Windows gate는 공유를 금지한 native 파일 핸들과 delete-on-close로 중단 시 자동 정리 |
| 자동 감지 | `src/runtime/observe.ts`, `src/runtime/event-router.ts` — 같은 Extension Host의 기존/새 Codex·Claude stdio 연결 관찰, 창별 이벤트 라우팅, 기본 활성화와 즉시 설정 전환. 추가 런타임/모델 호출·폴링·훅 없음 |
| 알림 | `src/core/notifications.ts` — 전체 활성화 설정·창 포커스·소유권 검사, 결과 20개·16 KiB, toast 180자 |
| Windows | `src/windows/*` — Koffi Win32 ABI, 안정된 포커스 관측, HWND/PID/실행 파일 검증, 500ms manual 또는 OS flash, 5분 만료, SnoreToast 등록·전송·native `clicked` 처리, 클릭 시 검증된 창 활성화·최소화 복원 |

세션 상태는 최대 32개 활성/미확정 턴, 최근 종료 키 512개, 진단 100개를 유지한다. 활성 연결·세션 수도 설정값으로 제한한다. 미관측 턴의 종료는 오래된 키가 제거되었더라도 새 알림으로 만들지 않는다. 체크포인트를 알림 전달 전에 기록하므로 충돌·재시작 중 중복을 줄이지만, 기록 직후 프로세스가 죽으면 알림이 누락될 수 있다. 무제한 exactly-once 전달을 보장하지 않는다.

`turn/start`를 보내기 전에 시작 요청 ID를 저장한다. 턴 ID를 받기 전 연결이 끊겨도 미확정 시작 요청이 남아 새 실행을 차단한다. 복구 이력의 `userMessage.clientId`로 요청과 턴의 관계를 확인한 경우에만 연결하고, 대응을 확인할 수 없으면 미확정 상태를 유지한다.

Claude 입력 callback은 실행 요청 ID·연결 ID에 묶는다. 응답 직전 소유권과 미해결 요청을 다시 확인하며, 철회·완료·이전 연결의 늦은 승인 응답은 허용하지 않는다. SDK가 요청을 철회하면 상태 표시줄도 즉시 갱신한다. `interrupt()` 응답을 기다리는 동안 정상 결과가 먼저 도착한 경우 그 결과를 유지한다. 체크포인트 기록 실패 시 승인하지 않고 진단과 함께 정리한다.

Codex 복구는 `thread/resume(excludeTurns: true)` 이후 `thread/turns/list`로 최대 512개 턴의 메타데이터를 조회한다. 추적 중인 종료 턴과 시작 요청 대응에 필요한 항목만 `thread/items/list`로 읽는다. 조회당 최대 64페이지, 턴당 최대 512개 항목, 메타데이터 4 MiB 상한과 연결·소유권 재검사를 적용한다. 실제 런타임이 idle인데 저장 이력에만 inProgress가 남으면 `unknown`을 유지한다. 결과 원문 조회도 해당 턴만 읽는다. 승인 응답 재전송 캐시도 512개/4 MiB로 제한한다.

## 실행한 검증

| 검증 | 결과 |
| --- | --- |
| 타입 검사·테스트·빌드 | 2026-10-06에 `npm run typecheck`, `npm test`(97개), `npm run build` 통과. 단위·stdio 연결·SDK 경계·실제 이벤트·Windows pipe·클릭 종료 신호·포커스 재시도 검증 |
| 기존 확장 이벤트 라우팅 | 실제 Codex·Claude 이벤트 fixture와 합성 자식 프로세스의 실제 stdio로 검증. 기존/새 연결 감지, 원본 바이트 보존, 설정 전환, 중복 결과·소유 실행 제외, 파싱 실패 시 원본 프로세스 유지, 프로세스 종료 뒤 남은 stdout 수신 통과 |
| 실제 Codex 0.160.0 | 정상 완료, 계획 모드 질문 답변, 명령 승인 거절, 추가 권한 승인 거절, 질문 대기 중 취소 통과. 실제 usageLimitExceeded 오류를 성공과 구분. 완료 세션의 페이지별 원문 조회와 재연결 뒤 과거 결과 재알림 없음 |
| 실제 Codex 0.152.0 | 설정된 모델의 CLI 버전 미지원 API 오류를 `error`로 분류; 성공으로 오판하지 않음 |
| 실제 Claude SDK 0.3.289 | 재로그인 후 `JOB_FINISH_LIVE_OK` 정상 완료. 실제 AskUserQuestion 답변, 임시 파일 Write 승인, 대기 중 interrupt 취소, `error_max_turns` 오류와 요청 해제 모두 통과. 이전 OAuth 오류 fixture도 유지 |
| VS Code 1.140.0 Extension Host | 격리된 프로필에서 활성화·명령 등록·소유 실행·완료·취소·세션 해제 통과. 같은 Host의 외부 stdio 연결 자동 감지, 설정 해제 중 알림 없음, 재활성화 후 재감지 통과. 테스트용 stdio 서버 사용 |
| 두 Extension Host | 같은 폴더를 연 A/B 창에서 서로 다른 UUID·실행 프로세스, 결과 분리, 같은 세션의 두 번째 소유자 거부 통과. 별도 프로필·공유 coordination 저장소 사용. Windows 전경 전환 거부로 native flash·포커스 복귀 시각 항목은 SKIPPED |
| 동일 프로필의 두 실제 창 | 같은 폴더/서로 다른 폴더를 가리키는 A/B workspace에서 실제 공용 globalStorage 사용, 같은 제목으로 실행. 두 번째 소유자 거부·결과 분리·소유권 이전 후 과거 결과 재알림 없음 통과 |
| 창 reload·강제 종료 복구 | 위 동일 프로필에서 A 창 reload 후 새 UUID·연결 ID, 관측 중인 턴 복구·취소 확인. 이어 해당 Extension Host PID를 강제 종료하고 자동 재시작 후 죽은 소유자 회수·새 UUID·중복 없는 상태 복구 통과. 런타임은 이력을 보존하는 stdio fixture |
| Windows gate 강제 종료 | 실제 자식 프로세스가 gate 핸들을 가진 동안 다른 진입 거부, 강제 종료 후 즉시 재획득. 이전 버전의 닫힌 gate 파일도 회수하고 살아 있는 핸들은 배제 |
| 큰 Codex 이력·복구 경합 | 합성 600턴/2 MiB 이상 저장 이력을 페이지별로 재개, 최근 512키 유지, 20 KiB 결과 원문 조회, 미확정 시작 요청 대응, 오래된 연결 응답 배제·조회 예산 초과 처리 검증 |
| Windows toast pipe | 실제 named pipe에 SnoreToast 형식의 합성 `action=clicked` callback을 전송해 분할 UTF-16·중복 클릭·helper 종료 경합·잘못된 action·8 KiB 상한·재등록 검증. 클릭 후 해당 알림 정지·창 활성화 전달과 HWND 폐쇄/PID·실행 파일 변경 거부도 검증. 제어된 helper 경계 사용이며 시각 클릭 증거와 구분 |
| Native toast smoke | 2026-10-06에 실제 토스트 표시·마우스 클릭·콜백 1회·명시한 실제 VS Code HWND의 전경 활성화 확인. 아래 추가 검증 참조. 실행 중인 확장 자동 바인딩과 알림 센터 클릭은 이 실험 범위 밖 |
| Win32 native ABI | 실제 user32/kernel32 로딩, 전경 핸들 조회, FLASHWINFO x64 32byte 확인 |
| 10만 턴 / 8세션 부하 | GC 후 감지 상태 heap 증가 606,496 bytes. 진단 100개·종료 키 세션별 512개 이하·활성 턴 0. 이 수치는 SDK/런타임 자식 프로세스 사용량을 포함하지 않음 |
| 자동 라우터 10만 턴 / 8연결 부하 | GC 후 기준 대비 유지 heap +361,536 bytes(약 0.35 MiB), 파서 버퍼 합계 64 KiB, 활성 턴 0. 추가 런타임 프로세스·폴링 타이머 0. 워밍업 대비 전체 프로브 RSS +114 MiB이며 위 heap 수치는 전체 메모리 증가가 아님. 합성 데이터 생성·전송과 fixture 핸들 비용을 포함하며 자식 프로세스 메모리는 제외 |
| 의존성 | `npm audit` 취약점 0개. node-notifier가 가져오는 uuid는 11.1.1 이상으로 override |
| VSIX 패키지 검증 | 임시 사용자 프로필에 설치 성공. 패키지 안의 Koffi native 로드·Claude SDK import·SnoreToast 및 Claude 실행 파일 포함 여부 확인. 이 검증은 사용자 확장 목록을 변경하지 않음 |

실제 런타임 이벤트에서 가져온 fixture는 `tests/fixtures/codex-*.json`, `claude-auth-error.json`, `claude-success.json`, `claude-turn-limit.json`, `claude-input-contracts.json`이다. Codex question·approval·permissions·cancel·usage-limit도 실제 수신 이벤트다. 세션·턴 식별자 또는 임시 파일 경로를 치환했으며, stderr·계정 설정·인증 정보와 reasoning 항목은 포함하지 않는다. Claude 취소는 실제 SDK interrupt 응답으로 확인했고, 존재하지 않는 취소 result를 만들어 저장하지 않았다. 다른 상태·대형 메시지·동시 실행 입력은 합성 fixture임을 테스트 파일에서 구분한다.

토스트 클릭 수정에서는 기존 테스트의 `activated` 입력을 실제 SnoreToast 형식의 `clicked`로 바꾸자 클릭 timeout이 발생하는 것을 먼저 확인했다. native action 인식과 창 활성화 호출을 연결한 뒤 회귀 테스트가 통과했다. 최소화 여부에 따른 복원 호출과 전경 전환 재시도 후 입력 큐 해제는 FFI 경계를 대체해 검증했으며, 실제 데스크톱 포커스 성공으로 집계하지 않는다.

2026-10-06 추가 진단에서는 실제 토스트 클릭 시 SnoreToast가 종료 코드 0을 반환하지만 파이프의 `clicked` 메시지는 오지 않는 현상을 재현했다. 제품은 파이프 메시지만 처리하고 종료 250ms 뒤 수신 연결을 닫아 창 활성화 호출이 누락됐다. 이제 파이프 응답을 기다린 뒤, 데이터가 전혀 없고 종료 코드가 0인 경우 Windows의 `ToastNotifier.Setting`이 Enabled인지 확인해 클릭을 한 번 전달한다. 숨김·시간 초과·사용자 취소·프로세스 종료 신호·Windows 알림 차단·상태 조회 실패는 클릭으로 처리하지 않는다. 늦은 파이프 클릭과 중복되지 않으며, 대기 중 알림 교체·설정 해제·확장 종료 시 취소한다.

창 활성화는 HWND·PID·실행 파일·알림 소유권을 재검증하고 실제 전경 창을 확인한다. OS가 전환을 거부하거나 최소화 복원이 아직 반영되지 않았으면 최대 850ms 동안 총 4회 시도한다. 새 사용자 입력, 알림 비활성화, 대상 창 소멸, 새 활성화 요청, 확장 종료는 재시도를 중단한다. 실패한 전경 전환을 성공으로 집계하지 않는다.

수정 후 2026-10-06 01:58 KST에 실제 SnoreToast를 표시하고 Windows 마우스 입력으로 클릭했다. 제품의 `WindowsToast` → `WindowIdentity.activateWithRetry` 경로에서 콜백 1회, 실제 전경 HWND `853872` → 대상 Job-Finish HWND `1444962`, `activated: true`, 진단 오류 없음으로 확인했다. 원자료는 `test-artifacts/fixed-1791219492316.json`에 있다. 별도 진단 프로세스에서 명시한 실제 HWND를 사용했으며, 실행 중인 확장의 자동 HWND 바인딩·최소화 복원·알림 센터 클릭을 모두 실측했다는 뜻은 아니다. 설치된 확장은 이 검증으로 교체하지 않았다.

## 재실행

```powershell
npm ci
npm run check
npm run test:load
npm run test:router-load
npm run test:extension
npm run test:windows
npm run test:profile
npm run test:profile -- --different-projects
npm run test:profile -- --native
npm run test:live -- codex
npm run test:live -- claude
npm run test:live:claude-input
npm run test:live:codex-input
npm run test:live:codex-input -- permissions
npm run test:live:codex-history
npm run package
npm run test:package
# 실제 알림을 클릭하고 명시한 VS Code 창의 전경 전환을 검증(현재 HWND로 변경)
npm run test:toast -- --activate-hwnd 1444962 --expect-click
```

`test:extension`과 `test:windows`는 임시 디렉터리의 VS Code 프로필을 사용한다. VS Code 테스트 인스턴스 격리 때문에 `test:windows`는 별도 A/B 프로필과 공유 소유권 저장소를 사용한다(테스트 모드에서만 storage override 허용). 같은 폴더를 가리키는 A/B workspace를 열며 테스트 창의 포커스를 전환하려고 한다. Windows가 포커스 전환을 거부하면 native 시각 검증을 `SKIPPED`로 기록하며 flash 성공으로 집계하지 않는다.

`test:profile`은 별도로 같은 임시 프로필의 일반 창 두 개에 테스트 harness를 설치한다. harness가 제품의 `activate()`를 호출하며 ExtensionMode.Test만 제공하고, globalStorage와 VS Code API는 실제 값을 사용한다. storage override는 사용하지 않는다. 임시 창의 새로고침과 해당 테스트 Extension Host만 강제 종료한다. 사용자 프로필·확장 설치는 변경하지 않는다. 런타임은 실제 stdio 전송을 사용하는 합성 서버이며 provider의 실제 모델 실행과는 구분한다.

`test:profile -- --native`는 동일 프로필의 일반 창에서 포커스·HWND·flash 경로를 시도한다. 이번 환경에서도 두 창 모두 Windows 전경 전환이 거부되어 native 검증은 SKIPPED였다. 제목은 창 핸들을 찾는 테스트 준비에만 사용하며 제품의 UUID 바인딩은 포커스 관측만 사용한다.

`test:live`와 `test:live:claude-input`은 실제 계정으로 짧은 모델 호출을 하며 다른 테스트에서 자동 실행하지 않는다. 입력 검증은 새 임시 폴더의 고정 marker 파일 쓰기와 색상 질문만 허용한다.

`test:live:codex-input`도 실제 모델을 호출하며 질문·입력 대기 중 취소·무해한 stdout 명령의 승인 거절을 검증한다. `-- permissions`는 해당 세션에만 실험적 request_permissions_tool을 켜고 임시 폴더 권한 요청을 거절한다. 사용자 전역 설정은 변경하지 않는다. usageLimitExceeded가 나오면 후속 모델 검증을 중단한다. `test:live:codex-history`는 앞선 검증에서 완료된 세션만 재개·조회하며 새 모델 턴을 만들지 않는다.

프로브에만 사용할 CLI 경로는 `JOB_FINISH_LIVE_CODEX_EXECUTABLE`, 모델은 `JOB_FINISH_LIVE_CODEX_MODEL` 환경 변수로 지정한다. 사용자 전역 Codex 설치·인증은 변경하지 않는다. 실행별 원자료는 git에서 제외한 `test-artifacts/`에 남긴다.

## 남은 인수 확인 및 제약

- 기존 확장 자동 감지는 공개 vendor 구독 API가 아닌 Node의 내부 `ChildProcess.prototype.spawn` 및 `_getActiveHandles()`에 의존한다. 같은 Extension Host의 stdio 프로세스만 관찰하며, 실행 인수·확장 경로가 바뀌면 진단 후 관찰을 중단할 수 있다. 파싱 실패는 관찰자만 해제하고 원래 프로세스·입출력은 유지한다.
- 자동 감지 상태는 메모리에만 보관한다. 켠 직후 이미 실행 중인 턴의 실제 종료 통지는 수신할 수 있지만, 꺼져 있는 동안의 결과와 닫힌 연결의 결과는 다시 조회하지 않는다. Codex 임시·하위 에이전트 thread는 관측한 메타데이터를 기준으로 제외한다. 연결 최대 16개, 연결별 세션 최대 32개, 파서 버퍼는 방향별 1 MiB로 제한한다.

- Claude의 실제 rate-limit advisory는 `allowed`였으며 quota 오류로 오판하지 않았다. 계정 한도 오류의 실제 증거는 Codex usageLimitExceeded로 확보했다. Claude 계정 quota 오류는 별도 실측하지 않았고, `error_max_turns`를 계정 quota로 분류하지 않는다.
- 같은 제목의 두 실제 창에서 HWND 연결·빠른 포커스 전환, toast의 실제 시각 표시·클릭은 직접 확인해야 한다. 창 reload·강제 종료 후 제품 상태 복구는 자동 검증했으나, native 시각 결과까지 확정하지 않는다.
- SDK는 끊긴 Claude 실행의 종료를 검증하는 API 계약이 확인되지 않아 `unknown`을 보존한다. 기록 조회의 일반 assistant 응답을 성공으로 대체하지 않는다.
- Codex는 전체 이력 대신 페이지별 조회를 사용한다. 단일 항목/페이지가 1 MiB를 넘거나 64페이지 조회 예산을 초과하면 원문 조회가 실패하거나 미확정 복구 상태를 유지할 수 있다. 최근 512턴보다 오래된 미확정 턴은 자동으로 새 실행과 연결하지 않는다.
- 소유권 lock 본문 자체가 손상되면 소유자를 확인할 수 없어 연결을 거부한다. Windows gate 핸들은 프로세스 종료 시 자동 회수하지만 손상된 lock 기록을 임의로 덮어쓰지 않는다.
- 토스트 클릭 callback은 살아 있는 전달 프로세스/pipe 동안만 지원한다(최대 30초). 늦은 알림 센터 클릭과 확장 종료 후 재활성화는 별도 기능이다.
- 토스트 클릭 시 `SetForegroundWindow`를 호출하고, 거부되면 전경 스레드의 입력 큐를 잠시 연결해 재시도한 뒤 항상 해제한다. 최소화 복원은 `ShowWindowAsync(SW_RESTORE)`를 사용한다. 현재 보이는 실제 창의 클릭 후 활성화는 위 추가 검증에서 확인했으며, 최소화 복원과 모든 Windows 전경 제한 조건의 성공을 보장하지 않는다.
- Windows x64 VSIX를 제공한다. 원격 workspace, 브라우저 host, ARM64/x86 패키지는 이번 검증 범위 밖이다.

## 확인한 계약

- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server): 초기화·턴 이벤트·재개와 조회 API를 구분한다. Codex 0.160.0의 실험 API 포함 생성 타입을 `src/protocol`에 보관한다.
- [Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript): 설치한 0.3.289의 `sdk.d.ts`로 result·canUseTool·interrupt 계약을 확인했다.
- [SnoreToast](https://github.com/KDE/snoretoast): `-install`과 동일 AppUserModelID, `-pipeName` callback을 사용한다.
- [SnoreToast native action](https://github.com/KDE/snoretoast/blob/v0.7.0/src/snoretoastactions.h): `Clicked`의 pipe 문자열은 `clicked`다. node-notifier의 `activate` 정규화는 binary를 직접 호출할 때 적용되지 않는다.
- [Windows SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow), [AttachThreadInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-attachthreadinput): 전경 활성화에는 OS 제한이 있으며 입력 큐 연결은 클릭 처리 동안만 유지한다.
- [Windows CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew): 공유 모드 0과 `FILE_FLAG_DELETE_ON_CLOSE`로 gate의 배타성과 프로세스 중단 시 정리를 보장한다.

설치와 사용 방법은 [README.ko.md](../README.ko.md)를 참고한다.
