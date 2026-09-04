# Codex CLI バックエンド（PR-D）

対象: `codex-cli 0.146.0`（検証済みバージョン。`src/server/backends/profiles.ts` の `CODEX_TRAITS.preflight.verifiedVersion` が SoT）
関連: `docs/multibackend-plan-r2.md` §3 / `docs/poc/codex-poc-2026-09-04.md`（PoC 実測）

---

## 1. 何ができるか / できないか

| 項目 | codex | 備考 |
|---|---|---|
| PTY 起動・注入（master→エビ） | ○ | `--no-alt-screen` でインライン描画。注入は本文 write → 500ms → `\r`（claude と同じ経路） |
| `reply_to_master`（エビ→master） | ○ | `-c mcp_servers.ebi-control.*` で制御MCP を起動引数に焼く |
| notification（channel）注入 | **×** | Claude harness 固有機能。配送は自動的に PTY 注入へ落ちる（`supportsChannelInject: false`） |
| usage（cost / context）表示 | **×** | statusLine 相当が無い。UI では「—（未対応）」表示（PR-E） |
| 役割プロンプト | ○（注入） | `--append-system-prompt` 相当が無いため、**ready 後の初回 PTY 注入**で渡す |
| idle 判定 | ○ | 待機中の出力は 0 バイト（PoC 実測）。しきい値は据置 900ms |

---

## 2. 起動形（実際に組み立てられるコマンドライン）

```
codex --no-alt-screen [-m <MODEL>] -s <sandbox> -a never \
  -c disable_paste_burst=true \
  -c check_for_update_on_startup=false \
  -c 'projects={"<repo>"={trust_level="trusted"},"<worktree>"={trust_level="trusted"}}' \
  -c 'mcp_servers.ebi-control.command="node"' \
  -c 'mcp_servers.ebi-control.args=["<repo>/dist/server/mcp/control-server.js"]' \
  -c 'mcp_servers.ebi-control.cwd="<repo>"' \
  -c 'mcp_servers.ebi-control.default_tools_approval_mode="approve"' \
  -c 'mcp_servers.ebi-control.env={EBI_CONTROL_URL="http://127.0.0.1:8787",EBI_MCP_ROLE="engineer",EBI_ID="<agentId>",EBI_NOTIFY_SUBSCRIBE="off"}' \
  -c 'mcp_servers.ebi-control.startup_timeout_sec=60' \
  -c features.apps=false
```

- cwd は **worktree ルート**（worktree 起動時）。位置引数のプロンプトは**使わない**（後述 §4）。
- 実装: `src/server/backends/codex.ts`（`buildArgs`）と `src/server/backends/mcpSpec.ts`（TOML 方言への射影）。

### 2.1 フラグの意味（なぜ必要か）

| フラグ | 無いとどうなるか |
|---|---|
| `--no-alt-screen` | 代替スクリーンに描画され、ブラウザ（xterm.js）のスクロールバックが機能しない |
| `-a never` | 承認待ちで無人セッションが固まる（`on-request` は使わない） |
| `-s <sandbox>` | 権限が既定のまま。permissionMode の写像は §3 |
| `-c disable_paste_burst=true` | 一括入力がペースト扱いされ、注入が送信にならないことがある |
| `-c check_for_update_on_startup=false` | 起動直後に「✨ Update available!」ダイアログで停止（無人 spawn が死ぬ） |
| `-c 'projects={...}'` | 「Do you trust the contents of this directory?」ゲートで停止。**ドット記法は黙って無視される**ので必ずインラインテーブル形式。worktree は git サブディレクトリ扱いなので **repo root と worktree の両方** |
| `-c mcp_servers.ebi-control.default_tools_approval_mode="approve"` | MCP ツール呼び出しのたびに承認ダイアログで停止。**`-a never` では抑止されない**（承認系統が別）。値域は `auto`/`prompt`/`writes`/`approve` で、**`auto` ではダイアログが出る** |
| `-c mcp_servers.ebi-control.startup_timeout_sec=60` | 制御MCP の起動待ちが短く、ツールが揃わないままセッションが始まる。env `EBI_CODEX_MCP_STARTUP_TIMEOUT_SEC` で調整可 |
| `-c features.apps=false` | 組込み MCP `codex_apps`（ChatGPT アプリ連携）が起動し、MCP 群の起動完了が十数秒遅れる。その間のターンは**ツール無し**で走り、`reply_to_master` が使えない。ebi-team では使わない機能なので止める（子プロセスも 1 本減る） |

