# VS Code TypeScript 확장 MVP 실측 검증

검증일: **2026-10-03 00:11 KST**. 설계 기준은 [vscode-extension-migration.md](vscode-extension-migration.md)이며, 구현은 [독립 MVP](../experiments/vscode-extension-mvp/README.md)에 있다.

**VS Code Extension Host에서 TypeScript 감시 확장을 실행하고, 실제 Codex·Claude 호출 및 세션 로그의 새 기록을 수신하는 데 성공했다. 같은 폴더를 연 두 창에서도 실행 UUID와 결과가 분리됐다.**

## 환경과 검증 방법

| 항목 | 실제 사용 환경 |
| --- | --- |
| OS | Windows x64 |
| VS Code | 1.140.0 |
| Codex 실행 파일 | `openai.chatgpt` 26.930.21537에 포함된 `codex-cli 0.159.0-alpha.12.1` |
| Claude 실행 파일 | `anthropic.claude-code`에 포함된 Claude Code 2.1.287 |
| 추가 확인 | 독립 설치 Claude Code 2.1.233에서도 같은 호출·로그 감시 통과 |
| 실행 방식 | `@vscode/test-electron`으로 설치된 VS Code의 실제 Extension Host 실행 |

첫 호출은 확장의 TypeScript 코드가 CLI 프로세스를 시작한다. stdout의 JSONL을 검증용 파일에 기록하고 `vscode.workspace.createFileSystemWatcher`와 증분 파서로 완료 신호를 받는다. 그다음 provider가 저장한 **원본 세션 로그를 연결한 상태에서 동일 세션을 재개**해, 해당 파일에 추가되는 기록도 실제 watcher로 감지한다. AI에는 고정된 짧은 식별 문자열만 응답하도록 요청했다.

두 창은 별도 테스트 프로필을 사용한다. 동일 로그의 소유권 경합을 확인하려고 테스트 조정 디렉터리를 공유했다. 일반 확장 실행은 같은 host/profile의 `globalStorageUri`를 조정 영역으로 쓴다. 한 VS Code 메인 프로세스와 동일 프로필 아래의 여러 창 조합은 별도로 재현하지 않았다.

## 실제 수신 결과

| 대상 | 실제 신호 | 수신 본문 | MVP 판정 |
| --- | --- | --- | --- |
| Codex 직접 호출 | `turn.completed` | `JF_LIVE_A` | `completed` |
| Claude 직접 호출 | `result/success`, `is_error: false` | `JF_LIVE_B` | `completed` |
| Codex 원본 로그 감시 | `event_msg/task_complete` + `turn_id` | `JF_NATIVE_A` | `completed` — 해당 턴 종료 |
| Claude 원본 로그 감시 | `assistant.message.stop_reason: end_turn` | `JF_NATIVE_B` | `responseObserved` — 응답 종료 감지 |

Codex CLI의 JSONL 이벤트는 [OpenAI Docs: Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)에 문서화되어 있다. Claude의 `stream-json`과 `result` 출력은 [Claude Code 공식 실행 문서](https://code.claude.com/docs/en/headless)에 설명되어 있다. 원본 로그의 필드 해석은 **위에 적은 설치 버전의 실측 결과**이며, 모든 버전의 공개 연동 계약으로 취급하지 않는다.

Claude `end_turn`은 응답의 종료를 확인한다. 이것만으로 Stop hook 처리나 관련 백그라운드 작업까지 끝났다고 판정하지 않는다. Codex `task_complete`도 단일 턴의 종료이며 장기 목표 달성을 뜻하지 않는다.

## 창별 검증

| 시나리오 | 결과 |
| --- | --- |
| 같은 폴더를 두 창에서 열기 | workspace URI가 같고 창 UUID는 다름 |
| 서로 다른 폴더를 두 창에서 열기 | 각각의 UUID와 감시 신호 분리 |
| 두 창의 실제 AI 호출 | A의 Codex 결과는 A, B의 Claude 결과는 B에 기록 |
| 동일 로그를 두 창에서 연결 | 두 번째 소유권 획득 거절 |
| 동일 Codex 종료 기록을 두 번 쓰기 | 신호 1회만 기록 |
| JSON과 UTF-8 한글을 나누어 쓰기 | 미완성 상태에서는 알리지 않고 완성 후 정확히 파싱 |
| 테스트 창 종료 후 동일 프로필 재실행 | 새 UUID 생성, 과거 종료 기록 재알림 없음, 새 기록 수신 |
| VS Code 문서 변경 | `onDidChangeTextDocument` 이벤트 수신 |

같은 workspace의 최종 실측 ID:

```text
A / Codex : 4cf40bfc-0fc5-4201-9ad0-7d01c5e7de38
B / Claude: 3c30e722-698d-48b2-b4c1-2d9771bcf235
A 재실행 : 0376643d-5a43-4551-bce3-ec57ae4becbc
```

같은 workspace의 watcher 이벤트는 A에서 9회, B에서 7회였으며 파싱 오류는 없었다. 문서 변경 이벤트는 각각 2회 수신했다. UUID는 VS Code의 운영체제 창 번호나 HWND가 아니라 **해당 창에서 활성화된 확장 실행의 식별자**다. 전체 UUID로 귀속하고 짧은 ID는 표시용으로 쓴다.

요약 증거: [verification-result.json](../experiments/vscode-extension-mvp/verification-result.json). 상세 원본은 MVP의 `.verification/2026-10-02T15-11-25-669Z/summary.json`에 있다. 파일명의 시각은 UTC이고 보고서의 시각은 KST다.

## 검사와 산출물

- MVP TypeScript 빌드 및 핵심 테스트 **5개 통과**.
- 실제 VS Code 통합 테스트: 같은 workspace, 다른 workspace, 각 종료 후 재실행 **모두 통과**.
- 각 provider의 새 호출과 원본 로그 감시용 재개 호출 **모두 통과**.
- 기존 저장소의 `npm run typecheck`, `npm test` 통과.
- 설치 가능한 `job-finish-mvp-0.0.1.vsix` 생성.

재현 명령과 수동 실행 방법은 [MVP README](../experiments/vscode-extension-mvp/README.md)에 있다.

## 확인하지 않은 범위

기존 Codex·Claude 확장의 채팅 화면에 프롬프트를 보내거나 모든 실행을 자동 구독하는 타 확장 API는 검증하지 않았다. 이번 실측은 **확장이 직접 시작한 CLI 실행과 명시적으로 연결한 원본 로그**에 대한 것이다. 로그의 `cwd`만 보고 원래 창을 자동으로 알아내지는 않는다.

자동 테스트에서는 VS Code 팝업을 생략하고 수신 결과를 검사했다. 포커스 이벤트 구독은 구현했지만 이번 실행에서 이벤트가 발생하지 않아 실제 수신은 미검증이다. Reload Window 명령 자체 대신 창 종료·재실행을 검사했다.

비정상 종료 후 소유권 lock 회수, 원격 host, 여러 버전의 로그 adapter, 실제 사용량 제한·입력 대기·취소·백그라운드 작업, Windows 시스템 토스트·작업표시줄 깜빡임은 검증 범위에 포함하지 않았다. 성공/오류 분류와 Codex 취소 레코드 해석은 핵심 테스트에서 검사했다.
