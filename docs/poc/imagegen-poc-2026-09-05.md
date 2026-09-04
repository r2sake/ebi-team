# 画像生成 PoC（2026-09-05）— Gemini エビ / Codex エビに画像を生成させ、master が viewer で見る

対象: gemini-cli **0.58.0** / codex-cli **0.146.0**、ebi-team main `b2142da`
検証ブランチ: `ebi/ebiteam-poc-imagegen`（worktree `.worktrees/ebi-ebiteam-poc-imagegen`）
検証アカウント（**この状態で検証せよ**という前提）:

| CLI | アカウント | 枠 |
|---|---|---|
| Gemini | Workspace 垢（`yoshitaka.ota@nexlim.co.jp`）／`GOOGLE_CLOUD_PROJECT=engineering-478708` | Gemini Code Assist **Standard** |
| Codex | ChatGPT 個人垢（`spdba.y.ota@gmail.com`）／`chatgpt_plan_type: "free"` | **無料枠** |

`GEMINI_API_KEY` / `OPENAI_API_KEY` による API 直課金は一切使っていない。

---

## 0. 結論（3 行）

1. **現アカウント状態では、Gemini・Codex とも画像生成は不可**（A ×／B ×）。理由は別々で、Gemini は
   **CLI に画像生成の口が無く、Code Assist 経路が画像モデルを配っていない**。Codex は
   **CLI 側に組み込み `image_gen` ツールが実装済みだが、無料プランのセッションにはそのツールが配られない**。
2. したがって C（エビに生成させ master が viewer で見る）は**画像生成の一段目で止まる**。
   ただし「エビを spawn → タスク注入 → `reply_to_master` で結果回収」までは両バックエンドで通っており、
   **PNG さえ置ければ配送経路は既に成立している**。
3. `open_viewer` は **`.md` / `.markdown` / `.txt` のみ**。PNG は現状 400 で弾かれる（実測）。
   画像対応には §5 の最小改修（`ViewerFormat` に `image` を足し、バイト列を返す読み取り専用 API を 1 本足す）が要る。**実装は要件外なので提案に留めた**。

---

## 1. A: Gemini CLI（0.58.0）で画像生成できるか → **×**

調査した 4 経路すべてに口が無い。

| 経路 | 結果 | 実測 |
|---|---|---|
| 組み込みツール | **×** | CLI のツール群に画像生成ツールが無い。バンドルの `generateImage` は同梱 `@google/genai` SDK のメソッド（`models.generateImages`）で、**エージェントのツールとしては露出していない** |
| モデル指定 `-m gemini-2.5-flash-image` | **× 404** | `ModelNotFoundError: Requested entity was not found. (code 404)`。Code Assist（OAuth）経路にこのモデルは無い。`docs/backends/gemini.md` §7 の「モデル alias の 404」と同じ壁 |
| 拡張（`gemini extensions`） | **未実施（要判断）** | `No extensions installed.`。公式の genmedia 系拡張（Imagen / Veo）は **Vertex AI 課金**が前提で、サブスク枠では動かない。§4 参照 |
| MCP ツール | **未実施（要判断）** | `No MCP servers configured.`。画像生成 MCP はいずれも API キーか Vertex 課金が要る |
| skills | **×** | `gemini skills list` → cloudflare-deploy / pdf / security-best-practices の 3 つのみ。画像生成なし |

### 実行コマンドと出力

```bash
# 1) trust ゲート（headless では --skip-trust が要る）
gemini -m gemini-2.5-flash-image --approval-mode yolo -p "Generate an image of a cute shrimp mascot."
#   → Gemini CLI is not running in a trusted directory. ... (exit 55)

# 2) trust を越えたうえで画像モデルを指定
gemini --skip-trust -m gemini-2.5-flash-image --approval-mode yolo -p "Generate an image of a cute shrimp mascot."
#   → ModelNotFoundError: Requested entity was not found. { code: 404 }   （tmp/imagegen/g2.err）
```

### 結論

**Gemini Code Assist Standard（Workspace 垢の OAuth 経路）は画像生成モデルを配っていない。**
gemini-cli 側にも生成した画像を保存するツールが無いので、仮にモデルが通っても
「PNG をファイルに落とす」段が別途要る。**サブスク枠のままで A を○にする道は無い。**

