# ebi-team マルチバックエンド化 実行計画 r2（Claude / Codex / Gemini）

作成: 2026-09-04 engineer エビ（master 委譲・**設計のみ / 実装なし**）
対象リポジトリ: `~/workspace/GitHub/ebi-team`（稼働サーバ実体 = 実装 SoT）
前身: `~/workspace/GitHub/r2sake/minaebi/ops/ebiteam-multibackend-plan.md`（2026-08-03・PR0〜PR7）
ボス要件（2026-09-04）: 「GPT や Gemini を利用できるように ebi-team を対応したい」／**Gemini はサブスク枠（OAuth）で使い `GEMINI_API_KEY` 課金は避ける**

---

## 0. 結論（10行）

1. **`feat/backend-abstraction`(04e6def) は main(f5a18bf) へほぼ無痛で取り込める。** 実測でトライアルマージした結果、衝突は **3ファイル・各1ハンク・すべて import 行だけ**（`agent.ts` / `index.ts` / `registry.ts`）。両側を残す形で機械的に解決でき、`tsc -p tsconfig.server.json --noEmit` 通過・`node --test test/*.test.ts` が **151件中 150 pass / 1 skip / 0 fail**。→ **方針は「main を feat ブランチへ merge して解決 → main へ merge」（rebase 不要）**。
2. **先行すべきは Gemini**。ログイン済み（OAuth personal）で、**alt-screen が既定 OFF**（`ui.useAlternateBuffer` を true にしない限り Ink インライン描画＝xterm.js スクロールバックがそのまま効く）、**起動ゲート（信頼/テーマ/認証ダイアログ）が既定で出ない見込み**、**MCP stdio クライアント対応**と、ebi-team の前提に最も素直に噛み合う。
3. **Gemini の per-エビ MCP 注入口は `GEMINI_CLI_SYSTEM_SETTINGS_PATH`**（env で system スコープ設定ファイルを差し替え）。実装を読んだ限り **system スコープはマージ最終段＝最優先**なので、`~/.gemini/settings.json` を汚さずに `mcpServers` / `ui.useAlternateBuffer=false` / `security.auth.selectedType` をエビ単位で焼ける。これが Claude の `--mcp-config`、Codex の `CODEX_HOME` に対応する。
4. **コスト0の担保は「env のホワイトリスト化」が肝**。実測でシェルに **`GOOGLE_CLOUD_PROJECT` が設定済み**。Gemini CLI の `setupUser()` はこれを `cloudaicompanionProject/duetProject` として送るため、**放置すると無料枠（free-tier）でなく GCP 紐付きの Code Assist 経路に載りうる**。spawn env から `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_APPLICATION_CREDENTIALS` を**明示的に落とす**設計にする（新規 `envDenyList`）。
5. **Codex はログイン完了（`codex login status` = Logged in using ChatGPT）**。0.146.0 の `--help` 実測で旧プランの前提（`-c` TOML 上書き・`--no-alt-screen`・`-s/-a`・位置引数プロンプト・`CODEX_HOME`）は**すべて健在**。ただし **`-p` は `--profile`（`$CODEX_HOME/<name>.config.toml` レイヤ）であって prompt ではない**点だけ旧記述を訂正。`codex doctor` が事前チェックに使える。
6. **唯一の実質ブロッカーは PTY 駆動性（本文 write→遅延→`\r`）と idle 判定**。特に `IdleDetector` は「PTY 出力が止まったら idle」だけの判定なので、**TUI が経過時間カウンタ等で定期再描画する CLI では永久 busy → 配送が滞留する**。PoC の受け入れ基準に必ず入れる。
7. **通信路（reply_to_master）は 3 バックエンド共通で成立見込み**。ebi-control MCP は stdio + `EBI_ID` env + 127.0.0.1 HTTP だけに依存しており、Claude 固有機能を使っていない。**Claude 固有なのは受信側（`notifications/claude/channel` 注入）だけ**で、Codex/Gemini は既存の PTY 注入フォールバックへ自動的に落ちる（`hasControlBridge` の backend 委譲は PR1 で実装済み）。
8. **master(Fable) 自身は Claude 固定**。context-guard は master の statusLine 使用率のみを見るため、非 Claude エビが増えても誤検知しない（実測: `contextGuard.ts` は `targetId="master"` 以外の usage を無視）。ただし `isQuiescent()` は**全 dynamic エビの idle 状態**を見るので、6 の idle 判定失敗は「キリ良し通知が永久に来ない」という形で context-guard に波及する。
9. **UI/可観測性**: Codex/Gemini には Claude の statusLine 相当が無く、cost/context は欠測。バッジ（🟣claude / 🟢codex / 🔵gemini）と「—（未対応）」表示で**欠測を明示**する（黙って空欄にしない）。
10. **ロールバックは 3 段**: ①`EBI_BACKEND=claude` / `defaultBackend:"claude"` に戻す ②役割の `backend` を外す ③PR-C/D のみ revert（PR-A/B は挙動不変）。**master は常に claude なので、最悪でも統括系は落ちない。**

---

## 1. 現状差分と PR1（`feat/backend-abstraction`）の取り込み

### 1.1 実測した位置関係

| 項目 | 値 |
|---|---|
| 分岐元 | `f29418b`（fix/tui-inline-scrollback） |
| feat ブランチ | `04e6def` refactor(backends): バックエンド抽象化の足場（1コミット） |
| main | `f5a18bf`（分岐後 **18 コミット**先行。二重配送根治・master 起動 MCP 自動付与・配送ハードニング・context-guard） |
| feat の差分 | 9 files, +825 / -186（`src/server/backends/{types,claude,index}.ts` 新設・`test/backendArgs.test.ts` 256行） |
| main の差分 | 31 files, +3479 / -155（`contextGuard.ts` `deliveryTag.ts` `mailbox.ts` `registry.ts` 大幅増） |

