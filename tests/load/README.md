# load

합성 이벤트를 사용해 보관 상태·메모리·이벤트 처리 성능을 검증한다.

- [load.ts](load.ts) — 대량 세션 이벤트와 JSONL 디코딩 후 상태 상한·힙 증가를 검사한다. `npm run test:load`로 실행한다.
- [router-load.ts](router-load.ts) — fixture 에이전트 8개의 대량 스트림으로 관찰·라우팅 성능을 측정하고 `test-artifacts/router-load.json`에 기록한다. `npm run test:router-load`로 실행한다.

`RouterLoadProbe.run()`은 준비 실행 → 측정 시작 → 이벤트 전송·완료 대기 → 측정 종료 → 상태 검증 → 보고서 저장을 조율한다. 에이전트 생성·신호 보관·JSONL 생성·전송과 `drain` 대기·측정·검증·보고·종료는 역할별 메소드로 나누며, 종료 대기 Promise는 `stopAgent()` 한 곳에서만 만든다.

저장소 루트에서 실행한다. 두 npm 명령은 GC 측정을 위해 `--expose-gc`를 전달하며 실제 모델을 호출하지 않는다.
