# PR-M0 PoC: master ヘッドレス頭脳（claude / codex）実測レポート

- 実施: 2026-09-05 engineer エビ（master 委譲）
- ブランチ: `ebi/ebiteam-master-chat-m0-poc`（worktree・**main へ merge しない**・push なし）
- 対象設計: `docs/design/master-chat-ui-2026-09-05.md`（ブランチ `ebi/ebiteam-master-chat-ui-design`）§9 PR-M0
- スクリプト: `scripts/poc-master-headless.mjs`（claude）/ `scripts/poc-master-headless-codex.mjs`（codex）/
  `scripts/poc-master-headless-soak.mjs`（放置観測）
- 環境: claude **2.1.258** / codex-cli **0.146.0** / Node v24.14.0 / macOS 26.4.1
- 安全条件の遵守: 稼働 control API（`127.0.0.1:8787`）には**一切触れていない**。PoC は偽 control API を
  別ポート（9911 / 9912）に立て、`.ebi-team/` の既存 mcp config も上書きしていない（PoC 専用 config を
  一時ディレクトリに生成）。プロセス停止はすべて **PID 指定**（`child.kill()`）で、広域 kill は使っていない。
  Chrome 拡張は未使用。`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` は spawn env から明示的に落として実行した。

---

## 0. 判定（3 行）

| 対象 | 判定 | 一言 |
|---|---|---|
| **claude ヘッドレス master** | **可** | ①〜⑦すべて green。`apiKeySource: "none"` ＝ **API キー無しの OAuth（サブスク）で走った**ことを init が自己申告する |
| **codex ヘッドレス master** | **技術は可・規約はグレー**（ボス裁定 Q-1 で opt-in 採用） | app-server の JSON-RPC で多ターン・MCP・steer・resume がすべて動作。`planType: "plus"` と枠使用率まで取れる |
| **contextGuard の代替入力** | **可（ただし設計書の想定は要修正）** | `result.usage` は**使えない**。正解は「ターン最後の assistant イベントの usage ÷ `result.modelUsage[model].contextWindow`」 |

**24h 生存だけは未確認**（実測できたのは **7.1 分 / 2 ping** まで。§6）。ここは
`scripts/poc-master-headless-soak.mjs` を長時間回して埋めるが、ヘッドレス claude の常駐はサブスク枠を
食うため、**起動はボス裁定待ち**（起動コマンド・想定消費・観測項目は §6.3）。

---

## 1. 実行手順（再現用）

```bash
# claude 版（①〜⑦）
node scripts/poc-master-headless.mjs
#   → tmp/poc-m0/{poc.log, run1.ndjson, run2.ndjson, findings.json}
#     （本リポジトリには poc.log.txt / run1.excerpt.ndjson / findings.json のみ収録）

# codex 版（④）
node scripts/poc-master-headless-codex.mjs
#   → tmp/poc-m0-codex/{poc.log, codex1.ndjson, codex2.ndjson, findings.json}
#     （収録は poc.log.txt / codex1.excerpt.ndjson / findings.json）

# 放置観測（§8-R1 の 24h 観測用。既定は 15 分 / 5 分間隔）
POC_SOAK_MINUTES=360 POC_SOAK_INTERVAL_MIN=30 node scripts/poc-master-headless-soak.mjs
#   → tmp/poc-m0-soak/{soak.log, soak.ndjson, soak-findings.json}
#     24h 運用の起動手順・想定消費は §6.3（本 PoC では未起動）
```

claude 側の起動引数（実測でそのまま通ったもの）:

```
claude -p \
  --input-format stream-json --output-format stream-json --verbose \
  --replay-user-messages \
  --mcp-config <PoC 専用 config> --strict-mcp-config \
  --permission-mode auto \
  --append-system-prompt "<master 役割>" \
  --model opus
```

codex 側（既存の `src/server/backends/mcpSpec.ts` の射影関数をそのまま流用できた）:

```
codex -c projects={"<root>"={trust_level="trusted"}} \
      -c mcp_servers.ebi-control.command="..." \
      -c mcp_servers.ebi-control.args=[...] \
      -c mcp_servers.ebi-control.cwd="..." \
      -c mcp_servers.ebi-control.default_tools_approval_mode="approve" \
      -c mcp_servers.ebi-control.env={EBI_CONTROL_URL="...",EBI_MCP_ROLE="master"} \
      -c mcp_servers.ebi-control.startup_timeout_sec=60 \
      app-server
```

---

