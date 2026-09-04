# PR0-G: Gemini CLI バックエンド PoC 実測記録（2026-09-04 実施）

実施: engineer エビ（master 委譲・ボス GO 済み）
対象設計書: `docs/multibackend-plan-r2.md` §2（ブランチ `ebi/ebiteam-multibackend-plan2`）
worktree: `.worktrees/ebi-ebiteam-poc-gemini`（`ebi/ebiteam-poc-gemini`）
稼働サーバ(8787) / `dist` / `ebi-team.config.json` / master-mcp は**無変更**（読み取りと `reverse-inject` の疎通のみ）

---

## 0. 結論（5行）

1. **PTY 方式で行ける。`--experimental-acp` は不要。** 注入成功率は **20/20**（enterDelay 200/500/1000ms すべて 100%）、alt-screen へ入らず、idle も完全に落ちる（60秒 0 バイト）。
2. **`GEMINI_CLI_SYSTEM_SETTINGS_PATH` による per-エビ MCP 注入は成立**。`~/.gemini/settings.json` は無変更のまま `reply_to_master` が master へ着弾した（headless / PTY(TUI) の両経路で確認）。
3. **課金 0（free-tier）は成立しない。** ログイン中のアカウントは Workspace アカウントで、**`userTier = standard-tier`（Gemini Code Assist Standard・`cloudaicompanionProject = engineering-478708`）**。設計書 §2.5 の `envDenyList` から **`GOOGLE_CLOUD_PROJECT` を外さないと起動すらできない**（`ProjectIdRequiredError`）。→ ボス判断が要る（§5）。
4. **PoC 中に gemini CLI が自動アップデートで 0.19.4 → 0.58.0 に上がった**（既定 on）。以降の実測は全て **0.58.0**。設計書 §2.2 の「起動ゲート既定なし」は 0.19.4 の話で、**0.58.0 では folderTrust ゲートが既定 on** に変わっている（system settings で無効化できることを実測済み）。
5. PR-C 実装で新たに要るのは 4 点: ①`general.enableAutoUpdate=false` の焼き込み ②`security.folderTrust.enabled=false` ③cwd はエビの worktree ルート（workspace 外読み取りが yolo でもダイアログになる）④**プロセスグループ kill**（gemini は子 node を再 exec するため PTY リーダの kill だけでは孤児が残る）。

---

## 1. 受け入れ基準ごとの結果

| # | 項目 | 判定 | 証拠 |
|---|---|---|---|
| 1 | PTY 起動＋「本文 write→遅延→`\r`」注入 | **○** | 20/20（後述 §2） |
| 2 | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` で per-エビ settings 注入 | **○** | `~/.gemini/settings.json` mtime 変化なし・MCP ツール 3 本が見えた（§3） |
| 3 | MCP 経由の `reply_to_master` | **○** | headless / PTY 両方で `delivered: ["master"]`（§3） |
| 4 | idle 判定（永久 busy にならないか） | **○** | 起動後 60 秒・タスク完了後 60 秒とも **0 バイト / 0 チャンク**（§4） |
| 5 | 課金 0（free-tier）の確認 | **×（重要）** | `currentTier = standard-tier` / `paidTier = gcp-standard-tier`（§5） |
| 6 | Flash での read タスク 1 本 | **○** | 約 7〜15 秒で日本語 3 行要約（§6） |

---

## 2. PTY 駆動性（受け入れ基準 1）

検証スクリプト: `tmp/poc-gemini/poc-gemini-pty.mjs`（node-pty で直 spawn・`agent.ts` と同じ DSR 自動応答・同じ注入手順）

起動コマンド（実測で成立したもの）:

```
gemini -m gemini-2.5-flash --approval-mode yolo --allowed-mcp-server-names ebi-control
  env: GEMINI_CLI_SYSTEM_SETTINGS_PATH=<per-エビ settings>
  cwd: <エビの worktree ルート>
