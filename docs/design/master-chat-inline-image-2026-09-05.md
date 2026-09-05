# master チャット内で画像を共有し、クリックで拡大表示する設計

- 作成: 2026-09-05 engineer エビ（master 委譲・**設計のみ / 実装なし・コード変更 0**）
- ブランチ: `ebi/ebiteam-chat-inline-image-plan`（push しない）
- ボス要望（原文）: **「生成した画像は open_viewer じゃなくてこのチャット内で共有＆クリックで拡大表示できるようにして」**
- 背景: imagegen エビが生成した画像（例 `tmp/images/smoke-20260905/*.png`）を、master が現状 `open_viewer` で
  別パネルに開いている。これを master の**チャット欄に画像として出し**、クリックでライトボックス拡大したい。
- 前提資料（本設計の SoT）:
  - `docs/design/master-chat-ui-2026-09-05.md`（§0.4 = PR-M4 添付 / §0.6 = PR-M5 承認 / §9 PR 分割 / §10 裁定表）
  - `docs/ops/master-chat-ui.md`（§4 再起動で切れる/残る・§6 e2e の使い分け・§7 添付保管庫の掃除）
  - `src/shared/protocol.ts`（`MasterChatEvent` の SoT）/ `src/client/chat.ts` / `chatModel.ts`
  - `src/server/master/session.ts`（`emitChat()` と seq 採番・JSONL）/ `src/server/chatAttachments.ts` /
    `src/server/viewerRegistry.ts`（`resolveViewerPath` = 許可ルート検証）/ `src/mcp/control-server.ts`（master 専用ツール群）

---

## 0. 結論（3 行 + 補足）

1. **master 専用 MCP ツール `chat_image({ path, title?, caption? })` を新設する**（案 A）。`open_viewer` は触らない。
2. サーバは `resolveViewerPath()`（＝ `EBI_VIEWER_ROOTS` 配下 / realpath / 拡張子 / サイズの既存検証）を通してから、
   実体を **既存の添付保管庫へコピー**し、以降は **basename だけ**で扱う。配信は既存 `GET /control/chat-attachment?name=` の**流用**（新エンドポイント 0 本）。
3. UI はチャット吹き出しにサムネイルカードを出し、クリックで**ライトボックス**（Esc / 背景クリックで閉じる・左右送りは
   トランスクリプト内の全画像を横断）。既存のボス添付サムネイルも**同じライトボックスに載せる**（実装 1 個で両方）。

**protocol.ts の追加は 2 つだけ**（`ChatImage` interface と `MasterChatEvent` の `kind:"image"` 1 件）。
**PR は 1 本**（`PR-M10`）、**0.5〜1 日**。terminal（PTY）master から `chat_image` を呼んだときは
**自動で `open_viewer` にフォールバック**して、ツールが失敗しないようにする。

---

## 1. いま何があって、何が足りないか

| 部品 | 現状 | 本件で足りないもの |
|---|---|---|
| 画像の保管と配信 | `ChatAttachmentStore`（`.ebi-team/chat-attachments/`）＋ `GET /control/chat-attachment?name=`。**basename しか受けない**・MIME 強制・`nosniff` | **そのまま使える**（新規追加なし） |
| チャット吹き出しの画像表示 | **ボスの添付は既に出ている**（`chat.ts` の `attachmentStrip()` / `.chat-attachment-thumb` 最大 160px） | **master 側から出す口**が無い |
| 拡大表示 | 無い（クリックしても何も起きない） | **ライトボックス** |
| 履歴復元 | `master-chat.jsonl` → `chatSnapshot` で `user` の attachments は復元される | **image イベントを JSONL に載せる**（＝ kind 追加すれば自動で乗る） |
| 許可ルート検証 | `resolveViewerPath()`（絶対パス化・拡張子 allow list・realpath・ルート包含・サイズ上限） | **流用**（新しい検証を書かない） |
| master が「見せる」口 | `open_viewer`（別パネル・`viewers.json` に永続化） | チャットに出す口 |

つまり**部品はほぼ揃っていて、足りないのは「master → チャットへ画像を差し込む 1 経路」と「ライトボックス」だけ**。

---

## 2. 経路の案（3 案比較）

### 案 A（推奨）: master 専用 MCP ツール `chat_image` を新設

