# PR-M3 実画面スクリーンショット（master チャット UI）

取得条件（稼働 8787 には一切触れていない）:

- 専用ポート **8799** で自前サーバを起動（`EBI_MASTER_UI=chat` / `EBI_CONFIG_PATH` は mkdtemp 配下の使い捨て config）
- 生成物（registry.json / delivery.log / master-chat.jsonl / viewers.json 等）はすべて mkdtemp 配下
- master の model は **haiku**（枠の消費を最小化）。実 claude プロセスの起動は撮影 1 回につき 2 本
  （初回起動ぶん ＋「新しい会話」で立て直したぶん）
- 停止は PID 指定（SIGINT → SIGKILL）。広域 pkill はしていない
- 撮影は Playwright（システムの Google Chrome を channel 指定で使用）。Chrome 拡張は不使用

| ファイル | 画面 |
|---|---|
| `01-desktop-idle.png` | 1280 幅・送信前（待機中・コスト/文脈は「—」・registry の master 行に 💬） |
| `02-desktop-streaming.png` | 逐次描画中（partial・カーソル ▍・送信ボタンが「⏹ 停止」・registry が busy） |
| `03-desktop-turnend.png` | turnEnd 後（markdown 整形・末尾に `$0.06 / ctx 13%`・ヘッダにも同じ値） |
| `04-desktop-inbound.png` | エビ返信（`/control/reverse-inject` の `[reply]`）を受けて master が応答した状態 |
| `05-mobile-375.png` | 375 幅（入力欄が下端固定・入力補助バーは chat では非表示） |
| `06-mobile-input.png` | 375 幅で入力中 |
| `07-desktop-new-conversation.png` | 「新しい会話」実行後（exit 通知 → 文脈リセットのシステム行 → 待機中に復帰） |
| `08-terminal-mode-desktop.png` | `ui:"terminal"`（既定）の画面。PR-M3 適用後も現行と同一 |
| `09-terminal-mode-mobile.png` | 同上・375 幅 |

## 機械チェックの結果

- スマホ幅のログスクロール: `scrollable=true` / `scrollTop` を 0 → 781 まで動かせることを実測
  （xterm 時代の「スマホでログがスクロールできない」の再発なし）
- スマホ幅の入力欄: `bottom=799 <= innerHeight=812`（画面内に固定で見えている）
- チャット内のエラー行（`.chat-system.level-error`）: **0 件**
- `ui:"terminal"` のゼロ差分比較: 同一サーバ実装で client dist だけを base(a4fcdfc) / PR-M3 に差し替え、
  固定エビ無し構成で 3 画面（デスクトップ / ファイルピッカー / 375 幅）を撮って PNG を突き合わせた。
  - ファイルピッカー・375 幅: **バイト単位で完全一致**
  - デスクトップ: 差分ピクセル **2 個・最大差 1/255**（トップバー y=16 のアンチエイリアス揺らぎ。
    2 回撮り直しでも位置が変わる Chrome 側のノイズで、レイアウト・色の差ではない）