## 2. claude: 項目別の結果と生ログ抜粋

### 2.1 ④ `system/init` に ebi-control が載るか → **可**

```json
{"type":"system","subtype":"init",
 "session_id":"...","model":"claude-opus-5","permissionMode":"auto",
 "mcp_servers":[{"name":"ebi-control","status":"connected"}],
 "apiKeySource":"none","claude_code_version":"2.1.258",
 "capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],
 "messaging_socket_path":"/tmp/cc-socks/58311.sock"}
```

`tools` には master ロールの 10 本が載った:

```
mcp__ebi-control__ask_supervisor / inject_message / kill_engineer / list_ebi / open_viewer /
read_scrollback / send_message / set_mode / spawn_ebi / spawn_engineer
```

- **`apiKeySource: "none"`** が、設計書 §1.1 の「非 `--bare` の `-p` は OAuth で走る」を
  **プロセスの自己申告として裏付ける一次証拠**。実装ではこの値を preflight で検査し、
  `none` 以外なら起動を拒否する（従量課金への転落を機械的に止める）。
- `--strict-mcp-config` を付けても ebi-control は connected になった。
  `--dangerously-load-development-channels` は**不要**（master は reply_to_master の受信側であり送信側ではない）。

### 2.2 ①多ターン往復 → **可**

| ターン | 送信 | 応答 |
|---|---|---|
| 1 | 合言葉『ウニ-4127』を覚えて | `覚えました（ウニ-4127）。` |
| 2 | さっきの合言葉を繰り返して | `ウニ-4127` |
| 4 | 合言葉を 2 つとも列挙して | `- ウニ-4127（ターン1でボスから）` / `- イクラ-9053（poc-engineer-1 からの割り込みで）` |

1 プロセスのまま、記憶が繋がった状態で 5 ターン往復した。

### 2.3 ②`--replay-user-messages` の ACK → **可（ただし tool_result も返ってくる）**

stdin に書いた行が、`{"type":"user","message":{...},"session_id":...,"uuid":...}` としてそのまま stdout に返る。

**ACK は即時ではない**（実測）:

| 投入タイミング | replay までの実測 |
|---|---|
| 起動直後（1 ターン目） | **3,383 ms**（プロセス起動＋MCP 接続待ちを含む） |
| 走行中ターンへの割り込み | **4,728 ms**（走行中のツール往復が終わるまで返らない） |

→ mailbox 側で **「投げた直後に ACK が来る」前提のタイムアウトを置くと誤検知する**。
ACK 待ちは最低 15 秒程度、望ましくは「返るまで待つが再送はしない」設計にする。

**注意**: replay されるのは「こちらが投げた user メッセージ」だけではなく、
**ツール往復の `tool_result` も同じ `type:"user"` で流れる**。
配送確認（mailbox の ACK）は「自分が投げた text ブロックと一致する user イベント」で照合し、
`content[].type === "tool_result"` を弾く必要がある。

### 2.4 ③busy 中の追加投入 → **可。ただし「キュー」ではなく走行中ターンに合流する**

ツール実行中（`mcp__ebi-control__list_ebi` の往復中）に user メッセージを 1 本追加投入したところ:

- replay ACK は 4.7 秒後（走行中のツール往復が終わってから）に返った
- `result.queued_turn_count` は **0 のまま**
- **同じターンの応答の中で割り込み内容を受領していた**:
  > エビ id は以下の2件です。
  > - `master`（fixed / busy）
  > - `poc-engineer-1`（dynamic / idle / branch: ebi/poc）
  > なお poc-engineer-1 からの割り込みも受領しました。合言葉『イクラ-9053』も覚えました（ウニ-4127 と併せて保持）。
- 次ターンでも両方の合言葉を保持していた（取りこぼしなし）

→ **reply_to_master の到達性としては理想的**（master が busy でも待たされない）。
一方で「キューに N 件溜まっています」という UI 表示は**設計から落とせる**。

### 2.5 ⑤MCP ツールの実呼び出し → **可**

偽 control API 側のアクセスログ:

```
[fake-control] HIT GET /control/agents
```

claude 側のツール呼び出しは `mcp__ebi-control__list_ebi` 1 本で、返り値（偽サーバが返した架空の
`poc-engineer-1`）がそのまま応答本文に現れた＝**MCP 経路が実際に貫通している**。

### 2.6 ⑥中断（interrupt） → **可。SIGINT も SIGTERM も要らない**

`stdin` に 1 行書くだけで止まる:

```json
{"type":"control_request","request_id":"poc-int-...","request":{"subtype":"interrupt"}}
```

応答（**19 ms**）:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"poc-int-...","response":{"still_queued":[]}}}
```

直後に出る `result`:

```json
{"subtype":"error_during_execution","is_error":true,"result":"undefined",
 "stop_reason":null,"terminal_reason":"aborted_streaming"}
```

- プロセスは**生存**し、次のターンも通常どおり応答した（合言葉も保持）。
- **`is_error:true` / `subtype:"error_during_execution"` で返る**ので、
  UI 側で「ユーザーが中断した」と「本当のエラー」を区別する分岐が必須。
  判別は `terminal_reason === "aborted_streaming"`＋直前に interrupt を送ったかで行う。

### 2.7 ⑦プロセス落ち → `--resume` 復帰 → **可**

`SIGKILL` で殺してから `--resume <session_id>` で起動し直したところ:

- `system/init.session_id` は**同じ ID** のまま
- 合言葉 2 つとも保持（`ウニ-4127` / `イクラ-9053`）
- `mcp_servers` も再接続され connected

### 2.8 ⑤/⑥ に対する **文脈使用率の算出（最大リスク②）**

**これが今回いちばん重要な訂正点。**

| 読み方 | ターン1 | 2 | 3（ツール往復あり） | 4 |
|---|---|---|---|---|
| **正: ターン最後の assistant の usage** | 2.5% | 2.5% | **2.6%** | 2.6% |
| 誤: `result.usage` をそのまま | 2.5% | 2.5% | **5.2%** | 2.6% |

- `result.usage` は **そのターンで発行した API リクエストの合計**。ツール往復が増えるほど水増しされ、
  次のターンで**下がる**（＝単調でない）。これを contextGuard に食わせると
  「65% 到達 → 次ターンで 40% に戻る」というチャタリングが起き、通知が壊れる。
- 正しい観測値は **そのターン最後の `assistant` イベントの `message.usage`** の
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。実測でセッション内単調増加を確認
  （25,428 → 25,498 → 26,102 → 26,272 → 26,837 → resume 後 26,907）。
- **分母（文脈窓）も取れる**: `result.modelUsage["claude-opus-5"].contextWindow = 1000000`。
  statusLine の `context_window_size` の代替はこれ。決め打ち定数は要らない。

```json
"modelUsage": {"claude-opus-5":{"inputTokens":2,"outputTokens":7,
  "cacheReadInputTokens":10014,"cacheCreationInputTokens":15370,
  "costUSD":0.158892,"contextWindow":1000000,"maxOutputTokens":64000,
  "canonicalModel":"claude-opus-5","provider":"firstParty","costBasis":"list"}}
```

**閾値の意味が変わる点に注意**: opus-5 の窓は **1,000,000** で、`docs/plans/context-guard-plan.md` の
65/70/85% は 200k 窓の PTY master を前提に決めた数字。窓が 5 倍になると
「65% ＝ 650k トークン」で、現行の中央値 313k では**そもそも到達しない**。
→ PR-M4 で **閾値は割合のまま据え置き、実運用の到達点が変わることを README に注記**するか、
ボスに「絶対トークン数での二段構え」を再裁定してもらう（§5 の設計修正点 D）。

### 2.9 コストの積算

`result.total_cost_usd` は **プロセス単位の積算**で、セッション累計ではない。

```
run1: 0.159537 → 0.173185 → 0.229870 → 0.247826
run2（--resume 直後）: 0.018906   ← リセットされる
```

→ 24h のコスト観測は ebi-team 側で「プロセスをまたいで足し込む」必要がある（設計書 §8-R1 の観測方法を修正）。

---

## 3. codex: 項目別の結果と生ログ抜粋

`codex app-server`（JSON-RPC 2.0 / stdio）で claude と同じ 7 項目を確認した。**すべて green。**

### 3.1 認証・モデル・枠

- `codex login status` → `Logged in using ChatGPT`（サブスク）。`OPENAI_API_KEY` は spawn env から削除して実行。
- `thread/start` の返り: `model: "gpt-5.6-sol"` / `modelProvider: "openai"`
- **`account/rateLimits/updated` が毎ターン流れる**（claude 側には無い情報）:

```json
{"rateLimits":{"limitId":"codex",
  "primary":{"usedPercent":5,"windowDurationMins":300,"resetsAt":1788593396},
  "secondary":{"usedPercent":1,"windowDurationMins":10080,"resetsAt":1789180196},
  "credits":{"hasCredits":false,"unlimited":false,"balance":"0"},
  "planType":"plus"}}