```
master(claude headless)
  └─ MCP tool  chat_image({ path, title?, caption? })      ← src/mcp/control-server.ts（ROLE==="master" ブロック内）
       └─ POST /control/chat-image                          ← src/server/control.ts
            ├─ resolveViewerPath(path, viewerRoots, …)      ← 許可ルート/realpath/拡張子/サイズ（既存）
            │    └─ format!=="image" は 400
            ├─ ChatAttachmentStore.save(bytes, mime)        ← 保管庫へコピー（既存クラス）
            └─ masterSession.emitChat({ kind:"image", … })  ← seq 採番 + JSONL + WS broadcast（既存経路）
                 └─ クライアント: chatEvent → ChatTranscript → 画像カード → クリックでライトボックス
```

ツール結果として master に返すのは `{ shown: true, name, url }` と一言（「チャットに表示しました」）。
**画像バイト列はツール結果にも NDJSON にも載せない**（master の文脈を食わない）。

- ✅ 意図が 1 対 1（「チャットに見せる」専用の口）。`title` / `caption` を素直に渡せる
- ✅ 既存の口（`open_viewer`）の意味を変えない＝ terminal master の外形ゼロ差分
- ✅ 保管庫コピーのおかげで、**JSONL に残るのは basename だけ**（base64 を載せないのでログが肥大しない）
- ✅ 元ファイルが `tmp/` 掃除で消えても、チャット履歴の画像は残る（スナップショット意味論。viewer のテキストと同じ思想）
- ⚠️ ディスクが二重になる（1 枚あたり最大 8MB。§3.4 と Q-2）
- ⚠️ MCP ツールが 1 本増える（master の tool 一覧が長くなる。現在 master ロールは 10 本前後なので許容）

### 案 B: `open_viewer` の image 形式だけチャットカード化

`open_viewer` が `format==="image"` を開いたら、viewer パネルに加えて（あるいは代わりに）チャットにもカードを出す。

- ✅ 新ツール不要。ボスの言い方（「open_viewer じゃなくて」）への最短距離
- ❌ `open_viewer` は md/txt も開く**汎用の口**で、「パネルで開きたいだけの画像」まで勝手にチャットへ流れる
- ❌ `title` はあるが `caption` を渡す口が無い（ツール定義を変えると結局 A と同じ工数）
- ❌ terminal master も同じツールを使うので、`ui` による分岐が `open_viewer` の中に入る（今はどの UI でも同じ挙動という単純さがある）
- ❌ `viewers.json`（永続化）と `master-chat.jsonl` に**同じ事実が二重に残る**

### 案 C: stream-json の image block を拾う

- ❌ **成立しない**。claude の assistant メッセージは `text` / `thinking` / `tool_use` しか出さず、**画像ブロックを出力しない**
  （入力側だけが image を受ける。PR-M4 §0.4-X の実測はあくまで stdin 方向）。
- 拾えるのは「master が `Read` で画像を読んだときの `tool_result` 内の画像」だが、
  ① `claudeEvents.ts` は `toolResult.content` を**文字列へ潰している** ②「見せる意図」の無い画像まで全部出る
  ③ base64 が JSONL に載って肥大 —— の 3 点で明示ツールに劣る。**却下**。

### 案 D（補助・案 A と併用可）: `open_viewer(image)` のときチャットに 1 行の導線カードを出す

「viewer パネルを開いた」ことだけをチャットに小さく出し、クリックでパネルへ切り替える。
画像そのものはチャットに出さない。**A の補助**として意味があるが、必須ではない（Q-3）。

### 判定

**案 A を採用**。理由は「意図の 1 対 1」「既存の口を汚さない」「配信・永続化・復元が既存部品の流用で済む」の 3 点。
案 D は裁定次第で同 PR に足せる（+0.1 日）。

---

## 3. セキュリティ設計

### 3.1 入口（path を受ける唯一の場所）

`POST /control/chat-image` の `path` は **`resolveViewerPath()` に丸投げ**する（`src/server/viewerRegistry.ts`）。
この関数が既に担保しているもの:

| 攻撃/事故 | 既存の防御 |
|---|---|
| 相対パス・`~` 展開の曖昧さ | `expandHome()` → 絶対パス化 |
| パストラバーサル（`../../etc/passwd`） | `realpath` 解決 → **許可ルート包含判定**（`EBI_VIEWER_ROOTS`・既定 `$HOME/workspace`） |
| シンボリックリンク脱出 | 実体（realpath）基準で判定。ルート側も realpath 化して比較 |
| 非画像の読み出し | 拡張子 allow list（`.png/.jpg/.jpeg/.webp/.gif` のみ通す。`.md/.txt` は `format!=="image"` で 400） |
| 巨大ファイル | `maxImageBytes`（既定 8MB・`EBI_VIEWER_MAX_IMAGE_BYTES`） |
| 特殊ファイル（fifo/dev） | `st.isFile()` チェック |

**新しい検証ロジックは 1 行も書かない**。書くのは「`format !== "image"` なら 400」の 1 分岐だけ。

### 3.2 保管とクライアントへの露出

- 検証を通ったバイト列を `ChatAttachmentStore.save(bytes, mime)` で保管庫へ**コピー**する。
  ファイル名は既存規則 `chat-<YYYYMMDD>-<HHMMSS>-<8hex>.<ext>`（`NAME_RE` で検証される形）。
- **クライアントへ出る配信キーは basename だけ**（`url = /control/chat-attachment?name=...`）。
  元の絶対パスは `sourcePath` として**表示用メタ**にだけ載せ（ツールチップ / ライトボックスのキャプション）、
  **配信経路では一切参照しない**。＝ 新しいパストラバーサル面が増えない。
- 配信は既存ハンドラのまま: `isValidAttachmentName()` → `join` 後に保管庫配下であることを二重確認 →
  `Content-Type`（拡張子由来）/ `X-Content-Type-Options: nosniff` / `Content-Disposition: inline` / `Cache-Control: no-store`。

### 3.3 権限

- `chat_image` は `src/mcp/control-server.ts` の **`if (ROLE === "master")` ブロック内**に置く
  （`open_viewer` / `permission_prompt` と同じ扱い）。**作業エビの MCP には露出しない**。
- 制御 API 側は既存の認証ゲート（`index.ts`）配下。`masterSession` が居ないときの扱いは §6。
- **`chat_image` は承認を要求しない**（`open_viewer` と同じ。読み取り専用・許可ルート限定のため）。

### 3.4 既存 viewer 配信（`/control/viewer-file?id=`）を流用しない理由

`viewer-file` は「**viewer として open 済みのもの**」しか配信しない（`readImage(id)` が `viewers` Map を引く）。
チャット画像のために viewer を裏で open すると、**ボスが閉じていないパネルが勝手に増える**か、
逆に viewer を閉じた瞬間にチャット履歴の画像が 404 になる。ライフサイクルが噛み合わないので使わない。

「コピーせず元パスを参照配信する」案（`/control/chat-image-file?ref=<sha256(path) 前 16 桁>`）も検討したが、
① 新エンドポイント ② ref→path マップの**再起動時再構築**（JSONL の走査が要る） ③ 配信のたびに `resolveViewerPath` 再検証
—— と増える面が 3 つあるのに対し、得られるのは**ディスク節約だけ**。**コピーを推奨**（Q-2）。

---

## 4. protocol.ts への追加（最小 2 つ）

`src/shared/protocol.ts` に足すのは以下だけ。

```ts
/**
 * master がチャットへ共有した画像 1 枚（PR-M10）。
 * 実体は**保管庫へコピーされたもの**で、参照キーは name（basename）だけ。
 * sourcePath は表示用メタで、配信経路では使わない。
 */
export interface ChatImage {
  /** 保管庫の basename（`chat-<ts>-<rand>.png`）。配信の唯一のキー。 */
  name: string;
  /** サムネイル/拡大表示の URL（`/control/chat-attachment?name=...`）。 */
  url: string;
  /** MIME（`image/png` 等）。 */
  mediaType: string;
  /** バイト数（UI 表示用）。 */
  bytes: number;
  /** 共有元の絶対パス（表示・master が Read するとき用。配信には使わない）。 */
  sourcePath: string;
  /** 見出し（未指定は null → UI は basename を出す）。 */
  title: string | null;
  /** 説明文（未指定は null）。 */
  caption: string | null;
}
```

`MasterChatEvent` の union に 1 kind:

