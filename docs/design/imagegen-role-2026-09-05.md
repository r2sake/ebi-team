# 設計: imagegen エビ（画像生成役割）を ebi-team に追加する

作成: 2026-09-05 / ブランチ `ebi/ebiteam-imagegen-role-design` / **設計のみ・実装なし**
前提資料:
[`../poc/imagegen-plus-2026-09-05.md`](../poc/imagegen-plus-2026-09-05.md)（Plus 化した Codex で生成→保存→viewer まで実証・**本文書の実測値の出所**。
※このファイルはブランチ `ebi/ebiteam-poc-imagegen-plus`（commit `145dbf6`）にあり main には未取り込み）／
[`../poc/imagegen-poc-2026-09-05.md`](../poc/imagegen-poc-2026-09-05.md)（無料枠では未配布）／
[`../research/codex-imagegen-plan-2026-09-05.md`](../research/codex-imagegen-plan-2026-09-05.md)（プラン別可否の一次証拠・ブランチ `ebi/ebiteam-codex-imagegen-evidence`）／
[`../backends/codex.md`](../backends/codex.md)／`src/server/roles.ts`／`src/server/backends/profiles.ts`

---

## 0. 結論（先に読む 8 行）

1. **`roles.imagegen`（`backend: "codex"` / `permissionMode: "acceptEdits"`）を稼働 config に足すだけで動く。** dist 再ビルドは不要（§8）。
2. **1 spawn = 1 ジョブ（複数枚バッチ）を推奨**。1 枚 1 spawn は固定オーバーヘッド（ACK 1 ターン＋ready ウォームアップ 20 s＋報告 1 ターン）が枚数分かかる。バッチなら `N+3` ターン、個別なら `4N` ターン（§1.3）。上限は **1 ジョブ 6 枚**。
3. **PoC 4 ステップのうち「SKILL.md を読む」は役割プロンプトにツールシグネチャを直書きして潰す。「cp」はジョブ末尾に 1 回のシェルターンへまとめる**（§1.2）。
4. **依頼／報告は YAML ブロック 1 個**に固定する（§2・§3）。engineer エビが同じ様式で「必要画像リスト」を出せば、master は**転記だけ**で済む（§2.3 に engineer 役割プロンプト追記案）。
5. **保存先の既定は ebi-team worktree の `tmp/images/<job-id>/`**。viewer 許可ルート（`$HOME/workspace`）内かつ codex の `workspace-write` サンドボックス内で、ボスの採否前に対象リポジトリを汚さない（§4）。
6. **サイズは生成後に `sips -Z` で正規化、WebP は `cwebp`**（`sips` は webp を **読めるが書けない**＝本機で実測。§4.3）。VC 方針どおり**減色・トリム・背景除去はしない**。
7. **役割プロンプトと報告文に codex ACK 検知語（「利用できません」等）を書かない。** ACK 監視窓は役割注入から 90 秒で、1 枚 76 秒の生成だと**失敗報告が窓内に入りうる**＝誤検知 respawn の実害がある（§6.4）。
8. **Plus の「1 日 N 枚」は公式に数値が無い＝不明**。公式が言うのは「included limits に含まれる」「通常ターンの **3〜5 倍**の速さで消費」まで（§7）。

**ボス裁定が要る点** → §9。

---

## 1. ターン最小化

### 1.1 PoC の 4 ステップ（実測・1 枚あたり 76.6 s）

| # | ステップ | 消える／残る |
|---|---|---|
| 1 | `~/.codex/skills/.system/imagegen/SKILL.md` を Read | **潰せる**（役割プロンプトにツール名と引数を書く） |
| 2 | `image_gen__imagegen` を実行（`~/.codex/generated_images/<uuid>/exec-<uuid>.png` が出る） | 残る（本体） |
| 3 | `cp` で指定パスへ配置＋`pixelWidth/pixelHeight` 確認 | **1 ジョブ 1 回にまとめられる**（枚数分は不要） |
| 4 | `reply_to_master` を 1 回 | 残る（1 ジョブ 1 回） |

### 1.2 目標のターン構成（1 ジョブ = N 枚）

```
[ACK]      役割プロンプト注入への応答（自動・1 ターン）
[生成 ×N]  image_gen__imagegen を N 回
[仕上げ]   cp + sips リサイズ + cwebp + サイズ確認を 1 シェルターンで一括
[報告]     reply_to_master 1 回（YAML 1 ブロック）
```

合計 **N + 3 ターン**。

- ステップ 1 を潰す仕掛け: 役割プロンプトに PoC §1 で確認したシグネチャをそのまま書く。

  ```ts
  tools.image_gen__imagegen(args: {
    prompt: string;
    referenced_image_paths?: Array<string> | null;
    num_last_images_to_include?: number | null;
  }): Promise<unknown>
  ```

  併せて「**skill の SKILL.md を読み直す必要は無い**」「`$imagegen` と書いて skill を明示起動しなくてよい」と明記する。