### 1.2 トライアルマージの実測結果（**本作業で実施済み・稼働環境には未反映**）

一時 worktree（`/private/tmp` 配下・稼働ディレクトリ非依存）で `git merge main` を実行:

```
CONFLICT (content): src/server/agent.ts
CONFLICT (content): src/server/index.ts
CONFLICT (content): src/server/registry.ts
（src/shared/protocol.ts は auto-merge 成功）
```

**衝突は 3 ハンクのみ、すべて「import 行が隣接した」ことによる textual conflict**。意味的な衝突ではない。

| ファイル | 衝突内容 | 解決 |
|---|---|---|
| `src/server/agent.ts` | feat 側の `backends/index.ts` import ブロック vs main 側の `import { deliveryText } from "../shared/deliveryTag.ts"` | **両方残す** |
| `src/server/registry.ts` | feat 側 `import { resolveBackend }` vs main 側 `import { logDelivery }` | **両方残す** |
| `src/server/index.ts` | feat: `loadFixedEbi(CONFIG_PATH, { command, backend: BACKEND_ID })` vs main: `loadFixedEbi(...)` の戻りを `applyMasterMcpConfig()` で map | **合成**: `const raw = await loadFixedEbi(CONFIG_PATH, { command: COMMAND, backend: BACKEND_ID }); const specs = raw.map((s) => applyMasterMcpConfig(s, ROLE_MCP_CONFIG.master));` |

解決後の検証（同一 worktree・`node_modules` は稼働クローンへ symlink）:

- `npx tsc -p tsconfig.server.json --noEmit` → **エラーなし**
- `node --import tsx --test test/*.test.ts` → **tests 151 / pass 150 / fail 0 / skip 1**
- 意味的整合の目視確認: `registry.hasControlBridge()` が `resolveBackend(command)` 委譲のまま生存、`agent.ts` が `launch.backend` → `backend.startupGates` / `backend.buildEnv()` を参照する形のまま生存、`index.ts` の `BACKEND_ID = resolveBackendId({ env: process.env.EBI_BACKEND })` も生存。**main 側のゲート改修（`test/gate.test.ts` +56行）と feat 側のゲート移設（`backends/claude.ts` へ SoT 移動）が競合していない**ことを、gate 系テストが green であることで確認。

### 1.3 取り込み手順（推奨: **rebase ではなく merge**）

rebase は「18コミット分の配送ハードニング/context-guard の上に大規模リファクタ1本を載せ直す」形になり、衝突解決の妥当性を人が追いにくい。**衝突が import 3行に収まっている以上、merge の方が安全で監査しやすい。**

```bash
cd ~/workspace/GitHub/ebi-team
git worktree add .worktrees/backend-abstraction-merge feat/backend-abstraction   # 既存 worktree あり
cd .worktrees/backend-abstraction-merge
git merge main                      # 上表の 3 ハンクを解決
npm run typecheck
npm run test:unit                   # 151 / 150 pass / 1 skip を確認
# 実機回帰（サーバ再起動が要るものはボス作業）
node scripts/e2e-control-mcp.mjs
node scripts/e2e-send-message.mjs
node scripts/e2e-delivery-hardening.mjs
node scripts/e2e-spawn-delivery.mjs
node scripts/e2e-context-guard.mjs
git commit                          # "merge: main を backend 抽象化ブランチへ取り込み（衝突は import 3ハンクのみ）"
```

**回帰確認の要点**（PR1 は「外形挙動ゼロ差分」が受け入れ条件）:
1. `npm run test:unit` が **fail 0**（backendArgs.test.ts 含む）。
2. `scripts/e2e-*.mjs` のうち **配送系（send-message / delivery-hardening / spawn-delivery / reverse-notify）** が green。ここが PR1 の主戦場（`hasControlBridge` の委譲化が配送経路の分岐に効くため）。
3. **実機**: サーバ再起動後、master の受信経路（channel 注入）が生きているか＝ボスが master へ 1 通投げて着弾するか。過去に「再起動2回目で復元」した前例があるため、1回で戻らなくても即ロールバックしない。
4. `ps -wwwE` で master ブリッジが二重購読していないこと（既知の ghost master 事故パターン）。

---

## 2. Gemini バックエンド（先行候補）

### 2.1 実測した環境

| 項目 | 値（2026-09-04 実測） |
|---|---|
| バイナリ | `/Users/yoimaro/.npm-global/bin/gemini`（`@google/gemini-cli` **0.19.4**） |
| 認証 | `~/.gemini/oauth_creds.json` あり・`~/.gemini/settings.json` に `security.auth.selectedType = "oauth-personal"` |
| API キー | `GEMINI_API_KEY` / `GOOGLE_API_KEY` **未設定**（＝現状は課金経路に載っていない） |
| ⚠ 注意 | シェル env に **`GOOGLE_CLOUD_PROJECT` が設定済み**（→ 2.5 のコスト論点） |
| ユーザ設定 | `ide.enabled`, `security.auth.selectedType`, `general.previewFeatures=false`, `sessionRetention.enabled` のみ。`ui.theme` 未設定・`ui.useAlternateBuffer` 未設定 |

### 2.2 TUI と PTY 注入（ebi-team の前提との噛み合い）

実装を読んで確認できた事実（`dist/src/gemini.js` / `ui/hooks/useAlternateBuffer.js` / `gemini-cli-core/utils/terminal.js`）:

