# protocol

생성된 Codex App Server 타입에서 확장에 필요한 선언과 전이 의존 타입을 선별한다.

- [vendor-protocol.mjs](vendor-protocol.mjs) — `.generated/codex160`의 타입을 읽어 `src/protocol`로 복사한다. 첫 번째 인자로 다른 생성 타입 폴더를 지정할 수 있다.

저장소 루트에서 `codex app-server generate-ts --experimental --out .generated/codex160`으로 타입을 생성한 뒤 `node build/protocol/vendor-protocol.mjs`를 실행한다. 현재 지원 버전과 갱신 기준은 [프로토콜 안내](../../src/protocol/README.md)를 따른다.
