# Guidelines

## Top-Level Rules

- **思考は必ず英語で行うこと**。ただし、**回答は日本語**で行うこと。
- **コードのコメントとエラーログメッセージは日本語**で記述すること。
- ハードコーディングは絶対に必要な場合を除き避けること。

## Project Summary

- このプロジェクトは **Google スプレッドシート向けの Chrome 拡張機能（Manifest V3）** であり、主な操作面は **ポップアップではなくシート上のインライン UI** である。
- Googleスプレッドシートを開いた時に画面上に**お気に入りバー**を追加し、よく使うフィルタ表示やシートにすばやくアクセスできる。

## Project Shape

- `content.js` は Google Sheets 上の UI 描画、イベント処理、`chrome.runtime.sendMessage` の呼び出しを担当する。
- `background.js` は `chrome.storage.sync` の読み書き、重複判定、URL 生成、メッセージハンドリングを担当する。
- `content.css` はインライン UI の見た目だけを担当し、ロジックは入れない。
- `manifest.json` の対象は `https://docs.google.com/spreadsheets/*` に限定する。
- 多言語文言は `_locales/en/messages.json` と `_locales/ja/messages.json` で管理する。

## Domain Rules

- お気に入りの保存単位は **スプレッドシート ID ごと** とする。
- URL のフィルタ状態は `gid` と `fvid` を扱う。`fvid` は query と hash の両方に出る可能性があるため、どちらも読む。
- 適用時は query 側の `gid` / `fvid` を正規化し、hash 側の重複パラメータは残さない。
- お気に入りの操作は、追加・適用・削除・名前変更・URL パラメータ編集・ドラッグ並べ替えを前提に考える。
- 表示・非表示の状態はスプレッドシート単位で保存されるため、UI の表示状態をグローバルな単一設定として扱わない。

## Editing Rules

- 既存の実装スタイルに合わせ、関数は小さく保ち、処理の責務を混ぜない。
- 既存のメッセージ名や storage キーを勝手に変更しない。
- 文言の追加や修正が必要なときは、`_locales` の両言語を同時に更新する。
- README や手動テスト文書を変更する場合は、実装の実態とずれていないかを先に確認する。
- コメントは簡潔にし、実装から明らかな説明を繰り返さない。

## Verification Bias

- 変更前は、近接する実装・設定・README だけを見て仮説を立てる。
- 変更後は、対象ファイルのエラー確認や差分確認など、最小の検証を優先する。
- 実際に存在しない popup、options page、言語切替 UI などを前提にした案を出さない。

