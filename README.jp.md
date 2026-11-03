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

## ライセンス

[MIT](README.md#license)
