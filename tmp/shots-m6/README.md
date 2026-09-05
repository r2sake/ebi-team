# PR-M6 実画面スクリーンショット（chat ヘッダの usage / context / cost 表示）

取得条件（稼働 8787 / `.ebi-team/` には一切触れていない）:

- 専用ポート **8813** で本番ビルド（`node dist/server/server/index.js`）を起動。
  `EBI_MASTER_UI=chat` / config・生成物はすべて mkdtemp 配下
- master の頭脳は **偽 claude**（`scripts/fake-claude-stream.mjs` を `claude` として PATH の先頭に置く）＝
  **実 claude は起動せず、サブスク枠も課金も消費しない**。本文の `ctx:<%>` / `rate:<5h>,<週次>` で
  `turnEnd.usage` と `rate_limit_event` を決定的に作る
- 撮影は Playwright（chromium・deviceScaleFactor 2）。Chrome 拡張は不使用
- 停止は PID 指定（SIGTERM）。広域 pkill はしていない
- 再現: `node tmp/shots-m6/take-shots.mjs`（playwright は npx キャッシュを絶対パスで import している）

| ファイル | 画面 |
|---|---|
| `01-header-normal.png` / `01b-header-normal-zoom.png` | 通常表示。`$0.02 / ctx 31% / 5h 19% / 週 4%`（すべて閾値未満＝色なし） |
| `02-header-warn.png` / `02b-header-warn-zoom.png` | 70% 超の色分け。`ctx 72%`＝hard（橙）・`5h 88%`＝critical（赤）・`週 66%`＝soft。NOTICE 欄に context-guard の advance / `/clear` 促し / hard が出ている |
| `03-header-dash.png` | 起動直後（turnEnd 未受信・枠未受信）＝ `— / ctx — / 5h — / 週 —`。算出不能な backend（codex stub 等）もこの表示になる |

## 機械チェックの結果

- `02` の DOM 実測（`.chat-stat` の class）:
  `cost:lv-none:$0.10 | ctx:lv-hard:ctx 72% | fiveHour:lv-critical:5h 88% | sevenDay:lv-soft:週 66%`
  → 65/70/85% の帯が contextGuard の発火（NOTICE 3 本）と一致している
- `03` の DOM 実測: `— / ctx — / 5h — / 週 —`（未受信を 0% に化けさせていない）
