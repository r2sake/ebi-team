# Gemini バックエンド（PR-C）

実装: `src/server/backends/gemini.ts`（性質のデータは `backends/profiles.ts` の `GEMINI_TRAITS`）
検証済み CLI: **gemini-cli 0.58.0**（`@google/gemini-cli` / `~/.npm-global/bin/gemini`）
根拠となる実測: `docs/poc/gemini-poc-2026-09-04.md`（PR0-G）＋ 本 PR の live e2e（`scripts/e2e-gemini-engineer.mjs`）

---

## 0. 3 行まとめ

1. **PTY 駆動で動く**。`--experimental-acp` は不要。ebi-team の骨格（node-pty / idle 検出 / scrollback / worktree）に素で乗る。
2. per-エビの MCP・起動ゲート無効化・役割プロンプトは **`GEMINI_CLI_SYSTEM_SETTINGS_PATH` に渡す JSON 1 枚**で完結する。**`~/.gemini/` 配下は一切書き換えない**。
3. claude との差分で気をつけるのは 4 点: **モデル名は明示 ID**・**ready はプロンプト表示で判定**・**kill はプロセスグループ**・**受信は PTY 注入固定**（channel 注入は非対応）。

---

## 1. 起動形

```
gemini -m gemini-2.5-flash --approval-mode yolo --allowed-mcp-server-names ebi-control
  cwd: エビの worktree ルート
  env: GEMINI_CLI_SYSTEM_SETTINGS_PATH=<per-エビ settings.json>
       EBI_ID=<agentId>
       （親 env から envDenyList の 5 キーを削除して継承）
```

| 項目 | 値 | 理由 |
|---|---|---|
| モデル | `gemini-2.5-flash`（既定）／重い読解のみ `gemini-2.5-pro` | **alias は 404**（`gemini-flash-latest` / `gemini-2.0-flash` / `gemini-3-*-preview` はいずれも Code Assist 経路で NOT_FOUND）。明示 ID 必須 |
| モデルの解決 | `gemini-` で始まらない指定は既定モデルへ落とす | 役割既定モデル（engineer = `claude-opus-5`）がそのまま `-m` に流れると即 404。役割ごとの backend 別モデルは PR-E |
| 承認モード | permissionMode から写像（既定 `yolo`） | §4 参照 |
| `--allowed-mcp-server-names` | 制御MCP を持たせるときだけ付与 | settings の `trust: true` と二重の保険 |
| cwd | **エビの worktree ルート**（サブディレクトリ不可） | yolo でも「workspace 外ファイルの読み取り確認」ダイアログが出て注入が食われる |
| 初回タスク | **PTY 注入**（`-i` は使わない） | §5 参照 |
| 役割プロンプト | per-エビ `GEMINI.md`（settings の `context.includeDirectories`） | §6 参照 |

## 2. per-エビ system settings

`<runtimeDir>/<agentId>/settings.json` に書き出して env で渡す。
runtimeDir の既定は `<サーバcwd>/.ebi-team/gemini/`（env `EBI_GEMINI_RUNTIME_DIR` で変更可）。
**エビの作業ディレクトリの外**に置くので worktree は汚れない。

```jsonc
{
  "ui": { "useAlternateBuffer": false },      // インライン描画（xterm.js のスクロールバック）
  "security": {
    "folderTrust": { "enabled": false },      // 0.58.0 は既定 on。出ると 1 通目が食われる
    "auth": { "selectedType": "oauth-personal" }
  },
  "general": { "enableAutoUpdate": false, "checkForUpdates": false },  // 自動更新中 20〜25 秒無出力
  "context": {                                 // 役割プロンプト（§6）
    "includeDirectories": ["<runtimeDir>/<agentId>"],
    "loadMemoryFromIncludeDirectories": true
  },
  "mcpServers": {
    "ebi-control": { "command": "...", "args": [...], "cwd": "...", "trust": true,
      "env": { "EBI_CONTROL_URL": "...", "EBI_MCP_ROLE": "engineer",
               "EBI_ID": "<agentId>", "EBI_NOTIFY_SUBSCRIBE": "off" } }
  }
}
```

