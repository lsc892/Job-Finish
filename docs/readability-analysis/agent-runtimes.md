# Claude·Codex 런타임 전체의 가독성 정리

2026-11-02. [Claude](../../src/runtime/claude/README.md)의 TypeScript 6개와 [Codex](../../src/runtime/codex/README.md)의 TypeScript 9개를 검토한다. 이전 변경을 보존하며 같은 파일 안에서 처리 단계와 오류·정리 경계를 드러낸다.

## 적용 기준과 보존 조건

- 진입 메소드는 실행 순서를 조율하고 검증·프로토콜 변환·상태 적용·복구·자원 정리는 이름 있는 메소드와 함수로 구분한다. 짧고 명확한 코드와 재내보내기는 유지한다.
- 클래스·파일 배치와 공개 API, 실행 옵션·프로토콜·예외 메시지·기본값·상한·탐색 순서는 유지한다. 입력과 결과의 검증 순서, 비동기 대기 시점, 연결 세대·소유권 재확인, 취소와 종료의 경합도 보존한다.
- Claude는 결과 뒤 스트림을 끝까지 읽고, 정상 종료·취소·해제의 서로 다른 정리 순서를 유지한다. Codex는 시작 요청을 중복 실행하지 않으며, 추적 중인 실행만 이력으로 복구한다.
- 변경 위험에 맞는 기존 테스트와 의미 있는 회귀 테스트를 사용한다. 실제 모델 호출·사용자 설치본 변경은 이 작업의 검증 범위에 포함하지 않는다.

## 파일별 검토 결과

| 범위 | 파일 | 결과 |
| --- | --- | --- |
| Claude | [execution](../../src/runtime/claude/execution.ts) | 턴 준비·SDK 인자·입력 생성·수신·정상 정리·확인된 취소를 분리했다. |
| Claude | [permissions](../../src/runtime/claude/permissions.ts) | SDK 콜백 검증·pending/철회 구독·요청 기록·응답 정리를 구분했다. |
| Claude | [events](../../src/runtime/claude/events.ts) | 사용자 입력 수집·텍스트 추출·턴 시작을 구분하고 앞서 분리한 결과/도구 요청을 유지했다. |
| Claude | [provider](../../src/runtime/claude/provider.ts) | 실행 옵션과 질문 타입·답변 매핑을 펼쳐 표시했다. |
| Claude | [adapter](../../src/runtime/claude/adapter.ts) | 이미 식별자 검증·종료 변환이 분리되어 있어 유지했다. |
| Claude | [index](../../src/runtime/claude/index.ts) | 단순 공개 재내보내기를 유지했다. |
| Codex | [execution](../../src/runtime/codex/execution.ts) | 스레드 시작·시작 요청 생성·응답 반영·미지원 요청 거절을 구분했다. |
| Codex | [connection](../../src/runtime/codex/connection.ts) | 초기화 매개변수와 응답 캐시 상한 유지를 구분했다. |
| Codex | [history](../../src/runtime/codex/history.ts) | 페이지 요청·커서 검증·metadata 누적·항목 검증을 분리했다. |
| Codex | [reconciliation](../../src/runtime/codex/reconciliation.ts) | 제목/활성 턴 확인·미확인 상태 보존·종료 이력 변환·충돌 조회 정리를 구분했다. |
| Codex | [events](../../src/runtime/codex/events.ts) | 제외 대상 기록·제목 수집·실시간 이벤트 전달을 순서대로 배치했다. |
| Codex | [adapter](../../src/runtime/codex/adapter.ts) | 시작·본문·입력 대기·종료 변환과 오류 설명을 분리했다. |
| Codex | [executable](../../src/runtime/codex/executable.ts) | 설정/PATH 후보 탐색과 발견 경로의 실행 명령 변환을 구분했다. |
| Codex | [provider](../../src/runtime/codex/provider.ts) | 실행 옵션과 질문별 응답 매핑을 펼쳐 표시했다. |
| Codex | [index](../../src/runtime/codex/index.ts) | 단순 공개 재내보내기를 유지했다. |

총 15개를 검토해 12개를 정리하고 3개를 유지했다. 자세한 보존 조건과 적용 근거는 [Claude](claude-runtime.md), [Codex 실행·연결·이력](codex-runtime-execution.md), [Codex 관찰·변환·명령 탐색](codex-runtime-events.md)에 있다. 같은 파일 내부 정리로 끝났으며 새 소스 파일·클래스·공개 계약은 추가하지 않았다.

## 검증 결과

- 실행·권한·이력·명령 탐색의 회귀 테스트 17개를 보강했다. 작업 시작 시 보존한 15개 런타임 소스를 번들러에서 대체 로드해 관련 테스트 118개를 실행하고, 현재 소스에도 같은 118개를 실행해 모두 통과했다. 공통 전송 등 요청 범위 밖의 코드는 두 실행에서 현재 상태를 공통으로 사용했다.
- `npm run check`: 제품/테스트 타입 검사·전체 191개 테스트·확장/C# 빌드 통과. 구독·기본 옵션·입력/결과 식별자·큐/캐시 제한·예외·취소/완료 경합·이력 페이지·소유권/연결 상실을 포함한다.
- 격리 VS Code 1.144.0 Extension Host: 명령·완료·취소·세션 해제·외부 프로세스 자동 관찰·설정 끄기/켜기 통과. 최종 실행은 `nativeBound: false`여서 실제 HWND 연결·시각 효과의 성공을 주장하지 않는다. 로컬 결과는 `test-artifacts/extension-host.json`에 있다.
- fixture 프로세스 8개·10만 턴의 관찰 부하 검증 통과. 종료 시 각 연결의 활성 턴은 0개이고 observer가 별도 프로세스를 생성하지 않았다. 로컬 결과는 `test-artifacts/router-load.json`에 있으며 성능 향상률을 측정한 것은 아니다.
- TypeScript 구문 트리로 작업 전후 공개 선언을 대조해 동일함을 확인했고 두 폴더의 런타임 import 순환은 없었다. `git diff --check`와 변경 문서의 상대 링크도 확인했다.
- 실제 계정·모델 호출, 공식 확장의 승인/질문 UI, Windows 배너 클릭, 사용자 설치본 교체는 수행하지 않았다.
