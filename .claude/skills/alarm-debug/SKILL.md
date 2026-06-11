---
name: alarm-debug
description: Fire the job-finish notification events on demand to verify they work. Asks via AskUserQuestion whether the "input waiting" alarm rang, then ends so the "work finished" alarm fires. Use when the user wants to test/debug job-finish alarms, check if the notification rang, or invokes /alarm-debug.
---

# alarm-debug

job-finish 알림이 실제로 울리는지 수동으로 검증하는 테스트 스킬. 두 이벤트를 차례로 발화시킨다:

1. **입력 대기 알림** — `AskUserQuestion`(PreToolUse) 훅이 잡아 알림을 띄운다.
2. **작업 완료 알림** — 스킬이 끝나 에이전트가 멈추면 `Stop` 훅이 띄운다.

## 절차

1. 다른 말 하기 전에 **바로 `AskUserQuestion`** 을 호출한다 (이게 입력 대기 알림을 발화시킴):
   - header: `알람 확인`
   - question: `입력 대기 알람이 울렸나요?`
   - options: `네, 울렸어요` / `아니요, 안 울렸어요`

2. 답을 받으면 **한 줄로만** 끝낸다 — 추가 도구 호출 없이:
   - 울렸으면: `입력 대기 알람 확인됨. 이제 작업 완료 알람이 울립니다.`
   - 안 울렸으면: `입력 대기 알람이 안 울렸어요. 이제 작업 완료 알람이 울립니다.`

3. 그 한 줄을 마지막 응답으로 두고 멈춘다. 멈추는 순간 `Stop` 훅이 작업 완료 알림을 띄운다.

## 주의

- 1번 `AskUserQuestion` 전에 다른 텍스트/도구를 끼우지 말 것 — 알림 타이밍이 흐려진다.
- 답변 후에는 절대 추가 작업을 벌이지 말 것. 목적은 "체크 → 완료 알림"뿐이다.