**起動ゲートは「自動応答」ではなく「出させない」**方針（`startupGates: null`）。承認の自動クリックという危険な機構を増やさずに済む。

---

## 3. permissionMode の写像（既定は読み取り寄り）

抽象語彙（`ebi-team.config.json` / 役割定義の `permissionMode`）→ codex `-s` の写像:

| permissionMode | codex `-s` | 用途 |
|---|---|---|
| （未指定） | `read-only` | 既定。読解・下調べ |
| `default` | `read-only` | 同上 |
| `plan` | `read-only` | 同上 |
| `acceptEdits` | `workspace-write` | worktree 内の編集を許す |
| `auto` | `workspace-write` | 同上 |
| `dontAsk` | `workspace-write` | 同上 |
| `bypassPermissions` | `danger-full-access` | サンドボックス無効（claude の bypass 相当） |

`-a`（承認）は**常に `never`**。設計書 Q-7 の推奨（当面は読み取り寄り・実装役は claude を維持）に沿った既定。
実装・テスト: `codexSandboxFor()` / `test/codexBackend.test.ts`。

### 3.1 モデル指定

モデル名の語彙は backend ごとに別物。役割の `defaultModel`（`opus` / `sonnet` 等の claude 語彙）は
**claude にだけ**効く。codex では

1. spawn 引数の明示指定 > 2. env `EBI_CODEX_MODEL` > 3. 未指定（codex 既定 = `gpt-5.6-terra`）

の順で解決する。claude 語彙をそのまま渡すと ChatGPT アカウントでは毎ターン
`The 'sonnet' model is not supported when using Codex with a ChatGPT account.` で 400 になる（実測）。

---

## 4. 初回タスク・役割プロンプトの渡し方

- 位置引数のプロンプトは **使わない**。boot 中に渡すと
  `⚠ MCP startup interrupted. The following servers were not initialized: codex_apps, ebi-control`
  が出る（PoC §5）。
- 役割プロンプトは **ready 到達後に PTY へ 1 回だけ注入**する（`LaunchParams.initialInject` →
  `Agent.sendInitialInject()`）。これが CLAUDE.md 相当のセキュリティ節を非 claude エビへ届ける経路（R7 対策）。
- ready 判定は「バナー（`>_ OpenAI Codex (v…)`）の検知 ＋ boot 猶予 ＋ idle」（PR-C の
  `readyPattern` 機構に相乗り）。さらに **readyWarmupMs（既定 20 秒）** を boot 猶予に加算する。
  TUI は 2〜3 秒でプロンプトを出すが **MCP ツールの登録はその後**で、間に 1 通目を投げると
  エビはツール無しのターンを回す（「reply_to_master を利用できません」と答えて終わる＝静かな
  故障。e2e で 10/10 再現し、ready + 12 秒なら安定することを実測）。
- ready 到達前に予期せず終了した場合は **1 回だけ再 spawn**する（PR-C の `watchEarlyExit`・
  `retryOnEarlyExit: true`）。PoC §6 の「起動 3.2 秒後の exit 0」対策。
- 起動ゲート/更新ダイアログ/ログイン要求は `fatalPatterns` で検知し、notice とサーバログに
  原因を 1 行で残す（黙って ready 待ちタイムアウトさせない）。