- **alt-screen は既定 OFF**。`isAlternateBufferEnabled = settings.merged.ui?.useAlternateBuffer === true` の**厳密比較**で、既定は未設定＝false。`shouldEnterAlternateScreen(useAlternateBuffer, isScreenReader)` も `useAlternateBuffer && !isScreenReader`。
  → **Claude の `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` / Codex の `--no-alt-screen` に相当する操作が不要**。ペインのスクロールバックは素で確保できる。念のため system settings に `ui.useAlternateBuffer=false` を明示して固定する（ユーザ設定変更に対する防御）。
- **マウスイベントは alt-screen 有効時のみ有効化**（`mouseEventsEnabled = useAlternateBuffer`）。→ `CLAUDE_CODE_DISABLE_MOUSE` 相当も不要。
- **bracketed paste 対応あり**（`ui/utils/bracketedPaste.js` / `hooks/useBracketedPaste.js`）。Claude(Ink) と同系統なので、**`agent.ts` の「本文 write → `ENTER_DELAY_MS` 待ち → `\r` を別 write」がそのまま効く見込みが高い**。ただし遅延値は要チューニング（PoC で 200/500/1000ms を振る）。
- **起動ゲートは既定で出ない見込み**: テーマ選択ダイアログは `useState(!!initialThemeError)` ＝**テーマ解決に失敗したときだけ**開く。フォルダ信頼（folderTrust）も既定無効。認証は `selectedType` 済み。→ `startupGates: null` を第一候補とし、PoC の生バイト列で最終確認する。

### 2.3 MCP 配線（reply_to_master / ebi-control をどう持たせるか）

Gemini CLI は `settings.json` の `mcpServers`（stdio: `command` / `args` / `cwd` / `env` / `timeout` / `trust` / `includeTools` / `excludeTools`）で MCP サーバを持つ。設定スコープは 4 層で、**マージ順は `systemDefaults → user → workspace → system`（最後の system が最優先で上書き）**（`dist/src/config/settings.js` `mergeSettings()` のコメントと実装で確認）。

**system スコープのパスは `GEMINI_CLI_SYSTEM_SETTINGS_PATH` env で差し替え可能**（`settings.js:107`）。これを使うと:

```
# エビ spawn 時に ebi-team が生成
<repo>/.ebi-team/gemini/<agentId>.settings.json
```

```jsonc
{
  "ui": { "useAlternateBuffer": false },
  "security": { "auth": { "selectedType": "oauth-personal" } },
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

- `trust: true` で **ツール呼び出しの確認プロンプトを省く**（無人運用の必須条件）。保険で `--allowed-mcp-server-names ebi-control` を CLI 側にも付ける。
- `EBI_ID` を env に**直接焼く**ので、親 env の継承挙動に依存しない（Codex 設計と同じ流儀）。
- `EBI_NOTIFY_SUBSCRIBE=off`: Gemini は `notifications/claude/channel` を持たないので、購読ループを回さない（既存の純関数 `isNotifySubscribeEnabled` がそのまま使える）。
- **`gemini mcp add` は使わない**。あれは `~/.gemini/settings.json`（user）か `<cwd>/.gemini/settings.json`（project）を**書き換える**ため、ボスの環境やエビの worktree を汚す。ebi-team が JSON を生成して env で渡す方式に統一する。
- 代替（system settings が使えなかった場合のフォールバック）: エビの worktree に `.gemini/settings.json` を生成し、`.git/info/exclude` に足す（**worktree を汚すので第二候補**）。

### 2.4 非対話・初回タスク・ヘッドレス

`gemini --help` 実測:

| 用途 | 手段 |
|---|---|
| 初回タスクを起動時に渡す（注入タイミング問題の構造的回避） | **`-i, --prompt-interactive "<task>"`**（プロンプトを実行してから対話継続）＝ Codex の位置引数プロンプトに相当。→ `supportsInitialPrompt: true` |
| ワンショット（要約役・下調べ） | 位置引数 `gemini "<prompt>"`（既定 one-shot）／`-o json` `-o stream-json` |
| 承認モード | `--approval-mode default \| auto_edit \| yolo`、`-y/--yolo`、`--allowed-tools`、`--allowed-mcp-server-names` |
| モデル | `-m/--model`（env `GEMINI_MODEL` / alias env `GEMINI_MODEL_ALIAS_PRO` `..._FLASH` `..._FLASH_LITE`） |
| 作業ディレクトリ拡張 | `--include-directories` |
| 別駆動方式（PTY 代替） | **`--experimental-acp`**（ACP = stdio JSON-RPC でエージェントを外部駆動）。Codex の `app-server` に相当する保険 |
| セッション再開 | `-r/--resume latest`、`--list-sessions` |

### 2.5 コスト（サブスク枠を外さないための設計）— **最重要**

`gemini-cli-core/code_assist/setup.js` 実測:

```js
const projectId = process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GOOGLE_CLOUD_PROJECT_ID'] || undefined;
... loadCodeAssist({ cloudaicompanionProject: projectId, metadata: { duetProject: projectId } })
// tier が FREE のときだけ cloudaicompanionProject を undefined にして onboard する
```

つまり **`GOOGLE_CLOUD_PROJECT` が env にあると、その GCP プロジェクト紐付きの Code Assist（standard/licensed）経路に載る可能性がある**。ボス環境では**実際に設定されている**ため、そのまま spawn すると意図せず課金対象になりうる。

**設計上の対策（`EbiBackend.envDenyList` を新設）**:

```
gemini backend の envDenyList:
  GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_PROJECT_ID, GOOGLE_CLOUD_LOCATION,
  GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA,
  GOOGLE_APPLICATION_CREDENTIALS