```

→ **5 時間枠 / 週次枠の使用率と plan 種別（plus）がそのまま取れる**。
master のダッシュボードにクォータを出すなら、codex 頭脳のときは claude より情報量が多い。

### 3.2 MCP 接続

`mcpServerStatus/list` の結果:

```
codex_apps(49 tools), ebi-control(10 tools)
ebi-control tools: read_scrollback / ask_supervisor / list_ebi / spawn_ebi / spawn_engineer /
                   set_mode / kill_engineer / inject_message / send_message / open_viewer
```

既存の `toCodexConfigArgs` / `toCodexProjectsTrustArgs`（`src/server/backends/mcpSpec.ts`）が
**そのまま流用できた**。`default_tools_approval_mode="approve"` が無いと承認で止まるという
PR-D の既知事項も app-server 経路で同じく必要。

実際のツール往復（`item/completed` の生ログ）:

```json
{"type":"mcpToolCall","server":"ebi-control","tool":"list_ebi","status":"completed",
 "result":{"content":[{"type":"text","text":"{\"agents\":[{\"id\":\"master\",...},{\"id\":\"poc-engineer-1\",...}]}"}]},
 "error":null,"durationMs":52}
```

### 3.3 多ターン・割り込み（`turn/steer`）・resume

| 項目 | 結果 |
|---|---|
| 多ターン 1 プロセス | 可（turn1〜turn4、記憶継続） |
| 走行中の割り込み | **`turn/steer` で可**（`steerConsumed: true` ＝次ターンで両方の合言葉を列挙） |
| プロセス SIGKILL → `thread/resume` | **可**（別プロセスから同一 `threadId` を継続、両方の合言葉を保持） |

### 3.4 文脈使用率

`thread/tokenUsage/updated` が流れる。**claude とまったく同じ罠がある**:

```json
{"tokenUsage":{
  "total":{"totalTokens":31630,"inputTokens":31613,"cachedInputTokens":22528,"outputTokens":17},
  "last":{"totalTokens":15834,"inputTokens":15825,"cachedInputTokens":...}}}
