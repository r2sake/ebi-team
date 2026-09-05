# PR-M4 実画面スクリーンショット（master チャット UI・入力系）

取得条件（稼働 8787 には一切触れていない）:

- 専用ポート **8796** で自前サーバを起動（`EBI_MASTER_UI=chat` / `EBI_CONFIG_PATH` は mkdtemp 配下の使い捨て config）
- 生成物（registry.json / master-chat.jsonl / **添付の保存先 `EBI_CHAT_ATTACH_DIR`** 等）はすべて mkdtemp 配下。
  リポジトリの `.ebi-team/` には 1 バイトも書いていない
- master の model は **haiku**。実 claude のターンは **2 回だけ**（履歴用の 1 発話 ＋ 画像添付の 1 発話）
- 停止は PID 指定（SIGTERM → SIGKILL）。広域 pkill はしていない
- 撮影は Playwright（システムの Google Chrome を channel 指定）。Chrome 拡張は不使用
- 再現スクリプト: `node tmp/shots-m4/shoot.mjs`（`dist/` のビルド済みサーバを使うので事前に `npm run build`）

| ファイル | 画面 |
|---|---|
| `01-history-recall.png` | **ページを再読み込みした後**に ↑ を押して直前の送信文を呼び出した状態（localStorage 永続の実測） |
| `02-attach-tray.png` | 画像をペーストして添付トレイにサムネイルが出た状態（✕ で外せる） |
| `03-large-paste.png` | 10,500 文字の貼り付け → ファイルに落として**絶対パスを入力欄に残した**誘導 |
| `04-attach-sent.png` | 添付を送信した後（バブル内サムネイル ＋ master の返答） |

## 機械チェックの結果

- ↑ で呼び出した本文（再読み込み後）: `"PR-M4 の入力履歴テストです。短く挨拶して。"`
- 大きな貼り付け後の入力欄: 保存された `.txt` の**絶対パス 1 行だけ**（本文は展開されない）
- 画像添付の返答: master（haiku）が青い画像に対して「青。」と返答（`04-attach-sent.png`）
- チャット内のエラー行（`.chat-system.level-error`）: **0 件**

## 併走した e2e

- `npm run e2e:master-chat` … **7/7 OK**（chatSend 10/10・reverse-inject 10/10・`chatStop` で
  `turnEnd{aborted:true}`・seq 単調 142 件・usage 供給）
- `npm run e2e:master-chat-image` … **7/7 OK**（添付保存 → サムネイル配信 → 実 claude が
  **ツール 0 回**で画像の色を回答＝stream-json の image content block が読まれている）