- ステップ 3 を潰す仕掛け: 役割プロンプトで「**生成のたびに配置しない。全枚数の生成を終えてから、配置・リサイズ・形式変換・サイズ確認を 1 回のシェル実行でまとめて行う**」と指示する。
- **未検証の上積み（要 PoC）**: `image_gen__imagegen` は code mode（`exec` の TS 名前空間）で配られるので、**1 回の `exec` 内で N 枚を `await` で連続生成できる可能性**がある。成功すれば生成ターンが N → 1 になる。ただし PoC 未実測。役割プロンプトには「1 回の実行で複数枚をまとめて生成してよい」とだけ書き、**できなければ 1 枚ずつに素直に落ちる**形にしておく（強制はしない）。

### 1.3 バッチ（1 spawn で N 枚） vs 1 枚 1 spawn

| 観点 | バッチ（推奨） | 1 枚 1 spawn |
|---|---|---|
| ターン数 | **N + 3** | 4N（ACK・生成・配置・報告 を毎回） |
| 起動の実時間 | spawn 0.8 s ＋ ready ウォームアップ **20 s**（`readyWarmupMs`）を 1 回 | 20 s × N（`codex.ts` の `readyWarmupMs` は MCP 登録待ちで削れない） |
| 枠消費 | 生成トークンは同じ。**ACK・配置・報告ぶんの通常ターンが 3(N-1) 回浮く** | 固定費が枚数分 |
| master の手間 | 依頼 1 通・報告 1 通 | 依頼 N 通・報告 N 通（master の文脈も N 倍食う） |
| 失敗隔離 | **プロトコルで隔離**（1 枚失敗しても続行し、報告の `results[]` に `status: failed` として載せる） | プロセスで隔離（1 枚の事故が他に波及しない） |
| セッション単位の事故（レート制限・ハング） | ジョブ全体が巻き添え → **6 枚上限**で被害を限定 | 1 枚で済む |
| 並列 | ジョブを 2 本に割れば spawn 2 本で並列可（ただし枠を同時に食う） | 同左 |

**推奨: 1 spawn = 1 ジョブ（同一機能ぶんの画像をまとめる）。1 ジョブ 6 枚まで（ハード上限 8）。**
6 枚の根拠: 生成 76 s/枚 の実測から 6 枚で約 8 分＝ master が待てる範囲、かつセッション事故の巻き添えが半日仕事にならない範囲。
7 枚以上要るときは**ジョブを分割して順に spawn**（同時 2 本以上は枠を溶かすので §7 の目安に従う）。

---

## 2. 依頼フォーマット（master → imagegen）

### 2.1 様式（YAML・`send_message` / `spawn_ebi` の `task` 本文にそのまま貼る）

JSON でなく YAML を採る理由: master が手で書き足す前提なのでクォート・カンマ事故が少なく、プロンプト本文（長い日本語）を複数行スカラで書ける。

```yaml
imagegen_job: v1
job_id: vc-standee-2026-09-05        # 英数と - のみ。保存先ディレクトリ名にも使う
requester: ebi-3                     # 画像を必要としている engineer エビ（分かれば）
dest_root: tmp/images/vc-standee-2026-09-05   # imagegen の cwd からの相対。既定は tmp/images/<job_id>/
images:
  - id: hero-icon                    # 一意。報告・ファイル名の基準
    purpose: トップの見出し横に置くアイコン    # 用途（1 行）
    prompt: |
      白背景に、エビのマスコットのシンプルでかわいいフラットアイコン。
      太めの輪郭線、彩度低めのオレンジ、影なし。文字は入れない。
    count: 1                         # 同一プロンプトからの枚数（既定 1）
    size: 512x512                    # 最終ピクセル。none なら生成そのままを採用
    fit: contain                     # contain=長辺合わせ（既定・歪ませない） / none=リサイズしない
    format: png                      # png | webp（webp は cwebp -q 90 で変換）
    filename: hero-icon.png          # 省略時は <id>.<format>
  - id: empty-state
    purpose: 一覧が空のときのイラスト
    prompt: |
      白背景に、空の皿の前で首をかしげるエビのマスコット。フラット・線画寄り。
    count: 2                         # 2 案ほしい → hero-icon-1.png / -2.png のように連番
    size: 1024x1024
    fit: contain
    format: png
notes: |                             # 任意。全体に効く指示（トーン・禁止事項など）
  すべて同一トーンで揃えること。人物・実在ロゴ・文字は入れない。
```

**フィールドの決め**

