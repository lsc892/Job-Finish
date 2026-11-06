# 토스트 누락 로그 확인

새 빌드를 설치한 뒤 VS Code에서 `Developer: Reload Window`를 실행한다. 평소 사용하는 Codex·Claude 확장에서 작업을 실행하고 다른 창으로 이동한 상태에서 완료를 기다린다. 해당 VS Code 창을 보고 있으면 알림을 생략하는 것이 현재 정책이다.

누락이 발생하면 그 창에서 `Job-Finish: Show Diagnostics`를 실행하고 출력 패널의 **Job-Finish** 내용을 보관한다. 이 명령은 앞선 로그를 지우지 않고 현재 설정·연결·최근 결과·오류 스냅샷을 뒤에 붙인다. 로그는 확장 활성화부터 자동 기록하며 별도 디버그 설정이 필요하지 않다.

디스크의 출력 로그는 `Developer: Open Logs Folder`로 연 VS Code 로그 폴더 아래 `window*/exthost/output_logging_*/*-Job-Finish.log`에 있다. 기본 사용자 데이터 경로는 `%APPDATA%\Code\logs`다. 창이 여러 개면 `windowInstanceId`와 `application.started`의 버전·확장 경로로 구분한다. 다시 로드하면 새 로그 파일에 이어지므로 재현 당시 파일을 보관한다.

| 마지막으로 확인된 기록 | 확인할 내용 |
| --- | --- |
| `application.started`, `notifications.configured` | 실행 중인 빌드 경로·버전, enabled/toast/flash 설정, 제공자 확장 버전 |
| `observer.discovery.complete` | 감지된 연결 수. 0이면 roots·제공자 설치 상태와 같은 Extension Host인지 확인 |
| `observer.candidate.rejected` | 제공자처럼 보이지만 설치 확장 경로를 확인하지 못한 프로세스 |
| `observer.connection.attached/detached` | 관찰 연결의 생성·종료, 프로세스 ID와 연결 ID |
| `observer.frame.truncated`, `observer.frame.skipped` | 긴 문자열 축소 또는 구조 상한 초과 프레임 생략. direction으로 송수신을 구분하며 다음 프레임 관찰은 계속됨 |
| `runtime.lifecycle` | Codex 턴 시작·완료/오류 또는 Claude 결과가 실제 스트림에 도착했는지 확인 |
| `signal.received` | 완료·입력 대기 신호 생성 여부. 이후 기록은 notificationId로 연결 |
| `notification.skipped` | focused·disabled·not-owner·recent-question 중 생략 사유와 판정 단계 |
| `toast.skipped`, `toast.cancelled` | 토스트 설정 OFF, 비동기 준비 중 정책 변경·교체·중지·해제 여부 |
| `toast.helper.started/exit`, `diagnostic.error` | helper 경로·PID·종료 코드·stderr·오류와 관련 알림 ID |
| `toast.registration.ready` | Windows 알림 설정 상태(setting) |
| `toast.submitted`, `toast.history.confirmed`, `toast.observation.complete` | Windows 제출·알림 센터 기록·관찰 종료 결과와 notificationState |

Windows 제출이나 알림 센터 기록 확인만으로 화면 배너 표시를 보장하지는 않는다. 이 단계까지 성공했다면 Windows 알림 설정·방해 금지 상태도 함께 확인한다. 연결 스냅샷의 incomingMessages/outgoingMessages/lastIncomingEvent는 연결은 있지만 완료 신호가 없는 경우를 조사하는 데 쓴다.

추가한 자동 추적은 응답 본문 대신 식별자·상태·길이를 기록한다. 진단 명령이 덧붙이는 최근 결과 스냅샷에는 기존과 같이 응답 본문이 들어가므로 외부에 공유할 때 내용을 확인한다.

## 긴 본문·한글 표시 검증

빌드된 helper와 기존 `JobFinish.VSCode` 등록이 있는 환경에서 `node --import tsx tests/windows/toast-layout.ts`를 실행한다. 아이콘 켬·끔 토스트의 한글·이모지와 줄 수 제한을 Windows 알림 센터 XML에서 대조하고 자신이 만든 테스트 알림만 제거한다. 이 검사는 배너의 실제 시각 표시나 클릭을 보장하지 않는다.

한글이 포함된 JavaScript를 Windows PowerShell의 here-string 파이프로 `node`에 넘기지 않는다. 기본 `$OutputEncoding`이 US-ASCII이면 실행 전부터 한글이 `?`로 바뀔 수 있다. UTF-8 소스 파일을 직접 실행하는 위 검증 명령을 사용한다.
