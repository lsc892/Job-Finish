# Codex 실행·연결·이력 가독성 정리

## 범위와 보존 조건

- 검토 대상: [execution.ts](../../src/runtime/codex/execution.ts), [connection.ts](../../src/runtime/codex/connection.ts), [history.ts](../../src/runtime/codex/history.ts), [reconciliation.ts](../../src/runtime/codex/reconciliation.ts).
- 실행 명령, 연결 세대·소유권 검사, 시작 요청의 저장 시점, 이벤트와 응답 순서, 복구의 조회 전용 성격을 유지한다.
- 1·2·4초 재시도, 최근 512개 이력, 공유 64페이지·4 MiB 제한, 검색 방향과 오류 문구를 유지한다.

## 확인한 문제와 적용 계획

| 대상 | 문제 | 같은 파일 안에서 적용할 정리 |
| --- | --- | --- |
| execution | 스레드 분기·프로토콜 객체 조립·세션 갱신이 open/run에 섞이고 연결 콜백의 역할을 람다 본문에서 읽어야 한다. | 이름 있는 연결 처리기, 스레드 시작, 턴 요청 생성·응답 적용·미지원 요청 거절 단계로 분리한다. |
| connection | 초기화 정책·프로세스 실행이 open에 함께 있고 응답 캐시 삽입과 상한 유지를 함께 읽어야 한다. | 초기화와 캐시 제한 책임을 분리하고 복구 조건을 읽기 쉽게 펼친다. |
| history | 페이지 요청과 응답 검증·metadata 바이트 누적이 한 루프에 섞인다. | 페이지별 조회·검증과 metadata·항목 검증 책임을 이름으로 구분한다. |
| reconciliation | pending 시작 연결·활성 소유권 확인·본문 복구·baseline 생성이 reconcile에 집중되고 충돌 복구가 긴 Promise 콜백이다. | 복구 단계를 메소드로 분리하고 기존 오류·finally 경계를 유지한다. |

## 검증 계획과 미확인 범위

- 관련 테스트: [connection](../../tests/codex-connection.test.ts), [history](../../tests/codex-history.test.ts), [reconciliation](../../tests/codex-reconciliation.test.ts), [integration](../../tests/integration.test.ts).
- 공유 페이지 예산·반복 ID·metadata 제한, 활성 소유권 확인 순서, 최종 본문 조회 도중 연결 상실 계약을 보강하고 변경 전후에 실행한다.
- 타입 검사와 위 테스트를 실행한다. 실제 모델 실행·설치·UI 검증은 이 내부 정리의 범위에 포함하지 않는다.
- 클래스·파일·알고리즘·자료구조 변경은 적용하지 않는다. 현재 필요한 큰 구조 변경 제안은 없다.

## 적용 결과

- [스레드 열기](../../src/runtime/codex/execution.ts#L41)는 연결 → 새 스레드 시작 또는 재개 → 세션 연결 → 이벤트 활성화로 읽힌다. `startThread()`는 RPC Promise를 그대로 반환하고 응답 뒤 세션 적용을 호출부에 두어 새 await 경계를 만들지 않았다.
- [턴 실행](../../src/runtime/codex/execution.ts#L98)은 시작 요청 저장 → 매개변수 생성 → RPC 요청 → 연결/소유권 검증과 응답 반영으로 나눴다. 오류 처리·취소·재연결·응답 전달과 미지원 요청 거절도 책임별로 표시했다.
- [연결](../../src/runtime/codex/connection.ts#L41)은 초기화 매개변수 구성과 [응답 캐시 상한 유지](../../src/runtime/codex/connection.ts#L153)를 구분했다. 준비 전 큐·연결 세대·복구 공유·1/2/4초 타이머는 기존 구조를 유지한다.
- [이력 조회](../../src/runtime/codex/history.ts#L45)는 페이지 요청, 커서 검증, 턴 metadata 누적과 항목의 턴 확인을 분리했다. 페이지 조회 뒤 연결 재확인과 한 인스턴스의 공유 예산·반복 순서는 유지한다.
- [이력 대조](../../src/runtime/codex/reconciliation.ts#L29)는 제목/활성 소유권 확인, 미확인 진행 상태 보존, 종료 이력 변환과 충돌 조회 완료를 구분했다. pending 시작 검색과 본문 조회 루프는 같은 비동기 메소드에 남겨 원래 await 사이에 추가 대기가 들어가지 않게 했다.
- metadata 제거·반복 턴·4 MiB 제한, 턴/항목 공유 64페이지 예산·탐색 방향, 512개 상한, 활성 소유권 확인 순서와 본문 조회 중 연결/소유권 상실의 회귀 테스트 6개를 보강했다. 변경 전후 같은 관련 테스트 118개가 모두 통과했으며, 타입 검사·전체 191개 테스트·확장/C# 빌드도 통과했다. [통합 검증](agent-runtimes.md)에 결과와 범위를 정리했다.