| キー | 必須 | 意味 |
|---|---|---|
| `job_id` | ○ | 保存先ディレクトリ名・報告の突合キー |
| `dest_root` | — | imagegen の cwd からの相対パス。既定 `tmp/images/<job_id>/`。**cwd の外は書けない**（§4.1） |
| `images[].id` | ○ | 報告の突合キー。ファイル名の既定でもある |
| `images[].purpose` | ○ | 用途 1 行（生成品質に効くので必ず書く） |
| `images[].prompt` | ○ | 生成プロンプト本文（複数行可） |
| `images[].count` | — | 既定 1。2 以上は `-1` `-2` の連番 suffix |
| `images[].size` | — | `WxH` または `none`。`image_gen` に size 引数は無いので**生成後にリサイズ**して満たす |
| `images[].fit` | — | `contain`（長辺合わせ・既定）/ `none`。**`cover`（切り抜き）は使わない**（§4.3 の加工禁止方針） |
| `images[].format` | — | `png`（既定）/ `webp` |
| `images[].filename` | — | 省略時 `<id>.<format>` |

### 2.2 master の投げ方（1 回）

```
spawn_ebi({
  role: "imagegen",
  task: "<上の YAML をそのまま貼る>",
  cwd: "/Users/yoimaro/workspace/GitHub/ebi-team"      // 既定でよければ省略可
})
```

`send_message({to:"imagegen-1", message:"<YAML>", spawnIfMissing:true, role:"imagegen"})` でも同じ。

### 2.3 engineer 役割プロンプトへの追記案（転記だけで済ませるため）

`src/server/roles.ts` の `ENGINEER_APPEND_SYSTEM_PROMPT` 末尾に足す想定（**この変更は組込み役割＝コード変更なので dist 再ビルドが要る**。§8）。

```
実装に画像素材が必要になった場合、自分で画像を作ろうとしないこと。必要な画像を洗い出し、
reply_to_master の本文末尾に次の YAML ブロックを 1 個だけ付けて master に渡す
（master がそのまま imagegen エビへ転記する）:
imagegen_job: v1 / job_id: <英数と-> / requester: <自分のid> /
images: - id / purpose / prompt / count / size(WxH) / fit(contain|none) / format(png|webp)。
prompt は日本語で、被写体・背景色・画風・禁止事項（文字を入れない等）まで書き切ること。
画像が不要なタスクではこのブロックを付けない。
```

---

## 3. 報告フォーマット（imagegen → master）

`reply_to_master` を **1 ジョブにつき 1 回**だけ呼ぶ。本文は「1 行サマリ ＋ YAML ブロック 1 個」。

```yaml
imagegen_result: v1
job_id: vc-standee-2026-09-05
summary: 3/4 ok, 1 failed
results:
  - id: hero-icon
    status: ok                 # ok | failed | refused | skipped
    path: /Users/yoimaro/workspace/GitHub/ebi-team/tmp/images/vc-standee-2026-09-05/hero-icon.png
    pixels: 512x512            # 実測値（sips -g pixelWidth -g pixelHeight）
    bytes: 244310
    format: png
    tool: image_gen__imagegen
  - id: empty-state-1
    status: ok
    path: /.../empty-state-1.png
    pixels: 1024x1024
    bytes: 831865
    format: png
    tool: image_gen__imagegen
  - id: empty-state-2
    status: failed
    error_code: GEN_ERROR      # §6 の表の値のみ
    note: 生成ツールがエラー応答（同一プロンプトで 1 回再試行済み）
gen_seconds: 233
```

規約:

- `path` は**絶対パス**（master が `open_viewer` にそのまま渡せる）。
- `pixels` は**実測**（依頼値のコピペ禁止。`image_gen` は 1024 指示に対し 1254 を返した実績がある）。
- `error_code` は §6.1 の表の値**だけ**を使う。`note` は自由記述だが **§6.4 の禁止語を使わない**。
- 途中経過をチャットに書いても master には届かない。**報告はこの 1 回だけ**。

### 3.1 master が見せる手順

```
open_viewer({ path: "<results[].path>", title: "<job_id> / <id>" })
```

- 許可ルートは `EBI_VIEWER_ROOTS`（未設定なら `$HOME/workspace`）。§4.1 の保存先ならそのまま通る。
- 画像の上限は `EBI_VIEWER_MAX_IMAGE_BYTES`（既定 8 MB）。1254px PNG が約 0.9 MB なので通常は余裕。
- 複数枚を見せるときは `open_viewer` を枚数ぶん呼ぶ（viewer は 1 パネル 1 ファイル）。**枚数が多いときは代表 1〜2 枚だけ開き、残りはパスの列挙に留める**のが master の文脈節約になる。

---

## 4. 保存先とサイズ規約

