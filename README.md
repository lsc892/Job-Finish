# Job-Finish

Windows-only completion notifications for Claude Code and Codex.

Job-Finish shows a Windows toast when an agent finishes work or waits for input. If you click the toast, it brings the existing VS Code window to the foreground. It can also flash the taskbar button and play the default Windows sound.

## Quick Start

```powershell
npx job-finish init
```

For local development from this repository:

```powershell
npm run build
node dist/index.js init
```

Other commands:

```powershell
npx job-finish doctor
npx job-finish preview
npx job-finish uninstall
```

## Features

| Mode | Description |
| --- | --- |
| Windows toast | Shows a native Windows notification. |
| Click to focus | Toast clicks open the existing VS Code window through `jobfinish-focus://`. |
| Open missing window | If the clicked toast no longer has a valid VS Code target, the helper opens the project with `code -n`. |
| Clear on focus | When the target VS Code window is focused manually, only that window's toast is removed. |
| Taskbar flash | Flashes the target window until it is focused or the configured timeout ends. |
| Sound | Plays the default Windows sound when enabled. When toast mode is also enabled, toast sound is used as the primary notification sound. |

When multiple VS Code windows are open, Job-Finish keeps them separate by passing the target window handle and process id through the toast activation URL. The clicked toast focuses the same window that was flashed. Focus behavior is designed so each VS Code window is handled independently when multiple windows are open.

## How It Works

```text
Claude Code Stop / AskUserQuestion, or Codex notify
  -> job-finish-notify.ps1
  -> Windows toast / taskbar flash / sound
  -> toast click runs jobfinish-focus://open
  -> HKCU protocol handler runs jf-focus-vscode.exe
  -> existing VS Code window is brought to foreground, or a new project window is opened
```

## Installed Files

Depending on the selected scope, files are written to either `~/.job-finish/` or `./.claude/job-finish/`.

- `job-finish-notify.ps1`
- `job-finish.config.json`
- `jf-focus-vscode.exe`

`init` removes old Job-Finish hooks from the other scope before installing the selected scope, so Claude does not run duplicate hooks from global and project settings at the same time.

## Scope Rules

Global installs take priority over project installs. If a global Claude hook or a Job-Finish Codex notify that does not point at the current project is already active, choosing a project install keeps that setup, skips the project install, and reports what it found.

Choosing a global install cleans the current project's Job-Finish hook and `./.claude/job-finish/` install folder first, so only the global setup remains active.

Codex only supports one global `notify` array in `~/.codex/config.toml`. A project-scoped Codex install still changes that global file, so Job-Finish treats an existing Codex notify as a global setting and will not silently replace an unrelated notify command.

## Requirements

- Windows
- Node.js 18+
- PowerShell

The bundled `jf-focus-vscode.exe` is self-contained, so a separate .NET runtime is not required on the target machine.

## Debug Logging

If you enable debug logging during install, Job-Finish writes:

- `job-finish.log` next to `job-finish-notify.ps1`
- `jf-focus-vscode.log` next to `jf-focus-vscode.exe`

These logs are only written when debug logging is enabled, so normal releases remain quiet.

## Uninstall

Remove hooks:

```powershell
npx job-finish uninstall
```

For a full local cleanup:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.job-finish" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force ".\.claude\job-finish" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "HKCU:\Software\Classes\jobfinish-focus" -ErrorAction SilentlyContinue
```

## License

MIT
