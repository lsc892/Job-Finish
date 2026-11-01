# Job-Finish

现已实现 Windows x64 VS Code 扩展和基于运行时事件的测试。最新安装方法与支持范围请参阅 [English](README.md)，验证结果见[验证报告](docs/verification.md)。以下 MVP 描述为历史验证记录。

**[English](README.md) · [한국어](README.ko.md) · 中文 · [日本語](README.jp.md)**

Claude Code 或 Codex 完成回复后，回到你的任务。

Job-Finish 将智能体的信号显示在对应的 VS Code 窗口中。即使同时处理多个项目，也能清楚地看到哪个任务已经收到回复。

![VS Code](https://img.shields.io/badge/platform-VS%20Code-0078D4)
![Status](https://img.shields.io/badge/status-verified%20MVP-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## 正在开发

- 在 VS Code 中查看 Claude Code 和 Codex 的信号。
- 按窗口区分结果，包括打开同一项目的多个窗口。
- 明确的回复完成提示，以及查看智能体结果的界面。

## 当前状态

已通过 TypeScript VS Code 扩展 MVP 验证真实智能体调用、会话日志信号和窗口标识。目前仓库保留项目介绍、开发文档以及决策与验证日志，已移除可执行 MVP 和测试文件。

[开发文档](docs/requirements-and-verification.md)说明功能、实现算法和完成条件；[日志](docs/일지.md)保存选择依据、历史实现和实测结果。

## 许可证

[MIT](README.md#license)
