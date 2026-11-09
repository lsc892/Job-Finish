# build

[extension.mjs](extension.mjs)가 C# 알림 도우미를 게시하고 VS Code 확장을 번들링한다.

| 명령 | 출력 | 자동 추적 로그 |
| --- | --- | --- |
| `npm run build` | `dist/extension.cjs`, `dist/native/` | 번들에서 제외 |
| `npm run build:diagnostics` | `dist-diagnostics/extension.cjs`·소스맵, `dist-diagnostics/native/` | 포함 |

로그 전용 문장은 `diagnostic:` 라벨로 표시하며 일반 빌드에서 해당 문장과 인수 평가를 함께 제거한다. Codex 상세 추적기도 진단 라벨 안에서만 생성·호출하므로 일반 번들에는 포함되지 않는다. 라벨에 알림 판정·전송·자원 정리 같은 제품 동작을 넣지 않는다. 오류 보관과 `Show Diagnostics`의 수동 스냅샷은 일반 빌드에도 남고, helper의 필수 전송·클릭 응답도 유지한다.

`npm run package`는 prepublish에서 일반 빌드를 다시 만든 뒤 Windows x64 VSIX로 묶는다. 진단 폴더·소스맵·테스트 소스·로그 파일은 VSIX에서 제외한다. 진단 빌드는 일반 산출물을 덮어쓰지 않으며 실행용 배치는 [로그 안내](../docs/notification-debugging.md)를 따른다. 런타임 의존성은 Windows API 호출용 `koffi`다.
