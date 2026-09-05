# master チャット: 停止ボタン分離 + 返信（引用）機能 設計プラン

- 日付: 2026-09-05
- 起票: ボス指示（① 「停止はチャット送信とは別でできるようにして。じゃないと停止中しかチャット送れなくなる」／② 「改修ついでにリプライ機能もほしい。master のどの内容に対して俺が回答したかわかりやすくしたい」）
- 状態: **プランのみ。実装はボス承認後**

---

## 0. 現状（実装箇所の特定）

### 0.1 送信 / 停止

| 位置 | 内容 |
| --- | --- |
| `src/client/chat.ts:156-159` | 送信ボタン `this.sendBtn`（クラス `chat-send`）を 1 個だけ作り、`click` → `onSendClick()` |
| `src/client/chat.ts:279-297` | `onSendClick()`。**先頭で `this.state === "busy"` なら `onStop(masterId)` して return**（＝送信操作が停止操作に化ける） |
| `src/client/chat.ts:265-268` | `onKeyDown()`。Enter（Shift 無し）で `onSendClick()` → **busy 中は Enter が停止になる**（今日の事故の主経路） |
| `src/client/chat.ts:422-433` | `syncControls()`。busy のときラベルを `⏹ 停止` に、`chat-send` に `.stop` を付ける。`starting` / `stopped` では送信ボタンと入力欄を `disabled` |
| `src/client/main.ts:62-66` | `onSend` → WS `chatSend` / `onStop` → WS `chatStop` |
| `src/server/index.ts:986-993` | `chatStop` → `session.interrupt()` |
| `src/server/master/session.ts:572-575` | `interrupt()` → `brain.interrupt()`（SIGINT ではない。会話は殺さない） |
| `src/shared/protocol.ts:637-641` | `ChatStopMessage { type:"chatStop"; id }` |
| `src/client/style.css:1144-1145` | `.chat-send` / `.chat-send.stop`（背景 `--busy`） |

### 0.2 busy 中の送信はそもそも通る（重要）

`session.sendUserText()`（`src/server/master/session.ts:508-537`）は state を見ておらず、`brain` さえ生きていれば投入する。
設計書 `docs/design/master-chat-ui-2026-09-05.md` の修正点 F（§85 / §424 / §686）に **「busy 中の投入はキューされず走行中ターンに合流する（`queued_turn_count` は 0 のまま）」** と実測結果が明記されている。
つまり **サーバ側は無変更で、busy 中の `chatSend` はそのまま master に届く**。ブロックしているのはクライアント側 `onSendClick()` の分岐だけ。

- `starting` / `stopped` は brain が居ないので送っても `accepted:false`（`src/server/index.ts:979-980` でエラー表示）。ここは従来どおり入力欄を無効化する。
- `waiting`（未応答の承認/質問あり）は現状も送信可能。挙動は変えない。

---

## 1. 停止分離のプラン（最小変更）

### 1.1 UI 前後

| | 変更前 | 変更後 |
| --- | --- | --- |
| ボタン | 1 個。busy 中だけ `⏹ 停止` に化ける | **2 個。`送信`（常時）＋ `⏹`（停止・busy のときだけ有効）** |
| busy 中の Enter | 停止が飛ぶ | **送信される**（走行中ターンに合流） |
| busy 中のクリック | 停止が飛ぶ | 送信ボタン＝送信 / 停止ボタン＝停止 |
| starting・stopped | 入力欄と送信ボタンを無効化 | 同左。停止ボタンも無効 |
| idle・waiting | 停止ボタンは存在しない | **停止ボタンは表示するが `disabled`**（レイアウトを揺らさない） |

### 1.2 実装差分（3 ファイル）

1. `src/client/chat.ts`
   - フィールド `private readonly stopBtn: HTMLButtonElement` を追加。`chat-stop` クラス、ラベル `⏹`、`title="実行中のターンを中断します（会話は消えません）"`、`aria-label="停止"`。`row.append(this.input, this.stopBtn, this.sendBtn)`。
   - `onSendClick()`: **`state === "busy"` の分岐を削除**。`blocked`（starting / stopped）のみ早期 return。
   - `onStopClick()` を新設: `masterId` があり `state === "busy"` のときだけ `onStop(masterId)`。
   - `syncControls()`: `sendBtn.textContent` は常に `"送信"`、`.stop` トグル削除。`stopBtn.disabled = this.state !== "busy"`。placeholder は busy 中だけ `master に話しかける（実行中でも送れます / Enter で送信）` に差し替え。
2. `src/client/style.css`
   - `.chat-send.stop` を `.chat-stop` へ置換（`flex:0 0 auto; min-height:38px;` 背景 `--busy`、`disabled` は既存の共通 disabled スタイルに乗る）。狭幅（`@media` 1322 行付近）にも `.chat-stop { min-height: 44px; }` を追加。
3. `src/client/main.ts` — **変更なし**（`onStop` の配線は既存のまま使う）。

サーバ / `protocol.ts` は **無変更**。

### 1.3 誤爆防止