MCP の `command` / `args` / `cwd` / 接続先は **`scripts/gen-master-mcp.mjs` が生成する
`.ebi-team/engineer-control(.dev).mcp.json` を読み直して**射影している（二重管理を作らないため）。

**触らないもの**: `~/.gemini/settings.json` / `~/.gemini/trustedFolders.json` / `~/.gemini/GEMINI.md`。
（`~/.gemini/oauth_creds.json` は gemini CLI 自身がトークン更新時に書き換える。ebi-team は書かない。）

## 3. 課金枠と 2 つのログインモード

ebi-team は**アカウント種別を決め打ちしない**。`GOOGLE_CLOUD_PROJECT` は
「**あれば継承・無ければ無し**」で起動する（preflight の必須 env は空）。

| モード | アカウント | `GOOGLE_CLOUD_PROJECT` | 枠 |
|---|---|---|---|
| A: Workspace 垢 | `…@nexlim.co.jp` 等 | **必須**（無いと `This account requires setting the GOOGLE_CLOUD_PROJECT` で起動不能） | 会社 GCP の **Gemini Code Assist Standard**（シート課金型サブスク） |
| B: 個人垢（**現行方針**・ボス裁定 2026-09-05） | 個人 Google アカウント（Google AI Pro 等） | **設定しない**（設定すると GCP 紐付き経路に載る） | 個人サブスクの枠 |

- モード A で `GOOGLE_CLOUD_PROJECT` が未設定だと gemini が起動時にエラーを出す。ebi-team は
  その文言を検知して **notice とサーバログへ明示**する（`fatalPatterns`）。黙って ready 待ち
  タイムアウトさせない。
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` による**従量課金経路には絶対に載せない**。
  envDenyList で 5 キーを親 env から落とす: `GEMINI_API_KEY` / `GOOGLE_API_KEY` /
  `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_GENAI_USE_GCA` / `GOOGLE_APPLICATION_CREDENTIALS`。

### 3.1 枠の確認方法

- TUI 起動画面の `Plan: …` 行と、フッタ右の `quota N% used`。
- モード A の課金レコード: GCP コンソール → 対象プロジェクト（例 `engineering-478708`）→
  お支払い → 費用の内訳で **Gemini for Google Cloud / Gemini Code Assist** の行を見る
  （日次で反映されるので、使用日の翌日に確認する）。
- 現在の tier を機械的に見たい場合は `gemini -d`（debug）起動時のログか `/about`。

### 3.2 個人アカウントへ切り替える手順（**ボス作業**。エビは実行しない）

エビは `~/.gemini` 配下を書き換えず、ログアウトもしない。以下は人間が手で行う。

```bash
# 1) 現行（Workspace 垢）の資格情報を退避
cp ~/.gemini/oauth_creds.json ~/.gemini/oauth_creds.workspace.json.bak

# 2) 個人アカウントでログインし直す
#    ebi-team のエビを全部止めてから行う（起動中のエビは古い資格で動き続ける）
gemini
#    TUI で /auth → "Login with Google" → ブラウザで個人アカウントを選択

# 3) 確認: Plan 行が個人サブスクになっていること・GOOGLE_CLOUD_PROJECT 無しで起動できること
env -u GOOGLE_CLOUD_PROJECT gemini
#    → 起動できれば個人垢。`requires setting the GOOGLE_CLOUD_PROJECT` が出るなら Workspace 垢のまま