### 4.1 保存先: 既定は ebi-team 配下、対象リポジトリ直書きは「明示指定 ＋ cwd 合わせ」のとき限定

**既定（推奨）**: imagegen エビの cwd = ebi-team リポジトリ（`/Users/yoimaro/workspace/GitHub/ebi-team`）、保存先 = `tmp/images/<job_id>/`。

理由:

1. **サンドボックス**: `permissionMode: acceptEdits` → codex `-s workspace-write`（`src/server/backends/codex.ts` の `codexSandboxFor`）。書けるのは **cwd 配下**。対象リポジトリの assets へ直書きしたいなら、そもそも spawn 時の `cwd` をそのリポジトリに向ける必要がある。
2. **viewer 許可ルート**: `$HOME/workspace` 配下（`src/server/viewerRegistry.ts`）。ebi-team は `~/workspace/GitHub/ebi-team` なので条件を満たす。`/tmp` 配下に置くと `open_viewer` が弾く。
3. **採否前に他人の作業ツリーを汚さない**: 生成物はボスの採用／やり直し判断を通る。engineer が作業中の worktree へ横から書き込むと、engineer の `git status` を汚し、コミット事故と衝突の元になる。
4. `tmp/` は ebi-team で既にコミット対象外の作業置き場として使われている。

**対象リポジトリへ直書きするケース**（依頼で `dest_root` に相対パスを書き、**master が spawn 時に `cwd` をそのリポジトリ／worktree に合わせる**）:

- 置き場所と名前がすでに確定していて、やり直しの見込みが低いとき（例: VC の立ち絵のように既定パイプラインが確立しているもの）。
- その場合も **engineer が作業中の worktree は避け**、リポジトリ本体か画像専用 worktree を使う。

**受け渡し**: 既定経路では、採用が決まってから **engineer か master が `cp` で対象リポジトリへ配置**する（imagegen エビは自分の cwd の外に手を出さない）。

### 4.2 ディレクトリとファイル名

```
<cwd>/tmp/images/<job_id>/<id>.<ext>          # count=1
<cwd>/tmp/images/<job_id>/<id>-1.<ext> ...    # count>=2
```

### 4.3 サイズ・形式（`image_gen` に size 引数が無い問題への対処）

`ImagegenArgs` は `prompt` / `referenced_image_paths` / `num_last_images_to_include` の 3 つだけで、**サイズ指定の口が無い**。プロンプトに「1024x1024 程度」と書いても **1254x1254 が返った**（PoC §4-4）。よって**生成後にエビ自身が正規化する**。

```bash
# 1) 生成物を配置（image_gen の出力は ~/.codex/generated_images/<uuid>/exec-<uuid>.png）
cp "<generated>" "tmp/images/<job_id>/<id>.png"

# 2) リサイズ（fit: contain = 長辺合わせ・アスペクト比を保つ・歪ませない）
sips -Z 512 "tmp/images/<job_id>/<id>.png" >/dev/null

# 3) WebP が要るとき（★ sips は webp を「読める」だけで「書けない」。本機で --formats 実測）
cwebp -q 90 "tmp/images/<job_id>/<id>.png" -o "tmp/images/<job_id>/<id>.webp" \
  && rm "tmp/images/<job_id>/<id>.png"

# 4) 実測サイズ（報告の pixels / bytes はこの出力を使う）
sips -g pixelWidth -g pixelHeight "tmp/images/<job_id>/<id>.png"
stat -f%z "tmp/images/<job_id>/<id>.png"
```

**加工の禁止事項（VC の方針に合わせる）**

- やってよい: **リサイズ（`sips -Z` の長辺合わせ）** と **形式変換（PNG→WebP）** だけ。
- やらない: **減色・パレット化・トリム／切り抜き（`cover`）・背景除去・アルファ操作・回転・シャープ等の補正**。
- `sips -z H W`（縦横を強制）は**歪む**ので使わない。指定サイズと生成アスペクト比が合わないときは、**リサイズせずに `status: ok` ＋ 実測 `pixels` を報告し、`note` に「アスペクト比が合わないため長辺のみ合わせた」と書く**（勝手に切らない）。
- `cwebp` は `/usr/local/bin/cwebp` に存在（実測）。無い環境では `format: webp` を **`status: skipped`（`error_code: TOOL_MISSING`）で PNG のまま報告**し、変換を master に返す。

---

## 5. 役割定義の具体案（稼働 `ebi-team.config.json` の `roles` に足す）

現行の稼働 config は `roles` に `writer` / `reviewer` を持ち、`defaultBackend` / `backends` キーは持たない（＝ backend 既定は env `EBI_BACKEND` → `claude`）。そこへ **`imagegen` を 1 エントリ追加**する。

