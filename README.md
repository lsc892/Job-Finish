# Job-Finish

**English · [한국어](README.ko.md) · [中文](README.zh.md) · [日本語](README.jp.md)**

Get back to your task when Claude Code or Codex finishes a response.

Job-Finish brings agent signals into the VS Code window where they belong, so you can keep moving between projects and see which task is ready.

![VS Code](https://img.shields.io/badge/platform-VS%20Code-0078D4)
![Status](https://img.shields.io/badge/status-verified%20MVP-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## What we're building

- Claude Code and Codex signals in VS Code.
- Results tied to their own window, including windows sharing the same project.
- Clear completion signals and a place to review the agent's response.

## Current stage

Real agent calls, session-log signals, and window identities were verified with a TypeScript VS Code extension MVP. This repository now keeps the introduction and a single implementation and verification document; executable MVP and test files have been removed.

Read the [feature algorithms, reference implementation, and verification results](docs/requirements-and-verification.md).

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
