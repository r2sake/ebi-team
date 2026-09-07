# master チャット UI が「コンテキストをリセットしてもログが消えず重い」問題 — 調査と修正プラン

- 日付: 2026-09-07
- ブランチ: `ebi/log-heavy-plan`（調査のみ。実装は未着手）
- 報告（原文）: 「コンテキストのリセットはできたが、ログが消えないのでUIがめちゃくちゃ重たい」

---

## 1. 結論（先に要点）

1. **仕様どおり消えていない。** 「🆕 新しい会話」（WS `chatNew`）は *頭脳プロセスの文脈* だけをリセットし、**UI のトランスクリプトと JSONL は意図的に残す**設計（`src/server/master/session.ts:627-655` のコメント、ボタンの title 文言 `src/client/chat.ts:129-131`）。リセット後に UI が軽くならないのは想定どおりの挙動で、バグではなく設計の未対応点。
2. **重さの主因は「溜まった DOM の量」そのものではなく、`ストリーミング 1 トークンごとの同期強制リフロー`。** 追記のたびに `renderItem()` が DOM を差し替え、直後に `scrollToBottom()` が `scrollHeight` を読むため、**ログ全体（実測 564,169px / 31,690 ノード）のレイアウトが毎トークン再計算される**。実測で **1 トークンあたり 0.95ms（79 アイテム）→ 24.58ms（3,575 アイテム）** と、蓄積量に比例して悪化する。
3. クライアントの `ChatTranscript.items` と `ChatPanel.rendered` は**上限なし**（`src/client/chatModel.ts:104`, `src/client/chat.ts:588-596`）。サーバ側リングは 400 件で有界（`DEFAULT_SNAPSHOT_LIMIT = 400`）なので、**リロードすれば軽くなるがタブを開きっぱなしにすると際限なく重くなる**。ボスの環境は 2 日連続稼働で 22,710 イベント＝ **3,575 アイテム**まで育っていた。

---

## 2. どこに何件溜まるか（経路の特定）

| 層 | 実体 | 上限 | リセット時の扱い |
|---|---|---|---|
| CLI（頭脳） | claude プロセスの会話 | — | `newConversation()` で `--resume` 無し再起動 → **消える**（ここは正常） |
| サーバ・メモリ | `MasterSession.ring` | **400 件**（`session.ts:72,710-712`） | **残る**（`newConversation()` は notice を 1 件足すだけ） |
| サーバ・永続 | `.ebi-team/master-chat.jsonl` | 16MB で 1 世代ローテート（`chatLog.ts:18`） | **残る**（追記のみ。切り詰め無し） |
| クライアント・モデル | `ChatTranscript.items` | **上限なし** | **残る**（`resetStats()` しか呼ばれない → `chat.ts:132-135`） |
| クライアント・DOM | `.chat-log` の子要素 ＋ `ChatPanel.rendered[]` | **上限なし** | **残る** |

補足:

- 新規接続・再接続時は `chatSnapshot`（ring の末尾 400 件）で**総入れ替え**される（`index.ts:454-460`, `chat.ts:225-231`）。→ **ページをリロードした直後だけ軽い**。
- `chatNew` はサーバ側で `session.newConversation()` を呼ぶだけ（`index.ts:1024-1032`）。**UI へ「ここで切れた」を伝える構造化イベントが無い**（`notice` の文字列 1 行のみ）。
- 実ログの内訳（`.ebi-team/master-chat.jsonl`、2026-09-05 06:28 〜 09-07 00:50、6.0MB / 22,710 行）:
  `text 15,688 / thinking 3,996 / toolCall 1,029 / toolResult 1,029 / turnEnd 428 / inbound 275 / user 204 / image 46 / session 8 / exit 6 / notice 1`
  → `notice 1` ＝ この期間に「新しい会話」が押されたのは 1 回。`seq` は 1 から通しで、**リセットしても採番も ring も途切れていない**ことの裏付け。

---

## 3. 重さの根拠（実測）

計測方法: 実ログの末尾 N 件を `ChatPanel` にそのまま流し込むハーネス（`tmp/log-heavy/`）を Vite（5175 番）で配り、Playwright（Chromium, 1280x900）から計測。再現手順は `tmp/log-heavy/README.md`。