- 停止は「押した瞬間に飛ぶ」ままとし、**確認ダイアログや長押しは入れない**。
  - 根拠: 事故の原因は「送信操作が停止に化けること」であり、ボタンが分かれれば誤爆経路は消える。停止は緊急操作なので確認を挟むと本来の用途を損なう。
  - 代わりに、送信ボタンとの間に 8px のギャップ（既存 `.chat-input-row` の gap）＋色分け（`--busy`）＋ `title` で区別する。
- ボスが「やっぱり確認が欲しい」と判断した場合の追加は 3 行（`window.confirm`）で済むので、承認時に一言もらえれば入れる。

### 1.4 キーボード

- `Enter` = 送信（Shift+Enter = 改行）。**変更なし**。
- **停止にショートカットは割り当てない。** `Esc` は既にライトボックスの閉じるキー（`src/client/chat.ts:623-626`）で、入力欄フォーカス中の `Esc` を停止にすると「入力を取り消すつもりが停止」という同種の事故を再生産する。停止はボタンのみ。

### 1.5 テスト影響

- `test/masterChatUi.test.ts` / `test/masterChatWiring.test.ts` は **`ChatPanel` を DOM ごと組み立てていない**（`ChatTranscript` / `InputHistory` / `LightboxState` などの純ロジックと、サーバ配線が対象）。既存テストの**修正は不要**。
- `test/masterChatSession.test.ts:417,476`（`chatStop` → `interrupt()`、中断後も会話継続）はサーバ側なので影響なし。
- 追加テスト: `chat.ts` から純関数 `sendEnabled(state)` / `stopEnabled(state)` を切り出して export し、`masterChatUi.test.ts` に「busy でも送信可・busy のときだけ停止可・starting/stopped は両方不可」を 1 本追加する（DOM を持ち込まないため）。
- 実機確認は Playwright のみ（稼働中の 8787 は止めない・触らない。確認は別ポートの dev サーバで行う）。

---

## 2. 返信（引用）機能のプラン

### 2.1 (1) メッセージに安定 id はあるか → **ある。`seq` を使う**

- 全チャットイベントは `MasterChatEnvelope { seq, ts, event }`（`src/shared/protocol.ts:589-593`）で採番され、JSONL に追記され、`chatSnapshot` で seq 昇順に復元される（`src/client/chatModel.ts:137-142` が seq で重複を捨てている）。**再起動を跨いで安定**。
- `ChatItem` も `seq` を持つ（`src/client/chatModel.ts:24-76`）。ただし注意点が 2 つ:
  - **streaming の assistant アイテムは「最初の partial の seq」を保持する**（`applyStream`、`src/client/chatModel.ts:279-305`）。後続 partial の seq は捨てられるので、引用先としては **ブロック先頭の seq** を指すことになる。これは「どの発言に返信したか」の粒度として妥当。
  - `tool` アイテムは `toolCall` の seq に `toolResult` を畳む。返信対象は **`assistant` / `thinking` / `tool` / `image` / `inbound`** に限定し、`user`（自分の発言）・`pending`・`notice`・`turnEnd`・`session` にはボタンを出さない（初版は `assistant` と `image` に絞ってもよい。§2.5 で判断を仰ぐ）。
- 新規 id の付与は不要。**表示用の参照キーは `master#<seq>`** とする。

### 2.2 (2) UI

- **返信の起点**: 各バブル（`buildItem()` の返す `chat-bubble`）の右上に、`chat-bubble:hover`／`:focus-within` で現れる小ボタン `↩︎`（`aria-label="このメッセージに返信"`）。タッチ端末では常時薄く表示（`@media (hover:none)` で `opacity:.5`）＝長押しは実装しない（長押しは iOS のテキスト選択と衝突するため）。
- **引用プレビュー**: 入力欄の上（`chat-foot` 内、`trayEl` の隣）に `chat-reply-preview` を追加。`↩︎ master#123 に返信` ＋ 抜粋（先頭 60 文字・改行は空白へ潰す）＋ `✕`（解除）。抜粋クリックで該当バブルへ `scrollIntoView` ＋ `flash`（`scrollToPending()` と同じ手法・`src/client/chat.ts:442-450`）。
- **`Esc` で解除**しない（§1.4 と同じ理由）。解除は `✕` のみ。
- **送信後の表示**: ボスの `user` バブルの中に、本文の上に引用チップ `chat-quote`（`↩︎ master#123: <抜粋>`）を出す。クリックで引用元へジャンプ。ジャンプ先が snapshot の範囲外（ログにしか無い）なら、チップは出すがクリックを無効化しツールチップで「これより前の会話はログにのみ残っています」。
- 引用は **1 件のみ**（複数返信は作らない）。新しく `↩︎` を押したら差し替え。

### 2.3 (3) protocol / サーバ側の変更点

```ts
// src/shared/protocol.ts
/** 返信の引用元（PR-M11）。seq は MasterChatEnvelope.seq。 */
export interface ChatReplyRef {
  seq: number;
  /** 表示用の抜粋（クライアントが作り、サーバは中身を検証しない・最大 200 文字）。 */
  excerpt: string;
}

export interface ChatSendMessage {
  // ...既存
  replyTo?: ChatReplyRef;   // 追加
}

// MasterChatEvent の user イベント
| { kind: "user"; text: string; attachments?: ChatAttachment[]; replyTo?: ChatReplyRef }  // replyTo 追加
```