---

## 2. B: Codex CLI（0.146.0）で画像生成できるか → **×（無料垢では）**

**ここは「機能が無い」ではなく「無料プランに配られていない」**。これが今回いちばん重要な発見。

### 分かったこと

- codex 0.146 には**組み込みの `image_gen` ツールが実装されている**。バイナリ内に
  `ext/image-generation/src/tool.rs` / `struct ImagegenArgs { prompt, referenced_image_paths, num_last_images_to_include }`
  があり、`$CODEX_HOME/skills/.system/imagegen/SKILL.md` が同梱されている。
  SKILL.md は明記している: **「built-in `image_gen` tool … Does not require `OPENAI_API_KEY`」**
  （＝サブスク枠で動くはずの経路）。保存先の既定は `$CODEX_HOME/generated_images/`。
- 機能フラグも **有効**: `codex features list` → `image_generation  stable  true`。
- それでも**セッションのツール一覧に `image_gen` が入らない**。決定的な実測（`RUST_LOG=trace`）:

```bash
RUST_LOG=trace codex exec -s read-only "hi"
# response.created の response.tools を取り出すと:
#   tools: wait, request_user_input, exec, collaboration
#   → image_gen は含まれていない（クライアントが送っていない）
```

- モデルが「使えません」と言っているだけ（ハルシネーション）ではないことは、上の tools 配列で確認済み。
- アカウントは無料プラン: `~/.codex/auth.json` の id_token クレームに
  `"chatgpt_plan_type": "free"`, `"chatgpt_subscription_active_until": null`。

### 実行コマンドと出力

```bash
# exec（非対話）
codex exec -s workspace-write -c check_for_update_on_startup=false \
  "tmp/imagegen/ に … codex-shrimp.png … 組み込みの image_gen ツールを使ってください。"
#   → imagegen SKILL.md を読んだうえで
#      「組み込みの image_gen ツールがこの環境では利用できないため、生成できませんでした。」
#      （tmp/imagegen/c1.log。tokens used 9,964）

# 対話 TUI（PTY・ebi-team と同じ起動形）でも同じ
#   → 「組み込みの image_gen ツールが利用できません。」（tmp/imagegen/c2.raw）
```

### 結論

**`image_gen` は Plus / Pro など有料 ChatGPT プランのエンタイトルメントで配られる**と見るのが自然
（クライアント側に `-c tools.image_gen=true` のような開ける設定は無く、未知キーは黙って無視される）。
**有料垢を 1 つ用意できれば B は○になる可能性が高い**が、無料垢のままでは打つ手が無い。
CLI フォールバック（`scripts/image_gen.py` + `gpt-image-2`）は **`OPENAI_API_KEY` 必須**＝今回の禁止事項。

---

## 3. C: ebi-team のエビとして spawn して生成させる → **画像生成の一段目で停止**

`scripts/poc-imagegen-ebi.mjs`（本 PoC 用に追加した使い捨てドライバ）で実測した。
**稼働サーバ（8787）には一切触れていない**。専用ポート **8811** で control-server を自前起動し、
master は bash の使い捨てエビ、状態ディレクトリは mkdtemp。終了時に全プロセスを撤収している。

```bash
node scripts/poc-imagegen-ebi.mjs codex
node scripts/poc-imagegen-ebi.mjs gemini
```

| backend | spawn | タスク注入 | 生成 | reply_to_master 着弾 |
|---|---|---|---|---|
| codex（`-s workspace-write`） | ○ | ○（`via: pty`） | **×** | **○** |
| gemini（`--approval-mode yolo`） | ○ | ○（`via: pty`） | **×** | **×**（下記） |

- **codex エビの master 着弾（原文）**:
  `[from:ebi-1] [reply] 生成できませんでした。組み込み image_gen ツールの利用可否を確認しましたが、この環境には公開されていません。CLI フォールバックは明示承認と OPENAI_API_KEY が必要なため実行していません。`
  → §2 の結論を **ebi-team のランタイム上でも再現**（エビ本人の口から確認できた）。
