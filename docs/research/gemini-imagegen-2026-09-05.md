# Gemini 経由の画像生成を ebi-team から使う経路（2026-09-05 調査）

対象: gemini-cli **0.58.0** / codex-cli **0.146.0** / Antigravity CLI **1.1.26**
ブランチ: `ebi/ebiteam-gemini-imagegen-research`（worktree、push なし・main マージなし）
前提アカウント:

| CLI | アカウント | 枠 | 実測 |
|---|---|---|---|
| Gemini CLI | Workspace 垢 `yoshitaka.ota@nexlim.co.jp` / GCP `engineering-478708` | **Gemini Code Assist Standard** | `loadCodeAssist` の `currentTier.id = "standard-tier"`、`paidTier.id = "gcp-standard-tier"` |
| Codex CLI | 個人垢 `spdba.y.ota@gmail.com` | **無料**（2026-09-05 時点） | `~/.codex/auth.json` の id_token: `chatgpt_plan_type: "free"`, `chatgpt_subscription_active_until: null` |

前回 PoC: `docs/poc/imagegen-poc-2026-09-05.md`（main `a16ea70`）。本書はその「経路が他にあるはず」を潰し切ったもの。

---

## 0. 結論（先に読むところ）

1. **ボスの「Flash 3.8」は実在した。** ただし **Gemini CLI のモデルではなく Google Antigravity のモデル**。
   Antigravity のモデル一覧に `Gemini 3.8 Flash` があり、画像は **Nano Banana 2** を使う
   「generative image tool」が Agent に組み込まれている（一次情報: antigravity.google/docs/models）。
2. **現行の Gemini ログイン枠（GCA Standard / OAuth）では画像生成は不可能。** 追加調査でも新事実なし。
   Code Assist API に**画像モデルが 1 つも配られていない**ことを HTTP ステータスで確定させた（§1）。
   `responseModalities:["TEXT","IMAGE"]` もテキストモデル側で **400 INVALID_ARGUMENT**。
3. **Antigravity 経由は「技術的には○、規約的に×」。** Antigravity CLI (`agy`) は headless (`-p`) を持ち
   `generate_image` 相当のツールを持つが、公式 FAQ が
   **「Claude Code / OpenClaw / OpenCode などサードパーティから Antigravity ログインを使うのは ToS 違反。アカウント停止の根拠になりうる」**
   と名指しで書いている（§3）。ebi-team から `agy` を叩くのは、まさにこの文が禁じている形。
   さらに **Antigravity は個人 Google アカウント専用**で、いまの Workspace 垢ではサインインできない。
4. **Google AI Pro に切り替えても Gemini CLI は開かない。** 2026-06-18 に
   **Gemini CLI は Google AI Pro / Ultra / 無料ティアへの応答を停止済み**（GCA Standard/Enterprise と API キーのみ継続）。
   AI Pro で開くのは Antigravity 側であり、それは 3 の ToS 問題に戻る（§4）。
5. **推奨: 画像生成担当は Codex（ChatGPT Plus）。** Codex の `image_gen` は
   **ChatGPT 有料プラン（Plus 以上）のエンタイトルメントで配られる公式のサブスク内機能**で、
   サードパーティ経由の利用を禁じる文言もない。ただし **現時点の `~/.codex/auth.json` はまだ `free`** なので、
   Plus 契約後に `codex login` をやり直す必要がある（§5）。
   Gemini 側で追加課金なしの正規ルートは**存在しない**。どうしても Gemini 系の絵が要るなら
   AI Studio の従量 API キー（1K 画像 **$0.067**）が Google 自身の推奨する回避策（§6）。

---

## 1. Gemini CLI（Code Assist / OAuth）で使えるモデルの実測

`gemini` は `models list` 相当を持たないので、**CLI が使うのと同じ Code Assist エンドポイントを直接叩いて**
モデル id ごとの応答を測った。再現スクリプト: `tmp/imagegen/probe_models.sh`、生ログ: `tmp/imagegen/probe-models-codeassist.txt`。

