# Claude バックエンド（既定）とヘッドレス master

- 対象読者: ebi-team を自分の環境で回す人／master をチャット UI（`ui:"chat"`）に切り替えるか判断する人
- 関連: [`docs/ops/master-chat-ui.md`](../ops/master-chat-ui.md)（移行手順・ロールバック） / [`docs/design/master-chat-ui-2026-09-05.md`](../design/master-chat-ui-2026-09-05.md)（設計・一次情報 URL） / [`codex.md`](codex.md) / [`gemini.md`](gemini.md)

claude は ebi-team の**既定バックエンド**で、2 つの使われ方がある。

| 使われ方 | 起動形 | 表示 | 状態 |
| --- | --- | --- | --- |
| **作業エビ（engineer / supervisor / 動的エビ）** | PTY で対話 TUI を起動（従来どおり） | xterm | 変更なし |
| **ヘッドレス master**（`ui:"chat"`） | `claude -p` の stream-json プロセスを 1 本常駐 | チャット DOM | 本ドキュメント §1〜 |

---

## 1. ヘッドレス master の仕組み

`fixedEbi[].ui` が `"chat"` のとき、サーバは master の **PTY を一切起動せず**、`claude -p`（print モード）を
多ターン用に立てて標準入出力で会話する。実際に組み立てられる引数列は次のとおり（`src/server/master/claudeArgs.ts`）。

```
claude -p \
  --input-format stream-json --output-format stream-json --verbose \
  --replay-user-messages --include-partial-messages \
  --mcp-config <.ebi-team/master-control(.dev).mcp.json> --strict-mcp-config \
  --permission-mode auto \
  --append-system-prompt <master の役割プロンプト> \
  --model <config の model。既定 opus> \
  [--resume <sessionId>] [config の args...]
```

| フラグ | なぜ要るか |
| --- | --- |
| `--input-format stream-json` | **1 プロセスで多ターン**を回すため。stdin に `{"type":"user",...}` を 1 行書くと 1 発話になる（公式サポート） |
| `--output-format stream-json --verbose` | NDJSON で `assistant` / `tool_use` / `result` 等を受け取る |
| `--replay-user-messages` | 投入した user メッセージが stdout に返る＝**投入 ACK**。`tool_result` も同じ `type:"user"` で流れるので text ブロック一致で照合する |
| `--include-partial-messages` | 逐次描画（差分追記 → ブロック完了時に全文で置換） |
| `--mcp-config` + `--strict-mcp-config` | ebi-control（master ロール）を接続する。`--strict-mcp-config` を付けても connected になる（実測） |
| `--permission-mode auto` | 現行 config と同じ。`--permission-prompts none` は**付けない**（付けると `AskUserQuestion` がツール一覧から消え、「ボスに聞く」が死ぬ） |
| `--model` | **CLI の既定モデルは opus ではない**（実測 `claude-fable-5-1`）ため明示する |
| `--resume` | プロセスだけが死んだときの自動復帰（サーバ再起動時は付けない＝新しい会話） |

主な帰結:

- **受信（`reply_to_master`）が backend 非依存になる**。mailbox → master の stdin へ user メッセージを 1 行書くだけになり、
  PTY 注入・notification channel といった harness 固有の裏口を使わない。配送ハードニング（エコー照合・PTY フォールバック・
  二重配送ガード）は chat 経路では **1 行も走らない**。
- **中断は `SIGINT` ではなく `control_request`（`subtype:"interrupt"`）を stdin へ 1 行**。プロセスは生きたまま次のターンへ進める。
  `SIGTERM` はターンを未完のまま exit 143 で残すので使わない。
- **文脈使用率は statusLine ではなく `turnEnd` の usage から算出**する（ヘッドレスに statusLine は無い）。
  「ターン最後の `assistant` の `message.usage`（input + cache_read + cache_creation）」÷「`result.modelUsage[model].contextWindow`」。
  statusLine との誤差は実測で最大 0.5pt（statusLine 側の整数丸めぶん）。
- **コストは `result.total_cost_usd`**（client-side estimate）。これは**プロセス単位**の積算で `--resume` すると 0 に戻るため、
  サーバ側の `MasterCostLedger` がプロセスを跨いで足す。
- 会話は `.ebi-team/master-chat.jsonl` に永続化され、サーバ再起動後もチャット画面に直近ぶんが復元される。

## 2. サブスク枠の担保（従量課金へ落ちないための三重の歯止め）

ebi-team の **絶対条件は「サブスク枠を外れないこと」**（Agent SDK / API 直叩き禁止）。
ヘッドレス master はこれを次の 3 段で機械的に固定している。