| 投入イベント数 | アイテム数 | `.chat-log` 配下 DOM ノード | 行数 | scrollHeight | textContent 長 | 初期描画 | **streaming 1 トークン** |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 400（＝リロード直後の状態） | 79 | 586 | 79 | 10,268px | 33,620 | 100.7ms | **0.95ms** |
| 1,000 | 189 | 1,441 | 189 | 24,839px | 83,736 | 98.9ms | **1.43ms** |
| 4,000 | 631 | 5,661 | 631 | 93,838px | 256,787 | 217.6ms | **4.09ms** |
| 22,710（＝ボスの 2 日ぶん） | 3,575 | 31,656 | 3,575 | 564,169px | 1,557,960 | **1,132ms** | **24.58ms** |

主因の切り分け（同一ページで 200 トークン投入して比較）:

| 状態 | 79 アイテム | 3,575 アイテム |
|---|---:|---:|
| 末尾追従 ON（現行） | 0.95 ms/token | **24.32 ms/token** |
| 末尾追従 OFF（`stuckToBottom=false`） | ≈0 ms/token | **≈0 ms/token** |
| `scrollTop = scrollHeight` だけ（DOM 変更なし） | ≈0 ms/call | ≈0 ms/call |

**読み方**: DOM 差し替え単体も、スクロール代入単体も、コストはほぼゼロ。**「DOM を書き換えた直後に `scrollHeight` を読む」組み合わせだけ**が高い。これは典型的な *layout thrashing*（同期強制リフロー）で、コストはログ全体の大きさに比例する。該当箇所は

- `src/client/chat.ts:236-244` … `applyEvent()` が `renderItem()` の直後に `scrollToBottom(false)`
- `src/client/chat.ts:544-550` … `scrollToBottom()` が `this.logEl.scrollHeight` を読む

24.58 ms/token は、体感で言えば **毎秒 40 トークンの出力でメインスレッドがほぼ 100% 占有**される水準。入力欄のタイプ、スクロール、他ペインの操作がすべて引っかかる。ボスの「めちゃくちゃ重たい」はこれで説明が付く。

二次的な要因（今回の主因ではないが効いてくる）:

- `renderItem()` は毎トークン **アイテム全体を作り直す**（`buildItem()` → `renderMarkdownInto()` で本文を毎回フルパース）。1 メッセージ内で O(本文長²)。長文の最終盤で効く。
- `toolResult` の本文は `<details>` の中でも DOM に載る（実ログで累計 1.27M 文字）。折りたたみは描画コストを消さない。
- 初期描画 1,132ms は、再接続のたびに 400 件で作り直されるうちは問題にならない（実測 100ms）。

---

## 4. 修正プラン

### 案 1（推奨）: 追従スクロールの rAF 化 ＋ 表示件数の上限

**狙い**: 主因（同期強制リフロー）を O(1) にし、同時に DOM を有界にする。ログの中身は消さないので「消えたら困る」リスクが無い。

| 項目 | 内容 |
|---|---|
| 変更ファイル | `src/client/chat.ts`（追従の rAF 化・件数上限とノード破棄）、`src/client/chatModel.ts`（`ChatTranscript` に `trim(max)`）、`test/masterChatUi.test.ts`（`trim` の単体テスト追加） |
| 規模 | 実装 ~120 行、テスト ~60 行 |
| 実装の要点 | ① `scrollToBottom()` を `requestAnimationFrame` で 1 フレーム 1 回に畳む（連続呼び出しは合流）。② `applyEvent()` 後に `items.length > MAX_ITEMS`（既定 400＝サーバ ring と同値）なら先頭から溢れた分を `items` / `rendered` / DOM から落とし、先頭に「これより前はログファイルにのみ残っています」の既存 `.chat-more` 行を出す。 |
| リスク | **中**。`rendered[index]` と `openStream` が**配列 index 依存**（`chat.ts:722-750`, `chatModel.ts:107,318-319`）。先頭を削ると index がずれるので、`trim()` で `openStream` を減算し、`ChatPanel` 側も同じ件数だけ `rendered` を `shift` する必要がある。ここを外すと「別の発言が書き換わる」不具合になる。`jumpToSeq()` は seq 検索なので影響なし（落ちた seq へは元々ジャンプしない）。 |
| テスト方針 | 単体: `trim()` 後に `apply()` を続けても streaming が正しいアイテムへ載ること、`touched` の index が整合すること。実測: `tmp/log-heavy/measure.mjs` を再実行し、22,710 件投入でも **1 トークン 1ms 未満・DOM 4,000 ノード未満**を確認。 |