```ts
  | { kind: "image"; images: ChatImage[] }
```

**`MasterEvent`（`src/server/master/brain.ts`）には足さない。** この kind は `user` / `inbound` と同じ
「**ワイヤ側にしか無い kind**」（設計書 §0.2-M）で、`MasterSession.emitChat()` を直接呼んで載せる。
＝ `toChatEvent()` の exhaustive switch を触らない＝ backend 実装（claude/codex）に影響 0。

`images` を配列にしておくのは、将来 1 呼び出しで複数枚を出せるようにするため。
**PR-M10 の `chat_image` は 1 枚固定**（`images.length === 1`）で入れる（§5.2 の左右送りは吹き出しを跨ぐので、複数枚を 1 発で出す必要が無い）。

クライアント側 `src/client/chatModel.ts` の `ChatItem` にも 1 kind:

```ts
  | { kind: "image"; seq: number; ts: number; images: ChatImage[] }
```

`applyEvent()` に `case "image": this.closeStream(); return this.push({...})` の 1 ケース。

---

## 5. UI 設計

### 5.1 吹き出し内のサムネイル

- **master 側（assistant 行）のカード**として出す（`bubbleRow("assistant")` + `.chat-bubble assistant`）。
  ボスの添付（右寄せ）と見分けが付く。
- 1 枚のときのサムネイル上限: **`max-width: min(320px, 100%)` / `max-height: 240px` / `object-fit: contain`**。
  画像の縦横比は保つ（生成画像は 1024x1024 や 16:9 が混ざる）。
- `title` があれば画像の上に太字 1 行、`caption` があれば下に `.chat-image-caption`（小さめ・折り返す）。
  無ければ basename をツールチップに出すだけで、行を増やさない。
- `loading="lazy"` / `decoding="async"` を付ける（履歴に画像が溜まったときのスクロール負荷対策）。
- **読み込み失敗（保管庫を掃除した後）** は `img.onerror` で
  `（画像は削除されています: chat-… ）` のプレースホルダに差し替える（履歴の吹き出し自体は残す）。
- カーソルは `zoom-in`、`role="button"` / `tabindex="0"` を付けて **Enter / Space でも開ける**ようにする。

### 5.2 ライトボックス（クリックで拡大）

- 実体は `position: fixed; inset: 0;` の 1 枚のオーバーレイ。**`z-index: 200`**
  （既存の最大は `.chat-*` 周辺の 100 なので、その上に出す）。背景 `rgba(0,0,0,.82)`。
- 中身: 画像（`max-width: 96vw; max-height: 92vh; object-fit: contain`）＋
  下部に `title / caption / sourcePath` の 1〜3 行 ＋ 右上に `×` ＋ 枚数インジケータ `3 / 12`。
- **閉じる**: `Esc` / 背景（画像の外側）クリック / `×`。
- **左右送り**: `←` `→` キーと画面端のボタン。
  送りの対象は「その吹き出しの中」ではなく **トランスクリプト内の全画像**
  （`chat_image` は 1 枚ずつ出すので、吹き出し内に閉じると送りが機能しないため）。
  ボスの添付画像も同じ列に含める（時系列順・§5.4）。
- 開くときに `document.body` へ `overflow: hidden` を掛け、閉じたら戻す（背面スクロール抑止）。
- フォーカス: 開いたらオーバーレイに `focus()`、閉じたら**元のサムネイルへ戻す**（キーボード操作の迷子防止）。
- **スワイプは入れない**（左右ボタンで足りる。§5.5 / Q-6）。

### 5.3 ロジックはどこに置くか（unit で守るため）

既存 unit（`test/masterChatUi.test.ts`）は **DOM に依存しない**（jsdom を入れていない。DOM 側は Playwright スクショで確認）。
この方針を崩さないため、ライトボックスの**状態機械だけを `chatModel.ts` の純クラスに切り出す**:

```ts
/** トランスクリプト全体から、時系列順の画像リストを作る（ボス添付 + master 共有）。 */
export function collectImages(items: readonly ChatItem[]): LightboxEntry[];

/** 開いている画像の index と、next/prev/close の遷移だけを持つ純クラス。 */
export class LightboxState { open(key): void; next(): void; prev(): void; close(): void; get current(): … }
```

