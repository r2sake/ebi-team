# PR-M11 送信 / 停止の分離 — 実測とスクショ

- `take-shots.mjs` … 偽 claude（`fake-claude-slow.mjs`）で **20 秒続くターン**を作り、
  busy 中の送信が中断に化けないことを Playwright で実測する。ポート 8816（稼働中の 8787 には触らない）。
- 実行: `npm run build && node tmp/shots-m11/take-shots.mjs`（全 15 チェック PASS で exit 0）

| ファイル | 内容 |
| --- | --- |
| `01-busy-desktop.png` | 実行中に 2 通目を Enter で送ったところ（user バブルが 2 本・状態は「実行中…」のまま・停止は独立した ⏹） |
| `02-aborted-desktop.png` | ⏹ を押して中断したところ（「⏹ 中断しました」・その後 ⏹ は disabled） |
| `03-busy-mobile.png` | 375px 幅（横はみ出し 0px） |