---

## 5. 既知の罠

1. **サーバは本番同様 dist 起動で使うこと**（`npm run build` → `npm start`）。
   非 claude backend を dev サーバから spawn すると警告が出る。
   なお PR-D 時点ではこの罠を「エビが『reply_to_master ツールが利用できません』と答えて
   **静かに失敗する**」現象の原因と見ていたが、**2026-09-05 の再測定で否定された**:
   dist 起動 9/10・dev(tsx) 起動 4/5 と成績に差が出ず、失敗ラウンドでも制御MCP は起動している
   （§7.1）。dist 起動を勧める理由は「本番と同じ形で動かす・tsx 依存を挟まない」であって、
   この失敗の型を避けるためではない。
2. **`codex login status` の結果は stderr に出る**（0.146.0）。preflight は stdout+stderr を
   連結して判定している（`src/server/backendPreflight.ts` の `loginCheck`）。
3. **組込み MCP `codex_apps` は既定で 1 本立つ**（本実装では `features.apps=false` で止めている）。
   kill はプロセスグループごと行う（`CODEX_TRAITS.killProcessGroup = true` → PR-C の
   `killProcessGroupSignal` が pgid に SIGTERM→SIGKILL）。後始末の確認は `pgrep -x codex`（0 件が正）。
4. **`~/.codex/config.toml` は作らない**（すべて `-c` インライン）。ただし
   `~/.codex/{history.jsonl,logs_2.sqlite,…}` はセッション状態として書かれる（回避不可）。
5. **notification 注入は効かない**。master → codex エビの配送は必ず PTY 注入経路になる
   （`hasControlBridge` は `-c mcp_servers.ebi-control.*` の有無で判定）。
6. 固定エビ（master）の backend は **command から解決**する。`EBI_BACKEND=codex` にしても
   master（claude / bash）に codex の性質が乗らない（統括系を落とさないための設計）。

---

## 6. 使い方

```bash
# 単発（spawn 引数で指定・サーバ既定は claude のまま）
curl -s localhost:8787/control/spawn \
  -H 'content-type: application/json' \
  -d '{"role":"engineer","backend":"codex","cwd":"/path/to/repo","useWorktree":true}'

# サーバ既定を codex にする（動的エビ全部が codex になる）
EBI_BACKEND=codex npm start
```

役割ごとの既定として使う場合（PR-E）。`ebi-team.config.json`:

```jsonc
{
  "backends": { "codex": { "command": "codex", "defaultModel": "gpt-5.5" } },
  "roles": {
    "engineer-codex": {
      "label": "実装2nd",
      "backend": "codex",
      "defaultModel": "gpt-5.5",
      "appendSystemPrompt": "セカンドオピニオンの実装役。…"
    }
  }
}
```

`spawn_ebi(role="engineer-codex")` のように役割 id を指定するだけで codex 起動になります
（解決順は spawn 引数 > 役割 > `defaultBackend` > env > claude）。
**組込みの `engineer` 役割は claude 既定のまま**です（codex の e2e 成績が確定するまで実装役の既定は変えない）。
UI では 🟢 codex バッジが付き、cost / context は「—（未対応）」表示になります（`reportsUsage: false`）。

関連 env:

| env | 既定 | 意味 |
|---|---|---|
| `EBI_CODEX_COMMAND` | `codex` | 起動バイナリ（`EBI_COMMAND` は claude 用なので流用しない） |
| `EBI_CODEX_ARGS` | （空） | 追加引数（`EBI_ARGS` は claude 用） |
| `EBI_CODEX_MODEL` | （空） | codex の既定モデル |
| `EBI_CODEX_MCP_STARTUP_TIMEOUT_SEC` | `60` | 制御MCP の起動待ち上限 |
| `EBI_CODEX_READY_WARMUP_MS` | `20000` | ready 昇格の追加猶予（MCP ツール登録待ち） |
| `EBI_GROUP_KILL_GRACE_MS` | `2000` | プロセスグループ kill の SIGTERM→SIGKILL 猶予（PR-C 共通） |

