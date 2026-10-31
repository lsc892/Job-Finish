# windows-toast

Windows 토스트를 등록·전달하고 클릭 승인 후 대상 VS Code 창을 활성화한다.

- [Program.cs](Program.cs) — `Program`: 등록·표시·활성화 명령과 확장 파이프의 클릭 승인을 조율한다.
  - `Target`: 대상 창의 핸들·프로세스·실행 파일·시작 시각을 전달한다.
  - `Request`: 토스트 표시와 클릭 승인에 필요한 알림·창·파이프 정보를 전달한다.
- [ComActivator.cs](ComActivator.cs) — `ComActivator`: COM 서버 등록과 STA 메시지 루프의 수명을 관리한다.
  - `ToastFactory`: Windows가 요청한 토스트 활성화 콜백의 COM 인스턴스를 생성한다.
  - `ToastCallback`: COM 활성화를 클릭 처리에 전달하고 서버 종료를 요청한다.
- [Focus.cs](Focus.cs) — `Focus`: 창과 프로세스의 결합을 확인하고 승인된 대상 창을 전면으로 활성화한다.
- [Branding.cs](Branding.cs) — `Branding`: 설치된 VS Code 실행 파일과 토스트 헤더용 앱 이미지를 찾는다.
- [ToastContent.cs](ToastContent.cs) — `ToastContent`: 텍스트와 선택적 로컬 이미지의 경로를 이스케이프해 토스트 XML을 구성한다.
- [Registration.cs](Registration.cs) — `Registration`: 토스트 바로가기의 앱 식별자·실행 경로·활성화 CLSID와 백업을 관리한다.
  - `Result`: 바로가기 변경 여부와 레거시 백업 경로를 전달한다.
  - `ShortcutInfo`: 바로가기에서 읽은 앱 식별자·실행 경로·활성화 CLSID를 전달한다.
  - `ShellLink`: Windows Shell Link COM 객체로 바로가기 저장소에 접근한다.
- [ToastDelivery.cs](ToastDelivery.cs) — `ToastDelivery`: 토스트를 제출하고 WinRT 콜백과 알림 기록을 관찰해 전달 결과를 보고한다.
- [JobFinish.Native.csproj](JobFinish.Native.csproj): 네이티브 도우미의 .NET 빌드·Windows 대상·단일 파일 게시 설정을 정의한다.
- [.gitignore](.gitignore): .NET 빌드 중간 파일과 실행 결과물을 버전 관리에서 제외한다.
