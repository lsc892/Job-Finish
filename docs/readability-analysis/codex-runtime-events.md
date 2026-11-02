# Codex 관찰·상태 변환·실행 명령 가독성 정리

## 범위와 보존 계약

- 검토 범위: [adapter.ts](../../src/runtime/codex/adapter.ts), [events.ts](../../src/runtime/codex/events.ts), [executable.ts](../../src/runtime/codex/executable.ts), [provider.ts](../../src/runtime/codex/provider.ts), [index.ts](../../src/runtime/codex/index.ts), [README.md](../../src/runtime/codex/README.md).
- 현재 흐름: 관찰 이벤트가 제외 대상과 제목을 기록한 뒤 실시간 이벤트만 세션에 전달하고, 어댑터가 프로토콜을 공통 턴 상태로 바꾼다. 직접 실행 명령은 설정값 또는 PATH 후보 순서로 찾고 셸 없이 실행할 명령으로 바꾼다.
- 보존: 검증·오류 순서, 본문과 종료 이벤트의 구분, 일반 오류의 비종료 처리, 관찰 중 시작된 턴의 수용, 이력의 제목 전용 사용, 임시·하위 스레드 제외, 저장 상한과 제목 우선순위, 실행 파일 탐색 순서, 질문의 순차 처리와 취소.
- 기준 소스: 루트 담당자가 보존한 `.generated/runtime-readability-before-f7a0c93e-760b-4778-9e17-9f9803795df8/`의 해당 파일. 앞서 수락된 미커밋 변경을 유지한다.

## 즉시 적용할 내부 정리

- `CodexEvents.incoming`의 제외 판정·제목 수집·실시간 이벤트 반영을 이름 있는 단계로 분리한다. `outgoing`의 익명 콜백 연결은 프롬프트의 텍스트 선택 책임이 보이도록 정리한다.
- `CodexAdapter`의 이벤트 분기에서 시작·본문·입력 대기를 구분하고, 종료 이력의 본문 반영과 오류 설명 구성을 독립시킨다.
- `codexCommand`의 후보 생성과 발견한 경로의 실행 명령 변환을 구분한다. 설정 우선과 npm 셸 래퍼 대체 규칙을 유지한다.
- `CodexProvider`의 설정 구성·질문 식별자를 풀어 써 응답 계약을 드러낸다. 짧고 명료한 공개 재내보내기는 유지한다.
- 소스 파일·클래스·공개 API·알고리즘 변경 제안은 없다.

## 검증 계획과 미확인 사항

- 실행 파일 탐색의 설정 우선·PATH 순서·JS/셸 래퍼·미발견 경로를 회귀 테스트로 추가하고 소스 변경 전후에 실행한다.
- 기존 [이벤트 라우터 테스트](../../tests/event-router.test.ts), [제목 테스트](../../tests/session-title.test.ts), [제공자 테스트](../../tests/providers.test.ts), [상태 테스트](../../tests/state.test.ts)와 타입 검사를 실행한다.
- 실제 로그인한 모델·UI·확장 설치는 이 내부 정리의 검증 범위에 포함하지 않는다.

## 결과

| 파일 | 적용 또는 유지 |
| --- | --- |
| [events.ts](../../src/runtime/codex/events.ts#L49) | 수신은 제외 대상 기록 → 제목 수집 → 실시간 이벤트 전달로 분리했다. 송신 프롬프트의 제목 수집과 제외 스레드·시작 요청 상태 이름도 구분했다. |
| [adapter.ts](../../src/runtime/codex/adapter.ts#L55) | 시작 턴·완성된 본문·입력 대기 반영, 종료 이력의 본문 수집·오류 설명 생성을 이름 있는 메소드로 나눴다. 지원 이벤트 검사를 payload 해석보다 먼저 수행하는 순서는 유지한다. |
| [executable.ts](../../src/runtime/codex/executable.ts#L7) | 후보 생성과 발견한 경로의 native/Node 실행 명령 변환을 분리했다. 설정 경로·디렉터리별 탐색 우선순위와 셸 래퍼 대체 규칙은 유지한다. |
| [provider.ts](../../src/runtime/codex/provider.ts) | 실행 옵션을 필드별로 표시하고 질문·답변 이름과 응답 매핑을 풀어 썼다. 순차 질문·취소 시 부분 응답을 보내지 않는 계약은 유지한다. |
| [index.ts](../../src/runtime/codex/index.ts) | 짧은 공개 재내보내기만 담당하여 변경하지 않았다. |

- 설정 우선·설정 누락 시 PATH 미사용, PATH 디렉터리/파일 우선순위, JS 확장자 대소문자, 셸 래퍼와 인접 npm 스크립트, 미발견 오류의 회귀 테스트 6개를 추가했다. 실행 파일을 실제로 시작하지 않고 임시 파일로 탐색·명령 변환 계약을 검증한다.
- 변경 전후 동일한 관련 테스트 118개와 `npm run check`의 타입 검사·전체 191개 테스트·확장/C# 빌드가 통과했다. 임시·하위 스레드 제외, 제목·첫 미리보기 우선순위, 일반 오류의 비종료 처리와 본문/종료 분리는 기존 테스트도 함께 확인했다.
- 상세 통합 범위와 남은 검증 제약은 [전체 런타임 기록](agent-runtimes.md)에 정리했다.
