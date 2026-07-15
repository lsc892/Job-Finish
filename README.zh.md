# Job-Finish

**[English](README.md) · [한국어](README.ko.md) · 中文 · [日本語](README.ja.md)**

无需一直盯着终端，确认 AI 智能体是否已经完成。
当 Claude Code 正在等待输入，或者 Claude Code/Codex 的任务结束时，通过 Windows 通知让你第一时间回到工作。

| 弹窗通知 | 任务栏闪烁 |
| :---: | :---: |
| <img src="resources/Toast.gif" alt="弹窗通知演示" width="420"> | <img src="resources/Flash.gif" alt="任务栏闪烁演示" width="420"> |
| 点击弹窗即可跳回 VS Code | 在你回来之前目标窗口持续闪烁 |

![Platform](https://img.shields.io/badge/platform-Windows-0078D4)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![License](https://img.shields.io/badge/license-MIT-blue)

## 主要功能

- 同时支持 Claude Code 与 Codex —— 一次性接入 Claude Code 的 `Stop` / `AskUserQuestion` 与 Codex 的 `notify` 事件。
- Windows 原生通知 —— 以 toast 通知的形式展示任务完成、等待输入以及智能体的最后一条消息。
- 异常中断提醒 —— 当 Claude Code 因用量/会话额度耗尽或 API 错误而停止时也会通知，并使用不同的标题（`Usage limit reached` / `API error`），一眼即可与正常完成区分开。
- 点击通知回到 VS Code —— 点击 toast 后，会找到已有的 VS Code 窗口并将其带到前台。
- 窗口已关闭也能打开项目 —— 如果目标 VS Code 窗口已被关闭，会通过 `code -n <project>` 的方式重新打开项目窗口。
- 焦点感知 —— 如果你已经在看着 VS Code，可以跳过通知；重新聚焦时，仅清理对应窗口的通知。
- 任务栏闪烁 —— 即使错过了通知，目标窗口也会在任务栏中闪烁。可在 `30s`、`5m`、`10m`、`infinite` 中选择。
- 声音提醒 —— 通过操作系统默认提示音听到任务完成。
- global / project 两种安装范围 —— 可选择面向整个账户，或仅面向当前项目安装。
- 安全的配置合并 —— 不会覆盖 Claude/Codex 配置，只追加所需的 hook，并在修改前留下 `.bak` 备份。
- 防止重复通知 —— 清理旧的 Job-Finish hook 残留，并检测 Codex notify 冲突。
- 诊断与预览 —— 通过 `doctor`、`preview` 命令快速确认当前安装状态与通知效果。
- 仅在 VS Code 中生效 —— Codex Desktop、Claude Desktop、Orca ADE 等桌面客户端自带通知功能，会与 Job-Finish 冲突。因此通知与任务栏闪烁仅在智能体运行于 VS Code 时触发，从这些其他环境触发的 hook 会被跳过。

## 支持对象

| 对象 | 接入方式 | 通知时机 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` 或 `./.claude/settings.json` hooks | 任务完成、`AskUserQuestion` 等待输入、额度耗尽 / API 错误中断 |
| Codex | `~/.codex/config.toml` 的 `notify` | 任务完成、最后一条 assistant 消息 |

> Job-Finish 是仅面向 Windows 的工具。它使用了 PowerShell、Windows toast API 以及 VS Code 窗口焦点处理。

## 安装

```powershell
npx job-finish init zh
```

安装向导默认使用英语。可在命令末尾添加语言代码，以韩语、中文或日语运行：

```powershell
npx job-finish init     # 英语
npx job-finish init jp  # 日语
npx job-finish init ko  # 韩语
```

在安装向导中可选择以下内容：

| 配置项 | 说明 |
| --- | --- |
| 安装范围 | 当前项目（`./.claude`）或全局（`~/.claude`、`~/.job-finish`） |
| 智能体 | 在 Claude Code、Codex 中选择要接入的工具 |
| 通知模式 | Windows toast、任务栏闪烁 |
| 闪烁时长 | `30s`、`5m`、`10m`、`infinite` |
| 声音 | 是否使用 Windows 默认提示音 |
| 焦点抑制 | 当你已经在看目标 VS Code 窗口时，是否跳过通知 |

安装完成后，可以立即发送一条测试通知。

## 使用方法

```powershell
# 中文交互式安装（省略语言代码时使用英语）
npx job-finish init zh

# 检查安装状态与依赖 + 发送测试通知
npx job-finish doctor

# 使用当前配置预览通知
npx job-finish preview

# 移除 hook 和已安装的文件
npx job-finish uninstall
```

如需以本地开发版本运行：

```powershell
npm install
npm run build
node dist/index.js init zh
```

## 工作原理

```text
Claude Code Stop / AskUserQuestion
或 Codex notify
  -> 运行 job-finish-notify.ps1
  -> Windows toast / 任务栏闪烁 / 声音
  -> 点击 toast 时启动 jobfinish-focus://open
  -> jf-focus-vscode.exe 查找已有的 VS Code 窗口
  -> 将匹配的窗口置于前台，或在新窗口中打开项目
```

Job-Finish 不只是弹出一条通知。即使同时打开了多个 VS Code 窗口，它也会利用项目名、cwd、窗口句柄（window handle）和进程 ID（process id）找到最合适的那个窗口。通知点击与任务栏闪烁被设计为指向同一个窗口，因此即便同时处理多个项目也不会混淆。

## 安装的文件

根据安装范围，文件会被生成在下列位置之一。

| 范围 | 位置 |
| --- | --- |
| project | `./.claude/job-finish/` |
| global | `~/.job-finish/` |

生成的文件：

- `job-finish-notify.ps1`
- `job-finish.config.json`
- `jf-focus-vscode.exe`

此外，为了在 Windows 上处理 toast 点击，会为当前用户（`HKCU`）注册 `jobfinish-focus://` 协议处理器。

## 配置文件

`job-finish.config.json` 保存在安装目录中。无需重新安装即可直接修改。

```json
{
  "version": 1,
  "platform": "win32",
  "modes": ["os", "flash"],
  "flashTimeout": "5m",
  "sound": { "enabled": true },
  "suppressWhenFocused": true,
  "clearToastOnFocus": true,
  "debug": false,
  "watchApp": ""
}
```

调试日志默认关闭。在 `job-finish.config.json` 中改为 `"debug": true` 后，会生成 `job-finish.log`、`jf-focus-vscode.log`；否则不会创建日志。

## 环境要求

- Windows
- Node.js 18+
- PowerShell
- VS Code

`jf-focus-vscode.exe` 以 self-contained 二进制文件的形式发布，因此无需额外安装 .NET 运行时。

## 卸载

```powershell
# 移除 Claude/Codex hook 与已安装的文件
npx job-finish uninstall

# 只移除 hook，保留已生成的文件
npx job-finish uninstall --keep-files
```

## 许可证

MIT