```
POST https://cloudcode-pa.googleapis.com/v1internal:generateContent
Authorization: Bearer <~/.gemini/oauth_creds.json の access_token>
{"model":"<id>","project":"engineering-478708","request":{"contents":[{"role":"user","parts":[{"text":"say OK"}]}]}}
```

| model id | HTTP | 判定 |
|---|---|---|
| `gemini-2.5-flash` | **200** | ○ 実際に text を返す |
| `gemini-3-flash` | **429** RESOURCE_EXHAUSTED | ○ **存在する**（クォータ切れ＝配られている） |
| `gemini-3.5-flash` | **429** RESOURCE_EXHAUSTED | ○ **存在する**（Standard で使える最新の Flash） |
| `gemini-3-pro-preview` | 404 | × |
| `gemini-3.1-pro-preview` | 404 | × |
| `gemini-2.5-flash-image` | **404** | × 画像 |
| `gemini-2.5-flash-image-preview` | **404** | × 画像 |
| `gemini-3-pro-image-preview`（Nano Banana Pro） | **404** | × 画像 |
| `gemini-3.1-flash-image` / `-preview`（Nano Banana 2） | **404** | × 画像 |
| `gemini-3.1-flash-lite-image-preview` | **404** | × 画像 |
| `gemini-3.8-flash` / `gemini-3.8-flash-image` | **404** | × Code Assist には無い |
| `imagen-4.0-generate-001` | **404** | × |

補足の実測（`tmp/imagegen/probe-image-endpoints.txt`）:

- `responseModalities:["TEXT","IMAGE"]` を付けると、**200 で通るはずの `gemini-2.5-flash` / `gemini-3-flash` が 400 INVALID_ARGUMENT**。
  → テキストモデルに画像を吐かせる裏口も無い。
- `v1internal:generateImage` / `:predict` / `:generateImages` はいずれも **404**（そもそもメソッドが無い）。
- `v1internal/models`・`v1internal:listModels` も 404（Code Assist はモデル一覧 API を公開していない）。

CLI バンドル（`~/.npm-global/lib/node_modules/@google/gemini-cli/bundle/*.js`）に埋まっているモデル id を全抽出しても、
`gemini-3.5-flash` / `gemini-3.1-pro-preview` / `gemini-3-flash` などテキスト系が並ぶだけで、
画像系は `gemini-2.5-flash-image`（同梱 SDK の定数）と `imagen-product-recontext-preview-06-30` のみ。
**「Flash 3.8」に相当する id は CLI 側にも Code Assist 側にも存在しない。**

> 判定: **Gemini CLI × 現行ログイン枠 = 画像生成不可（確定）**。前回 PoC の結論は正しかった。

---

## 2. Gemini CLI の extensions / MCP

現状: `gemini extensions list` → `No extensions installed.` / `gemini mcp list` → `No MCP servers configured.`

| 経路 | 認証 | ログイン枠で動くか |
|---|---|---|
| 公式 `gemini-cli-extensions/nanobanana` | **`NANOBANANA_API_KEY`（AI Studio の Gemini API キー）必須** | **×** — README に「Set the `NANOBANANA_API_KEY` environment variable with your Gemini API key. Get one from Google AI Studio.」。OAuth 枠は使わない |
| 同拡張の対応モデル | `gemini-3.1-flash-image-preview`（既定, v1.0.11+）/ `gemini-3-pro-image-preview` / `gemini-2.5-flash-image` | いずれも **API 課金側のモデル** |
| genmedia 系（Imagen / Veo） | **Vertex AI 課金**前提 | × |
| community の画像生成 MCP | API キー or Vertex | × |

しかも **Gemini API の画像生成モデルは free tier に無い**（公式 pricing で Nano Banana 2 / Pro とも Free tier: Not available）。
つまり拡張を入れても、**課金 API キーを作らない限り 1 枚も出ない**ので、今回は**インストールしていない**（`~/.gemini` を汚さない指示にも合致）。

> 判定: **拡張 / MCP はすべて「API キーか Vertex 課金」。サブスク枠で動くものはゼロ。**

---

## 3. Google Antigravity — 「Flash 3.8」の正体と、使えない理由

### 3.1 それは何か

