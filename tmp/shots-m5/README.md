# PR-M5 承認 / 質問 UI のスクリーンショット

撮影: `node tmp/shots-m5/take-shots.mjs`（要 `npm run build`）
実 claude は使わない（`scripts/fake-claude-stream.mjs` を `claude` として PATH の先頭に置く）＝
**サブスク枠も課金も消費しない**。専用ポート 8814 / `EBI_MASTER_UI=chat` / mkdtemp 構成で、
稼働 8787 と `.ebi-team/` には触れない。

| ファイル | 内容 |
|---|---|
| `01-pending-bar.png` | 未応答のスティッキーバー（入力欄の上・「⏸ 未応答の承認/質問が 1 件あります」）。ヘッダのバッジも「応答待ち」になる |
| `02-permission.png` | 承認ダイアログ（`承認が必要: Bash` ＋ 許可 / 拒否ボタン） |
| `03-question.png` | 質問の選択肢 UI（単一選択のラジオ ＋「その他（自由入力）」＋ 回答するボタン） |
| `04-settled.png` | 応答後。バブルは畳まれて「✅ 許可しました」「✅ 回答しました: ラーメン」だけが残る（ボタンは消える） |

補足: `01-pending-bar.png` の registry 側で master が `idle` に見えるのは仕様。
registry の status は contextGuard の quiescence 判定に使うため busy 以外を idle に写している
（チャット側の本当の状態はヘッダのバッジ「応答待ち」）。
