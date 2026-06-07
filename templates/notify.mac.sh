#!/usr/bin/env bash
# job-finish-notify (macOS) — focus-aware completion notifier for Claude Code / Codex.
# Usage: notify.mac.sh <stop|notify|codex> [codex-json]
#   Claude passes a JSON payload on stdin; Codex appends its JSON as the final arg.
# Reads choices from job-finish.config.sh next to this script.

EVENT="${1:-stop}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------------------- load config
JF_MODES="os flash"; JF_FLASH_TIMEOUT="5m"; JF_SOUND_ENABLED="1"
JF_SOUND_PATH=""; JF_SUPPRESS_FOCUSED="1"; JF_WATCH_APP=""
# shellcheck source=/dev/null
[ -f "$DIR/job-finish.config.sh" ] && . "$DIR/job-finish.config.sh"

has_mode() { case " $JF_MODES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ------------------------------------------------------------- event payload
PAYLOAD=""
if [ "$EVENT" = "codex" ]; then
  PAYLOAD="${2:-}"
elif [ ! -t 0 ]; then
  PAYLOAD="$(cat 2>/dev/null)"
fi
extract() { printf '%s' "$PAYLOAD" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }

PROJECT="$(basename "$PWD")"
CWD="$(extract cwd)"; [ -n "$CWD" ] && PROJECT="$(basename "$CWD")"

case "$EVENT" in
  notify) TITLE="Job-Finish · 입력 대기"; TEXT="$PROJECT · 입력을 기다리는 중" ;;
  codex)  TITLE="Job-Finish · Codex 완료"
          LAST="$(extract last-assistant-message)"
          TEXT="${LAST:-$PROJECT · 작업이 끝났어요}" ;;
  *)      TITLE="Job-Finish · 작업 완료"; TEXT="$PROJECT · 작업이 끝났어요" ;;
esac
TEXT="${TEXT:0:180}"

# ------------------------------------------------------------ focus detection
# Parent-process walking to a GUI app is unreliable on macOS, so we check which
# app is frontmost and treat known editor/terminal hosts as "you are looking".
frontmost_app() {
  osascript -e 'tell application "System Events" to name of first process whose frontmost is true' 2>/dev/null
}
is_focused() {
  local front; front="$(frontmost_app)"
  [ -z "$front" ] && return 1
  if [ -n "$JF_WATCH_APP" ]; then
    case "$front" in *"$JF_WATCH_APP"*) return 0 ;; *) return 1 ;; esac
  fi
  case "$front" in
    "Code"|"Visual Studio Code"|"Electron"|"Code - Insiders"|\
    "iTerm2"|"Terminal"|"WezTerm"|"Alacritty"|"kitty"|"Warp") return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$JF_SUPPRESS_FOCUSED" = "1" ] && is_focused; then
  exit 0
fi

# ------------------------------------------------------------------- notify
if has_mode os; then
  # Escape double quotes for AppleScript.
  AT="${TITLE//\"/\\\"}"; AX="${TEXT//\"/\\\"}"
  osascript -e "display notification \"$AX\" with title \"$AT\"" 2>/dev/null
fi

# ------------------------------------------------------------- flash (dock)
# macOS has no clean external API to bounce another app's dock icon, so mode
# "flash" degrades to the notification + sound above. Documented limitation.

# ------------------------------------------------------------------- sound
if [ "$JF_SOUND_ENABLED" = "1" ]; then
  SND="$JF_SOUND_PATH"; [ -z "$SND" ] && SND="/System/Library/Sounds/Glass.aiff"
  [ -f "$SND" ] && afplay "$SND" >/dev/null 2>&1 &
fi

exit 0