```

- `total` は**スレッド累計の積算**（15,796 → 31,630 → 85,138 → 104,007 と単調に伸び続ける）
- 文脈占有量は **`last.inputTokens`**（15,788 → 15,825 → 18,806 → 18,851 → resume 後 19,541）
- **窓サイズは通知に含まれない** → codex 頭脳では窓をモデル別テーブルで持つ必要がある
  （claude の `modelUsage[].contextWindow` に相当するものが無い）

### 3.5 規約（ボス裁定 Q-1 の反映）

技術的には**最も素直**（JSON-RPC が MasterBrain にほぼ 1:1）だが、OpenAI 公式 auth docs は

> "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs."
> （https://developers.openai.com/codex/auth → https://learn.chatgpt.com/docs/auth）

と明記しており、**ChatGPT サブスク資格情報での常駐は公式の推奨から外れる**。
`codex app-server` 自体も `--help` 上で `[experimental]`。

ボス裁定（2026-09-05・Q-1）＝ **「codex も master 頭脳の対象に入れる。ただし規約グレーの点は docs に明記し、
既定は claude」** に従い、実装は以下の形にする:

- `brain: "codex"` を**明示指定したときだけ**有効な opt-in（既定は `claude`）
- README と設計書に上記原文と URL を引用して掲載する
- `app-server` が experimental である旨も併記（プロトコルの破壊的変更を織り込む）

---

## 4. 未確認（残リスク）

| # | 内容 | 状況 |
|---|---|---|
| **⑧24h 生存** | 1 プロセスを長時間生かしたときに OAuth が切れないか（`authentication_failed`） | **未達**。実測は 7.1 分 / 2 ping まで（§6。21 分設定だったが観測プロセスの親セッション終了で中断）。`scripts/poc-master-headless-soak.mjs` を 6h 以上回して埋める（起動はボス裁定待ち・§6.3） |
| auto-compact | 文脈が窓に迫ったときヘッドレスが自動 compact するか、その際にイベントが出るか | **未観測**（窓 1M に対し 27k までしか使っていない） |
| レート枠の跨ぎ | claude 側は枠情報が `result` に出ない（codex は `account/rateLimits/updated` で出る） | claude 頭脳では枠の可視化ができない。既存の `usageStore` と同様に「不明」表示 |
| 長文脈 resume | 313k 級の文脈で `--resume` したときの復帰レイテンシ | 未計測（本 PoC は 27k） |

---

## 5. PR-M1 以降への設計修正点

設計書 `docs/design/master-chat-ui-2026-09-05.md` に対する、実測ベースの修正提案。

| # | 対象 | 修正内容 |
|---|---|---|
| **A** | §4 MasterSession 起動シーケンス | **`system/init` は「最初の user メッセージを受け取るまで出ない」**。init 待ちで ready 判定するとデッドロックする（実測: 2 分待って出ず）。`spawn → ready`、初回 init で `session_id` を確定、の順にする。**init はターンごとに再送される**ので、2 回目以降は差分だけ見る |
| **B** | §4 NDJSON パーサ | 起動直後に **SessionStart hook の `system/hook_started` `system/hook_response` が流れる**。本文はプラグインの skill 全文で巨大（1 イベント数万字）。**未知の `system.subtype` は捨てる**設計にし、UI へは流さない |
| **C** | §8-R3 contextGuard の入力 | `result.usage` は使えない（ターン内 API リクエストの合計＝非単調）。**「ターン最後の assistant イベントの `message.usage` の input+cache_read+cache_creation」÷「`result.modelUsage[model].contextWindow`」**に確定。codex は `tokenUsage.last.inputTokens` ÷ モデル別テーブル |
| **D** | §8-R3 / context-guard-plan | **opus-5 の窓は 1,000,000**。65/70/85% は 200k 窓前提の数字で、1M 窓では 650k まで発火しない＝実質無効化される。**閾値の再裁定が要る**（割合据え置き＋注記か、絶対トークン数の併用か）。ボス確認事項として §10 に追加 |
| **E** | §8-R1 コスト観測 | `total_cost_usd` は**プロセス単位の積算**で resume するとリセットされる。24h コストは ebi-team 側でプロセスを跨いで足し込む |
| **F** | §3 reply_to_master の配送 | busy 中の投入は**キューされず走行中ターンに合流する**（`queued_turn_count` は 0 のまま）。「待機 N 件」UI は不要。ただし (1) **replay には `tool_result` も混ざる**ので ACK 照合は text ブロック一致で行い tool_result を弾く、(2) **ACK は即時でない**（起動直後 3.4s / 走行中割り込み 4.7s）ので短いタイムアウトでの再送は誤検知になる |
| **G** | §4 中断 | SIGINT / SIGTERM は不要。**`control_request` の `interrupt`（stdin 1 行）で 19ms**。ただし中断後の `result` は `is_error:true` / `subtype:"error_during_execution"` / `terminal_reason:"aborted_streaming"` で来るので、**エラー通知に化けさせない分岐が必須**。`capabilities` に `interrupt_receipt_v1` / `interrupt_cancel_queued_v1` があることを起動時に確認する |
| **H** | §4 起動引数 | **既定モデルは opus ではない**（実測 `claude-fable-5-1`）。master は `--model opus` を**明示**する。`--strict-mcp-config` でも ebi-control は接続でき、`--dangerously-load-development-channels` は**不要** |
| **I** | §1.1 サブスク担保 | `system/init.apiKeySource` が **`"none"`** を返す＝プロセスの自己申告が取れる。**preflight で `none` 以外なら起動拒否**を入れれば、`--bare` 拒否 + env deny に加えて三重で従量課金を止められる |
| **J** | §1.2 codex 射影 | `turn/start` の `input` は**配列**（`{items:[...]}` は `-32600`）。`turn/steer` は **`expectedTurnId` 必須**。item は `item.type`（`item_type` ではない）、最終回答は `agentMessage` かつ `phase === "final_answer"`（途中経過は `phase: "commentary"`） |
| **K** | §5 ダッシュボード | codex 頭脳のときは **`account/rateLimits/updated` で 5h / 週次の枠使用率と `planType` が取れる**。claude 頭脳では取れない。「枠の可視化はバックエンド依存」と設計に明記する |

---

## 6. 放置観測（実測 7.1 分 / 2 ping）

### 6.1 実測できた範囲

`scripts/poc-master-headless-soak.mjs` を **21 分 / 7 分間隔**の設定で起動したが、
**観測プロセスの親セッションが 7 分過ぎに落ちたため ping#2 で中断**した。
以下は実際に取れた 2 サンプルのみ（`tmp/poc-m0-soak/soak.log.txt` / `soak.ndjson`）。

| ping | 経過 | 結果 | レイテンシ | 文脈トークン（last-assistant） | プロセス累計コスト | `api_error_status` |
|---|---|---|---|---|---|---|
| #1 | 0.1 分 | `success` / `is_error:false` | 5,508 ms | 27,036 | $0.175367 | null |
| #2 | 7.1 分 | `success` / `is_error:false` | 2,005 ms | 28,275 | $0.201434 | null |

- `system/init` は**両ターンとも再送**され、いずれも `apiKeySource: "none"` / `claude-opus-5` /
  同一 `session_id`（`4b1c41cf-…`）。7 分のアイドルを挟んでも **OAuth は切れていない**。
- `authentication_failed` は 1 件も検出されず（スクリプトは全イベントを文字列検索して検知する）。
- ping 1 回あたりの増分（この 2 点間の実測値）: **文脈 +1,239 トークン / コスト +$0.026067**。

**7 分では 24h 生存の根拠にならない**。OAuth トークンの有効期限や長時間アイドル時の再接続は
まったく踏めていないので、判定は「未確認」のまま据え置く。

### 6.2 スクリプト側の既知の穴（起動前に直すべき点）

- `soak.log` は リポジトリの `.gitignore`（`*.log`）に掛かる。**証跡を残すなら出力名を `.log.txt` にするか
  `tmp/` の扱いを決める**（本コミットでは手で `soak.log.txt` にリネームして収録した）。
- 親プロセスが死ぬと観測ごと落ちる（今回の中断原因）。長時間回すときは
  **`nohup` / 別セッションで起動し、PID をファイルに残す**こと（停止は PID 指定・広域 kill 禁止）。
- 中断時に `soak-findings.json` が書かれない（`samples` は完走時にしか書き出さない）。
  長時間運用では **ping ごとに findings を上書き保存**するよう直したほうがよい。

### 6.3 24h ソーク観測の起動プラン（ボス裁定待ち・本 PoC では未起動）

**起動コマンド**（ebi-team の稼働 control API には触らない。MCP なしで起動する）:

```bash
cd <このworktree>
nohup env POC_SOAK_MINUTES=1440 POC_SOAK_INTERVAL_MIN=30 \
  node scripts/poc-master-headless-soak.mjs > tmp/poc-m0-soak/nohup.out 2>&1 &