- `src/server/index.ts` の `case "chatSend"`: `msg.replyTo` を `session.sendUserText()` へ素通し。`excerpt` は **200 文字で clamp・制御文字を除去**してから使う（クライアント由来の文字列なので長さだけは信用しない）。`seq` は数値であること以外は検証しない（存在しない seq でも表示が壊れないため）。
- `src/server/master/session.ts` `sendUserText()`:
  - `emitChat({ kind:"user", text, replyTo })` → JSONL・snapshot・再起動復元は**追加実装ゼロ**で乗る（`shareImage()` と同じ理屈）。
  - **master の CLI に届く本文**（`brain.send({ text: body })` の `body`）に引用ヘッダを前置する:
    ```
    > [reply to master#123] Playwright で確認したところ、送信ボタンが…
    <ボスの本文>
    ```
    - 1 行目は `> [reply to master#<seq>] <excerpt を 1 行へ潰したもの>`。
    - 既存の添付フッタ（`[添付ファイル]\n<絶対パス>`）はその後ろに続く（順序: 引用ヘッダ → 本文 → 添付フッタ）。
- `src/client/chatModel.ts`: `ChatItem` の `user` に `replyTo?: ChatReplyRef` を足し、`applyEvent` の `case "user"` で写す。
- `src/client/chat.ts`: `buildItem()` の `user` ケースで `chat-quote` を描画。`ChatPanel` に `replyTo: ChatReplyRef | null` の状態と `setReplyTo()/clearReplyTo()`、`onSend` のシグネチャに 4 引数目（`replyTo`）を追加 → `main.ts` の配線 1 行を変更。

テスト追加: `masterChatUi.test.ts` に「`user` イベントの `replyTo` がトランスクリプトへ載る／無ければ undefined」、`masterChatSession.test.ts` に「`replyTo` 付き `sendUserText` が `> [reply to master#N] …` を前置して brain へ送る」。

### 2.4 (4) 同じ PR にするか → **分ける（2 本）**

| PR | 内容 | 規模 | 根拠 |
| --- | --- | --- | --- |
| **PR-A（停止分離）** | §1。client 2 ファイル・サーバ無変更・純関数テスト 1 本 | 〜60 行 | **事故が起きている回帰なので単独で早く出してマージする**。レビューも短い |
| **PR-B（返信/引用）** | §2。protocol / server / client / test | 〜250 行 | 新機能。protocol 変更を含むのでレビュー観点が別。PR-A を待たずに並行で書けるが、`chat.ts` の入力欄まわりで衝突するため **PR-A マージ後に rebase して出す** |

### 2.5 承認時に確認したい点

1. 返信ボタンを出す対象は「master の発言（assistant）＋ 共有画像 ＋ ツール ＋ エビ返信（inbound）」でよいか。それとも初版は **assistant のみ**に絞るか（推奨: assistant + image + inbound。tool は数が多く邪魔になりがち）。
2. 停止ボタンに確認ダイアログは **入れない**方針でよいか（§1.3）。

---

## 3. リスク

| リスク | 影響 | 緩和 |
| --- | --- | --- |
| busy 中の送信が「走行中ターンに合流」する仕様に依存している | 合流されず握り潰されるとボスの発言が消える | 修正点 F で PoC 実測済み。加えて `user` バブルは投入前に必ず出るので**送ったことは UI に残る**。承認後 Playwright で busy 中送信を 1 度実測する |
| busy 中に送れるようになることで、ボスが連投して master のターンが長くなる | 文脈消費が増える | 挙動としては現状の「エビからの配送」と同じ経路。UI 変更なし |
| 停止ボタンが常時見えることで別種の誤爆（idle のとき押す） | 無し（idle では `disabled`） | `disabled` ＋ tooltip |
| `seq` を引用キーにすると、ログを跨いだ古い発言への返信でジャンプ先が無い | チップは出るがジャンプできない | クリック無効＋ツールチップ（§2.2）。master 側本文には `master#<seq>` が載るので参照自体は成立 |
| `excerpt` がクライアント由来 | 長大文字列 / 制御文字の投入 | サーバで 200 文字 clamp ＋ 制御文字除去（§2.3）。表示は全て `textContent` |

---

## 4. 気づき（今回のスコープ外・実装しない）

- `syncControls()` が「ボタンのラベル」と「操作の意味」を同時に切り替える設計そのものが今回の事故の温床だった。以後、**1 つのコントロールが状態によって別のコマンドを発行する UI は避ける**（ラベルだけ変えて意味は変えない、が安全）。
- `starting` / `stopped` で入力欄ごと `disabled` にしているため、master が落ちている間にボスが文章を書き溜められない。`disabled` を外して「送信時にエラー表示」にする方が親切だが、別件。
- チャットログのページング（`chatHistory`）はクライアント未実装（`renderAll()` は「これより前はログファイルにのみ」と出すだけ）。§2.2 の「ジャンプ先が無い」問題はページング実装で自然に解消する。
