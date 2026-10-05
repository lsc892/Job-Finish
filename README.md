# Job-Finish

**English · [한국어](README.ko.md) · [中文](README.zh.md) · [日本語](README.jp.md)**

Get back to your task when Claude Code or Codex finishes a response.

Job-Finish brings agent signals into the VS Code window where they belong, so you can keep moving between projects and see which task is ready.

![VS Code](https://img.shields.io/badge/platform-VS%20Code-0078D4)
![Status](https://img.shields.io/badge/status-implementation%20%2B%20verification-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- Claude Code and Codex signals in VS Code.
- Results tied to their own window, including windows sharing the same project.
- Clear completion signals and a place to review the agent's response.

## Current stage

The Windows x64 extension automatically observes the existing Codex and Claude extensions' stdio runtime events in the same Extension Host, then routes completion, errors, and input requests to this window's toasts and flash. `jobFinish.enabled` defaults to `true` and changes immediately. Existing and newly spawned agent processes are observed without provider hooks, transcript scans, additional App Servers, or model calls. Direct Job-Finish execution remains available.

Observation uses Node's internal process discovery/spawn methods and checks installed provider paths and stream arguments. Provider or VS Code changes can affect compatibility. Separate Extension Hosts, WSL/remote agents, and external terminal processes are outside automatic observation. Use **Job-Finish: Show Diagnostics** to inspect `automatic.connections`; approvals and answers for existing chats stay in their original UI.

Use Node.js 22+ and run `npm ci`, `npm run check`, then `npm run package`. Install `job-finish-win32-x64.vsix` with **Extensions: Install from VSIX…**, or press F5 for a development window. Codex needs an installed, authenticated compatible CLI (live-tested with 0.160.0). The bundled Claude SDK CLI also needs valid authentication.

For automatic legacy migration and version-aware installation, install the independent CLI dependencies with `npm --prefix tools/installer ci`, then run `npm run install:extension -- --vsix ./job-finish-win32-x64.vsix`. `npm run update:extension` uses the same reconciliation flow. Add `--dry-run` to preview or `--profile <name>` to select a VS Code profile. The tool backs up and removes legacy PowerShell/C# hooks/files before installing, updates older extensions, and preserves equal or newer versions. It compares the VSIX's extension version, preserves current extension settings/data, and checks VSIX validity and VS Code compatibility before cleanup. Direct VSIX installation through VS Code bypasses this migration step. See [installer instructions](tools/installer/README.md) for npm/npx packaging.

Run **Job-Finish: Run Codex** or **Run Claude** from the command palette. Use **Answer Pending Request** for tool approvals/questions and **Show Results** for recent responses. Commands also support continuing, cancellation, saved-session resumption, reconnection, releasing ownership, and native window binding. The status bar opens pending requests when present.

Set `jobFinish.codexMode` to `plan` for structured planning questions in newly connected Codex sessions. Permission approvals grant only the requested permissions for the current turn. Recovery reads bounded history pages and preserves unknown outcomes when the runtime cannot confirm them.

See the [Korean usage guide](README.ko.md) for configuration defaults and the [verification report](docs/verification.md) for evidence and outstanding acceptance checks. The extension supports local desktop execution; remote workspaces and web hosts are outside this release. Clicking a toast stops its flash and activates the verified originating window, restoring it if minimized. Missing window bindings or refused foreground activation appear in **Show Diagnostics**. Toast callbacks are limited to the live toast process, not delayed Action Center activation after shutdown.

Read the [development document](docs/requirements-and-verification.md) for features, implementation algorithms, and acceptance criteria. The [journal](docs/일지.md) contains the rationale, historical implementations, and measured results.

## Remove the old PowerShell/C# installation

The installer is an independent package in [tools/installer](tools/installer/README.md), with its own dependencies and tests. Its uninstall command can also remove legacy installations separately. From the repository root:

```powershell
npm --prefix tools/installer ci
npm run uninstall:legacy -- --dry-run
npm run uninstall:legacy
npm run uninstall:legacy -- --keep-files
npm run uninstall:legacy -- --project "C:\Projects\MyProject"
```

The root command forwards arguments to the standalone package. You can also run `npm --prefix tools/installer run uninstall:legacy -- --dry-run` directly. The default project and relative paths use the directory from which the command was invoked. The tool is excluded from the VSIX.

The command removes Job-Finish hooks from user and selected project settings, backs up changed settings beside their originals, and removes verified legacy installation folders, the focus protocol and its Start Menu shortcut. It also checks `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when set. `--dry-run` only previews changes; `--keep-files` removes hooks while retaining files and Windows registrations. Changed Codex TOML is reformatted without comments; its original text remains in the backup. Run with `--project` for each additional project installation. C# source projects and the current VS Code extension are preserved. If the old npm package was installed globally, remove it separately with `npm rm -g job-finish`.

## License

MIT License

Copyright (c) 2026 lsc892

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
