# PR-M10 チャット内画像共有 / ライトボックスのスクリーンショット

撮影: `node tmp/shots-m10/take-shots.mjs`（要 `npm run build`）
実 claude は使わない（`scripts/fake-claude-stream.mjs` を `claude` として PATH の先頭に置き、
画像は `POST /control/chat-image` ＝ `chat_image` ツールと同じ口から共有する）＝
**サブスク枠も課金も消費しない**。専用ポート 8815 / `EBI_MASTER_UI=chat` / mkdtemp 構成で、
稼働 8787 と `.ebi-team/` には触れない（`EBI_VIEWER_ROOTS` も temp 配下に固定）。

| ファイル | 内容 |
|---|---|
| `01-card-desktop.png` | チャット内の画像カード（見出し「エビ（16:9）」＋ サムネイル最大 320x240 ＋ 説明文）。縦長画像も同じ枠に `contain` で収まる |
| `02-lightbox-desktop.png` | サムネイルをクリックしたライトボックス（左上に枚数 `1 / 2`・左右送りボタン・右上 ✕・下部に title / caption / 元パス） |
| `03-lightbox-next.png` | `→` キーで 2 枚目へ（送りの対象は**会話内の全画像**。ボスの添付も同じ列に載る） |
| `04-card-mobile.png` | 375px 幅の画像カード。横スクロールは 0px（撮影スクリプトが `scrollWidth - clientWidth` を機械チェックしている） |
| `05-lightbox-mobile.png` | 375px 幅のライトボックス（左右ボタンは 44x44px 以上のタップ領域） |

補足:

- 画像は縦横比が分かるようストライプの生成 PNG（16:9 の 640x360 と 縦長の 360x640）を使っている。
- 閉じる操作は `Esc` / 背景クリック / ✕ の 3 つ。撮影スクリプトは `Esc` で閉じられること
  （`closed = true`）もログに出す。