```jsonc
"imagegen": {
  "label": "画像生成",
  "emoji": "🎨",
  "backend": "codex",
  "mcpRole": "engineer",
  "permissionMode": "acceptEdits",
  "appendSystemPrompt": "あなたはエビチームの imagegen エビ。master から渡された imagegen_job(YAML) の画像を Codex 組み込みの画像生成ツールで作り、1 回だけ結果を報告する使い捨てセッション。\n\n【ツール】画像は必ず code mode の image_gen__imagegen で作る。シグネチャは tools.image_gen__imagegen({ prompt: string, referenced_image_paths?: string[]|null, num_last_images_to_include?: number|null }): Promise<unknown>。引数はこの 3 つだけで、サイズ引数は無い。imagegen skill の SKILL.md を読み直す手順は省くこと（内容はこのプロンプトに要約済み）。$imagegen と書いて skill を明示起動する必要も無い。OPENAI_API_KEY は使わない（ChatGPT ログインの枠で動く）。\n\n【手順】(1) 依頼 YAML の images を上から順に生成する。1 回の実行で複数枚まとめて生成できるならそうしてよい。(2) 全枚数の生成を終えてから、配置・リサイズ・形式変換・実測を 1 回のシェル実行でまとめて行う（1 枚ごとにシェルを起動しない）。配置先は依頼の dest_root、既定は tmp/images/<job_id>/。ファイル名は依頼の filename、既定は <id>.<format>、count が 2 以上なら <id>-1 <id>-2 の連番。(3) 最後に reply_to_master を 1 回だけ呼んで報告する。チャットに書いた文章は master に届かない。\n\n【サイズと加工】生成物のピクセル数は指示どおりにならない（1024 と書いても 1254 が返る）。依頼に size があれば sips -Z <長辺> で長辺だけ合わせる（sips -z は歪むので使わない）。format: webp は cwebp -q 90 で変換する（sips は webp を書けない）。cwebp が無ければ PNG のまま残し、その画像の status を skipped、error_code を TOOL_MISSING にする。許可された加工はリサイズと形式変換だけ。減色・パレット化・トリム・切り抜き・背景除去・アルファ操作・回転・補正は一切しない。指定サイズとアスペクト比が食い違うときは切らずに長辺だけ合わせ、note にその旨を書く。\n\n【範囲】書き込みは自分の cwd 配下だけ。cwd の外にファイルを作ったり消したりしない。~/.codex/generated_images は読むだけで、掃除はしない。git commit・git push・外部送信・破壊的操作はしない。\n\n【報告】本文は 1 行サマリと次の YAML ブロック 1 個。imagegen_result: v1 / job_id / summary / results: 各要素は id, status(ok|failed|refused|skipped), path(絶対パス), pixels(sips の実測値), bytes, format, tool, error_code?, note? / gen_seconds。path は必ず絶対パスにし、pixels は依頼値ではなく実測値を書く。\n\n【失敗したとき】1 枚でつまずいても残りの生成を続け、その画像だけ status を failed か refused にして報告に含める。原因は error_code(GEN_TOOL_OFF / REFUSED / GEN_ERROR / RESIZE_ERROR / TOOL_MISSING / TIMEOUT) で示し、note は事実だけを短く書く。note に『利用』『使用』『提供』『登録』『用意』『呼び出』『実行』『送信』『報告』を否定形で組み合わせた言い回しは書かない（サーバの故障検知に誤ヒットして作り直しが走る）。error_code と『NG』『不可』『未配布』『エラー応答』のような短い語で表現すること。"
}
```

**フィールドの補足**

| 指定 | 値 | 理由 |
|---|---|---|
| `backend` | `"codex"` | 画像生成の口は codex にしか無い（Gemini は全経路 ×・research doc §6） |
| `permissionMode` | `"acceptEdits"` | codex では `-s workspace-write` に写像（`codexSandboxFor`）。ファイル配置に必要な最小。`bypassPermissions` は `danger-full-access` になり過剰 |
| **`sandbox`** | **書かない** | 役割定義に `sandbox` フィールドは存在しない（`normalizeCustomRole` が受け付けるのは label / emoji / mcpRole / permissionMode / defaultModel / backend / appendSystemPrompt）。サンドボックスは `permissionMode` から自動写像される |
| `model` / `defaultModel` | **書かない** | 稼働 config に `backends.codex.defaultModel` が無いので、CLI 既定モデル（PoC 実測時 `gpt-5.6-sol`）が使われる。claude 語彙（`opus` 等）を書くと毎ターン 400 になる |
| `mcpRole` | `"engineer"` | 動的エビの唯一の権限ティア（`reply_to_master` ＋ 参照系） |

**permissionMode → codex `-s` の写像（`src/server/backends/codex.ts`）**

