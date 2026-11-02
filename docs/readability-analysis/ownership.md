# 소유권 잠금의 오류 경계와 해제 흐름 정리

2026-11-02. 사용자 요청에 따라 [소유권 관리](../../src/core/ownership.ts)와 [Windows gate](../../src/windows/gate.ts)의 파일 내부 흐름을 정리한다.

## 확인한 문제와 적용 범위

- `Ownership.gate()`가 플랫폼 선택, 파일 열기 실패의 오류 변환, PID 기록, 작업 실행, 파일 정리를 함께 처리해 연속된 두 `try`의 목적을 구분해야 했다.
- `claimLock()`·`release()`의 콜백 안에서 잠금 아래 수행할 소유자 갱신·해제를 정의하고, `read()`·`alive()`·`Lease`는 여러 동작을 한 줄에 모아 놓았다.
- Windows gate의 API 초기화·핸들 확보·작업 실행·해제도 한 함수에 섞여 있었다.

같은 파일 안에서 플랫폼 선택, 확보 오류 변환, 작업과 해제, 소유자 갱신을 이름 있는 함수로 구분한다. 실행과 해제는 `확보 → try에서 작업 → finally에서 해제` 순서로 읽히게 한다. 파일·클래스 배치와 공개 API, 잠금 알고리즘은 유지하며 별도 구조 변경 후보는 없다.

## 보존할 계약과 검증 계획

두 소유권 키의 확보 순서와 실패 시 롤백, 임의 토큰·PID 검증, 파일 경로·체크포인트 형식, 예외 메시지·전파 순서, 플랫폼별 gate 해제와 Windows API 초기화·플래그를 유지한다. [소유권 테스트](../../tests/ownership.test.ts)의 Windows·대체 플랫폼·실패 정리 계약과 타입 검사를 실행한다.

## 적용 결과

- [소유권 확보](../../src/core/ownership.ts#L38)는 키·토큰 준비 → 두 잠금 확보 → Lease 생성 순서로 읽힌다. [두 잠금 확보와 롤백](../../src/core/ownership.ts#L46), [gate 안의 소유자 갱신](../../src/core/ownership.ts#L66), [토큰을 확인한 해제](../../src/core/ownership.ts#L129)를 이름 있는 메소드로 구분했다.
- [플랫폼 선택](../../src/core/ownership.ts#L92)은 해당 gate 실행만 위임한다. [대체 플랫폼 gate](../../src/core/ownership.ts#L101)는 파일 확보 뒤 하나의 `try/finally`로 PID 기록·작업 실행·정리를 담당하고, [파일 확보 실패의 오류 변환](../../src/core/ownership.ts#L112)은 `openPortableGate()`만 맡는다.
- [Windows gate](../../src/windows/gate.ts#L16)는 API 조회 → 핸들 확보 → 작업 실행 → `finally`에서 해제로 읽힌다. API는 계속 처음 사용할 때 한 번 생성하며, [핸들 확보](../../src/windows/gate.ts#L38)의 access·open·attribute 플래그를 같은 값의 상수로 표시했다. 실패 직후 Win32 오류를 읽는 순서도 유지했다.
- 소유자 읽기·PID 생존 판정과 `Lease` 저장·해제를 펼쳐 각각의 예외·반환·상태 변경 시점을 드러냈다. 실패 중 추가 해제 오류가 나면 기존처럼 그 오류가 전파되고, 파일 핸들 해제가 실패하면 뒤의 삭제도 실행되지 않는 기존 순서를 유지했다.
- `node --import tsx --test tests/ownership.test.ts`: 7개 테스트 통과. 두 번째 잠금 실패 시 부분 롤백, 대체 플랫폼의 확보/작업 실패 구분과 gate 정리, 다른 토큰 보존, 죽은 PID 회수, Windows 배타 핸들·강제 종료 복구·작업 예외 뒤 해제를 확인했다.
- `npm run typecheck`와 `git diff --check` 통과. 실제 계정·모델 호출과 UI 동작은 이 파일 내부 리팩터링의 검증 범위에 포함하지 않았다.
- 메인 검토 후 `npm run check`의 타입 검사·전체 169개 테스트·확장/C# 빌드가 통과했다. 대체 플랫폼 검사는 Windows에서 `process.platform` 값을 제어해 해당 분기를 실행했으며 실제 Linux 환경 검증과는 구분한다.
