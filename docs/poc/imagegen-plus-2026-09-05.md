# 画像生成 PoC 第2弾（2026-09-05）— ChatGPT **Plus** 化した Codex で画像生成 → 保存 → viewer 表示

前提資料: [`imagegen-poc-2026-09-05.md`](./imagegen-poc-2026-09-05.md)（無料枠で `image_gen` 未配布だった記録）／
[`../research/gemini-imagegen-2026-09-05.md`](../research/gemini-imagegen-2026-09-05.md)（Plus 推奨の根拠）／
[`../backends/codex.md`](../backends/codex.md)

対象: codex-cli **0.146.0**（モデル `gpt-5.6-sol`）、ebi-team `d0c43ab`
検証ブランチ: `ebi/ebiteam-poc-imagegen-plus`（worktree `.worktrees/ebi-ebiteam-poc-imagegen-plus`）
アカウント: ChatGPT 個人垢（`spdba.y.ota@gmail.com`）／`~/.codex/auth.json` の id_token クレーム
`chatgpt_plan_type: "plus"`、`chatgpt_subscription_active_until: 2026-10-05`（**読み取りのみ**）

---

## 0. 結論（3 行）

1. **すべて成功。** 手動でも ebi-team 経由でも、Codex 組み込みの画像生成ツールで PNG を生成・保存できた。
   `OPENAI_API_KEY` は不要（ChatGPT ログインのサブスク枠で動く）。前回の「無料枠では配られない」は
   **Plus 化＋`codex login` やり直しで解消**した。
2. **エビ → PNG → master の viewer 表示まで一気通貫で通った。** ebi-team 経由の実測は
   spawn 0.8s ＋ 生成〜`reply_to_master` 着弾 **76.6s**（全体 85.1s）、`GET /control/viewer-file` が
   `200 image/png` でバイト列を配信（PNG マジックバイト一致・888,052 B）。
3. **ツールの露出形が前回と変わっている。** `image_gen` はトップレベルの関数ツールではなく、
   **code mode の `exec` 名前空間ツール `image_gen__imagegen`** として配られる（§1）。
   前回 §2 の「`response.tools` に `image_gen` が無い」判定はこの形では**空振りする**ので、
   今後の可否判定は §1 の方法で見ること。

---

## 1. `image_gen` が配られていることの確認（手動）

```bash
RUST_LOG=trace codex exec -s read-only -c check_for_update_on_startup=false "reply with the single word OK" 2> tools-probe.err
grep -o '"name":"[a-z_]*"' tools-probe.err | sort -u
#   → collaboration / exec / followup_task / interrupt_agent / list_agents
#      request_user_input / send_message / spawn_agent / wait / wait_agent
#   ※ image_gen は「トップレベル関数ツール」としては出てこない（前回と同じ見え方）
```

**が、`image_gen` は配られている。** リクエスト本文を読むと 2 か所に出る:

```bash
grep -o '.\{150\}image_gen.\{250\}' tools-probe.err | head
```

- `exec` ツールの TypeScript 宣言の中（= code mode 経由で呼ぶ）:

  ```ts
  declare const tools: {
    image_gen__imagegen(args: {
      num_last_images_to_include?: number | null;
      prompt: string;
      referenced_image_paths?: Array<string> | null;
    }): Promise<unknown>;
  };
  ```

- リクエストの `tool_usage` に `image_gen` の枠が最初から確保されている:

  ```json
  "tool_usage": { "image_gen": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }, "web_search": {...} }
  ```

`codex features list` の `image_generation` は前回同様 `stable true`。`~/.codex/skills/.system/imagegen/SKILL.md`
も同梱のままで、エビは実行時にこれを読んでから生成に入る（§3 のターン内訳）。

> **判定レシピ（次回以降これを使う）**
> `grep -c 'image_gen__imagegen' <trace>` が 1 以上 → 配られている。
> `"name":"image_gen"` を探すのは**誤判定の元**（code mode 化で出なくなった）。

---

## 2. 手動での生成 → PNG 保存（成功）

```bash
WT=/Users/yoimaro/workspace/GitHub/ebi-team/.worktrees/ebi-ebiteam-poc-imagegen-plus
time codex exec -C "$WT" --skip-git-repo-check -s workspace-write \
  -c check_for_update_on_startup=false \
  -c "projects={\"$WT\"={trust_level=\"trusted\"}}" \
  "組み込みの image_gen（image_gen__imagegen）ツールを使って画像を1枚生成し、
   docs/poc/imagegen-plus-sample.png に保存してください。題材: 白背景に、エビのマスコットの
   シンプルでかわいいフラットなアイコン。サイズは1024x1024程度。"
```