```

`agent.ts` の PTY env 構築時に **deny list のキーを削除**してから spawn する（現状は親 env をそのまま継承）。これを入れないと「無料枠のつもりが課金」という**静かな事故**になる。

**コスト0の確認方法（PoC のチェック項目）**:
1. `env -u GOOGLE_CLOUD_PROJECT gemini` で起動し、`/about`（または `-d/--debug` のログ）で **`userTier` が `free-tier`** であること、`cloudaicompanionProject` が Google 管理プロジェクトであることを確認。
2. `/stats` でセッションのトークン消費を確認（課金の有無ではなくレート枠の消費把握用）。
3. Google Cloud コンソール側で当該プロジェクトに Gemini for Google Cloud の課金レコードが立たないことを、PoC 翌日に一度だけ確認。
4. **モデル選択**: 無料枠は Pro の 1 日あたり上限が小さい。**既定は Flash 系**（`-m` で明示、alias env に依存しない）、重い設計・読解タスクのみ Pro を明示指定する運用にする。

### 2.6 使いどころ（役割割り当ての指針）

| 用途 | 適性 | 理由 |
|---|---|---|
| 大量スクショ・画像の読解、動画理解 | ◎ | マルチモーダルが強く、無料枠で回せる |
| 下調べ・一次情報の要約・ドキュメント読解 | ◎ | Flash で速く安い（枠内） |
| ログ/長大テキストの一次スクリーニング | ○ | 長コンテキスト |
| 実装・リファクタ・破壊的操作を伴う作業 | △ | 承認モデルとサンドボックスが Claude/Codex と別系統。当面は read 寄りの役割に限定 |
| master（統括） | ✗ | **Claude 固定**（context-guard / channel 注入が Claude 前提） |

### 2.7 PoC 手順（**ボス GO 後に実行**・所要 30〜45分）

`scripts/poc-gemini-pty.mjs`（node-pty で直 spawn する使い捨てスクリプト）を書いて検証する。**稼働サーバ(8787)には触らず、別ポートで一時サーバを立てるか、reply の到達だけ稼働サーバの `/control/reverse-inject` で確認する。**

```bash
# 0) 前提確認（読み取りのみ）
gemini --version                      # 0.19.4
cat ~/.gemini/settings.json           # oauth-personal であること

# 1) 課金経路に載っていないことの確認（対話・手動）
env -u GOOGLE_CLOUD_PROJECT -u GOOGLE_CLOUD_PROJECT_ID gemini -d
#   → /about で userTier=free-tier / auth=oauth-personal を目視、Ctrl+C で抜ける

# 2) per-エビ system settings で MCP を持たせる
mkdir -p /tmp/ebi-poc && cat > /tmp/ebi-poc/gemini.settings.json <<'JSON'
{ "ui": {"useAlternateBuffer": false},
  "security": {"auth": {"selectedType": "oauth-personal"}},
  "mcpServers": { "ebi-control": {
      "command": "node",
      "args": ["<repo>/dist/server/mcp/control-server.js"],
      "cwd": "<repo>",
      "env": {"EBI_CONTROL_URL":"http://127.0.0.1:8787","EBI_MCP_ROLE":"engineer","EBI_ID":"poc-gemini","EBI_NOTIFY_SUBSCRIBE":"off"},
      "trust": true } } }
JSON

env -u GOOGLE_CLOUD_PROJECT -u GEMINI_API_KEY \
    GEMINI_CLI_SYSTEM_SETTINGS_PATH=/tmp/ebi-poc/gemini.settings.json \
    gemini --approval-mode yolo --allowed-mcp-server-names ebi-control -m gemini-flash-latest
#   → /mcp で ebi-control と reply_to_master が見えるか
#   → 「reply_to_master で『PoC 疎通』と送って」で 稼働 master に着弾するか

