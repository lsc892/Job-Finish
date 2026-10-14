# Job-Finish

**[English](README.md) · [한국어](README.ko.md) · 中文 · [日本語](README.jp.md)**

不用一直盯着聊天窗口，等待 AI 智能体完成任务。
当 **Claude Code 或 Codex 完成任务、需要输入或遇到错误时**，Job-Finish 会通知你，并带你回到对应的 VS Code 窗口。

| Windows 通知 | 任务栏闪烁 |
| :---: | :---: |
| <img src="https://raw.githubusercontent.com/lsc892/Job-Finish/877024beb5f86c390c1beec4992cf64c862dbc67/resources/Toast.gif" alt="Windows 通知及返回 VS Code 的演示" width="380"> | <img src="https://raw.githubusercontent.com/lsc892/Job-Finish/877024beb5f86c390c1beec4992cf64c862dbc67/resources/Flash.gif" alt="VS Code 任务栏按钮闪烁的演示" width="380"> |
| 点击通知，回到该任务所在的 VS Code 窗口 | 即使错过通知，也能看到等待你处理的窗口 |

*这些 GIF 展示的是早期版本的通知行为；当前扩展的通知外观可能有所不同。*

![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4)
![VS Code](https://img.shields.io/badge/VS%20Code-1.99%2B-007ACC)
![License](https://img.shields.io/badge/license-MIT-blue)

## 功能一览

| 功能 | 说明 |
| --- | --- |
| **Claude Code + Codex** | 自动检测现有 VS Code 扩展中受支持的活动。 |
| **任务完成、输入与错误提醒** | 提醒任务完成、错误，以及等待选项选择、问题回答或批准的状态。 |
| **点击返回** | 将发送通知的 VS Code 窗口置于前台，同时打开多个窗口时也能准确返回。 |
| **任务栏闪烁** | 持续突出显示任务所在的窗口，直到你返回或达到设置的超时时间。 |
| **感知窗口焦点** | 当你正在查看该窗口时，不发送新的通知，也不启动闪烁。 |
| **最近结果** | 通过 **Job-Finish: Show Results** 查看智能体的回复。 |

## 安装与更新

需要 **Windows x64、VS Code 1.99+、Node.js 22+ 和受信任的本地工作区**。请安装并登录你使用的 Codex 或 Claude Code VS Code 扩展，然后运行：

```powershell
npx job-finish@latest install
```

安装程序会安装包中附带的 VS Code 扩展，并备份和移除检测到的旧 PowerShell/C# 安装。请在项目文件夹中运行，以便同时清理该项目的旧安装。在出现提示时重新加载 VS Code；Job-Finish 会自动启动，无需单独安装 .NET。

更新时运行：

```powershell
npx job-finish@latest update
```

添加 `--dry-run` 可预览更改，添加 `--profile "Profile name"` 可选择 VS Code 配置文件。安装程序会保留相同或更新版本的扩展。详情见[安装程序指南](tools/installer/README.md)。

<details>
<summary>全局安装 CLI</summary>

```powershell
npm install -g job-finish@latest
job-finish install
```

安装最新 CLI 后，也可以使用 `job-finish update` 和 `job-finish uninstall`。

</details>

<details>
<summary>手动安装 VSIX</summary>

1. 按照下方的源码构建步骤生成 `job-finish-win32-x64.vsix`。
2. 在 VS Code 中按 `Ctrl+Shift+P`，选择 **Extensions: Install from VSIX…**。
3. 选择 VSIX 文件，并在出现提示时重新加载 VS Code。

更新时，用同样的方法安装新的 VSIX。手动安装不会移除旧的 PowerShell/C# 安装。

</details>

<details>
<summary>从源码构建 VSIX</summary>

安装 **Node.js 22+ 和 .NET SDK 8+** 后，在仓库根目录运行：

```powershell
npm ci
npm run check
npm run package
```

生成的文件为 `job-finish-win32-x64.vsix`。开发时也可以按 `F5` 打开开发窗口。

如果你使用过旧的 PowerShell/C# 版本，安装程序可以在安装扩展前备份并移除旧版：

```powershell
npm --prefix tools/installer ci
npm run install:extension -- --vsix ./job-finish-win32-x64.vsix
```

</details>

## 使用扩展

1. 照常在 VS Code 中使用 Codex 或 Claude Code 聊天。Job-Finish 默认启用。
2. 当任务窗口处于非活动状态时，任务完成、错误或等待选择、回答、批准都会触发通知和任务栏闪烁。
3. 点击通知回到对应窗口，在原来的聊天中选择选项、回答问题或批准请求。

按 `Ctrl+Shift+P` 打开命令面板，搜索 **Job-Finish**：

| 命令 | 用途 |
| --- | --- |
| **Show Results** | 查看最近的回复。 |
| **Stop Flash** | 立即停止任务栏闪烁。 |
| **Show Diagnostics** | 检查检测与通知状态。 |
| **Run Codex / Run Claude** | 直接通过 Job-Finish 启动任务。 |
| **Answer Pending Request** | 回答通过 Job-Finish 启动的任务中的问题或审批请求。 |

直接执行任务需要已安装并完成认证的 Codex CLI，或捆绑的 Claude SDK CLI 所需的有效认证。如果 Codex 不在 PATH 中，请设置 `jobFinish.codexExecutable`。

自动检测支持同一 VS Code Extension Host 中的本地智能体。WSL、远程工作区、外部终端智能体和桌面智能体应用不在支持范围内。如果提供方更新后检测失效，请查看 **Show Diagnostics**。

## 设置一览

打开 VS Code 设置（`Ctrl+,`），搜索 **Job-Finish**。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `jobFinish.enabled` | `true` | 立即开启或关闭自动检测与通知。 |
| `jobFinish.toast` | `true` | 显示 Windows 通知。 |
| `jobFinish.flash` | `true` | 让任务所在的 VS Code 窗口在任务栏闪烁。 |
| `jobFinish.flashMode` | `manual` | `manual`：每 0.5 秒闪烁一次。`system`：使用 Windows 默认的闪烁行为。 |
| `jobFinish.flashTimeoutSeconds` | `300` | 达到设定秒数后停止闪烁。设为 `0` 时，持续闪烁，直到窗口重新获得焦点、点击通知或使用 **Stop Flash**。 |

## 卸载

移除 VS Code 扩展和检测到的旧安装：

```powershell
npx job-finish@latest uninstall
```

在出现提示时重新加载 VS Code。添加 `--dry-run` 可预览移除操作，添加 `--profile "Profile name"` 可指定 VS Code 配置文件，添加 `--project "C:\Projects\MyProject"` 可清理其他项目的旧安装。

如果曾全局安装 CLI，请在卸载扩展后移除 CLI：

```powershell
npm uninstall -g job-finish
```

最后这条命令只会移除 npm CLI，不会卸载 VS Code 扩展。

<details>
<summary>手动移除 VS Code 扩展</summary>

在 VS Code 扩展视图（`Ctrl+Shift+X`）中找到 **Job-Finish**，选择 **Uninstall**，并在出现提示时重新加载。也可以运行：

```powershell
code --uninstall-extension lsc892.job-finish
```

</details>

<details>
<summary>仅移除旧的 PowerShell/C# 版本</summary>

使用 `npx job-finish@latest uninstall-legacy`，或在仓库根目录运行：

```powershell
npm --prefix tools/installer ci
npm run uninstall:legacy -- --dry-run
npm run uninstall:legacy
```

这些命令会移除旧版 Job-Finish 的钩子和安装文件，不会卸载 VS Code 扩展。对于其他安装过旧版的项目，分别使用 `--project "C:\Projects\MyProject"`。备份行为及其他选项见[安装程序指南](tools/installer/README.md)。

</details>

实现细节与验证信息见[开发文档](docs/requirements-and-verification.md)和[验证报告](docs/verification.md)。

## 许可证

[MIT](LICENSE)。捆绑的第三方组件保留各自的许可证。