# 4) 戻したいときは 1) の退避ファイルを oauth_creds.json へ書き戻す
```

モード B へ切り替えたら、ebi-team サーバの env から `GOOGLE_CLOUD_PROJECT` を外して起動する
（付いたままだと GCP 紐付き経路に載る可能性がある）。

## 4. permissionMode の写像と「書き込み抑止」の考え方

| 抽象 permissionMode | `--approval-mode` |
|---|---|
| `bypassPermissions` / `dontAsk` / `auto` / 未指定 | `yolo` |
| `acceptEdits` | `auto_edit` |
| `default` / `plan` | `default` |

**無人運用では `yolo` が実質必須**。gemini の承認ダイアログは「ファイル書き込み」だけでなく
**MCP ツール呼び出し**と **workspace 外ファイルの読み取り**でも出る。ダイアログが出た回は
PTY 注入がそれに食われる（PoC で 10 回中 9 回に劣化）。つまり `reply_to_master` を確実に
届けるには yolo が要る。

したがって **書き込み抑止は承認モードでは担保しない**。担保するのは次の 3 点:

1. **cwd をエビ専用の worktree に閉じる**（workspace 外は触らせない）
2. **役割プロンプト（GEMINI.md）で読み取り・調査寄りに限定する**
3. 必要なら gemini 側のサンドボックス（`--sandbox`）を足す（現状は未使用）

適性は「下調べ・要約・ログ読解・画像/スクショ読解」。実装・リファクタは当面 claude / codex に任せる。

## 5. 初回タスクの渡し方（`-i` を既定にしない理由）

`-i "<task>"` は成立する（PoC ○ ／ 本 PR の e2e でも 2/2 で応答を確認）。それでも**既定は PTY 注入**にした:

- ebi-team の起動経路は「**spawn → send_message**」の 2 段で、spawn の時点ではタスク本文が無い
  （`spawnIfMissing` でも spawnAgent はタスクを受け取らない）。`-i` を既定にすると
  「タスク付き spawn」という別 API を作る必要があり、claude/codex 経路と分岐が増える。
- PTY 注入の到達率は本 PR の e2e で **10/10**（ready 判定を §7 のとおり直した後）。`-i` にしても
  改善する余地が無い。
- `-i` は `traits.initialPromptArgs` として残してある（`["-i", prompt]`）。PR-E 以降で
  「タスク付き一括起動」を作るときに使える。

## 6. 役割プロンプトと `~/.gemini/GEMINI.md` の共存

gemini には `--append-system-prompt` 相当が無い。`GEMINI_SYSTEM_MD` は
**コアのシステムプロンプトを丸ごと差し替える**（ツール利用の指示ごと壊れる）ので使わない。

採用したのは **per-エビ `GEMINI.md` + `context.includeDirectories`**:

- `<runtimeDir>/<agentId>/GEMINI.md` に役割プロンプトを書き、そのディレクトリを
  `context.includeDirectories` に入れて `loadMemoryFromIncludeDirectories: true` にする。
- ボスの `~/.gemini/GEMINI.md`（グローバル共有コンテキスト）は**従来どおり読み込まれる**ので共存する。
  TUI フッタが `2 GEMINI.md files` と出れば「グローバル + 役割」の両方が載っている（e2e で毎回検査）。
- worktree にファイルを置かないので `git status` が汚れない。

## 7. 既知の罠

| 罠 | 症状 | 対策（実装済み） |
|---|---|---|
| **ready の誤判定** | OAuth トークン再取得中に `Waiting for authentication...` で沈黙 → 「boot 猶予＋初回 idle」が ready と誤判定 → **1 通目が丸ごと消える** | `readyPattern: /Type your message/`。プロンプト（入力欄）が描画されるまで ready にしない |
| **孤児プロセス** | gemini は子 node を再 exec する。PTY リーダの kill だけでは子と配下の stdio MCP が残る（PoC で 21 プロセス残存） | `killProcessGroup: true` → `process.kill(-pid, SIGTERM)` → 猶予後 `SIGKILL`。e2e で毎回 `pgrep -g` 0 件を検査 |
| **folderTrust ゲート**（0.58.0 で既定 on） | `Do you trust the files in this folder?` が出て 1 通目が食われる。`1\r` で答えると `~/.gemini/trustedFolders.json`（共有ファイル）が作られる | settings で `security.folderTrust.enabled: false`（ダイアログ自動応答は採らない） |
| **自動更新** | 起動中に npm 更新が走り 20〜25 秒無出力。その間の注入が宙に浮く | settings で `enableAutoUpdate` / `checkForUpdates` を false |
| **モデル alias の 404** | `gemini-flash-latest` 等が NOT_FOUND | 明示 ID（`gemini-2.5-flash`）を定数で持つ |
| **workspace 外の読み取り確認** | cwd のサブディレクトリで起動すると親ディレクトリの読み取りでダイアログ | cwd は worktree ルート。広げたいときは `--include-directories` |
| **usage（cost/context）が取れない** | claude の statusLine 相当が無い | `reportsUsage: false`。UI は「—（未対応）」表示（PR-E）。フッタの `quota N% used` は将来 PR-F で拾える |

## 8. 通信路

- **送信（エビ → master）**: `reply_to_master`（ebi-control MCP・stdio）。claude と同一経路で動く。
- **受信（master → エビ）**: **PTY 注入に一本化**。gemini は Claude harness 固有の
  `notifications/claude/channel` を持たないため、`supportsChannelInject: false` /
  `hasControlBridge(): false` にして購読待ちを発生させない（＝無駄な待ちなしで即 PTY）。
  MCP 側も `EBI_NOTIFY_SUBSCRIBE=off` を焼いて購読ループを回さない。
- 注入パラメータ（`ENTER_DELAY_MS=500` / `EBI_IDLE_MS=900`）は **claude と同じ値でよい**（PoC 実測）。

## 9. 使い方

```bash
# 単発（制御API 経由）
curl -s localhost:8787/control/spawn -H 'content-type: application/json' \
  -d '{"id":"ebi-scout","role":"engineer","backend":"gemini","cwd":"/path/to/worktree"}'