DOM（`chat.ts`）は `LightboxState` の値を描画するだけにする。→ **左右送り・端での折り返し有無・
閉じたあとの復帰は unit で検証でき、Playwright は見た目の確認だけで済む**。

### 5.4 履歴（JSONL）からの復元

- `kind:"image"` は `emitChat()` を通るので **`master-chat.jsonl` に自動で載る**（base64 は載らない＝肥大しない）。
- 再接続・サーバ再起動後は `chatSnapshot` → `ChatTranscript.reset()` でそのまま復元される（**追加実装ゼロ**）。
- 実体（保管庫のファイル）は残る（`docs/ops/master-chat-ui.md` §4 の「残るもの」に載る）。
  手動掃除で消えていた場合は §5.1 のプレースホルダになる。
- `collectImages()` は snapshot 適用後の items から作り直す（ライトボックスの並びも復元される）。

### 5.5 スマホ（375px）

- サムネイル: `max-width: 100%` が効くので横はみ出ししない。カード幅は吹き出し幅に従う。
- ライトボックス: `max-width: 96vw / max-height: 92vh` の `contain` なので縦横どちらの画像も収まる。
  左右ボタンは **44x44px 以上**のタップ領域にする（親指で押せる大きさ）。
- 背面スクロール抑止（§5.2）は iOS Safari で特に効く。
- `chat-image` カードは既存の `.chat-attachments` と同じ余白系（`gap: 8px` / `margin-top: 6px`）に揃える。

---

## 6. terminal（PTY）master での挙動

`src/mcp/control-server.ts` は **`ui` を知らない**（`EBI_MCP_ROLE` しか見ない）。したがって
terminal master でも `chat_image` は tool 一覧に出るし、呼ばれうる。

**推奨: サーバ側で自動フォールバックする**（Q-4）。

```
POST /control/chat-image
  ├─ masterSession あり（ui:"chat"）→ 保管庫へコピー + emitChat → { shown:"chat", name, url }
  └─ masterSession なし（ui:"terminal"）→ openViewer(path, title) を呼ぶ
                                        → { shown:"viewer", id } ＋ note「chat master が居ないため viewer で開いた」
```

- ツールが**失敗しない**ので、master が「chat か terminal か」を意識せずに済む（役割プロンプトを分岐させない）。
- `open_viewer` が既にやっている検証と同じ検証を通るので、セキュリティ面の差は無い。
- ロールバック（`ui` を terminal に戻す）したときも master の書き方を変えずに済む＝
  `docs/ops/master-chat-ui.md` §4 の「1 手で戻せる」性質を壊さない。
- 反対案（`ui:"terminal"` では 404 を返してツールを失敗させる）は、
  PR-M4 の添付エンドポイントが「chat master が居ない構成では塞ぐ」方針を採っている点と整合するが、
  **あちらは書き込み口（外から保管庫にファイルを置ける口）で、こちらは読み取り + 表示**なので、
  同じ扱いにする必要は無いと判断した。裁定は Q-4。

---

## 7. PR 分割・テスト方針・工数

### 7.1 PR は 1 本（`PR-M10`）

> 番号について: 設計書 §9 の表では **PR-M8 = codex brain（opt-in・未着手）** / **PR-M9 = gemini（取り消し・欠番）** なので、
> 本件は衝突を避けて **PR-M10「チャット内画像共有」** と名乗る。マージ後に §9 の表へ 1 行追記する。

| 変更ファイル | 内容 | 規模目安 |
|---|---|---|
| `src/shared/protocol.ts` | `ChatImage` / `kind:"image"` | +25 行 |
| `src/server/chatImages.ts`（新規） | `shareChatImage(path, title, caption)` = 検証 → コピー → `ChatImage` 組み立て（**純粋関数に近い形**で切る） | +70 行 |
| `src/server/control.ts` | `POST /control/chat-image`（deps 経由・§6 のフォールバック分岐） | +40 行 |
| `src/server/index.ts` | deps 配線（`shareChatImage` / `openViewer` の合成） | +15 行 |
| `src/server/master/session.ts` | `shareImage(images)` = `emitChat({kind:"image", …})` の薄いラッパ | +10 行 |
| `src/mcp/control-server.ts` | `chat_image` ツール（master ロール限定） | +30 行 |
| `src/client/chatModel.ts` | `ChatItem` の `image` / `collectImages()` / `LightboxState` | +90 行 |
| `src/client/chat.ts` | 画像カード描画・ライトボックス DOM・既存サムネイルのクリック配線 | +120 行 |
| `src/client/style.css` | `.chat-image*` / `.chat-lightbox*` | +60 行 |
| docs | `docs/ops/master-chat-ui.md` に「画像共有」節 ＋ §7 掃除の追記、設計書 §9 に 1 行 | +40 行 |