| permissionMode | codex `-s` |
|---|---|
| `plan` / `default` | `read-only` |
| `acceptEdits` / `auto` / `dontAsk` | `workspace-write` ← **これを使う** |
| `bypassPermissions` | `danger-full-access` |

**ACK 誤検知語を書いていないことの確認**（検知語の SoT は `src/server/backends/profiles.ts` の `CODEX_ACK_FAILURE_PATTERNS`）

| パターン | 上の役割プロンプトに含まれるか |
|---|---|
| `(利用\|使用)でき(ない\|ません\|ず)` | 含まない（「使う」「使わない」は単独形で、否定形の「〜できない」と組み合わせていない） |
| `(呼び出せません\|呼び出せない\|使えません)` | 含まない |
| `(提供\|登録\|用意)されて(いない\|いません\|おらず)` | 含まない |
| `(実行\|送信\|報告)でき(ない\|ません\|ず)` | 含まない（「外部送信はしない」「報告する」の形にしてある） |
| `(tool\|tools).{0,40}(not available\|unavailable\|not provided\|not registered)` | 含まない |

> 役割プロンプトは注入時に TUI がそのままエコーし、ACK 走査バッファに必ず入る。**上の 5 行は config を編集するたびに目視すること。**
> **実際に踏んだ罠**: 当初 §6.1 の error_code を `TOOL_UNAVAILABLE` としていたが、これは英語パターン
> `(tool|tools)[^\n]{0,40}(not available|unavailable|...)`（大小無視）に**一致する**。役割プロンプト本文だけでなく
> **error_code の語彙も同じ走査に掛かる**ため `GEN_TOOL_OFF` に改名した（本文書の 5 パターンは正規表現で機械照合済み）。
> `test/codexAckRespawn.test.ts` が錠前を掛けているのは組込み役割と e2e のタスク本文だけで、**config 由来のカスタム役割は自動検査の対象外**（§8 の PR-3 で検査を足す案あり）。

---

## 6. 失敗時の扱い

### 6.1 error_code の一覧（報告 YAML で使う語彙）

| error_code | 起きること | エビ側の動き | master 側の動き |
|---|---|---|---|
| `GEN_TOOL_OFF` | `image_gen__imagegen` がセッションに配られていない（プラン切れ／`codex login` の id_token が古い） | **リトライしない**。ジョブ全体を打ち切り、全 `results` を `failed` にして即報告 | §6.2 の診断 → ボスへ。**再 spawn しても同じ**なので繰り返さない |
| `REFUSED` | 生成ポリシーで拒否された | **同一プロンプトでは再試行しない**。その画像だけ `refused` にして次へ | プロンプトを書き換えて**新しいジョブ**として再依頼（同じ文言の再送は枠の無駄） |
| `GEN_ERROR` | ツールがエラー応答／出力ファイルが見当たらない | **同一プロンプトで 1 回だけ**再試行。だめなら `failed` | 1 枚なら再依頼、複数枚が同じなら §6.2 を疑う |
| `RESIZE_ERROR` | `sips` が失敗 | 元 PNG を残したまま `failed`、`note` に実サイズ | master が手元で `sips` |
| `TOOL_MISSING` | `cwebp` が無い | PNG のまま残して `skipped` | 変換は master 側で |
| `TIMEOUT` | master 側の打ち切り（エビは自分では出さない） | — | §6.3 |

### 6.2 `GEN_TOOL_OFF` の診断レシピ（master／ボスが手で 2 コマンド）

```bash
# 1) プラン（free だと画像生成の口が閉じる）
python3 -c "import json,base64,os;t=json.load(open(os.path.expanduser('~/.codex/auth.json')))['tokens']['id_token'].split('.')[1];print(json.loads(base64.urlsafe_b64decode(t+'='*(-len(t)%4)))['https://api.openai.com/auth']['chatgpt_plan_type'])"
# → plus 以外なら契約 or codex login のやり直し（契約直後は free のまま）

# 2) セッションに配られているか（★ "name":"image_gen" を探すのは誤判定の元）
RUST_LOG=trace codex exec -s read-only -c check_for_update_on_startup=false "reply with the single word OK" 2>&1 \
  | grep -c 'image_gen__imagegen'    # 1 以上なら配られている
```

### 6.3 タイムアウトの見積りと打ち切り

- 実測: 生成 1 枚 **76.6 s**（ebi-team 経由・注入から報告着弾まで）／手動 `codex exec` 65.3 s。
- master の待ち目安 = **90 s × 枚数 ＋ 120 s**（起動 20 s ウォームアップ＋仕上げ＋報告ぶん）。6 枚なら約 11 分。
- 超過したら: `read_scrollback({id, tail})` を **1 回だけ**見る → 生成が進んでいなければ `kill_engineer` → **枚数を半分にして再 spawn**（同じ枚数で投げ直さない）。

