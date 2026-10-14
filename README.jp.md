# Job-Finish

**[English](README.md) · [한국어](README.ko.md) · [中文](README.zh.md) · 日本語**

AI エージェントの作業が終わったか、チャットを見続ける必要はありません。
**Claude Code や Codex の作業完了・入力待ち・エラー**を Job-Finish が通知し、作業中の VS Code ウィンドウへ戻れます。

| Windows のトースト通知 | タスクバーの点滅 |
| :---: | :---: |
| <img src="https://raw.githubusercontent.com/lsc892/Job-Finish/877024beb5f86c390c1beec4992cf64c862dbc67/resources/Toast.gif" alt="Windows のトースト通知から VS Code に戻るデモ" width="380"> | <img src="https://raw.githubusercontent.com/lsc892/Job-Finish/877024beb5f86c390c1beec4992cf64c862dbc67/resources/Flash.gif" alt="VS Code のタスクバーボタンが点滅するデモ" width="380"> |
| 通知をクリックして、作業中の VS Code ウィンドウへ | 通知を見逃しても、応答を待つウィンドウがわかる |

*この GIF は旧バージョンの通知動作を示しています。現在の拡張機能ではトーストの外観が異なる場合があります。*

![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4)
![VS Code](https://img.shields.io/badge/VS%20Code-1.99%2B-007ACC)
![License](https://img.shields.io/badge/license-MIT-blue)

## 主な機能

| 機能 | できること |
| --- | --- |
| **Claude Code + Codex** | 既存の VS Code 拡張機能で、対応するエージェントの動作を自動検出します。 |
| **作業完了・入力待ち・エラーの通知** | 作業の完了・エラーと、選択肢の選択・質問への回答・承認待ちを知らせます。 |
| **クリックして戻る** | 複数のウィンドウを開いていても、通知を送った VS Code ウィンドウを前面に表示します。 |
| **タスクバーの点滅** | ウィンドウに戻るか、設定した時間が経過するまで、作業中のウィンドウを目立たせます。 |
| **フォーカスを考慮した通知** | そのウィンドウを操作している間は、新しいトースト通知や点滅を行いません。 |
| **最近の結果** | **Job-Finish: Show Results** でエージェントの応答を確認できます。 |

## インストールと更新

**Windows x64、VS Code 1.99 以降、Node.js 22 以降、信頼済みのローカルワークスペース**が必要です。使用する Codex または Claude Code の VS Code 拡張機能をインストールし、ログインしてから実行してください。

```powershell
npx job-finish@latest install
```

パッケージに同梱された VS Code 拡張機能をインストールし、検出した旧 PowerShell/C# 版をバックアップ・削除します。プロジェクトのフォルダーで実行すると、そのプロジェクトの旧版も整理します。再読み込みを求められたら VS Code を再読み込みしてください。Job-Finish は自動的に起動し、.NET を別途インストールする必要はありません。

更新する場合は次のコマンドを実行します。

```powershell
npx job-finish@latest update
```

`--dry-run` を追加すると変更内容を確認でき、`--profile "Profile name"` で VS Code のプロファイルを選べます。同じバージョンまたは新しいバージョンの拡張機能は維持します。詳細は [インストーラーガイド](tools/installer/README.md) を参照してください。

<details>
<summary>CLI をグローバルにインストールする</summary>

```powershell
npm install -g job-finish@latest
job-finish install
```

最新の CLI をインストールした後は、`job-finish update` と `job-finish uninstall` も使用できます。

</details>

<details>
<summary>VSIX を手動でインストールする</summary>

1. 以下のソースビルド手順で `job-finish-win32-x64.vsix` を用意します。
2. VS Code で `Ctrl+Shift+P` を押し、**Extensions: Install from VSIX…** を選択します。
3. VSIX ファイルを選択し、再読み込みを求められたら実行します。

更新も同じ手順で新しい VSIX をインストールします。手動インストールでは旧 PowerShell/C# 版を削除しません。

</details>

<details>
<summary>ソースから VSIX をビルドする</summary>

**Node.js 22 以降と .NET SDK 8 以降**を用意し、リポジトリのルートで次のコマンドを実行します。

```powershell
npm ci
npm run check
npm run package
```

`job-finish-win32-x64.vsix` が生成されます。開発用ウィンドウを開く場合は、代わりに `F5` を押します。

旧 PowerShell/C# 版を使用していた場合は、インストーラーで旧版をバックアップ・削除してから拡張機能をインストールできます。

```powershell
npm --prefix tools/installer ci
npm run install:extension -- --vsix ./job-finish-win32-x64.vsix
```

</details>

## 拡張機能の使い方

1. VS Code の普段の Codex または Claude Code チャットで作業します。Job-Finish は初期状態で有効です。
2. 作業中のウィンドウが非アクティブなとき、完了・エラー・選択や回答、承認の依頼をトースト通知とタスクバーの点滅で知らせます。
3. 通知をクリックしてそのウィンドウに戻り、元のチャットで選択・回答・承認を行います。

`Ctrl+Shift+P` でコマンドパレットを開き、**Job-Finish** を検索します。

| コマンド | 用途 |
| --- | --- |
| **Show Results** | 最近の応答を確認します。 |
| **Stop Flash** | タスクバーの点滅をすぐに停止します。 |
| **Show Diagnostics** | 検出と通知の状態を確認します。 |
| **Run Codex / Run Claude** | Job-Finish から直接タスクを開始します。 |
| **Answer Pending Request** | Job-Finish から開始したタスクの質問や承認に応答します。 |

直接実行には、インストール・認証済みの Codex CLI、または同梱の Claude SDK CLI で有効な認証が必要です。Codex が PATH にない場合は、`jobFinish.codexExecutable` を設定してください。

自動検出の対象は、同じ VS Code Extension Host 内で動作するローカルエージェントです。WSL、リモートワークスペース、外部ターミナルのエージェント、エージェントのデスクトップアプリは対象外です。プロバイダーの更新後に検出できなくなった場合は、**Show Diagnostics** を確認してください。

## 主な設定

VS Code の設定（`Ctrl+,`）を開き、**Job-Finish** を検索します。

| 設定 | 初期値 | 説明 |
| --- | --- | --- |
| `jobFinish.enabled` | `true` | 自動検出と通知の有効・無効をすぐに切り替えます。 |
| `jobFinish.toast` | `true` | Windows のトースト通知を表示します。 |
| `jobFinish.flash` | `true` | 作業中の VS Code ウィンドウをタスクバーで点滅させます。 |
| `jobFinish.flashMode` | `manual` | `manual`：0.5 秒ごとに点滅。`system`：Windows 標準の点滅動作を使用。 |
| `jobFinish.flashTimeoutSeconds` | `300` | 指定した秒数で点滅を停止します。`0` の場合は、ウィンドウに戻る、通知をクリックする、または **Stop Flash** を実行するまで続きます。 |

## アンインストール

VS Code 拡張機能と検出した旧版を削除します。

```powershell
npx job-finish@latest uninstall
```

再読み込みを求められたら VS Code を再読み込みしてください。`--dry-run` で削除内容を確認でき、`--profile "Profile name"` で VS Code のプロファイルを指定できます。他のプロジェクトの旧版は `--project "C:\Projects\MyProject"` で指定します。

CLI をグローバルにインストールした場合は、拡張機能を削除した後に CLI も削除します。

```powershell
npm uninstall -g job-finish
```

最後のコマンドは npm CLI のみを削除し、VS Code 拡張機能は削除しません。

<details>
<summary>VS Code 拡張機能だけを手動で削除する</summary>

VS Code の拡張機能（`Ctrl+Shift+X`）で **Job-Finish** を探し、**Uninstall** を選択します。再読み込みを求められたら実行してください。次のコマンドも使用できます。

```powershell
code --uninstall-extension JobFinish.JobFinish
```

</details>

<details>
<summary>旧 PowerShell/C# 版だけを削除する</summary>

`npx job-finish@latest uninstall-legacy` を使用するか、リポジトリのルートで次のコマンドを実行します。

```powershell
npm --prefix tools/installer ci
npm run uninstall:legacy -- --dry-run
npm run uninstall:legacy
```

旧 Job-Finish のフックとインストールファイルを削除します。VS Code 拡張機能は削除されません。他のプロジェクトにも旧版をインストールしている場合は、プロジェクトごとに `--project "C:\Projects\MyProject"` を指定します。バックアップの動作やその他のオプションについては、[インストーラーガイド](tools/installer/README.md) を参照してください。

</details>

実装と検証の詳細は、[開発ドキュメント](docs/requirements-and-verification.md) と [検証レポート](docs/verification.md) を参照してください。

## ライセンス

[MIT](LICENSE)。同梱するサードパーティのコンポーネントには、それぞれのライセンスが適用されます。