分けるとしたら「①サーバ + protocol」「②UI + ライトボックス」の 2 本にできるが、
**①だけマージすると画像が出せるのに表示されない**（`kind:"image"` を知らないクライアントは無視する）ので、
レビュー単位としても 1 本が自然。

### 7.2 テスト

**unit（新規 18〜22 本・DOM 非依存）**

| ファイル | 検証 |
|---|---|
| `test/chatImages.test.ts`（新規） | 許可ルート外 → 拒否 / `.md` → 拒否（image 以外）/ サイズ超過 → 拒否 / 正常系でコピー後の名前が `NAME_RE` に合う / `sourcePath` が絶対パス / シンボリックリンクでルート外を指したら拒否 |
| `test/masterChatUi.test.ts`（追記） | `image` イベントの畳み込み（push される・streaming を閉じる）/ snapshot 再適用で復元 / `collectImages()` が **ボス添付と master 共有を時系列で 1 列にする** / `LightboxState` の next/prev/端での挙動/close |
| `test/masterChatSession.test.ts`（追記） | `shareImage()` が seq を進め JSONL に載る / snapshot に含まれる |
| `test/masterChatWiring.test.ts`（追記） | `masterSession` 不在時に `/control/chat-image` が viewer フォールバックへ落ちる |

**e2e（実 claude を消費しない）**

`scripts/e2e-master-chat-image.mjs` は「添付が turn に届くか」を実 claude で見る既存スクリプトなので**触らない**。
本件は新規 `scripts/e2e-master-chat-share-image.mjs`（`npm run e2e:master-chat-share-image`）を追加し、
**偽 claude スタブ（`scripts/fake-claude-stream.mjs`）**の土俵で回す:

1. 専用ポート + `mkdtemp` の状態ディレクトリでサーバを起動（`EBI_MASTER_UI=chat`・`EBI_VIEWER_ROOTS` を temp 配下に固定）
2. temp 配下に PNG を 2 枚生成（既存スクリプトの単色 PNG ジェネレータを流用）
3. `POST /control/chat-image` → 200・`name` が保管庫形式・`url` が 200 で**同じバイト列**を返す
4. WS に `chatEvent{kind:"image"}` が流れる（seq が単調）
5. **許可ルート外のパス → 400**（`/etc/hosts` ではなく temp の外に置いた PNG で確認）／`.md` → 400
6. サーバ再起動 → `chatSnapshot` に image イベントが残っている（`master-chat.jsonl` 経由）
7. `EBI_MASTER_UI` を外した（terminal）サーバで同じ POST → **viewer フォールバック**（`shown:"viewer"`）になり、
   `GET /control/viewer-file?id=` が 200

さらに `fake-claude-stream.mjs` に `img:<path>` 指令を足し、
**MCP ツール → 制御 API の実配線**（`chat-permission` と同じ叩き方）を 1 チェックだけ通す。

**回帰**: `npm test`（unit 全体）/ `npm run build` / `npm run e2e:all-chat` 全 green /
`ui` 未指定での外形ゼロ差分（`e2e:all-terminal` は画像共有に触らないが、`control.ts` を触るので 1 回通す）。
Playwright スクショ 4 枚（`tmp/shots-m10/`: PC のカード / ライトボックス / 375px のカード / 375px のライトボックス）。

### 7.3 工数

| 作業 | 目安 |
|---|---|
| サーバ（protocol / chatImages.ts / control / index / session / MCP） | 0.2 日 |
| UI（chatModel の純ロジック + chat.ts + style.css） | 0.4 日 |
| テスト（unit + e2e スクリプト + スクショ） | 0.3 日 |
| docs 追記 | 0.1 日 |
| **合計** | **0.5〜1 日** |

---

## 8. 裁定が要る点（Q-1 .. Q-7）