---

## 7. テスト

```bash
npm run test:unit                 # 純関数（buildArgs 外形固定・permission 写像・preflight 分岐）
npm run build && npm run e2e:codex # live e2e（実 codex を 10 回 spawn。ChatGPT サブスク枠を消費）
```

### 7.1 e2e 成績（2026-09-05 再測定・15 ラウンド）

**合計 13/15（86.7%）。連続 10 回の受け入れ基準（10/10）は未達だが、PR-D 時点の 2/10（20%）からは
明確に改善している。** 内訳（`codex-cli 0.146.0` / `gpt-5.6-terra` / 無料 ChatGPT 垢 / Darwin 25.4.0）:

| 条件 | サーバ起動形 | ラウンド | 成功 | 失敗ラウンド | reply 所要（成功時） |
|---|---|---|---|---|---|
| A: 作りたて dist | `node dist/server/server/index.js`（既定） | 10 | **9/10** | round 9 | 29.0〜33.3s（中央値 33.0s） |
| B: dev(tsx) | `EBI_E2E_SERVER_MODE=src` | 5 | **4/5** | round 4 | 30.9〜33.0s |
| 合計 | — | 15 | **13/15** | 2 | — |

- A は `npm ci` → `npm run build` 直後の worktree（`.worktrees/ebi-ebiteam-codex-remeasure`・専用ポート 8819）
- B は同じ worktree・同じ dist を持つ状態で src(tsx) 起動に切り替え（専用ポート 8820）
- 失敗ラウンドは 2 件とも `ROUND_TIMEOUT_MS`（180s）到達。成功ラウンドは全て 30 秒前後で安定しており、
  **「遅いから間に合わない」型の失敗ではない**（成功と失敗が二値に分かれる）
- 全 15 ラウンドで idle 復帰 OK・kill 後の `pgrep -x codex` = 0・制御MCP の残存 0

#### 失敗の型（PR-D と同一・2/15）

エビが役割プロンプトへの最初の応答で

> 承知しました。以後、テスト用の疎通係として対応します。
> ただし、この環境では reply_to_master ツールが利用できないため、現時点では master へ送信できません。

と述べ、続くタスク注入にも「reply_to_master ツールがこの環境で利用できないため、呼び出せません」と
返して終わる（＝静かな故障）。観測できた事実:

- **制御MCP プロセスは失敗ラウンドでも立っている**。失敗した 2 ラウンドとも e2e の計測値は `mcp=3`
  （ベースライン差 +3 = 期待どおり）で、codex 側の TUI にも `Booting MCP server: ebi-control` が出ている。
  つまり「MCP が起動していない」故障ではない
- **注入の順序も成功／失敗で同じ**。scrollback を機械比較すると、どちらも
  `Booting MCP server` → 役割プロンプト注入 → ACK の順で、タイミング差は見つからない
- **勝負は役割プロンプトへの ACK 文面で決まっている**。成功ラウンドの ACK は
  「承知しました。テスト用の疎通係として対応します。」だけで、`利用でき` の語は 1 件も出ない。
  一度「利用できない」と述べたセッションは、そのあとタスクを投げても回復しない

#### 条件差の切り分け（§5-1 は根因ではなかった）

再起動後検証（`docs/verify/post-restart-2026-09-05.md`）で挙がっていた 3 つの候補のうち、

| 仮説 | 判定 |
|---|---|
| ② 作りたて dist で回すと通る（§5-1 の裏返し） | **否**。dev(tsx) 起動でも 4/5 で、dist 9/10 と差が出ない（15 回では有意差なし） |
| ① サーバー再起動によるホスト状態リセット / ③ 直前の gemini 実行による暖まり | **切り分け未了**。今回は再起動から約 5 時間後・gemini を回さずに実測して 13/15 なので、少なくとも「直前の暖機が必須」ではない |
| モデル側のツール可視性のばらつき（§7.1 旧・仮説 1） | **残る唯一の説明**。MCP プロセス・注入順序・所要時間のいずれにも差が無く、モデルの初回応答だけが分かれる |

