# tests

자동 감지와 Windows 알림의 검증 코드다. 명령은 저장소 루트에서 실행한다.

| 위치 | 검증 | 명령 |
| --- | --- | --- |
| `*.test.ts` | 이벤트 해석·세션 격리·중복 제거·포커스·토스트·클릭 계약 | `npm test` |
| [load](load/README.md) | 합성 이벤트와 8개 스트림의 10만 턴·메모리 상한 | `npm run test:load`, `npm run test:router-load` |
| [vscode](vscode/README.md) | 실제 확장 호스트의 자동 감지·명령·설정 전환·창별 격리 | `npm run test:extension`, `npm run test:windows` |
| [windows](windows/README.md) | 네이티브 등록·클릭·창 활성화·프로세스 계약 | `npm run test:toast`, `npm run test:native` |
| [native-toast](native-toast/README.md) | C# 등록·COM 계약 | `test:native`에서 사용 |
| [package](package/README.md) | 격리 VSIX 설치·의존성·이미지·도우미 | `npm run test:package` |
| [fixtures](fixtures/README.md) | 관찰 대상 합성 프로세스와 실제 기록 이벤트 | 각 검증에서 사용 |

`npm run typecheck`는 제품과 테스트를 별도로 검사한다. 실제 모델을 호출하는 실행기와 직접 실행·세션 복구 테스트는 제거했다. Windows 배너의 시각 확인은 자동화된 계약 검사와 구분한다.
