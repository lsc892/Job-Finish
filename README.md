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
| Taskbar flash | Flashes the target window until it is focused or the configured timeout ends. |
| Sound | Plays the default Windows sound when enabled. |

## How It Works

```text
Claude Code Stop / AskUserQuestion, or Codex notify
  -> job-finish-notify.ps1
  -> Windows toast / taskbar flash / sound
  -> toast click runs jobfinish-focus://open
  -> HKCU protocol handler runs jf-focus-vscode.exe
  -> existing VS Code window is brought to foreground
```

## Installed Files

Depending on the selected scope, files are written to either `~/.job-finish/` or `./.claude/job-finish/`.

- `job-finish-notify.ps1`
- `job-finish.config.json`
- `jf-focus-vscode.exe`

`init` removes old Job-Finish hooks from the other scope before installing the selected scope, so Claude does not run duplicate hooks from global and project settings at the same time.

## Requirements

- Windows
- Node.js 18+
- PowerShell

The bundled `jf-focus-vscode.exe` is self-contained, so a separate .NET runtime is not required on the target machine.

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