- **gemini エビ**: 画面上は「調査完了・`reply_to_master` にて送信済み」と述べるが、**master の scrollback には何も届かなかった**。
  ツール呼び出しが実際には行われず「送ったつもり」になっている疑い。**PoC の主題外だが要追跡**（§6）。
- **gemini は `permissionMode: acceptEdits`（= `auto_edit`）だと `WriteTodos` の承認ダイアログで停止**し、注入が食われた。
  `bypassPermissions`（= `yolo`）で越えられる。`docs/backends/gemini.md` §4 の「無人運用では yolo が実質必須」を再確認。
- 生成物: `tmp/imagegen/*.png` は **AI 生成分ゼロ**（`_probe.png` は §4 の viewer 検証用に自前で作った 8×8 の PNG）。

---

## 4. open_viewer は PNG を開けない（実測）

```bash
curl -s -X POST localhost:8811/control/open-viewer -H 'content-type: application/json' \
  -d '{"path":"<worktree>/tmp/imagegen/_probe.png","title":"probe"}'
#   → {"error":"対応していない拡張子です: .png（許容: .md, .markdown, .txt）"}

curl -s -X POST localhost:8811/control/open-viewer -H 'content-type: application/json' \
  -d '{"path":"<worktree>/docs/backends/gemini.md"}'
#   → {"id":"viewer-1", ... "format":"md"}   （md は当然通る）
```

根拠は `src/server/viewerRegistry.ts` の `ALLOWED_EXT`（`.md`/`.markdown`/`.txt` のみ）と
`src/shared/protocol.ts` の `ViewerFormat = "md" | "txt"`、`ViewerRecord.content: string`（UTF-8 前提）。

---

## 5. 提案: open_viewer を画像対応にする最小改修（**実装は要件外なので未実施**）

要点は「`content` は UTF-8 文字列前提なので、**画像はここに載せない**」。バイト列は別口で取りに行かせる。

1. **`src/shared/protocol.ts`**
   - `ViewerFormat` に `"image"` を追加。
   - `ViewerRecord.content` を「`format==="image"` のときは空文字」と規定（型は変えない）。
2. **`src/server/viewerRegistry.ts`**
   - `ALLOWED_EXT` に `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` → `"image"` を追加。
   - `open()` で image は**内容を読まない**（存在・許可ルート・realpath・サイズ検証だけ行う）。
   - サイズ上限を分ける: `EBI_VIEWER_MAX_BYTES`（既定 1MB）は md 用のまま、画像用に
     `EBI_VIEWER_MAX_IMAGE_BYTES`（既定 8MB 程度）を新設。1MB のままだと普通の生成 PNG が弾かれる。
3. **`src/server/control.ts`**
   - `GET /control/viewer-file?id=viewer-N` を新設。**id 参照のみ**（クライアントから生パスを受けない＝
     パストラバーサルの新しい入口を作らない）。登録済み viewer の path を realpath し直して
     `Content-Type` を拡張子から決め、`Content-Disposition: inline` と
     `Cache-Control: no-store`、`X-Content-Type-Options: nosniff` を付けて bytes を返す。**読み取り専用**。
4. **`src/client/viewer.ts`**
   - `rec.format === "image"` のとき `<img src="/control/viewer-file?id=...">` を作る（`alt` は title）。
     `innerHTML` は使わない現行方針のまま。CSS は `max-width:100%; image-rendering:auto;`。
5. **`src/mcp/control-server.ts`**
   - `open_viewer` の description の「.md/.markdown/.txt のみ」を更新。
6. **永続化**: `viewers.json` はパスしか持たないので**変更不要**。`restore()` は image でも
   「存在＋許可ルート＋サイズ」の検証をそのまま流用できる。

代替案（さらに小さい）: 画像を base64 data URI にして `content` に詰める。改修は 2 ファイルで済むが、
**WS ブロードキャストのペイロードが画像サイズの 4/3 倍に膨らむ**（viewers は全接続へ再 broadcast される）ので推奨しない。

---

## 6. D: コスト / クォータ / 所要時間