# 3) PTY 駆動性（node-pty 直 spawn・ここが本番の可否を決める）
node scripts/poc-gemini-pty.mjs
#   検証項目:
#   a. alt-screen へ入らない（\e[?1049h が出ない）＝インライン描画
#   b. 「本文 write → N ms → \r」で送信される（N=200/500/1000 を振って成功率を測る）
#   c. 起動〜プロンプト待ちの間にダイアログが出ないか（生バイト列を保存して確認）
#   d. **アイドル時に PTY 出力が完全に止まるか**（= IdleDetector が idle に落ちるか）
#      → 経過時間カウンタ等で定期再描画されると永久 busy になり配送が滞留する
#   e. -i "<task>" で起動直後にタスクを実行し、その後対話が継続するか
```

**受け入れ基準**: (2) の reply 到達 ＋ (3)-b の注入成功率 10/10 ＋ (3)-d の idle 復帰。
- (3)-d が NG → backend ごとの `idleThresholdMs` 引き上げ、または「直前フレームと同一/カーソル移動のみの出力は busy 化しない」フィルタを `IdleDetector` に足す（バックエンド非依存の改善なので Claude にも無害）。
- (3)-b が NG → `--experimental-acp`（ACP）方式へ設計切替（6章）。

---

## 3. Codex バックエンド（0.146.0 で再検証）

### 3.1 前提の更新

| 項目 | 旧プラン(2026-08-03) | 今回の実測(2026-09-04) |
|---|---|---|
| インストール | 未インストール | `codex-cli 0.146.0` 導入済み |
| ログイン | 未 | **`codex login status` = Logged in using ChatGPT**（`~/.codex/auth.json` あり） |
| config | — | `~/.codex/config.toml` は**存在しない**（＝全部デフォルト。`-c` 上書きが素直に効く） |

### 3.2 `codex --help` 実測で確認できた CLI 契約（0.146.0）

| 用途 | フラグ | 旧プランからの差分 |
|---|---|---|
| TOML 上書き | `-c, --config <key=value>`（ドット記法・値は TOML パース） | 変更なし（**MCP 注入の本命**） |
| インライン描画 | `--no-alt-screen`（"Runs the TUI in inline mode, preserving terminal scrollback history"） | 変更なし |
| サンドボックス | `-s, --sandbox read-only\|workspace-write\|danger-full-access` | 変更なし |
| 承認 | `-a, --ask-for-approval untrusted\|on-request\|never` | 変更なし |
| 全部バイパス | `--dangerously-bypass-approvals-and-sandbox` | 変更なし |
| モデル | `-m, --model` | 変更なし |
| 初回プロンプト | 位置引数 `[PROMPT]` | 変更なし（`supportsInitialPrompt: true`） |
| 作業ディレクトリ | `-C, --cd <DIR>` / `--add-dir` | — |
| **プロファイル** | **`-p, --profile <NAME>`＝`$CODEX_HOME/<name>.config.toml` を base config に重ねる** | **⚠ 旧プランの `-p` = prompt という読みは誤り。訂正。**（`CODEX_HOME` 方式の粒度が上がった＝per-エビ profile が使える） |
| 設定厳格化 | `--strict-config`（未知キーでエラー） | 新規に活用価値あり（バージョン差分の早期検知＝旧 C9 対策） |
| 事前診断 | `codex doctor`（auth/config/runtime の健全性） | **新規。spawn 前チェックに使える**（旧 C4 の `codex login status` より情報量が多い） |
| 非対話 | `codex exec`（`--json`）、`codex review` | 変更なし |
| 外部駆動 | `codex app-server` / `codex mcp-server` / `remote-control` | 変更なし（PTY 駄目時の保険） |

**`--full-auto` は 0.146.0 にも存在しない。** `-s ... -a never` で書く（旧プラン通り）。

### 3.3 起動コマンド（第一実装＝`-c` インライン方式）

```
codex --no-alt-screen \
  -m gpt-5.5 \
  -s danger-full-access -a never \
  -c disable_paste_burst=true \
  -c 'mcp_servers.ebi-control.command="node"' \
  -c 'mcp_servers.ebi-control.args=["<repo>/dist/server/mcp/control-server.js"]' \
  -c 'mcp_servers.ebi-control.cwd="<repo>"' \
  -c 'mcp_servers.ebi-control.env={EBI_CONTROL_URL="http://127.0.0.1:8787",EBI_MCP_ROLE="engineer",EBI_ID="<agentId>",EBI_NOTIFY_SUBSCRIBE="off"}' \
  "<役割プロンプト>\n\n<初回タスク>"
```

- 役割プロンプトは **`-c developer_instructions=...` に載せず、初回プロンプトへ前置き**する（長文・日本語・改行のクォート地獄を避ける。旧 C7）。
- フォールバック: **`CODEX_HOME=<repo>/.ebi-team/codex-home/<agentId>` ＋ `config.toml` 生成**、または **`-p <agentId>` プロファイル**（`$CODEX_HOME/<agentId>.config.toml`）。設定は `EBI_CODEX_CONFIG_MODE=inline|home|profile`。

### 3.4 PoC 手順（ボス GO 後・所要 30分）

```bash
codex --version && codex doctor            # 0.146.0 / auth OK を確認
# 1) MCP 疎通（対話・手動）
codex --no-alt-screen -c disable_paste_burst=true \
  -c 'mcp_servers.ebi-control.command="node"' \
  -c 'mcp_servers.ebi-control.args=["<repo>/dist/server/mcp/control-server.js"]' \
  -c 'mcp_servers.ebi-control.cwd="<repo>"' \
  -c 'mcp_servers.ebi-control.env={EBI_CONTROL_URL="http://127.0.0.1:8787",EBI_MCP_ROLE="engineer",EBI_ID="poc-codex",EBI_NOTIFY_SUBSCRIBE="off"}' \
  "reply_to_master で『Codex PoC 疎通』と送って"
#   → 稼働 master に着弾するか（＝実装 GO 判定の本丸）
# 2) PTY 駆動性（Gemini と同じ 4 項目 a〜e）
node scripts/poc-codex-pty.mjs
# 3) 起動ゲート（フォルダ信頼プロンプト）の有無と文言を生バイト列で採取
```

**受け入れ**: 1 の reply 到達 ＋ 2-b の注入 10/10 ＋ 2-d の idle 復帰。NG なら `codex app-server`（stdio JSON-RPC）方式へ設計変更。

---

## 4. 共通設計

### 4.1 抽象インターフェースの拡張（PR1 の `EbiBackend` へ追加）

PR1 で入った `EbiBackend`（`src/server/backends/types.ts`）はそのまま活かし、**4 点だけ足す**:

```ts
export type BackendId = "claude" | "codex" | "gemini";   // ← gemini 追加