- **IDE（VS Code フォーク）+ CLI (`agy`) + IDE 拡張**の三面構成のエージェント開発環境。Gemini CLI の後継として位置づけられている。
- モデル一覧（antigravity.google/docs/models）に **`Gemini 3.8 Flash`（Fast / Low-Medium-High）**、`Gemini 3.7 Flash`、`Gemini 3.6 Flash`、`Gemini 3.1 Pro`。
  サードパーティとして `Claude Sonnet 4.6 (thinking)` / `Claude Opus 4.6 (thinking)` / `GPT-OSS-120b` も選べる。
  → **ボスの情報はここ。「最新の Gemini Flash 3.8」は実在するが、Antigravity の中の話。**
- **画像生成の実体は Nano Banana 2**。docs の原文:
  > "Used by the generative image tool when the Agent wants to produce a UI mockup, needs images to populate a web page or application, generate system or architecture diagrams, or other generative image tasks."
  ユーザーが選ぶモデルではなく、**Agent が必要時に自動で呼ぶ内蔵ツール**（"not customizable"）。

### 3.2 外部から駆動できる口はあるか → **ある（技術的には）**

`agy` は headless を持つ。実測（バイナリ 1.1.26 を worktree 内に落として `--help` まで確認済み。後述のとおり撤去済み）:

```
--print / -p          Run a single prompt non-interactively and print the response
--output-format       text | json | stream-json
--input-format        stream-json（NDJSON を 1 行 1 ターンで流し込める）
--model               Model for the current CLI session
--dangerously-skip-permissions
サブコマンド: models / agents / mcp / plugin / remote-control / update ...
```

`--input-format stream-json` + `--output-format stream-json` は **ebi-team のエビとほぼ同じ形で会話を流せる**。
つまり **配線の難易度は低い**。実際、`agy` の `generate_image` ツールを外から叩く野良スキル
（`Openclaw-Metis/agy-image` 等）が公開されている。

### 3.3 それでも使えない理由 ×2

**(a) ToS が名指しで禁じている。** 公式 FAQ:

> **Q. Why can't I use third party software (e.g. Claude Code, OpenClaw, OpenCode) with my Antigravity login?**
> A. "Using third party software, tools, or services to access Antigravity is a violation of our Terms of Service, and severely degrades the experience for legitimate product users. **Such actions may be grounds for suspension or termination of your account.** If you would like to use a third party coding agent with Gemini, we recommend using a Vertex or AI Studio API key."

ebi-team が `agy` を spawn して画像を作らせるのは、この文が想定している「サードパーティから Antigravity ログインを使う」形そのもの。
**ボスの Google アカウント停止リスクを背負う話**なので、ここは勝手に踏み込まず判断を仰ぐ。

**(b) 今のアカウントではサインインできない。** FAQ:

> "Google Antigravity is currently available for **personal Google accounts** in approved geographies. Please try using an @gmail.com email address if having challenges with Workspace Google accounts."

Gemini CLI がログイン済みの Workspace 垢（`@nexlim.co.jp`）は対象外。
`agy models` を未認証で叩くと `Error: Please sign in to view available models.` で、**サインインは対話ブラウザ必須**（自動化不可）。
Business サインイン（GCP プロジェクト）経路は存在するが、**Gemini Enterprise Agent Platform の従量課金**または **Gemini Enterprise ライセンス**が要る（＝GCA Standard では入れない）。

### 3.4 現状のマシン

- **Antigravity.app は `~/.Trash` にある**（`lsregister` で確認）。IDE は 2026-04 頃まで使われていて、いま削除済み。
  残骸は `~/.gemini/antigravity/`（brain / conversations）と `~/Library/Application Support/Antigravity/`。
- 調査で `agy` 1.1.26 (darwin x64) を **worktree 内に手動配置して `--help` / `models` だけ確認し、撤去した**。
  `~/.local/bin` / shell rc / `~/.gemini` は一切変更していない。再現手順は §7。

> 判定: **Antigravity 経由 = 技術○ / 規約× / 現アカウント×。ボスの明示的な判断なしには進めない。**

---

