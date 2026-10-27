# native-toast

네이티브 알림 바로가기 등록과 COM 활성화 계약을 검증한다.

- [.gitignore](.gitignore) — C# 검증 실행 파일의 빌드·중간 산출물을 버전 관리에서 제외한다.
- [Program.cs](Program.cs) — `RegistrationTests`: 바로가기 이전·정확한 백업·반복 등록·타 앱 보호를 검증한다.
- [RegistrationTests.csproj](RegistrationTests.csproj) — 제품 등록 구현을 연결한 Windows 바로가기 검증 실행 파일을 구성한다.
- [com-activation](com-activation/README.md) — 실제 COM 콜백의 반환값·도우미 종료·등록 복원을 검증한다.