| # | 歯止め | 実装 | 破られたときの挙動 |
| --- | --- | --- | --- |
| 1 | **`--bare` を絶対に付けない／付いていたら起動拒否** | `MASTER_FORBIDDEN_ARGS`（`claudeArgs.ts`） | config の `args` や `EBI_ARGS` から混入していたら **起動を止める** |
| 2 | **API キー系 env を子プロセスから削除**し、残っていたら起動拒否 | `MASTER_ENV_DENY_LIST`: `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` | 親 env にあれば **落としたことを warning で知らせて起動**。子 env に残っていたら（＝実装バグ）**起動を止める** |
| 3 | **`system/init` の `apiKeySource` を検査** | `evaluateInitApiKeySource()`。`"none"` 以外なら起動失敗 | プロセス自身が「API キー無しの OAuth で走っている」と申告しない限り走らせない |

根拠（公式 docs の原文）:

> "Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your subscription login"
> "In bare mode, Claude Code never reads OAuth credentials or the system keychain."
> — https://code.claude.com/docs/en/headless

つまり **非 `--bare` の `-p` は OAuth（＝サブスクログイン）で走る**。上の 3 段はこの前提を運用中に崩さないための固定具で、
`ANTHROPIC_API_KEY` を設定した環境で master を起動しようとすると、静かに従量課金へ落ちる代わりに**起動が止まる**。

> 作業エビ（PTY の claude）は従来どおりで、この deny list の対象外。API キーを使う別用途がある環境では、
> master のプロセスだけが env を落とされる。

## 3. `brain`（master の頭脳 CLI）

`ui:"chat"` のときだけ意味を持つ。既定は `claude`。

| 値 | 状態 | 備考 |
| --- | --- | --- |
| `claude` | **実装済み・既定** | 本ドキュメント |
| `codex` | opt-in（stub → PR-M8 で実装） | **規約グレー**。原文と URL は [`codex.md`](codex.md) §9 |
| `gemini` | **対象外**（ボス裁定 Q-2） | 現行 CLI に `--input-format` が無い。[`gemini.md`](gemini.md) §13 |
| `agy` | 保留 | Antigravity CLI。技術は満たすがアカウント / ToS が入口で詰まる |

未実装の id を書くと起動時に `MasterBrainNotImplementedError` で落ちる（**黙って claude に落とさない**）。

## 4. terminal master（`ui` 未指定）との違い

| | terminal（既定・現行） | chat |
| --- | --- | --- |
| 起動 | PTY で対話 TUI | `claude -p`（PTY なし） |
| 表示 | xterm | チャット DOM（スマホでログがスクロールできる） |
| 受信（`reply_to_master`） | PTY 注入（`notifySubscribe:false`） | stdin へ user メッセージ |
| 中断 | 端末に Ctrl+C | `control_request`（interrupt） |
| 文脈 / コスト | statusLine → `/control/usage` | `turnEnd.usage` / `result.total_cost_usd` |
| 会話の永続化 | 無し（再起動で消える） | `.ebi-team/master-chat.jsonl` |
| `/clear` | 端末で打つ | 「新しい会話」ボタン（プロセスを `--resume` 無しで起動し直す） |

`ui` を書かない限り **terminal のまま**で、chat 実装はサーバに載っているだけで一度も動かない。
切り替えとロールバックの手順は [`docs/ops/master-chat-ui.md`](../ops/master-chat-ui.md)。

## 5. 既知の制約

- **stdin は 10MB 上限**（piped）。大きな貼り付けは UI がファイルへ落として絶対パスだけを渡す（8,000 文字超）。
- **サブエージェントのテキストは既定で流れない**（`--forward-subagent-text` / claude 2.1.211+）。
- 出力の消費が遅いと**最大 30 秒**ドレインを待って終了する（2.1.214+）。サーバは背圧をかけずに読み切る実装にしている。
- `system/init` は**最初の user メッセージ送信後**にしか出ず、毎ターン再送される。init 待ちで ready 判定すると**デッドロックする**。
- busy 中の投入は**キューされず走行中ターンに合流**する（`queued_turn_count` は 0 のまま）。
- 投入 ACK は即時ではない（実測 3.4s / 4.7s）ので、短いタイムアウトで再送しない。

## 6. テスト

```bash
npm test                        # unit（master 関連 100 本超を含む・枠を消費しない）
npm run e2e:context-guard       # 偽 claude スタブで chat 経路まで通す（枠を消費しない）
npm run e2e:master-chat         # 実 claude(haiku)。chat の往復 + reverse-inject を 10 回
npm run e2e:master-chat-image   # 実 claude(haiku)。画像添付が turn に届くか
npm run e2e:master-brain        # 実 claude。ClaudeHeadlessBrain 単体の 2 ターン
npm run compare:contextpct      # 実 claude。算出 ctx% と statusLine の突き合わせ
```

## 7. 一次情報

- ヘッドレス（`-p` / `--bare` と OAuth / stream-json / 承認 / SIGTERM）: https://code.claude.com/docs/en/headless
- CLI リファレンス（`--input-format` / `--resume` / `--permission-prompt-tool` / `--mcp-config`）: https://code.claude.com/docs/en/cli-reference
- Agent SDK ストリーミング入力（多ターン・キューイング・画像・割り込み）: https://code.claude.com/docs/en/agent-sdk/streaming-input