## 4. Google AI Pro（個人サブスク $19.99/月）に切り替えた場合

**重要な前提の変化**: 公式アナウンス（google-gemini/gemini-cli Discussion #27274）

> **2026-06-18 をもって、Gemini CLI と Gemini Code Assist IDE 拡張は
> 「Gemini Code Assist for individuals」「Google AI Pro」「Google AI Ultra」「無料ティア」からのリクエストの処理を停止した。**
> Gemini Code Assist **Standard / Enterprise** ライセンス、および有料 API キー経由は影響なし。

つまり:

| 期待 | 実際 |
|---|---|
| AI Pro にすれば **Gemini CLI** の枠が広がる / 画像が開く | **×。AI Pro では Gemini CLI がそもそも応答しない。** いま Gemini CLI が動いているのは Workspace の **GCA Standard** のおかげ |
| AI Pro にすれば **nanobanana 拡張**が動く | **×。** 拡張は AI Studio の**課金 API キー**を見るだけで、サブスクとは無関係 |
| AI Pro にすれば **Antigravity** の画像生成が使える | **○（ただし Antigravity の中でだけ）。** Pro は「5 時間ごとリフレッシュの高クォータ」。**無料 Individual プランでも週次リフレッシュのクォータで画像生成自体は使える** |
| AI Pro の画像を **ebi-team から** 使う | **× ToS**（§3.3(a)）。Google 自身の推奨は「サードパーティのコーディングエージェントを使うなら Vertex か AI Studio の API キー」 |

Antigravity のプラン（antigravity.google/docs/plans、参考価格）:

| プラン | 価格 | クォータ |
|---|---|---|
| Individual（無料） | $0 | "Meaningful quota, refreshed weekly" |
| Google AI Pro | 約 **$19.99/月** | "High, generous quota, refreshed every five hours" |
| Google AI Ultra 5x / 20x | 約 $99.99 / $199.99 | 最上位クォータ + サードパーティモデル |

> 判定: **AI Pro を買っても「ebi-team から使える Gemini 画像生成」は手に入らない。**
> 手に入るのは「ボスが Antigravity を手で使うときの快適さ」。Codex Plus とは買う物が違う。

---

## 5. Codex（ChatGPT Plus）の `image_gen` との比較

前回 PoC で分かっていたこと（再掲・裏取り済み）:

- codex 0.146 に **組み込み `image_gen` ツールが実装済み**（バイナリ内 `ext/image-generation/src/tool.rs`、同梱 `skills/.system/imagegen/SKILL.md`）。
  SKILL.md 原文: **「built-in `image_gen` tool … Does not require `OPENAI_API_KEY`」**＝**サブスク枠で動く設計**。
- `codex features list` → `image_generation stable true`。
- それでも無料垢のセッションには **`image_gen` がツール配列に配られない**（`RUST_LOG=trace` の `response.tools` で確認済み）。

今回の追加確認:

- 一次情報レベルの公開情報でも **「built-in の画像生成は ChatGPT 認証（Plus / Pro / Business / Edu / Enterprise）にゲートされ、Free では使えない」**。
  画像生成は Codex の利用枠を通常ターンの **3〜5 倍**の速さで消費する。
- **`~/.codex/auth.json` は 2026-09-05 現在まだ `chatgpt_plan_type: "free"`。**
  → **Plus を契約しただけでは変わらない。契約後に `codex login` をやり直して id_token を更新する必要がある。**

| 観点 | Codex `image_gen`（Plus $20/月） | Gemini/Antigravity |
|---|---|---|
| サブスク枠で画像が出るか | **○**（Plus 以上のエンタイトルメント） | Antigravity 内でのみ ○ |
| ebi-team から叩けるか | **○**（既存の codex エビの配線をそのまま使える。PNG を置く経路は PoC で成立済み） | **× ToS 違反の明記あり** |
| 追加費用 | **$20/月**（ボスが契約決定済み） | $0〜$19.99 だが ebi-team からは使えない |
| API キー不要 | **○** | 拡張・Vertex はキー必須 |
| 出力先 | `$CODEX_HOME/generated_images/`（既定） | — |
| リスク | 画像ターンは枠消費が 3〜5 倍 | **アカウント停止リスク** |