| # | 論点 | 選択肢 | **推奨** |
|---|---|---|---|
| **Q-1** | 画像をチャットに出す口 | (a) 新設 MCP `chat_image` / (b) `open_viewer` を拡張 / (c) stream-json から拾う | **(a)**。意図が 1 対 1 で、既存の `open_viewer` の意味を壊さない。(c) は claude が画像を出力しないので技術的に不成立 |
| **Q-2** | 実体の持ち方 | (a) 保管庫へ**コピー** / (b) 元パスを参照配信（ref マップ） | **(a) コピー**。配信・復元が既存部品の流用で済み、元ファイルが消えても履歴が壊れない。代償は最大 8MB/枚のディスク |
| **Q-3** | `open_viewer(image)` を呼んだとき、チャットにも導線カード（案 D）を出すか | (a) 出さない / (b) 「viewer を開いた」1 行カードを出す | **(a) 出さない**（まず `chat_image` に一本化して様子を見る）。欲しくなったら +0.1 日で足せる |
| **Q-4** | terminal（PTY）master で `chat_image` を呼んだとき | (a) **自動で `open_viewer` フォールバック** / (b) 404 でツールを失敗させる | **(a)**。`ui` を戻したときに master の書き方を変えずに済む＝ロールバック 1 手の性質を保てる |
| **Q-5** | 保管庫の掃除 | (a) 既存の `chat-attachments/` に同居（掃除は既存手順の `find -mtime +30 -delete` のまま） / (b) `chat-images/` を分ける | **(a) 同居**。掃除手順を 2 本に増やさない。増加量の目安（生成画像 1 枚 1〜3MB × 日 10 枚 = 月 300〜900MB）を docs に追記する |
| **Q-6** | ライトボックスの操作 | 左右送りの範囲: (a) トランスクリプト内の全画像 / (b) その吹き出し内だけ。スワイプ: (c) 入れる / (d) 入れない | **(a) + (d)**。`chat_image` は 1 枚ずつ出すので (b) だと送りが死ぬ。スワイプは実装/テストの割に得が薄い |
| **Q-7** | 作業エビ（imagegen 等）が**直接**チャットへ画像を出せるようにするか | (a) しない（master 経由のまま） / (b) `reply_to_master` に画像を添えられるようにする | **(a) しない**。作業エビ MCP に書き込み口を増やさない現行方針（PR-M4 §0.4-Y）を維持。(b) は別 PR の議題（§9） |

---

## 9. 気づき（要件外・今回はやらない）

1. **`reply_to_master` に画像を添える**（Q-7 (b)）: imagegen エビ → master の往復が 1 段減る。
   ただし「作業エビが master のチャットへ直接書き込める」ことになるので、保管庫の書き込み権限と
   1 返信あたりの枚数上限を別途詰める必要がある。**別 PR の議題**。
2. **`chat_image` の `caption` を master に必ず書かせる**: 後から `master-chat.jsonl` を grep して
   「あの画像どれだっけ」を引けるようになる。役割プロンプト（`src/server/roles.ts` の master）へ 1 行足すだけ。
3. **imagegen の納品フローとの接続**: imagegen エビの納品先（`tmp/images/<job_id>/`）が
   `EBI_VIEWER_ROOTS` 配下にあることが前提。`ebi-team` リポジトリ配下なら既定 `$HOME/workspace` で通るが、
   **ジョブ側が別ルートへ出すようになったら壊れる**ので、`docs/design/imagegen-role-2026-09-05.md` 側にも
   「納品先は許可ルート配下」と注記しておくとよい。
4. **viewer パネルは残す**: md/txt のレビューには引き続き viewer が最適で、画像の**原寸でじっくり見る**用途も
   ライトボックスより viewer の方が向く場面がある（並べて比較する等）。置き換えではなく**併存**が正解。
5. **動画 / PDF は対象外**: 拡張子 allow list に入れない。必要になったら別途（配信ヘッダと上限の設計が別物）。
6. **保管庫の総容量をヘッダに出す**案: `$ / ctx / 5h / 週` の並びに `保管庫 1.2GB` を足すと掃除の合図になるが、
   ヘッダが混むので**通知（notice）で閾値超過時だけ出す**方が良さそう。今回は入れない。
