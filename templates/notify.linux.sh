#!/usr/bin/env bash
# job-finish-notify (Linux/X11) — focus-aware completion notifier for Claude Code / Codex.
# Usage: notify.linux.sh <stop|notify|codex> [codex-json]
#   Claude passes a JSON payload on stdin; Codex appends its JSON as the final arg.
# Reads choices from job-finish.config.sh next to this script.

EVENT="${1:-stop}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------------------- load config
JF_MODES="toast flash"; JF_FLASH_TIMEOUT="5m"; JF_SOUND_ENABLED="1"
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

# --------------------------------------------------- find host window (by PID)
# Walk /proc parent chain; match each PID against windows known to wmctrl.
host_window() {
  command -v wmctrl >/dev/null 2>&1 || return 1
  local pid=$$ depth=0 wid
  while [ "$pid" -gt 1 ] && [ "$depth" -lt 12 ]; do
    wid="$(wmctrl -lp 2>/dev/null | awk -v p="$pid" '$3==p {print $1; exit}')"
    if [ -n "$wid" ]; then printf '%s' "$wid"; return 0; fi
    pid="$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)"
    [ -z "$pid" ] && break
    depth=$((depth + 1))
  done
  return 1
}

active_window() { xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | grep -o '0x[0-9a-fA-F]*' | head -1; }

# ------------------------------------------------------------ focus detection
is_focused() {
  local host act; host="$(host_window)"; act="$(active_window)"
  [ -z "$act" ] && return 1
  if [ -n "$host" ]; then
    # Normalize hex width before comparing.
    [ "$((host))" = "$((act))" ] && return 0 || return 1
  fi
  # Fallback: compare active window class against editor/terminal hosts.
  local cls; cls="$(xprop -id "$act" WM_CLASS 2>/dev/null | tr 'A-Z' 'a-z')"
  if [ -n "$JF_WATCH_APP" ]; then
    case "$cls" in *"$(printf '%s' "$JF_WATCH_APP" | tr 'A-Z' 'a-z')"*) return 0 ;; *) return 1 ;; esac
  fi
  case "$cls" in
    *code*|*terminal*|*konsole*|*kitty*|*alacritty*|*wezterm*|*tilix*|*xterm*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$JF_SUPPRESS_FOCUSED" = "1" ] && is_focused; then
  exit 0
fi

# ------------------------------------------------------------------- notify
if has_mode toast || has_mode os; then
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "$TITLE" "$TEXT" >/dev/null 2>&1
  fi
fi

# --------------------------------------------------------- flash (urgency hint)
# Set _NET_WM_STATE_DEMANDS_ATTENTION on the host window — the taskbar entry
# highlights and the WM clears it automatically when the window is focused.
if has_mode flash; then
  WID="$(host_window)"
  if [ -n "$WID" ] && command -v wmctrl >/dev/null 2>&1; then
    wmctrl -i -r "$WID" -b add,demands_attention >/dev/null 2>&1
  fi
fi

# ------------------------------------------------------------------- sound
if [ "$JF_SOUND_ENABLED" = "1" ]; then
  SND="$JF_SOUND_PATH"; [ -z "$SND" ] && SND="/usr/share/sounds/freedesktop/stereo/complete.oga"
  if [ -f "$SND" ]; then
    if command -v paplay >/dev/null 2>&1; then paplay "$SND" >/dev/null 2>&1 &
    elif command -v aplay >/dev/null 2>&1; then aplay "$SND" >/dev/null 2>&1 &
    elif command -v ffplay >/dev/null 2>&1; then ffplay -nodisp -autoexit "$SND" >/dev/null 2>&1 &
    fi
  fi
fi

exit 0
