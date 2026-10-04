# Job-Finish

**[English](README.md) · [한국어](README.ko.md) · [中文](README.zh.md) · 日本語**

Claude CodeやCodexの応答が終わったら、作業に戻りましょう。

Job-Finishはエージェントの通知を対応するVS Codeウィンドウに表示します。複数のプロジェクトを行き来していても、どの作業に応答が届いたかを確認できます。

![VS Code](https://img.shields.io/badge/platform-VS%20Code-0078D4)
![Status](https://img.shields.io/badge/status-verified%20MVP-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## 開発中の機能

- VS CodeでClaude CodeとCodexの通知を確認。
- 同じプロジェクトを複数のウィンドウで開いても、結果をウィンドウごとに区別。
- 応答完了の通知と、エージェントの結果を確認する画面。

## 現在の状態

TypeScriptによるVS Code拡張MVPで、実際のエージェント呼び出し、セッションログの通知、ウィンドウIDの区別を検証しました。現在のリポジトリには紹介README、開発文書、意思決定・検証の記録を残し、実行用MVPとテストファイルは削除しました。

[開発文書](docs/requirements-and-verification.md)には機能・実装アルゴリズム・完了条件を、[記録](docs/일지.md)には選択の根拠・過去の実装・実測結果をまとめています。

## ライセンス

[MIT](README.md#license)