### 案 2（案 1 と同時に入れる小追加）: リセット時に UI ログも区切る

**狙い**: ボスの言葉どおり「リセットしたらログも消える」を満たす。案 1 だけだと、リセット直後も直前の会話が 400 件ぶん残る。

| 項目 | 内容 |
|---|---|
| 変更ファイル | `src/shared/protocol.ts`（`MasterChatEvent` に `{ kind: "cleared" }` を追加）、`src/server/master/session.ts`（`newConversation()` で `notice` の代わりに/加えて `cleared` を emit）、`src/client/chatModel.ts`（`cleared` を受けたら `items` を空にして区切りアイテム 1 件だけ残す）、`src/client/chat.ts`（`cleared` の change で全再描画）、`test/masterChatSession.test.ts` / `test/masterChatUi.test.ts` |
| 規模 | 実装 ~70 行、テスト ~50 行 |
| 実装の要点 | サーバ ring には `cleared` が 1 件残るので、**再接続・サーバ再起動後の snapshot 復元でも同じ「区切り済み」状態が再現**する（既存の `permissionSettled` と同じ流儀）。JSONL は追記のまま＝過去は失われない。 |
| リスク | **低**。ワイヤ形式に 1 種類足すだけ。旧クライアントは未知 kind を無視する（`chatModel.ts` の switch は default で `NO_CHANGE`）。ただし「見えなくなる」ので、区切り行に「これより前は `.ebi-team/master-chat.jsonl` にあります」を明記すること。 |
| テスト方針 | 単体: `newConversation()` が `cleared` を emit し、`snapshot()` に残ること／`ChatTranscript` が `cleared` で畳めること。e2e: `npm run e2e:master-chat` を拡張し、`chatNew` 後の `chatSnapshot` が区切り以降だけを返すこと。 |

### 案 3（見送り推奨）: 仮想化（virtual scroll）／`content-visibility`

**狙い**: 件数に一切上限を設けず、可視領域だけ描く。

| 項目 | 内容 |
|---|---|
| 変更ファイル | `src/client/chat.ts` 全面（描画とスクロールの設計変更）、`src/client/style.css` |
| 規模 | 実装 300 行以上＋大量の手動確認 |
| リスク | **高**。可変高さ（markdown・画像・`<details>` の開閉）で高さ推定が必要、`jumpToSeq()`・ライトボックス・引用・承認ボタンのフォーカス管理が全部絡む。依存ゼロ方針なのでライブラリも入れられない。 |
| 評価 | **今回は不要**。案 1 で 1 トークン 1ms 未満まで落ちる見込みで、費用対効果が合わない。`content-visibility: auto` を `.chat-row` に付けるだけの軽量版は案 1 の後で単独評価する価値はあるが、`scrollHeight` を読む限り強制リフローは残るので**案 1 の代替にはならない**。 |

### 手動「ログをクリア」ボタンについて

master チャットのヘッダに置くこと自体は 10 行で済む（`transcript.reset([])` ＋ 再描画）。ただし **案 2 を入れれば「新しい会話」ボタンが実質そのボタンになる**ので、UI を増やすより案 2 に寄せるほうがよい。「文脈は残したまま表示だけ捨てたい」という需要が別途出てきたら追加する。

---

## 5. 推奨と順序

**案 1 ＋ 案 2 を 1 本の PR で入れる**（合計 実装 ~190 行 / テスト ~110 行）。

1. 先に **案 1 の rAF 化だけ**を入れて `tmp/log-heavy/measure.mjs` で before/after を取る（1 行の変更で 24.58ms → 1ms 未満になるはずで、ここが最も費用対効果が高い）。
2. 続けて件数上限（案 1 の後半）。index ずれの取り扱いが唯一の要注意点。
3. 最後に `cleared` イベント（案 2）。ボスの要望「リセットしたらログも消える」に直接応える。

案 3 は着手しない。

## 6. 付録: 再現用ハーネス

`tmp/log-heavy/`（`README.md` に手順）。`gen-events.mjs` が実ログから末尾 N 件を切り出し、`harness.html` が `ChatPanel` を素で立ち上げ、`measure.mjs` / `measure2.mjs` が Playwright から数値を採る。8787 番（本番サーバ）とは別に 5175 番を使う。