したがって **§5-1 の「dev 起動だと静かに失敗する」は、この失敗の型の根因ではない**。
（dist 起動を推奨する理由自体は残る＝本番と同じ形で動かすため。§5-1 の表現は今回の実測に合わせて弱めた）

#### 次の一手（未実装）

1. **ACK 文面での早期検出＋再 spawn**。失敗は役割プロンプトへの応答時点で確定しており、
   `利用でき(ない|ません)` を含む応答は `fatalPatterns` 相当で検知できる。検知したら 1 回だけ
   再 spawn すれば、単純計算で失敗率は 13.3% → 約 1.8% に落ちる（各ラウンド独立と仮定）
2. ready 直後に `/mcp` を注入し、`ebi-control` の 3 ツールが列挙されることをサーバ側で確認する
   （1 の検出をモデルの言い回しに依存させない代替）
3. 報告経路を PTY 依存にしない（`<worktree>/.ebi-report.md` の watch・設計書 R3）。1 / 2 で足りるなら不要

#### Codex を実装役（`engineer`）の既定に昇格できるか — 現時点の推奨

**推奨: まだ昇格しない。`engineer` は claude 既定のまま、`engineer-codex` のようなオプトイン役割に留める。**

根拠:

- 成功率 13/15（86.7%）は「セカンドオピニオン用に手動で選ぶ」には十分だが、**失敗が静かな点が致命的**。
  エビは「ツールが使えません」と答えて idle に戻るため、master 側からは
  「起動して落ち着いているが報告が来ない」ようにしか見えず、タスクが 1 件消える
- 実装役は 1 タスクが長く、疎通が 1 回きりの e2e より **報告 1 回あたりの損失が大きい**
  （e2e はラウンド 30 秒だが、実装タスクは数十分の作業が報告されずに終わりうる）
- `reportsUsage: false` なので cost / context が UI に出ず、長時間タスクの監視性でも claude に劣る
- 上の「次の一手」1（ACK 検出＋再 spawn）を入れて **10/10 を 2 セット連続**で取れたら、
  そのとき昇格を再検討するのが妥当。判断材料は「成功率」ではなく「静かな故障が観測ゼロになること」

再現手順:

```bash
npm ci && npm run build
env -u EBI_ID EBI_E2E_PORT=8819 EBI_E2E_ROUNDS=10 npm run e2e:codex                        # 条件 A
env -u EBI_ID EBI_E2E_PORT=8820 EBI_E2E_ROUNDS=5 EBI_E2E_SERVER_MODE=src npm run e2e:codex # 条件 B
```

`npm run e2e:codex` は稼働サーバ（8787）に一切依存しない: 専用ポート（既定 8809）で control-server を
自前起動し、master は bash の使い捨てエビ。各ラウンドで
「spawn → ready → 役割プロンプト注入 → タスク注入 → `reply_to_master` 着弾 → idle → kill 後に残存 0」
を判定する。失敗ラウンド（または `EBI_E2E_DUMP=1`）では当該エビの画面が
`/tmp/e2e-codex-ebi-<round>.txt` に残る。

---

## 8. ロールバック

3 段（設計書 §4 と同じ）:

1. `EBI_BACKEND=claude`（既定に戻す。spawn 引数で `backend` を指定しなければ codex は起動しない）
2. 役割・spawn 引数から `backend: "codex"` を外す
3. PR-D のみ revert（PR-A / PR-B は挙動不変、PR-C は gemini 用なので残してよい）

**master は常に claude**（固定エビの backend は command から解決）。最悪でも統括系は落ちない。