| 項目 | 実測 |
|---|---|
| 結果 | **成功** |
| 所要 | **65.3 s**（`time` の real） |
| 生成物 | `docs/poc/imagegen-plus-sample.png` — PNG **1024 x 1024** / 831,865 B |
| 副産物 | `~/.codex/generated_images/<session-uuid>/exec-<uuid>.png`（ツールの既定出力先。ここから指定パスへコピーされる） |
| 終了コード | 0 |

> **`codex exec` に `-a never` は渡せない。** `error: unexpected argument '-a' found` になる
> （`-a` は対話 TUI 側のフラグ。`codex exec` は既定で非対話なので不要）。
> `docs/backends/codex.md` §2 の起動形は **TUI 起動用**であって `codex exec` にそのまま流用はできない。

---

## 3. ebi-team 経由（spawn → 生成 → 保存 → `reply_to_master` → viewer 配信）

ドライバ: [`scripts/poc-imagegen-plus.mjs`](../../scripts/poc-imagegen-plus.mjs)（本 PoC 用の使い捨て）。
**稼働サーバ 8787 には一切触れていない**。専用ポート **8812** で control-server を自前起動し、
状態ディレクトリは `mkdtemp`、master は bash の使い捨てエビ。終了時に全プロセスを撤収する。

```bash
node scripts/poc-imagegen-plus.mjs        # exit 0 で全条件成立
```

役割定義（ドライバが書く一時 config）:

```jsonc
"imagegen": {
  "label": "画像生成係", "emoji": "🎨",
  "permissionMode": "acceptEdits",          // codex では -s workspace-write に写像される
  "appendSystemPrompt":
    "あなたは画像生成係。画像は必ず組み込みの image_gen（image_gen__imagegen）ツールで生成し、" +
    "指定されたパスに PNG として保存すること。作業結果の報告は必ず reply_to_master ツールで送ること" +
    "（チャットに書くだけでは master に届かない）。"
}
```

### 実測結果

```json
{
  "replied": true,
  "pngExists": true,
  "pngBytes": 888052,
  "genSeconds": 76.6,
  "totalSeconds": 85.1,
  "viewer": {
    "status": 200,
    "contentType": "image/png",
    "length": 888052,
    "pngMagic": true,
    "nosniff": "nosniff",
    "cacheControl": "no-store"
  }
}
```

| 段 | 結果 | 所要 |
|---|---|---|
| `POST /control/spawn`（`backend: "codex"`） | ○ `ebi-1` | 0.8 s |
| `POST /control/send`（タスク注入） | ○ `via: "pty"` | — |
| 画像生成 → `docs/poc/imagegen-plus-ebi.png` 保存 | ○ PNG **1254 x 1254** / 888,052 B | — |
| `reply_to_master` 着弾（master scrollback） | ○ `[from:ebi-1] [reply] 生成できた / ファイルパス: docs/poc/imagegen-plus-ebi.png / 使ったツール名: image_gen__imagegen` | 注入から **76.6 s** |
| `POST /control/open-viewer` | ○ `{"id":"viewer-1","format":"image"}` | — |
| `GET /control/viewer-file?id=viewer-1` | ○ `200` / `image/png` / PNG マジック一致 / `nosniff` / `no-store` | — |

### エビ側のターン内訳（`tmp/imagegen-plus/ebi-screen.txt` より）

生成そのものは **実質 4 ステップ**で終わっている。

1. `imagegen` skill の `SKILL.md` を Read（`Explored └ Read SKILL.md (imagegen skill)`）
2. `image_gen__imagegen` を実行 → `~/.codex/generated_images/<uuid>/exec-<uuid>.png` が出る（約 28 s 時点）
3. `cp` で `docs/poc/imagegen-plus-ebi.png` へ配置し、`pixelWidth/pixelHeight` を確認（約 35 s 時点）
4. `ebi-control.reply_to_master({...})` を 1 回だけ呼ぶ（約 43 s 時点）

---

## 4. 詰まった点・気づき（すべて回避済み／要件外は提案に留める）

| # | 事象 | 対処 |
|---|---|---|
| 1 | 可否判定が空振りする | `response.tools` に `image_gen` は出ない。**`image_gen__imagegen`（code mode の exec 名前空間）で grep する**（§1 のレシピ） |
| 2 | `codex exec -a never` がエラー | `codex exec` に `-a` は無い。`docs/backends/codex.md` §2 の起動形は TUI 用 |
| 3 | worktree の trust | `~/.codex/config.toml` はリポジトリ本体しか trusted にしていない。手動起動時は `-c 'projects={"<worktree>"={trust_level="trusted"}}'` が要る（ebi-team の codex backend は元々これを焼いているので spawn 側は問題なし） |
| 4 | **サイズ指示が効かない** | 「1024x1024 程度」と言っても ebi 経由では **1254 x 1254** が返った。`ImagegenArgs` に size 引数が無く、`prompt` 中の指定もヒント程度。**厳密なサイズが要るなら生成後に `sips`/`magick` でリサイズする段を足すこと** |
| 5 | 役割プロンプト注入の直後、エビが「この環境には `reply_to_master` ツールがありません」と述べた | ready 直後は MCP の接続が済んでいないため。**実タスク時には正常に呼べており実害なし**。ただし役割プロンプトに「無い」と書かせると後続で使い渋る可能性があるので、役割注入は ready＋MCP 接続後にしたい（**要件外・提案**） |
| 6 | 生成物が `$CODEX_HOME/generated_images/` にも残る | ツールの既定出力先。**セッション毎に UUID ディレクトリが増え続ける**ので、運用では定期掃除を検討（**要件外・提案**） |