> **推奨: 画像生成担当は Codex 一択。** Gemini 側に「追加課金なし・規約内・ebi-team から駆動可」を同時に満たす経路は存在しない。

---

## 6. 経路まとめ（○×・認証・費用）

| # | 経路 | 可否 | 認証方式 | 追加費用 | 根拠 |
|---|---|---|---|---|---|
| 1 | Gemini CLI 組み込み | **×** | OAuth (Code Assist) | — | 画像生成ツールが CLI に存在しない（PoC §1） |
| 2 | Gemini CLI `-m <image model>` | **×** | OAuth (Code Assist) | — | 画像モデルが全て **404**（§1） |
| 3 | Gemini CLI + `responseModalities:IMAGE` | **×** | OAuth | — | **400 INVALID_ARGUMENT**（§1） |
| 4 | 公式 nanobanana 拡張 | **×**（枠内では） | `NANOBANANA_API_KEY` | 画像 1K あたり **$0.067**（Nano Banana 2） | README + 公式 pricing（Free tier: 無し） |
| 5 | genmedia / Vertex 系拡張・MCP | **×**（枠内では） | Vertex ADC | Vertex 従量 | 公式説明 |
| 6 | Antigravity IDE（手動） | **○**（ボスが手で使う分には） | 個人 Google 垢 | $0（Individual）〜$19.99 | docs/models・docs/plans |
| 7 | **Antigravity CLI `agy -p` を ebi-team から** | **×（規約）** | 個人 Google 垢（対話ブラウザ） | $0〜 | **FAQ が Claude Code 等を名指しで ToS 違反と明記** |
| 8 | Antigravity Business（GCP サインイン） | **△** | GCP / WIF | **Gemini Enterprise Agent Platform 従量 or Gemini Enterprise ライセンス** | docs/enterprise |
| 9 | AI Studio API キー + nanobanana 拡張 | **○（要課金）** | `GEMINI_API_KEY` | 1K 画像 $0.067 / 4K $0.151（Pro は $0.134 / $0.24） | 公式 pricing。**Google 自身がサードパーティ agent にはこれを推奨** |
| 10 | Vertex AI（会社 GCP） | **○（要課金）** | ADC / SA | Vertex 従量（ほぼ同単価） | 最後の手段 |
| 11 | **Codex `image_gen`（ChatGPT Plus）** | **◎** | ChatGPT ログイン | **$20/月（契約済み）** | SKILL.md「Does not require OPENAI_API_KEY」+ Free ではツール未配布を実測 |

---

## 7. 実行コマンドと生成物

### 実行した検証

```bash
# 0) 疎通（トークン更新）
gemini --skip-trust -p "reply with the single word OK"          # → OK   tmp/imagegen/probe-ok.log

# 1) tier 確認
bash tmp/imagegen/probe.sh                                       # → currentTier.id = standard-tier

# 2) モデル総当たり（Code Assist 直叩き）
bash tmp/imagegen/probe_models.sh                                # → tmp/imagegen/probe-models-codeassist.txt

# 3) 画像モダリティ / 代替エンドポイント
bash tmp/imagegen/probe_modal.sh                                 # → tmp/imagegen/probe-modalities.txt
                                                                 #   tmp/imagegen/probe-image-endpoints.txt

# 4) Antigravity CLI（--help / models のみ。撤去済み）
#    公式インストーラは shell rc を書き換えるので使わず、手動で配置した:
curl -fsSL https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_amd64.json
curl -fsSL -o agy.tar.gz https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.26-5550154686791680/darwin-x64/cli_mac_x64.tar.gz
shasum -a 512 agy.tar.gz   # d4b80f4c05eef14cd660f5a29a4a700e2d97b02af1ccddba2450136d9d4712606b09254610fecd6761178998cac1e9d3559b26fe0cfb335f44b0efb8c099fda7
tar -xzf agy.tar.gz antigravity && chmod +x antigravity
env HOME=<隔離ディレクトリ> AGY_CLI_DISABLE_AUTO_UPDATE=true ./antigravity --help
env HOME=<隔離ディレクトリ> AGY_CLI_DISABLE_AUTO_UPDATE=true ./antigravity models
#   → Error: Please sign in to view available models.
```