export interface EbiBackend {
  // ...既存...
  /** PTY env から削除するキー（課金経路・別認証への誤接続を防ぐ）。 */
  readonly envDenyList: readonly string[];
  /** statusLine 相当で usage(cost/context) を報告できるか。false なら UI は「—」表示。 */
  readonly reportsUsage: boolean;
  /** idle 判定のしきい値上書き(ms)。null なら サーバ既定。 */
  readonly idleThresholdMs: number | null;
  /** 初回タスクを起動時に渡す方法。 */
  initialPromptArgs(prompt: string): string[];   // claude: [] / codex: [prompt] / gemini: ["-i", prompt]
}
```

さらに **「制御 MCP の起動情報」をバックエンド中立な 1 オブジェクトに集約**し、3 方言へ射影する:

```ts
export interface ControlMcpSpec {         // 中立表現（SoT）
  command: string; args: string[]; cwd: string; env: Record<string, string>;
}
// claude  → {"mcpServers": {...}} JSON を書き出し `--mcp-config <path>`
// codex   → `-c mcp_servers.ebi-control.*`（または CODEX_HOME/config.toml）
// gemini  → {"mcpServers": {...}} JSON を書き出し env GEMINI_CLI_SYSTEM_SETTINGS_PATH=<path>
```

`scripts/gen-master-mcp.mjs` も**この中立表現から生成する形にリファクタ**する（Claude 用 JSON と他方言の二重管理を作らない）。※master は Claude 固定なので当面 claude 射影のみを使うが、生成元は 1 つにしておく。

### 4.2 spawn API（`backend` 引数の追加）

**解決優先度**（PR1 の `resolveBackendId()` がすでにこの順で実装済み）:
`spawn 引数 backend` > `役割(EbiRole).backend` > `config.defaultBackend` > `env EBI_BACKEND` > `"claude"`

配線（機械的にフィールドを通すだけ）:
`spawn_ebi / spawn_engineer / send_message`（`src/mcp/control-server.ts` の zod: `model` の隣に `backend`）→ `/control/spawn`（HTTP）→ `GeneralizedSpawnParams`（`control.ts:21`）→ `spawnAgent()`（`index.ts`）→ `LaunchParams`（`agent.ts:261` に `backend?: BackendId` あり）→ `AgentRecord.backend`（`protocol.ts`・PR1 で追加済み）→ UI。

zod の説明文（日本語）例:
```
backend: z.enum(["claude","codex","gemini"]).optional()
  .describe("バックエンド（未指定は役割の既定 → config → env → claude）")
model:   既存のまま（backend ごとに意味が変わるので、未指定時は backend の既定モデルを使う）
```

**モデル引数の扱い**: `model` は文字列のまま（バックエンド横断で列挙しない）。ただし **`backend` と `model` の食い違い（例: backend=gemini に `claude-opus-5`）は spawn 時に検証して明確なエラーで弾く**（黙って起動して crashloop させない）。各 backend に `isKnownModel(model): boolean`（プレフィクス判定程度の緩い検証）を持たせる。

### 4.3 役割ごとの既定バックエンド

```jsonc
// ebi-team.config.json（top-level）
{
  "defaultBackend": "claude",
  "backends": {
    "claude": { "command": "claude" },
    "codex":  { "command": "codex",  "defaultModel": "gpt-5.5",             "configMode": "inline" },
    "gemini": { "command": "gemini", "defaultModel": "gemini-flash-latest" }
  },
  "roles": {
    "engineer":   { "backend": "claude", "defaultModel": "claude-opus-5" },
    "researcher": { "backend": "gemini", "defaultModel": "gemini-flash-latest",
                    "permissionMode": "plan", "appendSystemPrompt": "..." },
    "engineer-codex": { "backend": "codex", "defaultModel": "gpt-5.5" }
  }
}
```

- **`EbiRole` に `backend?: BackendId` を足す**（`registerCustomRoles()` の検証に「実装済み backend id か」を追加）。
- 既定の割り当て指針: **engineer=claude（現状維持） / 下調べ・読解役=gemini / 実装セカンドオピニオン=codex**。
- **master は `fixedEbi` 側で `backend: "claude"` を明示**し、config で他バックエンドに変えられても**サーバ側で master だけは claude に固定**する（fail-safe。`fixedEbi.ts` に強制ロジックを1行）。

### 4.4 permissionMode の写像（抽象語彙は現行維持）

| 抽象値 | claude | codex | gemini |
|---|---|---|---|
| `bypassPermissions` | `--permission-mode bypassPermissions` | `-s danger-full-access -a never` | `--approval-mode yolo` |
| `acceptEdits` | 同名 | `-s workspace-write -a never` | `--approval-mode auto_edit` |
| `plan` / `default` | 同名 | `-s read-only -a on-request` | `--approval-mode default`（+ `plan` は read 寄り運用をプロンプトで担保） |
| `auto` / `dontAsk` | 同名 | `-s workspace-write -a never` | `--approval-mode yolo` |

**`plan` の厳密な等価物は codex/gemini に無い（近似）** ことを README に明記する。

### 4.5 UI・可観測性

- **REGISTRY 行 / PANE ヘッダに backend バッジ**: 🟣 claude / 🟢 codex / 🔵 gemini。**model 列は既存のまま**（backend が違えば model 文字列で判別できる）。
- **spawn フォームに backend セレクト**（既定 `defaultBackend`）。
- **cost/context 欠測**: `reportsUsage=false` の backend は **「—（statusLine 非対応）」を明示表示**。空欄にすると「壊れている」と誤読される。
- **context-guard は master(claude) 専用のまま**（`targetId="master"`）。非 claude エビの usage 欠測で誤発火しないことは実測確認済み（`contextGuard.ts:160` が `usage.id !== targetId` を無視）。
  ただし **`isQuiescent()` は全 dynamic エビの idle を見る**ため、非 claude エビの idle 判定が壊れると「キリ良し通知が来ない」形で影響が出る（→ PoC の (3)-d が受け入れ基準に入っている理由）。
- **supervisor（要約役）は claude 固定**を維持（`claude --print --model haiku`）。将来 `codex exec --json` / `gemini -o json` に差し替え可能（PR-F）。

### 4.6 配送（master→エビ）

```
deliver(agent, body):
  backend.supportsChannelInject && notifyMode && 購読中  → notification 経路（claude のみ）
  それ以外                                               → PTY 注入（既存フォールバック・msgId タグ照合つき）