| 経路 | 消費 | 課金レコード | 所要 |
|---|---|---|---|
| Gemini `-p`（画像モデル 404） | 404 なので**モデル課金ゼロ**。trust エラー分も同様 | GCA Standard（シート課金型サブスク）。従量の行は立たない | 各 30〜40 秒 |
| Gemini エビ（ebi-team 経由・`gemini-2.5-flash`） | TUI フッタの `quota` が **6% → 8%**（2 セッション） | 同上 | spawn→ready 約 40 秒／1 往復 2〜4 分 |
| Codex `exec` ×3 + TUI ×1 + エビ ×1 | ChatGPT **無料枠**のトークン（1 回あたり約 10k tokens） | 無料枠なので請求レコード無し。`image_gen` は**一度も呼べていない＝画像課金ゼロ** | exec 40〜60 秒／エビ 1 往復 約 90 秒 |
| GCP Vertex AI（Imagen 等） | **未実施** | — | — |

**Vertex AI 経路は今回試していない**（§7）。

---

## 7. ブロッカーと次の一手

| # | ブロッカー | 何が要るか | 効きそうな度 |
|---|---|---|---|
| 1 | Codex の `image_gen` が無料プランに配られない | **ChatGPT Plus / Pro のアカウントで `codex login` し直す**（ボス作業）。有料垢なら tools 配列に `image_gen` が入るはずで、そうなれば B → ○、C も一気に通る。`$CODEX_HOME/generated_images/` に PNG が出るので、あとはエビが `tmp/imagegen/` へコピーするだけ | **高**。実装済み機能のエンタイトルメント差なので、垢さえ変えれば通る公算が大きい |
| 2 | Gemini はサブスク枠に画像生成の口が無い | **GCP Vertex AI（Imagen / gemini-2.5-flash-image）を使う**＝会社 GCP の**従量課金**。ただし今回は `gcloud` が `Reauthentication failed. cannot prompt during non-interactive execution` で止まり、**エビからはトークンすら取れない**。まず**ボスが `gcloud auth login` を対話で実行**する必要がある。加えて「サブスク/ログイン枠のみ」という今回の縛りを外す判断が要る | 中。**課金と再ログインの 2 つでボス判断待ち** |
| 3 | `open_viewer` が画像非対応 | §5 の最小改修（別 PR）。**画像生成が 1 か 2 で通ってから着手するのが順当** | — |
| 4 | gemini エビが `reply_to_master` を「送ったつもり」で終わる | 本 PoC で 1 回観測（yolo・MCP 1 台認識済みの状態）。`docs/backends/gemini.md` の e2e は 10/10 で通っているので**再現条件が別にある**（長いタスク／複数ツール往復のあと、など）。別途切り分け | — |

### 推奨する順番

1. **ボスに ChatGPT Plus/Pro 垢での `codex login` を依頼**（ブロッカー 1）。これが通れば PoC は最短で完了する。
2. 通ったら C を再実行（`node scripts/poc-imagegen-ebi.mjs codex`）し、PNG が `tmp/imagegen/` に落ちることを確認。
3. そのうえで §5 の viewer 画像対応を別 PR で実装する。
4. Gemini 側は**当面「画像生成は担当しない」で割り切る**のが安い（Vertex 課金を開けるかはボス判断）。

---

## 付録: 生成物・ログの置き場（すべて worktree の `tmp/imagegen/`・コミットしない）

| ファイル | 中身 |
|---|---|
| `g1.err` / `g2.err` | gemini 直叩き（trust エラー／画像モデル 404） |
| `c1.log` | `codex exec` の全ログ（imagegen SKILL.md 全文つき） |
| `c2.raw` | codex 対話 TUI（PTY）の生ログ |
| `c3.log` | `RUST_LOG=trace` の codex 通信ログ（**tools 配列の根拠**） |
| `models.json` | `codex debug models` のモデルカタログ |
| `poc-codex.log` / `poc-codex-ebi.txt` | codex エビの PoC ログ＋エビ画面 |
| `poc-gemini.log` / `poc-gemini-ebi.txt` | gemini エビの PoC ログ＋エビ画面 |
| `_probe.png` | viewer の拡張子検証用に自前で作った 8×8 PNG（AI 生成物ではない） |
