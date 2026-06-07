# Job-Finish

> Claude Code / Codex가 작업을 끝내면 **포커스 인식 알림**을 띄웁니다.
> OS 알림 · 작업표시줄 깜빡임 · 소리 — `npx` 한 줄로 설치.

터미널을 계속 쳐다보지 않아도, 에이전트가 일을 끝내면 알려줍니다.
**보고 있는 창은 방해하지 않고**, 다른 일을 하고 있을 때만 알립니다.

## 빠른 시작

```bash
npx job-finish init
```

대화형 마법사가 OS를 감지하고, 알림 모드를 고르게 한 뒤(스페이스로 체크),
Claude Code의 `settings.json` 훅 / Codex의 `config.toml` notify에 안전하게 연결합니다.
설치 후 에이전트를 다시 시작하세요.

```bash
npx job-finish doctor      # 의존성 점검 + 테스트 알림
npx job-finish preview     # 현재 설정으로 미리보기(포커스 상태 반영)
npx job-finish uninstall   # 훅 제거(설정은 백업됨)
```

## 알림 모드

| 모드 | 설명 |
|---|---|
| **OS 알림창** | Windows 알림 센터 / macOS 알림 센터 / Linux `notify-send` |
| **작업표시줄 깜빡임** | **창을 안 보고 있을 때만** 깜빡임. 그 창을 다시 보면 자동으로 멈춤. 최대 시간: 30초 / 5분 / 10분 / 무한 |
| **소리** | on/off. OS 기본음 재생 |

### 포커스 인식 (확장 없이 동작하는 핵심)

알림 프로세스는 자신의 **부모 프로세스 체인을 거슬러 올라가** 에이전트를 띄운
GUI 창(예: VSCode `Code.exe`, Windows Terminal, 콘솔)을 찾습니다.

- 그 창을 **보고 있으면(포커스) → 알림 생략**
- **안 보고 있으면 → 알림 + 깜빡임**
- 그 창을 **다시 포커스하면 깜빡임 자동 종료**
  (Windows `FlashWindowEx`의 `FLASHW_TIMERNOFG`가 OS 차원에서 처리)

VSCode 통합 터미널, Claude Code 확장, 순수 터미널 어디서 실행해도 동작합니다.

## 동작 방식

```
에이전트 작업 완료 / 입력 대기
   └─ hook(Stop / PreToolUse:AskUserQuestion) 또는 Codex notify
        └─ job-finish-notify.(ps1|sh)   ← OS별 생성 스크립트
             ├─ job-finish.config.(json|sh) 읽기
             ├─ 호스트 창 포커스 판정
             └─ 알림 / 깜빡임 / 소리 디스패치
```

> `init` 은 설치 전에 **다른 스코프(전역/프로젝트)에 남은 job-finish 훅을 먼저 리셋**합니다.
> Claude 는 유저·프로젝트 설정의 훅을 모두 실행하므로, 두 곳에 남아 있으면 한 번 일에 알림이 두 번 떠요.
> 그래서 항상 **선택한 한 스코프에만** 활성 훅을 남깁니다.

설치되는 파일 (범위에 따라 `~/.job-finish/` 또는 `./.claude/job-finish/`):

- `job-finish-notify.ps1` (Windows) 또는 `job-finish-notify.sh` (mac/Linux)
- `job-finish.config.json` (Windows) 또는 `job-finish.config.sh` (mac/Linux) — 재설치 없이 직접 수정 가능

## 플랫폼별 참고

- **Windows**: PowerShell 내장으로 추가 설치 불필요. OS 알림은 WinRT 토스트, 실패 시 풍선 알림으로 폴백.
- **macOS**: `osascript`/`afplay` 사용. Dock 바운스는 외부 제어 제약으로 **알림 + 소리**가 대체 신호(깜빡임 모드는 best-effort).
- **Linux(X11)**: `notify-send`(libnotify), 깜빡임은 `wmctrl`의 urgency hint, 소리는 `paplay`/`aplay`/`ffplay`.

## 요구 사항

- Node.js 18+ (설치 CLI 실행용 — 런타임 알림 스크립트는 Node 불필요)
- macOS/Linux는 위 표의 시스템 도구. `npx job-finish doctor`로 점검하세요.

## 라이선스

MIT