```
PR1 で `registry.hasControlBridge()` は backend 委譲済み。**codex / gemini は自動的に PTY 経路**に落ち、無駄な ACK 待ちも起きない。初回タスクは `initialPromptArgs()` で起動時に渡し、spawn 直後の本文消失（2026-07-25 に根治した既知トラップ）を構造的に回避する。

### 4.7 ロールバック

| 段 | 操作 | 効果 |
|---|---|---|
| 1 | `EBI_BACKEND=claude`（env）／`defaultBackend: "claude"` | 明示指定なき全エビが claude に戻る |
| 2 | 役割定義から `backend` を外す | 役割単位で戻る |
| 3 | PR-C / PR-D のみ revert | PR-A/PR-B は挙動不変なので残してよい |
| 常時 | master は claude 固定 | 統括系は何があっても落ちない |

---

## 5. 実行計画（PR 分割・工数・ボス作業・裁定項目）

### 5.1 PR 分割

| PR | 内容 | 受け入れ基準 | 工数 | 依存 |
|---|---|---|---|---|
| **PR0-G** | **Gemini PoC**（2.7・コード変更は使い捨てスクリプトのみ） | reply 到達／注入 10/10／idle 復帰／課金経路でないこと（free-tier）の確認 | 0.5日 | ボス GO |
| **PR0-C** | **Codex PoC**（3.4） | 同上（課金確認は不要・ChatGPT サブスク枠） | 0.5日 | ボス GO |
| **PR-A** | **PR1 取り込み**（`feat/backend-abstraction` ← main を merge → main へ） | typecheck / unit 151（fail 0）／配送系 e2e green／実機で master 受信復活 | **0.5日**（衝突解決は検証済み） | なし（**PoC と並行可**） |
| **PR-B** | **抽象化の拡張（挙動不変）**: `BackendId` に gemini 追加・`envDenyList` / `reportsUsage` / `idleThresholdMs` / `initialPromptArgs` 追加・`ControlMcpSpec` 中立表現と 3 方言射影・`gen-master-mcp.mjs` を中立表現から生成 | 既存 unit + 新規純関数テスト green。**claude 起動の外形ゼロ差分**（`backendArgs.test.ts` を拡張して担保） | 0.5〜1日 | PR-A |
| **PR-C** | **Gemini バックエンド実装（opt-in）**: `GeminiBackend` / spawn 経路に `backend` 配線 / system settings 生成 / env deny / 起動前チェック（`gemini --version` と OAuth 資格の存在） | 新規 live e2e `scripts/e2e-gemini-engineer.mjs`：spawn → タスク委譲 → `reply_to_master` 着弾が**連続10回 100%**。claude 側 e2e 回帰なし | 1〜1.5日 | PR-B / PR0-G |
| **PR-D** | **Codex バックエンド実装（opt-in）**: `CodexBackend`（inline / home / profile の 3 モード）・`codex doctor` 事前チェック | `scripts/e2e-codex-engineer.mjs` 連続10回 100%／claude 回帰なし | 1〜1.5日 | PR-B / PR0-C |
| **PR-E** | **役割既定 + UI + docs**: `EbiRole.backend` / `config.backends` / バッジ / spawn セレクト / usage 欠測表示 / README に写像表 | 役割 spawn で既定 backend が効く。UI に backend が出る。cost 欠測が「—」と明示される | 0.5〜1日 | PR-C or PR-D |
| **PR-F**（任意） | supervisor の非 claude 化・usage 補完（`codex exec --json` / `gemini -o json`）・Discord/Slack ブリッジ（旧プラン §9 PR5〜7 を据え置き） | — | 別途 | PR-E |

**合計（PR0〜PR-E）: 約 3.5〜5 日**。

### 5.2 ボス作業（人手が要るもの）

| # | 作業 | タイミング |
|---|---|---|
| B-1 | PoC の GO 判断（`gemini` / `codex` を実際に起動する許可） | PR0 の直前 |
| B-2 | ~~`codex login`~~ **完了済み**（2026-09-04・`Logged in using ChatGPT`） | — |
| B-3 | Gemini の課金経路確認（`/about` の userTier 目視・GCP コンソールの課金レコード確認） | PR0-G 中／翌日 |
| B-4 | **サーバ再起動**（各 PR の反映ごと。`npm run build` → `node scripts/gen-master-mcp.mjs` → 再起動） | PR-A/C/D/E の反映時 |
| B-5 | 再起動後の master 受信経路（channel）の確認と、`ps -wwwE` での master ブリッジ二重購読チェック | 再起動のたび |

### 5.3 裁定項目（Q-1〜Q-8・各推奨つき）

| # | 論点 | 選択肢 | **推奨** |
|---|---|---|---|
| **Q-1** | PR1 の取り込み方 | (a) main を feat へ merge → main へ merge / (b) feat を main に rebase | **(a) merge**。衝突が import 3ハンクのみと実測済みで、履歴も追いやすい |
| **Q-2** | 先行バックエンド | (a) Gemini 先行 / (b) Codex 先行 / (c) 同時 | **(a) Gemini 先行**。alt-screen 既定 OFF・起動ゲート無しで検証項目が少なく、無料枠なので試行回数を稼げる |
| **Q-3** | Gemini の MCP 注入方式 | (a) `GEMINI_CLI_SYSTEM_SETTINGS_PATH` / (b) worktree の `.gemini/settings.json` / (c) `gemini mcp add` | **(a)**。ボスの `~/.gemini` もエビの worktree も汚さない。(c) は共有ファイルを書き換えるので**採らない** |
| **Q-4** | Gemini の既定モデル | (a) Flash 系 / (b) Pro 系 | **(a) Flash 既定＋重い読解のみ Pro を明示**。無料枠の Pro 上限は小さい |
| **Q-5** | env deny list を入れるか（`GOOGLE_CLOUD_PROJECT` 等を落とす） | (a) 落とす / (b) 継承したまま | **(a) 落とす**。ボス要件「課金は避ける」の唯一の機械的担保。**(b) は静かな課金事故の温床** |
| **Q-6** | Codex の config 注入方式 | (a) `-c` インライン / (b) `CODEX_HOME` / (c) `-p` プロファイル | **(a) を第一・(b) をフォールバック**（設定 `EBI_CODEX_CONFIG_MODE`）。(c) は 0.146 の新機能なので PR-D の中で評価 |
| **Q-7** | 非 claude エビの permissionMode 既定 | (a) 役割どおり bypass 相当 / (b) 当面 read 寄り（plan/default） | **(b) 当面 read 寄り**。まず「下調べ・読解」で信頼を積み、実装役は Claude を維持。ボスが望めば (a) へ 1 行で切替可能 |
| **Q-8** | 非 claude エビの usage 表示 | (a) 「—（未対応）」明示 / (b) 空欄 / (c) 別手段で推定 | **(a)**。(c)（`--json` からの推定）は PR-F 送り |

---

## 6. リスクと代替

| # | リスク | 深刻度 | 対策 / 代替 |
|---|---|---|---|
| **R1** | **PTY 注入が通らない**（bracketed paste / Enter が送信にならない） | 高（ブロッカー候補） | ①`ENTER_DELAY_MS` を backend 別に持つ ②codex は `disable_paste_burst=true` ③それでも駄目なら **外部駆動方式へ切替**: codex=`codex app-server`（stdio JSON-RPC）、gemini=`--experimental-acp`（ACP）。どちらも PTY を使わず、ebi-team 側は「PTY セッション」ではなく「JSON-RPC セッション」を持つ実装になる（別 PR・+2日規模） |
| **R2** | **idle 判定が効かず永久 busy**（TUI が定期再描画する） | 高 | ①backend 別 `idleThresholdMs` ②「直前フレームと同一 / カーソル制御のみ」の出力を busy 化しないフィルタを `IdleDetector` に追加（claude にも無害）③最終手段: 注入前に「busy でも一定時間経過していれば投げる」タイムアウト経路 |
| **R3** | **MCP が持てず reply 経路が無い** | 低（3 CLI とも stdio MCP 対応を確認済み） | 代替: **ファイル受け渡し**（エビが `<worktree>/.ebi-report.md` を書き、ebi-team が watch して master へ転送）。または `gemini -o stream-json` / `codex exec --json` の**ヘッドレス実行＋標準出力パース**（対話セッションを諦め、タスク単位の使い捨て実行にする） |
| **R4** | **意図せぬ課金**（Gemini が GCP プロジェクト経路に載る／`GEMINI_API_KEY` が後から設定される） | 中 | `envDenyList`（Q-5）＋ 起動前チェックで「deny 対象 env が残っていたら spawn 拒否」＋ PoC 翌日の課金レコード確認 |
| **R5** | **起動ゲート未知**（Gemini/Codex が初回に何か聞いてくる） | 中 | PoC で**生バイト列を採取**し、必要なら `startupGates` に定義追加（PR1 の `StartupGateSpec` がそのまま使える）。gemini は既定で出ない見込み（テーマは `initialThemeError` 時のみ・folderTrust 既定 off） |
| **R6** | **CLI のバージョン差でフラグが動く**（旧プランの `--full-auto` 消失、今回の `-p` 意味変化が実例） | 中 | ①`--version` を起動時に記録し、想定外なら警告 ②codex は `--strict-config` で未知キーを早期検知 ③backend 実装に「検証済みバージョン」を定数で持つ |
| **R7** | **セキュリティ節（CLAUDE.md）が非 claude エビに効かない** | 中 | 役割プロンプトを `appendSystemPrompt` 相当で**必ず**注入（gemini=`GEMINI.md` / system settings、codex=初回プロンプト前置き）。Discord/Slack 秘書（minaebi）の Codex 化を伴う場合は**旧プラン §9.5 S5 の「起動時ポリシー自己検査で fail-closed」を必須**とする |
| **R8** | 稼働サーバへの反映事故（dist / master-mcp / 8787） | 中 | 反映は必ず「build → gen-master-mcp → ボスが再起動」の順。**エビは稼働 dist / config / master-mcp を触らない**（本作業でも厳守した） |

---

## 付録 A: 本設計で実測したコマンド（読み取り系のみ・稼働環境は無変更）

```
git merge --no-commit --no-ff main            # 一時 worktree（/private/tmp 配下）でのトライアル
npx tsc -p tsconfig.server.json --noEmit      # → エラーなし
node --import tsx --test test/*.test.ts       # → 151 / pass 150 / fail 0 / skip 1
gemini --version / gemini --help / gemini mcp add --help
codex --version / codex --help / codex login status
cat ~/.gemini/settings.json / ls ~/.codex
（@google/gemini-cli 0.19.4 の dist を読解: settings.js / gemini.js / useAlternateBuffer.js / code_assist/setup.js）
```
※ トライアル用の一時 worktree は検証後に削除済み（`git worktree remove`）。

## 付録 B: 旧プランからの訂正・追加

- **訂正**: Codex の `-p` は `--profile`（設定プロファイル）。prompt ではない。
- **訂正**: 「ローカル 7 コミット未 push・2クローン分岐」（旧 §1 / C10）は現状と異なる。main は origin/main を含む形で 18 コミット進んでおり、`feat/backend-abstraction` だけが未マージ。
- **追加**: Gemini バックエンド（旧プランでは「将来の 3 つ目」扱い）を**先行候補**に格上げ。
- **追加**: `envDenyList`（課金経路の遮断）・`reportsUsage`・`idleThresholdMs`・`initialPromptArgs`・`ControlMcpSpec`（中立表現）。
- **据え置き**: Discord/Slack ブリッジ（旧 §9 / PR5〜7）は本 r2 のスコープ外。着手は PR-E 完了後。
