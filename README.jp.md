# Job-Finish


**[English](README.md) · [한국어](README.ko.md) · [中文](README.zh.md) · 日本語**

Claude CodeやCodexの応答が終わったら、作業に戻りましょう。

Job-Finishはエージェントの通知を対応するVS Codeウィンドウに表示します。複数のプロジェクトを行き来していても、どの作業に応答が届いたかを確認できます。

![VS Code](https://img.shields.io/badge/platform-VS%20Code-0078D4)
![Status](https://img.shields.io/badge/status-verified%20MVP-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## 自動通知

同じ VS Code ウィンドウ内の Codex・Claude Code の実行イベントを検出し、完了・エラー・キャンセル・入力要求を Windows 通知とタスクバーの点滅で知らせます。通知をクリックすると対応するウィンドウに戻り、質問への回答と承認は元の拡張で行います。

Windows x64 のローカルデスクトップ版 VS Code に対応し、インストール後に自動で有効になります。最新のインストール手順は [English](README.md)、検証範囲は[検証レポート](docs/verification.md)を参照してください。

## 変更履歴

<details>
<summary>v2.3.0（v2.2.0 以降）</summary>

### 自動通知に機能を集約

直接実行・セッション管理コマンド・実行設定・同梱 Claude SDK を削除し、既存拡張の通知検出に集約しました。

### コマンドと設定の簡素化

コマンドを4個、General・Notifications の設定を7個に整理しました。質問への回答・承認・会話管理は元の Codex・Claude UI で行い、保存上限で省略された応答には案内を表示します。

### 重複する完了通知の抑制

非同期の質問はすぐに通知します。同じターンで質問から5秒以内に正常完了した場合、両方の結果を保存し、追加の通知と点滅をまとめます。エラーとキャンセルは個別に通知します。

### ネイティブ通知の診断追加

制御されたストリームで質問の再送・完了タイミング・Windows 通知の送信・クリックコールバックを確認する診断スクリプトを追加しました。

</details>

<details>
<summary>v2.2.0（v2.1.2 以降）</summary>

### 内部構造のリファクタリング

エージェント実行・セッション管理・通信・Windows 通知を役割ごとに分離し、共通の処理フローを整理しました。

### 通知タイトルとアイコンの改善

通知にセッションタイトルを表示し、VS Code アイコンと既定の画像を復元しました。

### 設定カテゴリの整理

設定を General・Notifications・Codex・Claude に分け、必要な項目を見つけやすくしました。

### Codex の非同期質問通知

Codex の非同期質問イベントを検出し、ユーザー入力が必要なときに通知を表示します。

### 既存インストールからの更新経路の復元

既存の npm・Marketplace インストールから新しいバージョンへ更新できるようにしました。

</details>

## ライセンス

[MIT](README.md#license)