> このマシンは **Intel (x86_64)**。`darwin_arm64` のバイナリは `Bad CPU type` で動かない（一度踏んだ）。

### 生成物

**PNG は 1 枚も生成できていない。** 追加課金なし・規約内で画像を出せる経路が存在しなかったため。
`tmp/imagegen/` に残っているのは判定根拠のログと再現スクリプトのみ。

```
tmp/imagegen/probe.sh                       # loadCodeAssist（tier 判定）
tmp/imagegen/probe_models.sh                # モデル総当たり
tmp/imagegen/probe_modal.sh                 # responseModalities / モデル一覧 API
tmp/imagegen/probe-ok.log
tmp/imagegen/probe-models-codeassist.txt    # ← §1 の表の生ログ
tmp/imagegen/probe-modalities.txt
tmp/imagegen/probe-image-endpoints.txt
```

### 守った制約

- 稼働サーバ 8787（PID 49178/49179/49180/49181/49440）に一切触れていない。
- `~/.gemini` / `~/.codex` の恒久変更なし（`gemini -p` の通常のトークン自動更新のみ）。設定ファイルは書いていない。
- CLI の自動更新なし（`agy` は `AGY_CLI_DISABLE_AUTO_UPDATE=true` + 手動配置、`gemini`/`codex` は更新していない）。
- Chrome 拡張不使用（Web 調査は WebFetch / WebSearch）。
- 課金 API 呼び出しゼロ（AI Studio キー・Vertex は一切叩いていない）。
- 常駐プロセスの残骸なし（`agy` バイナリと隔離 HOME は撤去済み）。

---

## 8. 次アクション（ボス判断待ち）

1. **Codex Plus のログインをやり直す** — 契約済みでも `auth.json` が `free` のまま。
   `codex login` 後に `chatgpt_plan_type` が `plus` になり、セッションの `response.tools` に `image_gen` が入るかを再実測すれば決着する。
   ここが通れば、PoC で成立済みの「エビが PNG を置く → master が viewer で見る」が即座につながる（viewer の画像対応は `97e1ac2` でマージ済み）。
2. **Gemini 側を諦めるか、課金するか** — 諦める場合は本書で打ち止め。
   欲しい場合の最短は **AI Studio の従量 API キー + nanobanana 拡張**（1K 画像 $0.067）で、これは Google 自身がサードパーティ agent 向けに推奨している形。実行前に要承認。
3. **Antigravity を ebi-team から叩くのは非推奨** — アカウント停止リスクをボスが許容するかどうかの話。
   個人 Gmail でのサインインが要る点も含め、勝手にはやらない。

### 副次的な発見（本題外・要対処）

`~/.gemini/antigravity/mcp_config.json` に **GCP サービスアカウントの秘密鍵が平文**で入っている（旧 Antigravity IDE 用の google-analytics MCP 設定）。
Antigravity.app 自体はゴミ箱に移動済みだが**設定ファイルは残っている**ので、鍵のローテーションかファイル削除を検討したほうがいい。本調査では触れていない。

---

## 参考（一次情報）

- Antigravity Models: https://antigravity.google/docs/models/
- Antigravity Plans: https://antigravity.google/docs/plans/
- Antigravity FAQ（ToS / 個人アカウント限定）: https://antigravity.google/docs/faq/
- Antigravity CLI Headless: https://antigravity.google/docs/cli/headless/
- Antigravity CLI Install & Auth: https://antigravity.google/docs/cli/install/
- Antigravity Enterprise（GCP サインイン）: https://antigravity.google/docs/enterprise
- Gemini CLI → Antigravity CLI 移行アナウンス: https://github.com/google-gemini/gemini-cli/discussions/27274
- nanobanana 拡張 README: https://github.com/gemini-cli-extensions/nanobanana
- Gemini API Pricing（画像は Free tier 無し）: https://ai.google.dev/gemini-api/docs/pricing