```

| 観測 | 結果 |
|---|---|
| alt-screen 遷移（`ESC[?1049h`） | **出現しない**（設計どおりインライン描画。`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` 相当の操作は不要） |
| 起動〜プロンプト（`Type your message`）表示 | **5.1〜6.6 秒**（5 回計測: 5069 / 5362 / 5397 / 5740 / 5848 / 6582 ms） |
| 起動フェーズの出力量 | 約 5.6〜8.9 KB |
| 注入成功率 `enterDelay=500ms` | **10/10** |
| 注入成功率 `enterDelay=200ms` | **5/5** |
| 注入成功率 `enterDelay=1000ms` | **5/5** |
| 1 往復の所要（注入→モデル応答文字列の出現） | **1.7〜4.4 秒**（中央値およそ 3.0 秒） |
| `-i "<task>"`（起動時初回タスク） | **○**（初回タスクを実行後、対話が継続し追加注入も通る） |

→ **`ENTER_DELAY_MS` は claude 既定の 500ms のままで問題ない**（200ms でも通ったので backend 別に下げる余地はあるが、下げる理由が無い）。

ログ例（10/10 の回）:

```
[poc] プロンプト出現まで 5568ms
[poc] boot: idle到達=true bytes=8928 altScreen=false
[poc] idle観測 60s: bytes=0 chunks=0 最長無出力=60006ms
[poc] round 1: OK 3036ms ... round 10: OK 3350ms
[poc] 注入成功率: 10/10 (enterDelay=500ms)
```

### 2.1 起動ゲート（設計書 §2.2 の「既定で出ない見込み」は 0.58.0 で不成立）

0.58.0 の初回起動で **`Do you trust the files in this folder?`** が出た（`security.folderTrust.enabled` の既定が `?? true`＝**有効**に変わっている。0.19.4 は無効既定）。

```
│ Do you trust the files in this folder?                                     │
│ ● 1. Trust folder (poc-gemini)                                             │
│   2. Trust parent folder (tmp)                                             │
│   3. Don't trust                                                           │
```

- このゲートが出た回は **1 通目の注入がダイアログに食われて失敗**した（9/10）。
- **system settings に `security.folderTrust.enabled: false` を焼くとゲートは消え、10/10 になった**（再現確認済み）。
- 既存の `detectStartupGate()`（"trust" 検知＋`1\r` 自動応答）でも通るが、**settings で消す方が決定論的**なので PR-C はそちらを採る。
- なお、ゲートに `1\r` で答えると **`~/.gemini/trustedFolders.json`（共有ファイル）が作られる**。PoC では作られた同ファイルを削除して原状復帰した（バックアップは scratchpad）。「共有設定を汚さない」観点でも settings で消すのが正しい。

### 2.2 workspace 外ファイルの読み取りゲート（新規発見）

`--approval-mode yolo` でも、**cwd の外にあるファイルを読むときは確認ダイアログが出る**:

```
│  The following files are outside your workspace:                             │
│   - .../src/server/idleDetector.ts                                           │
│  Do you want to allow this read?   ● 1. Yes   2. No                          │
```

→ **エビの cwd は worktree ルートにする**（サブディレクトリで起動しない）。広げたい場合は `--include-directories`。

### 2.3 プロセス終了（新規発見・PR-C 必須）

`gemini` は起動後に **子 node を再 exec する**（`node --max-old-space-size=8192 .../bin/gemini ...`）。
PTY リーダ（`node-pty` が持つ pid）を `kill()` しても**子と、その下の stdio MCP サーバが残った**（PoC で 7 セッション分・計 21 プロセスが残存し、PID 指定で個別に停止した）。

→ PR-C では **プロセスグループ kill**（`process.kill(-pid)` / `pty.kill()` 後の残存確認）を入れる。claude では顕在化していない差分。

---

## 3. MCP 注入と `reply_to_master`（受け入れ基準 2・3）

per-エビ system settings（実験用は scratchpad に配置・`~/.gemini` は不変）:

```jsonc
{
  "ui": { "useAlternateBuffer": false },
  "security": {
    "auth": { "selectedType": "oauth-personal" },
    "folderTrust": { "enabled": false }          // ← 0.58.0 で必須（既定 true）
  },
  "general": { "enableAutoUpdate": false, "checkForUpdates": false },  // ← 自動更新の封じ込め
  "mcpServers": {
    "ebi-control": {
      "command": "node",
      "args": ["<repo>/dist/server/mcp/control-server.js"],
      "cwd": "<repo>",
      "env": {
        "EBI_CONTROL_URL": "http://127.0.0.1:8787",
        "EBI_MCP_ROLE": "engineer",
        "EBI_ID": "<agentId>",
        "EBI_NOTIFY_SUBSCRIBE": "off"
      },
      "trust": true
    }
  }
}
```

実測:

- ツール一覧（headless `-p` で列挙させた）: `list_ebi` / `read_scrollback` / `reply_to_master` の 3 本。**engineer ロールの出し分けがそのまま効いている**。
- `trust: true` + `--allowed-mcp-server-names ebi-control` で **確認プロンプトなしにツールが呼ばれた**。
- **headless 経路**（`gemini -p "…reply_to_master を呼んで…"`）→ 送信成功。
- **PTY(TUI) 経路**（起動後に注入）→ 画面に `masterセッションへの通知が正常に完了しました（delivered: ["master"]）`。
- 送信本文は指示どおり `[poc-gemini]` 始まりの 2 通のみ。
- `~/.gemini/settings.json` は **mtime・内容とも変化なし**（2025-12-06 のまま）。

補足: TUI フッタに `1 GEMINI.md file · 1 MCP server · 3 skills` と出る。**`~/.gemini/GEMINI.md`（ボスの共有コンテキスト）が読み込まれている**ので、PR-C で役割プロンプトを与えるときはこれとの共存/上書きを設計する必要がある。

---

## 4. idle 判定（受け入れ基準 4）

`IdleDetector` 相当（出力停止 900ms = `EBI_IDLE_MS` 既定）で観測:

| フェーズ | 観測時間 | meaningful 出力 | チャンク数 | 最長無出力 |
|---|---|---|---|---|
| 起動完了直後 | 60 秒 | **0 バイト** | **0** | 60006 ms |
| 起動完了直後（別回） | 15 秒 | 0 バイト | 0 | 15001 ms |
| タスク（read + 要約）完了後 | 60 秒 | **0 バイト** | **0** | — |
| タスク（MCP 呼び出し）完了後 | 60 秒 | **0 バイト** | **0** | — |

- **待機中の定期再描画は一切ない**。DSR（`ESC[6n`）の連投もなく、`answerTerminalQueries` 相当の応答すら不要だった（実装済みなので害はない）。
- 実行中は `⠸ Thinking... (esc to cancel, 6s)` の**経過秒カウンタで毎秒再描画**するが、これは「作業中＝busy」なので正しい挙動。
- → **設計書 R2（永久 busy）は Gemini では顕在化しない。`idleThresholdMs` の backend 別調整も不要**（claude と同じ 900ms でよい）。

---

## 5. 課金経路（受け入れ基準 5）— **想定と違う。ボス判断が要る**

### 5.1 事実

`loadCodeAssist` を**生成呼び出しなし**（メタデータのみ・トークン消費 0）で直接叩いた結果:

`GOOGLE_CLOUD_PROJECT` を**外した**とき:

```json
{ "allowedTiers": [ { "id": "standard-tier", "name": "Gemini Code Assist",
    "userDefinedCloudaicompanionProject": true, "isDefault": true, "usesGcpTos": true } ],
  "paidTier": { "id": "gcp-standard-tier", "name": "Gemini Code Assist Standard" } }
```

→ **`free-tier` は `allowedTiers` に存在しない**。CLI 側も起動時に落ちる:

```
This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID env var.
See https://goo.gle/gemini-cli-auth-docs#workspace-gca
```

`GOOGLE_CLOUD_PROJECT=engineering-478708` を**付けた**とき:

```json
{ "currentTier": { "id": "standard-tier", "name": "Gemini Code Assist" },
  "cloudaicompanionProject": "engineering-478708", "gcpManaged": true,
  "paidTier": { "id": "gcp-standard-tier", "name": "Gemini Code Assist Standard" } }
```

TUI の表示も一致:

```
▝▜▄     Gemini CLI v0.58.0
  ▗▟▀    Signed in with Google /auth
 ▝▀      Plan: Gemini Code Assist Standard /upgrade
```

ログイン中のアカウントは **`yoshitaka.ota@nexlim.co.jp`（Google Workspace / hd=nexlim.co.jp）**。個人 Google アカウントの無料枠（free-tier）は Workspace アカウントでは提供されない。

### 5.2 意味するところ

- **「`GEMINI_API_KEY` による従量課金」ではない**（キーは未設定のまま・deny してもよい）。載っているのは **GCP プロジェクト `engineering-478708` に紐づく Gemini Code Assist Standard（シート課金型サブスク）**。
- ボス要件「サブスク枠で使い `GEMINI_API_KEY` 課金は避ける」は、**文字どおりには満たしている**（キー課金ではない）。ただし「free-tier（個人枠）」ではなく、**会社 GCP のシート契約枠**を消費する。
- 設計書 §2.5 の `envDenyList` から **`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` を除外しないと起動不能**。ここは設計の訂正が必要。
- TUI フッタに `quota 3% used` が出るので、**枠消費の可視化手段はある**（PR-F の usage 補完の材料になる）。

### 5.3 ボスに確認したいこと

1. 会社 GCP（`engineering-478708`）の Code Assist Standard 枠をエビに使わせてよいか。
2. 使わせない場合の選択肢: (a) 個人 Google アカウントで別途 `gemini login`（→ free-tier が使える。ただし**ボスの再ログイン作業が必要**・本 PoC では勝手にログアウトしない指示に従い未実施） (b) Gemini バックエンドを見送り Codex 先行に切り替え。
3. PoC 翌日（2026-09-05 以降）に GCP コンソールで当該プロジェクトの課金レコードを 1 度確認（B-3）。

### 5.4 `envDenyList` の訂正案（PR-B）

```
gemini backend の envDenyList（訂正後）:
  GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENAI_USE_VERTEXAI,
  GOOGLE_GENAI_USE_GCA, GOOGLE_APPLICATION_CREDENTIALS
  （GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_PROJECT_ID は Workspace アカウントでは必須のため deny しない）
```

上記 5 個を落とした状態で全 PoC を実施し、正常動作を確認済み。

---

## 6. モデルと read タスク（受け入れ基準 6）

| 項目 | 実測 |
|---|---|
| 既定モデル | `gemini-2.5-pro`（`DEFAULT_GEMINI_MODEL`） |
| **`gemini-flash-latest`（設計書の指定）** | **404 `NOT_FOUND`**（Code Assist 経路ではエイリアスが解決しない） |
| `gemini-2.5-flash` | **○ 動作**（本 PoC は全てこれ） |
| `gemini-2.0-flash` / `gemini-3-pro-preview` / `gemini-3-flash-preview` | 404 `NOT_FOUND` |
| read タスク（`@src/server/idleDetector.ts` を 3 行要約） | **約 7〜15 秒**・内容は正確（クラス差し替え／`notifyOutput` 書き換えの 2 経路を正しく指摘） |
| headless 1 往復（`-p "Reply with exactly: PONG"`） | 約 9〜13 秒（プロセス起動込み） |
| 体感 | Flash は往復 2〜4 秒で軽快。日本語出力も自然。**読解・要約役としては十分実用**。 |

→ **Q-4（Flash 既定）は妥当。ただしモデル id は `gemini-2.5-flash` を明示定数で持つこと**（alias 依存は 404 になる）。

---

## 7. 自動アップデート（PoC 中に発生した環境変化）

PoC 1 回目の PTY 起動中に、gemini CLI が**自前で npm 更新を実行**した:

```
│ Gemini CLI update available! 0.19.4 → 0.58.0                                 │
│ Installed with npm. Attempting to automatically update now...                │
ℹ Update successful! The new version will be used on your next run.
```

- 現在のグローバル `gemini` は **0.58.0**（`gemini --version` で確認）。設計書 §2.1 の「0.19.4」は失効。
- 更新中は **20〜25 秒ほど PTY へ何も出力されない**（無出力＝IdleDetector 的には idle）。この間に注入すると入力が宙に浮く。
- 対策: system settings に **`general.enableAutoUpdate: false` / `general.checkForUpdates: false`** を焼く（本 PoC の 2 回目以降は焼いて実施し、再発なし）。
- ロールバックは未実施（ボスのグローバル環境の書き換えになるため）。**0.58.0 のまま検証済み**なので、PR-C の「検証済みバージョン」は **0.58.0** とする。

---

## 8. PR-C 実装への推奨

**PTY 方式で実装して問題ない（`--experimental-acp` は保険として据え置き）。**

`GeminiBackend` に必要なもの:

| 項目 | 値 |
|---|---|
| command | `gemini` |
| args | `-m gemini-2.5-flash --approval-mode yolo --allowed-mcp-server-names ebi-control`（初回タスクは `-i "<task>"`） |
| `supportsInitialPrompt` | `true`（`-i` で成立を実測） |
| `envDenyList` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_GENAI_USE_GCA` / `GOOGLE_APPLICATION_CREDENTIALS`（**`GOOGLE_CLOUD_PROJECT` は落とさない**） |
| 追加 env | `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<生成した per-エビ settings>` |
| settings 生成内容 | §3 のとおり（`folderTrust.enabled=false` / `enableAutoUpdate=false` / `useAlternateBuffer=false` / `mcpServers.ebi-control` に `EBI_ID` 直焼き + `trust:true`） |
| `startupGates` | **`null` でよい**（settings でゲートを消すため）。保険として既存 `trust` 検知はそのまま残す |
| `idleThresholdMs` | **claude と同じ 900ms でよい**（backend 別調整不要） |
| `ENTER_DELAY_MS` | **500ms のままでよい**（200〜1000ms すべて 100%） |
| `reportsUsage` | `false`（ただしフッタに `quota N% used` があるので PR-F で拾える） |
| cwd | **エビの worktree ルート**（サブディレクトリ不可・workspace 外読み取りゲート回避） |
| kill | **プロセスグループ kill 必須**（子 node の再 exec があるため） |
| 起動前チェック | `gemini --version`（0.58.0 系を期待）＋ `~/.gemini/oauth_creds.json` の存在＋ **`GOOGLE_CLOUD_PROJECT` が「ある」こと**（無いと起動不能。設計書と逆向きのチェックになる） |

**先送り/未検証**:

- 個人アカウント（free-tier）での動作は未検証（ボスの再ログインが必要なため実施せず）。
- `--experimental-acp` は未検証（PTY で足りたため）。
- 連続 10 回の**実 ebi-team 経由**（spawn → 委譲 → reply）は PR-C の e2e で実施（本 PoC は素の PTY での 20/20）。

---

## 9. 後片付け

- PoC で起動した gemini / 子 node / stdio MCP は **PID 指定で全て停止**。`pgrep -f "npm-global.*gemini"` → **0 件**。残っている `control-server.js` 2 本は master（みなエビ）と本セッション自身のもので PoC 由来ではない（PPID で確認済み）。
- `~/.gemini/settings.json` **無変更**。ゲート応答で作られた `~/.gemini/trustedFolders.json` は削除して原状復帰（内容は PoC パス 1 件のみ・バックアップは scratchpad）。
- 稼働サーバ(8787) / `dist` / `ebi-team.config.json` / master-mcp は無変更。master への送信は指示どおり `[poc-gemini]` 始まりの 2 通のみ。
- 実験用 settings と生ログは scratchpad（`gemini-poc.settings.json` / `clean-run-500ms.log`）。検証スクリプトは `tmp/poc-gemini/poc-gemini-pty.mjs`（本コミットに含む。生ログ・レポート JSON は非コミット）。