# master の MCP から
#   spawn_ebi(role="engineer", backend="gemini", ...)
#   send_message(to=..., spawnIfMissing=true, role="engineer", backend="gemini")
```

サーバ既定を gemini にしたい場合は `EBI_BACKEND=gemini` / `defaultBackend: "gemini"`（非推奨。
master は claude 固定なので統括系は落ちないが、動的エビが全部 gemini になる）。

**推奨は役割単位の指定（PR-E で実装済み）**。`ebi-team.config.json`:

```jsonc
{
  "backends": { "gemini": { "command": "gemini", "defaultModel": "gemini-flash-latest" } },
  "roles": {
    "researcher": {
      "label": "調査",
      "backend": "gemini",
      "permissionMode": "plan",
      "appendSystemPrompt": "下調べ・読解専任の使い捨てセッション。…"
    }
  }
}
```

これで `spawn_ebi(role="researcher")` が gemini 起動になる（解決順は spawn 引数 > 役割 >
`defaultBackend` > env > claude）。UI では 🔵 gemini バッジが付き、cost / context は
「—（未対応）」表示になる（`reportsUsage: false`）。

### 起動前チェック（preflight）

spawn の直前に自動実行される（**claude では 1 回も走らない**＝確認項目が空のため）。

- error（spawn を止める）: `~/.gemini/oauth_creds.json` が無い（未ログイン）
- warning（止めない）: `gemini --version` が取れない／検証済み 0.58.0 と違う

### ready 前に落ちたとき

`retryOnEarlyExit: true` なので **1 回だけ自動で再 spawn** する（notice が出る）。
2 回目も ready 前に落ちたら打ち切って notice で明示する。

## 10. e2e

```bash
node scripts/e2e-gemini-engineer.mjs                 # 10 ラウンド（既定）
EBI_E2E_ROUNDS=3 node scripts/e2e-gemini-engineer.mjs
EBI_E2E_INITIAL_PROMPT=1 node scripts/e2e-gemini-engineer.mjs  # `-i` 方式の参考計測つき
```

稼働サーバ(8787)には触らない（専用ポート 8803 ＋ mkdtemp の使い捨て状態ディレクトリ）。
1 ラウンドで **spawn → ready → 注入 → `reply_to_master` が master へ着弾 → idle 復帰 →
kill 後にプロセスグループ残存 0** を検査し、最後に `pgrep -f "npm-global.*gemini"` が 0 件であることを確認する。

## 11. ロールバック

| 段 | 手順 | 影響 |
|---|---|---|
| 1 | spawn 時に `backend` を指定しない（= claude） | gemini エビが立たなくなるだけ。既存は無傷 |
| 2 | `EBI_BACKEND` / `defaultBackend` を `claude` に戻す | 同上 |
| 3 | PR-C のコミットを revert | PR-A / PR-B（抽象化）は挙動不変なので残してよい。master は常に claude なので統括系は落ちない |

per-エビ runtime（`.ebi-team/gemini/<agentId>/`）は残っても無害（次回 spawn で上書き）。
消したい場合はディレクトリごと削除してよい。
