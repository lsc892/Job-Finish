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

The repository contains a Windows x64 desktop VS Code extension, bounded event/state processing, exclusive session ownership, Codex App Server and Claude Agent SDK execution controls, native toasts, and HWND-specific flash. Completion detection uses runtime events directly. Only executions started or resumed through Job-Finish are supported; existing agent extensions are not implicitly connected.

Use Node.js 22+ and run `npm ci`, `npm run check`, then `npm run package`. Install `job-finish-win32-x64.vsix` with **Extensions: Install from VSIX…**, or press F5 for a development window. Codex needs an installed, authenticated compatible CLI (live-tested with 0.160.0). The bundled Claude SDK CLI also needs valid authentication.

Run **Job-Finish: Run Codex** or **Run Claude** from the command palette. Use **Answer Pending Request** for tool approvals/questions and **Show Results** for recent responses. Commands also support continuing, cancellation, saved-session resumption, reconnection, releasing ownership, and native window binding. The status bar opens pending requests when present.

Set `jobFinish.codexMode` to `plan` for structured planning questions in newly connected Codex sessions. Permission approvals grant only the requested permissions for the current turn. Recovery reads bounded history pages and preserves unknown outcomes when the runtime cannot confirm them.

See the [Korean usage guide](README.ko.md) for configuration defaults and the [verification report](docs/verification.md) for evidence and outstanding acceptance checks. The extension supports local desktop execution; remote workspaces and web hosts are outside this release. Toast callbacks are limited to the live toast process, not delayed Action Center activation after shutdown.

Read the [development document](docs/requirements-and-verification.md) for features, implementation algorithms, and acceptance criteria. The [journal](docs/일지.md) contains the rationale, historical implementations, and measured results.

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