### 6.4 ACK 再 spawn との整合（重要）

- codex エビは役割プロンプト注入から **90 秒**（`EBI_CODEX_ACK_WATCH_MS`）が ACK 監視窓で、この間の PTY 出力が検知語に当たると**「静かな故障」と判定して 1 回だけ自動 respawn** される（`agent.ts` の `maybeDetectAckFailure`／`index.ts`）。監視は busy→idle のエッジ（`minObserveMs` 経過後）でも終わる。
- **危険な重なり**: 役割プロンプト注入の直後に master がタスクを投げると、1 枚 76 秒の生成が**監視窓 90 秒の中で終わる**。ここで失敗報告に「〜できません」が出ると、**正しく報告したのに respawn される**（＝枠を二重に食い、master には報告が 2 通来る）。
- 対策（この設計での採用）:
  1. **役割プロンプトで、失敗表現を `error_code` ＋「NG／不可／未配布」等の短語に固定する**（§5 の【失敗したとき】節）。これが本設計の主対策。
  2. master は**役割プロンプト注入の ACK が返ってから**タスクを投げる（`send_message` / `spawn_ebi` は ready 待ち後に注入するので通常は満たされる）。
  3. 恒久策（別 PR・要ボス裁定）: 実タスク注入時点で ACK 監視を明示的に閉じる、または imagegen 役割だけ `EBI_CODEX_ACK_WATCH_MS` を短くする。**コード変更なので §8 の PR-4 に切り出す。**

### 6.5 `~/.codex/generated_images/` の掃除

- ツールの既定出力先で、**セッションごとに UUID ディレクトリが増え続ける**（1 枚 ≒ 0.8〜0.9 MB）。
- **エビには掃除させない**（他セッションが同時に生成中のディレクトリを消す事故を避ける）。役割プロンプトにも「読むだけ・掃除しない」と明記済み。
- ebi-team 側で **7 日より古いものだけ**を落とす小さなスクリプトを `ops/` に置き、手動または週次で回す（§8 の PR-3）:

  ```bash
  find "$HOME/.codex/generated_images" -mindepth 1 -maxdepth 1 -type d -mtime +7 -print -exec rm -rf {} +
  ```

---

## 7. 枠（Plus の included limits）の見積り

**枚数の目安は「不明」。公式に数値が出ていない。**

分かっている一次情報（`docs/research/codex-imagegen-plan-2026-09-05.md` §2 が出典・原典は <https://learn.chatgpt.com/docs/pricing> と <https://learn.chatgpt.com/docs/image-generation>）:

| 公式が言っていること | 効いてくる点 |
|---|---|
| 画像生成は Free プランでは使えない。Go / **Plus** / Pro / Business / Enterprise・Edu では **included limits に含まれる** | 追加課金なしで使える（`OPENAI_API_KEY` 不要） |
| 「Image generation counts toward the same general usage limits as local messages and cloud chats」 | **画像専用の枠は無い**。engineer 用の codex 枠と食い合う |
| included limits を**通常ターンの 3〜5 倍**の速さで消費する | 1 枚 ≒ 通常ターン 3〜5 回分**相当**（公式は倍率のみで絶対値を出していない） |
| 大量バッチ向けには `OPENAI_API_KEY` を設定して API 課金にする道がある | **今回は使わない**（サブスク枠のみという縛り） |

**なぜ枚数に落とせないか**: Plus の local message limit 自体が公式に固定数値として公開されておらず（負荷に応じた動的な上限）、「3〜5 倍」も倍率であって絶対値ではない。したがって「1 日 N 枚」は**推定を書かず不明とする**。

**運用上の当て方（数値を出さずに枠を守る）**

1. **1 ジョブ 6 枚まで・同時 spawn は 1 本**（§1.3）。
2. **やり直しは必ずプロンプトを変えてから**。同一プロンプトの投げ直しは 3〜5 倍の消費をそのまま捨てる。
3. **枠に当たったら止める**。レート制限の応答が出たジョブは残りを打ち切って報告させ、時間を空ける。
4. 実際の残枠を知りたい場合は codex TUI の `/status` を見る（ebi-team は codex の usage を UI に出せない＝`reportsUsage: false`）。**この読み方は未検証＝要 PoC**。

---

## 8. 実装タスク分割（PR 単位・各 0.5 日以内）と反映方法

### 8.1 稼働反映は config だけで足りるか

