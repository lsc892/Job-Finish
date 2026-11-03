# Job-Finish


**[English](README.md) · [한국어](README.ko.md) · 中文 · [日本語](README.jp.md)**

Claude Code 或 Codex 完成回复后，回到你的任务。

Job-Finish 将智能体的信号显示在对应的 VS Code 窗口中。即使同时处理多个项目，也能清楚地看到哪个任务已经收到回复。

![VS Code](https://img.shields.io/badge/platform-VS%20Code-0078D4)
![Status](https://img.shields.io/badge/status-verified%20MVP-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## 自动通知

检测同一 VS Code 窗口内 Codex 和 Claude Code 的运行时事件，通过 Windows 通知和任务栏闪烁提示完成、错误、取消和输入请求。点击通知返回对应窗口；提问与审批仍在原扩展中处理。

支持 Windows x64 本地桌面版 VS Code，安装后自动启用。最新安装方法见 [English](README.md)，验证范围见[验证报告](docs/verification.md)。

## 更新记录

<details>
<summary>v2.2.0（自 v2.1.2 起）</summary>

### 专注自动通知

移除直接执行、会话管理命令、执行设置和随附的 Claude SDK，专注现有扩展的通知检测。

### 内部结构重构

按职责拆分智能体执行、会话管理、通信和 Windows 通知，并整理共用处理流程。

### 通知标题与图标改进

在通知中显示会话标题，并恢复 VS Code 图标和默认图片。

### 设置分类整理

将自动检测和通知设置分为 General 和 Notifications，方便查找所需选项。

### Codex 异步提问通知

检测 Codex 异步提问事件，在需要用户输入时显示通知。

### 抑制重复完成通知

减少 Codex 提问后紧接着出现的完成事件造成的重复通知。

### 恢复现有安装的更新路径

恢复现有 npm 和 Marketplace 安装更新至新版本的路径。

</details>

## 许可证

[MIT](README.md#license)