---

## 5. 稼働環境（8787）で使うための提案

> ここは**提案のみ**。本 PoC では実装していない。

### 5.1 役割定義（`ebi-team.config.json` の `roles` に足す想定）

```jsonc
"imagegen": {
  "label": "画像生成係",
  "emoji": "🎨",
  "backend": "codex",              // ← 画像生成は codex 一択（gemini/claude には口が無い）
  "permissionMode": "acceptEdits", // codex では -s workspace-write。ファイル書き込みに必須
  "appendSystemPrompt":
    "あなたは画像生成係。画像は必ず組み込みの image_gen（image_gen__imagegen）ツールで生成し、"
    + "master が指定したパスに PNG として保存すること。保存先を指定されなかった場合は "
    + "tmp/images/ 配下に置くこと。厳密なピクセルサイズを求められた場合は、生成後に "
    + "sips でリサイズしてから保存すること（image_gen 自体にサイズ引数は無い）。"
    + "作業結果（生成可否・絶対パス・実ピクセルサイズ）は必ず reply_to_master ツールで 1 回だけ報告すること。"
}
```

### 5.2 運用上の注意

- **枠消費**: 画像ターンは通常ターンの 3〜5 倍の速さで Codex の枠を食う（research doc §5）。
  乱発すると Plus の枠を溶かすので、**画像生成は専用ロールに閉じ込め、master が明示的に spawn する運用**にする。
- **viewer の許可ルート**: 既定は `$HOME/workspace`。生成先をその外（例 `/tmp`）に置くと
  `open_viewer` が「許可ルート外」で弾く。**リポジトリ配下に置かせるのが安全**。
- **サイズ上限**: 画像 viewer の上限は `EBI_VIEWER_MAX_IMAGE_BYTES`（既定 8 MB）。
  今回の 1254px PNG が約 0.9 MB なので、通常の 1〜2 枚なら余裕がある。
- **`~/.codex/generated_images/` の掃除**: §4-6。放置すると数百 MB 単位で溜まる。
- **`codex login` の再実行が必要だった件**: Plus 契約直後は `auth.json` が `free` のまま。
  **契約後に `codex login` をやり直さないとツールが配られない**。この PoC の成功は
  ボスがログインをやり直した後の状態で取っている。

---

## 6. 生成物・ログ

| パス | 内容 |
|---|---|
| `docs/poc/imagegen-plus-sample.png` | 手動生成（1024 x 1024 / 831,865 B） |
| `docs/poc/imagegen-plus-ebi.png` | **ebi-team 経由でエビが生成**（1254 x 1254 / 888,052 B） |
| `scripts/poc-imagegen-plus.mjs` | 一気通貫ドライバ（使い捨て） |
| `tmp/imagegen-plus/tools-probe-excerpt.txt` | `image_gen__imagegen` 露出の trace 抜粋（全文 1.3MB のため抜粋のみコミット） |
| `tmp/imagegen-plus/gen1-manual.txt` | 手動生成の出力 |
| `tmp/imagegen-plus/ebi-run.txt` | ebi-team 経由の全ログ（上表の実測値の出所） |
| `tmp/imagegen-plus/ebi-screen.txt` | エビの PTY 画面（ターン内訳の出所） |

### ボスが画像を見る手順

master の MCP で:

```
open_viewer(path="<repo>/docs/poc/imagegen-plus-ebi.png", title="エビ生成サンプル")
```

→ UI が viewer パネルに自動で切り替わり、`<img src="/control/viewer-file?id=viewer-N">` で PNG が表示される。

---

## 7. 守った制約

- 稼働サーバ **8787（PID 19972）に一切触れていない**（再起動なし・接続なし）。専用ポート 8812 のみ使用。
- 起動したプロセスは PID 指定で停止（広域 kill なし）。実行後 8812 の LISTEN 残骸ゼロを確認済み。
- `~/.codex/auth.json` は **読むだけ**（id_token のクレーム確認のみ）。`~/.codex/config.toml` は変更していない。
- Chrome 拡張は不使用。
- 要件外の実装はしていない（気づきは §4 / §5 の提案に留めた）。
- `git push` はしていない。
