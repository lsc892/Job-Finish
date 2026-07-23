# Job-Finish

**[English](README.md) · [한국어](README.ko.md) · [中文](README.zh.md) · 日本語**

AIエージェントが終わったかどうかを確認するために、ターミナルをずっと見張っている必要はありません。
Claude Codeが入力を待っている瞬間や、Claude Code / Codexの作業が完了した瞬間に、Windows通知で呼び戻します。

| トースト通知 | タスクバーの点滅 |
| :---: | :---: |
| <img src="resources/Toast.gif" alt="トースト通知のデモ" width="380"> | <img src="resources/Flash.gif" alt="タスクバー点滅のデモ" width="380"> |
| トーストをクリックすると VS Code に復帰 | 戻るまで対象ウィンドウが点滅 |

![Platform](https://img.shields.io/badge/platform-Windows-0078D4)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![License](https://img.shields.io/badge/license-MIT-blue)

## 主な機能

- Claude Code + Codex 対応 - Claude Codeの `Stop` / `AskUserQuestion` と、Codexの `Stop` ライフサイクルイベントをまとめて連携します。
- Windowsネイティブ通知 - 作業の完了、入力待ち、エージェントの最後のメッセージをトースト通知で表示します。
- 異常終了の通知 - トークン・セッション上限の超過やAPIエラーでClaude Codeが停止したときも通知し、タイトル（`Usage limit reached` / `API error`）を変えて通常の完了と一目で見分けられます。
- 通知クリックでVS Codeに復帰 - トーストを押すと既存のVS Codeウィンドウを探し出し、最前面に持ってきます。
- ウィンドウがなくてもプロジェクトを開く - 対象のVS Codeウィンドウが閉じている場合は、`code -n <project>` 方式でプロジェクトのウィンドウを開き直します。
- フォーカス検知 - すでにVS Codeを見ているときは通知を省略でき、再びフォーカスされるとそのウィンドウの通知だけを片付けます。
- タスクバーの点滅 - 通知を見逃しても、対象のウィンドウがタスクバーで点滅します。`30s`、`5m`、`10m`、`infinite` から選べます。
- サウンド通知 - OS標準の通知音で作業の完了を耳でも確認できます。
- global / project インストール - アカウント全体向け、または現在のプロジェクト向けにインストール範囲を選べます。
- 安全な設定マージ - Claude / Codexの設定を上書きせず、必要なhookだけを追加し、変更前に `.bak` バックアップを残します。
- 重複通知の防止 - 以前のJob-Finish hookを整理し、従来のCodex `notify` インストールを即時実行される `Stop` hookへ移行します。
- 診断とプレビュー - `doctor`、`preview` コマンドで、現在のインストール状態と通知動作をすばやく確認できます。
- VS Code環境専用 - Codex Desktop、Claude Desktop、Orca ADEといったデスクトップクライアントには独自の通知機能があり、Job-Finishと競合します。そのため通知とタスクバーの点滅は、エージェントがVS Code内で動作しているときだけ発火し、それ以外の環境から起動されたhookはスキップされます。

## 対応対象

| 対象 | 連携方式 | 通知タイミング |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` または `./.claude/settings.json` の hooks | 作業完了、`AskUserQuestion` の入力待ち、上限超過・APIエラーによる停止 |
| Codex | `~/.codex/config.toml` の `hooks.Stop` | 作業完了、最後の assistant メッセージ |

> Job-FinishはWindows専用ツールです。PowerShellとWindowsのtoast API、VS Codeのウィンドウフォーカス処理を利用します。
>
> Codexは信頼されていないcommand hookを実行しません。ターミナルで`codex`を起動すると`Hooks need review`画面が表示されるので、**Trust all and continue**を選んでください。設定は初回の1回だけで、以降は再確認されません。

## インストール

```powershell
npx job-finish init jp
```

インストールウィザードは既定で英語表示です。コマンドの末尾に言語コードを付けると、韓国語、中国語、または日本語で実行できます。

```powershell
npx job-finish init     # 英語
npx job-finish init ko  # 韓国語
npx job-finish init zh  # 中国語
```

インストールウィザードでは、次の項目を選択します。

| 設定 | 説明 |
| --- | --- |
| インストール範囲 | 現在のプロジェクト（`./.claude`）または全体（`~/.claude`、`~/.job-finish`） |
| エージェント | Claude Code、Codex のうち連携するツール |
| 通知モード | Windowsトースト、タスクバーの点滅 |
| 点滅時間 | `30s`、`5m`、`10m`、`infinite` |
| サウンド | Windows標準サウンドを使うかどうか |
| フォーカス抑制 | すでに対象のVS Codeウィンドウを見ているときに通知を省略するかどうか |

インストールが完了すると、すぐにテスト通知を送信できます。

## 使い方

```powershell
# 日本語の対話型インストール（言語コードを省略すると英語）
npx job-finish init jp

# インストール状態と依存関係の確認 + テスト通知
npx job-finish doctor

# 現在の設定で通知をプレビュー
npx job-finish preview

# hook とインストール済みファイルを削除
npx job-finish uninstall
```

ローカルの開発版で実行する場合は、次のようにします。

```powershell
npm install
npm run build
node dist/index.js init jp
```

## 仕組み

```text
Claude Code Stop / AskUserQuestion
または Codex Stop
  -> job-finish-notify.ps1 を実行
  -> Windows toast / タスクバーの点滅 / サウンド
  -> toast クリック時に jobfinish-focus://open を起動
  -> jf-focus-vscode.exe が既存の VS Code ウィンドウを探索
  -> 該当ウィンドウを前面に出すか、プロジェクトを新しいウィンドウで開く
```

Job-Finishは、単に通知を出すだけではありません。開いているVS Codeウィンドウが複数あっても、プロジェクト名、cwd、ウィンドウハンドル、プロセスIDを活用して、もっとも適したウィンドウを見つけ出します。通知のクリックとタスクバーの点滅が同じウィンドウを指すように設計されているため、複数のプロジェクトを同時に進めていても迷いません。

## インストールされるファイル

インストール範囲に応じて、以下のいずれかの場所にファイルが作成されます。

| 範囲 | 場所 |
| --- | --- |
| project | `./.claude/job-finish/` |
| global | `~/.job-finish/` |

作成されるファイル:

- `job-finish-notify.ps1`
- `job-finish.config.json`
- `jf-focus-vscode.exe`

また、Windowsでトーストのクリックを処理するために、`jobfinish-focus://` プロトコルハンドラが現在のユーザー（`HKCU`）に登録されます。

## 設定ファイル

`job-finish.config.json` はインストールフォルダに保存されます。再インストールしなくても、直接編集できます。

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

デバッグログは既定でオフになっています。`job-finish.config.json` で `"debug": true` に変更すると `job-finish.log`、`jf-focus-vscode.log` が生成され、そうでなければログは作成されません。

## 要件

- Windows
- Node.js 18+
- PowerShell
- VS Code

`jf-focus-vscode.exe` はself-containedバイナリとして配布されるため、別途.NETランタイムをインストールする必要はありません。

## アンインストール

```powershell
# Claude/Codex の hook とインストールしたファイルを削除
npx job-finish uninstall

# hook のみ削除し、生成されたファイルは残す
npx job-finish uninstall --keep-files
```

## ライセンス

MIT