echo $! > tmp/poc-m0-soak/soak.pid      # 停止は kill $(cat tmp/poc-m0-soak/soak.pid)（広域 kill 禁止）
```

**想定消費**（§6.1 の実測増分からの外挿。実測ではなく見積り）:

| 項目 | 24h / 30 分間隔（48 ping） | 24h / 60 分間隔（24 ping） |
|---|---|---|
| 追加コスト（`total_cost_usd` 積算・list 価格換算） | 約 **$1.3** | 約 **$0.65** |
| 文脈増加 | 約 **+60k** トークン（1M 窓の約 6%・compact には届かない） | 約 **+30k** トークン |
| 常駐プロセス | claude 1 本（アイドル時はほぼ CPU 0） | 同左 |

`total_cost_usd` は**サブスク下でも list 価格で計上される表示値**であって実課金額ではないが、
**サブスクのレート枠は実際に消費する**（claude 側は枠の残量を機械可読で出さないため、
どれだけ食ったかは事後に確認できない）。ここがボス裁定の要点。
枠消費を抑えるなら **60 分間隔（24 ping）**を推奨する。

**観測項目**（`soak-findings.json` の `samples[]` に落ちる）:

| 項目 | 見るもの | 失敗のシグナル |
|---|---|---|
| OAuth 生存 | 全イベントの `authentication_failed` 文字列検出 | 1 件でも出たら「24h 常駐は不可・再ログイン運用が要る」 |
| ターン成否 | `result.subtype` / `is_error` / `api_error_status` | `error_during_execution` や 401/429 の出現時刻 |
| 応答レイテンシ | `latencyMs`（アイドル明け 1 発目） | 時間とともに劣化していないか |
| 文脈占有 | `contextTokens`（last-assistant 由来） | 単調増加が崩れる＝auto-compact の発火（そのときのイベント形も採取） |
| コスト積算 | `cumulativeCostUsd` | プロセスを跨いだ足し込み設計（§5-E）の裏取り |
| プロセス生存 | `EXIT code=… sig=…` の有無 | 自発終了するなら supervisor 側の再起動設計が要る |