| 変更 | dist 再ビルド | サーバ再起動 | 根拠 |
|---|---|---|---|
| `ebi-team.config.json` の `roles.imagegen` 追加 | **不要** | **必要** | 役割は起動時に `registerCustomRoles()` がレジストリへマージする（`src/server/index.ts` と `src/mcp/control-server.ts` の両方が起動時に config を読む） |
| `spawn_ebi` の `role` 選択肢に `imagegen` が出ること | 不要 | 必要（master セッションごと） | master 用 MCP ブリッジが起動時の config から `z.enum(ROLE_IDS)` を作る。master は fixedEbi なのでサーバ再起動で一緒に上がる |
| `ENGINEER_APPEND_SYSTEM_PROMPT` への追記（§2.3） | **必要**（`npm run build`） | 必要 | 組込み役割はコード（`src/server/roles.ts`）にある |
| `ops/` の掃除スクリプト | 不要 | 不要 | 単体スクリプト |
| ACK 監視窓の調整（§6.4-3） | **必要** | 必要 | `src/server/agent.ts` / `profiles.ts` |

### 8.2 PR 分割

| PR | 内容 | 成果物 | 見積り | 依存 |
|---|---|---|---|---|
| **PR-1** | `roles.imagegen` を稼働 config に追加＋`ebi-team.config.example.json` にも同等サンプルを追記＋`README` の役割一覧に 1 行 | config 2 ファイル・README | 0.25 日 | なし |
| **PR-2** | 実運用スモーク（**本 PR で初めて枠を使う**）: 2 枚ジョブを 1 回流し、依頼 YAML → 生成 → `sips`/`cwebp` → 報告 YAML → `open_viewer` までを実測。結果を `docs/verify/imagegen-role-<date>.md` に記録。ターン数・所要・実ピクセルを表で残す | 検証 doc | 0.5 日 | PR-1 |
| **PR-3** | 運用の受け皿: `ops/clean-generated-images.sh`（§6.5）＋ **config 由来のカスタム役割プロンプトを ACK 検知語で走査する unit test**（`test/codexAckRespawn.test.ts` に 1 ケース追加。config が無い環境ではスキップ） | スクリプト・テスト | 0.5 日 | PR-1 |
| **PR-4** | engineer 役割プロンプトに「必要画像リストを imagegen_job YAML で出す」を追記（§2.3）。組込み役割変更なので**要ビルド**。既存 e2e の緑を確認 | `src/server/roles.ts`・テスト | 0.5 日 | PR-2（様式が実測で固まってから） |
| **PR-5**（任意・要ボス裁定） | ACK 監視窓と実タスクの重なりを断つ（実タスク注入時に監視を閉じる or 役割別に窓を短縮）。§6.4-3 | `src/server/agent.ts`・test | 0.5 日 | PR-2 で誤検知が実際に出たら着手 |
| **PR-6**（任意・要 PoC） | 「1 回の `exec` で N 枚生成」の検証（§1.2）。効けば役割プロンプトを更新してターン数を `N+3` → `4` に落とす | 検証 doc・config 更新 | 0.5 日 | PR-2 |

**最短ルート**: PR-1 → PR-2 で運用開始できる（1 日弱）。PR-3 以降は運用しながら。

---

## 9. ボス裁定が要る点

1. **保存先の既定**: ebi-team の `tmp/images/<job_id>/` に置いて採用後に配る（本設計の推奨）か、最初から対象リポジトリの assets へ直書きするか。直書きなら spawn 時の `cwd` を対象リポジトリに向ける運用になる（§4.1）。
2. **1 ジョブの上限枚数 6**（＝ 1 回の依頼で最大 6 枚・所要 8〜11 分）でよいか。枠の消費速度が読めない以上、最初は 4 枚に絞る選択もある（§1.3・§7）。
3. **PR-2 のスモークで枠を使うこと**（画像 2 枚ぶん＝通常ターン 6〜10 回相当）の可否。設計段階では一切使っていない。
4. **PR-5（ACK 監視窓のコード変更）** に踏み込むか、当面は役割プロンプトの語彙統制（§6.4-1）だけで回すか。
5. `image_gen` は **ChatGPT Plus の契約が切れた瞬間に使えなくなる**（Free で口が閉じる仕様）。契約更新のたびに `codex login` のやり直しが要る点を運用手順として持つか（§6.2）。

---

## 10. 本設計で守った制約

- **実装していない**（config・コードとも変更なし。本ファイル 1 枚のみ）。
- **稼働サーバ（8787）に触れていない**。稼働 `ebi-team.config.json` は**読んだだけ**。
- **課金する検証をしていない**（`codex` を 1 度も起動していない。§7 の枚数は推定せず「不明」と明記）。未検証事項は「要 PoC」と明示（§1.2 の複数枚一括生成、§7 の `/status`）。
- Chrome 拡張・外部送信・`git push` をしていない。
- 実測値はすべて既存 PoC / research doc の引用で、出所を明記した。`sips` の webp 非対応と `cwebp` の存在だけは**本機で実測**（`sips --formats` / `which cwebp`）。
