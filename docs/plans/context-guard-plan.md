# master コンテキスト枯渇ガード（context-guard）設計プラン

> 目的: master セッション（Claude Code / Fable 5.1・1M context）のコンテキスト使用率を ebi-team が監視し、**自動 compact に食われて PM 文脈が消える前に**ユーザーへ通知する。
> 大原則（既存方針の踏襲）: ebi-team は compact も `/clear` も**勝手に実行しない**。**促すだけ**。実行はボスの判断。

---

## 0. 結論（TL;DR）

**観測手段は既に repo 内に完成している。新規に作るのは「閾値判定と通知」だけ。**

- `~/.claude/statusline-command.sh` が `EBI_ID` 付きセッションの statusLine JSON 全文を `/control/usage` へ POST 済み。
- `src/server/usageStore.ts` がその JSON から `context_window.used_percentage` / `context_window_size` を既に抽出・保持済み。
- 実測（後述 §1.1）で **master の `contextUsedPct=15` / `contextSize=1000000` がライブで取れている**ことを確認した。

→ 実装は `ingestUsage()` にフックする新モジュール 1 本（約 150 行）＋配線。**ユーザーの `~/.claude/settings.json` は一切触らない。**

---

## 1. 観測手段の候補と実現性（実測ベース）

### 1.1 statusLine フック経由 ★★★ 採用（実現可能・実測済み）

**既存の配線（新規実装は不要）**

| レイヤ | 実体 | 状態 |
| --- | --- | --- |
| 収集 | `~/.claude/statusline-command.sh`（末尾の best-effort POST ブロック） | **稼働中**。`EBI_ID` がある時のみ statusLine JSON 全文を `http://127.0.0.1:${EBI_PORT:-8787}/control/usage` へ非ブロッキング POST |
| 受口 | `src/server/control.ts:275` `POST /control/usage`（`X-Ebi-Id` ヘッダで識別） | **稼働中**。loopback は `auth.ts` の二段判定で無認証通過 |
| 保持 | `src/server/usageStore.ts` `UsageStore.update()` | **稼働中**。`context_window.used_percentage` → `contextUsedPct`、`context_window_size` → `contextSize` |
| 配信 | `src/server/index.ts:329` `ingestUsage()` → `broadcast(usageStore.snapshot())` | **稼働中**。WS `usage` |

**実測（検証の証拠）**: 稼働中サーバ（pid 28837 / `:8787` LISTEN）へ loopback から WS `/ws` 接続し `usage` スナップショットを取得した。抜粋:

```json
{ "id": "master", "model": "Fable 5.1", "costUsd": 9.16,
  "contextUsedPct": 15, "contextSize": 1000000,
  "tokens": { "input": 56, "output": 393, "cacheRead": 145827, "cacheCreation": 2047 },
  "updatedAt": 1788421233186 }
```

`contextUsedPct` の**唯一の供給元は `context_window.used_percentage`**（`usageStore.ts:76`）なので、これが非 null で返る＝**statusLine JSON に `context_window` が実在する**ことの決定的な証拠になる。推測ではない。

**既存設定を壊さない点**: statusline スクリプトは既に POST 済みで、追加改修も `settings.json` の書き換えも不要。差し込みは**サーバ側（`ingestUsage` の内側）だけ**で完結する。

**判明した制約（設計に反映すること）**

1. `used_percentage` は**整数刻み**（15, 22, 43…）。65/70 の閾値判定には十分だが、小数の比較は書かない。
2. **セッション開始直後は `null`**。実測で `minaebi` / `supervisor` / `ebi-1` が `contextUsedPct: null`（初回ターン前に statusLine が走ったもの）。→ **null は「未知」であり「0%」ではない**。判定をスキップすること。
3. **更新は statusLine の再描画契機**（＝master が動いた時）。master が完全 idle だと値が古びる。`updatedAt` の鮮度チェックが要る。
4. `contextSize` も同 JSON から来るので、**モデル別上限テーブルは不要**（§1.5）。

### 1.2 transcript JSONL の usage ★★☆ 補助（実現可能だが配線が足りない）

`~/.claude/projects/<proj>/<session>.jsonl` の assistant 行に `message.usage` が入る。実測抜粋:

```json
{"input_tokens":2,"cache_creation_input_tokens":714,"cache_read_input_tokens":53014,
 "output_tokens":307,"cache_creation":{"ephemeral_1h_input_tokens":714,...}}
```

入力側コンテキスト ≒ `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`（この行なら約 53.7k）。値としては使える。

**しかし採用しない理由**: **ebi-team は master のセッション ID を一切保持していない**。`src/server/` 全体を検索しても session id / transcript path を扱うコードは存在しない（`agent.ts` が持つのは pid と PTY のみ）。使うには「cwd → プロジェクトディレクトリ名の変換」＋「mtime 最新の jsonl を master と推定」というヒューリスティックな新規配線が要り、`--resume` や複数セッション並走で誤爆する。§1.1 が動く以上、**割に合わない**。

**位置づけ**: §1.1 が長時間 stale になった場合の将来的なバックストップ。今回は実装しない（X-4）。

### 1.3 PTY 出力のパース ★☆☆ 不採用

`agent.ts` の scrollback から残量表示や compact 警告文を正規表現で拾う案。

**却下**: TUI は ANSI・再描画・折り返し・幅依存で表記が動き、Claude Code の版更新で無言に壊れる。既に `deliveryTag` の本文照合で「表示幅・言語に依存する照合の脆さ」を踏み抜いた前例がある（`shared/deliveryTag.ts` のコメント参照＝本文先頭照合から msgId タグ照合へ根治した経緯）。同じ轍は踏まない。

### 1.4 PreCompact 等の hook ★☆☆ 補助以下

Claude Code の hook（`settings.json` の `hooks`）で compact 直前を捕まえる案。現ユーザー環境には hooks 設定は無い（`~/.claude/settings.json` に `hooks` キー無し）。

**却下理由は仕組みではなく要件**: PreCompact が鳴る時点で**すでに compact が始まっており手遅れ**。本件の要件は「前段の閾値で促す」。加えてユーザーのグローバル `settings.json` を ebi-team が書き換えるのは §1.1 の「既存設定を壊さない」方針に反する。

**ただし関連する実利のある発見**: `claude --autocompact <auto|tokens>`（`claude --help` で実在を確認、`auto` または 100k–1M）で **auto-compact の発火窓そのものを動かせる**。master の起動 args（現状 `["--effort","medium"]`）に足せば「70% 通知より先に compact が走る」事故を構造的に潰せる。ただし発火閾値の正確な意味論は未検証なので、**採用前に実測ベンチを 1 回打つこと**（X-6）。

### 1.5 モデル別コンテキスト上限の取得 ★★★ 解決済み

**取得不要**。statusLine JSON の `context_window.context_window_size` がそのまま来る。実測で master(Fable 5.1)=`1000000`、supervisor(Haiku 4.5)=`200000` と、モデルごとに正しい値が入っていた。ハードコードのモデル表は作らない（作れば必ず腐る）。

---

## 2. 「キリが良い」の判定と、閾値のヒステリシス

### 2.1 キリの良さ（quiescence）の判定

ebi-team の既存状態だけで判定できる。新規のトラッキングは不要。

| 条件 | 取得元 | 意味 |
| --- | --- | --- |
| 配下エビが全員 idle | `registry.list()` の `AgentRecord.status`（`"idle" \| "busy"`）を `kind === "dynamic"` で絞る | 走行中タスクが無い |
| master 自身が idle | 同上、`id === "master"` の `status` | ユーザー入力待ち＝会話の切れ目 |
| 未達の配送が無い | `mailbox` の未 ACK キューが空 | 投げっぱなしのメッセージが残っていない |

`AgentStatus` は `idleDetector.ts` の「PTY 出力が `idleThresholdMs` 止まったら idle」ヒューリスティック。厳密ではないが、**本用途（急がない・促すだけ）には十分**。誤って「キリが良い」と判定しても実害は「通知文が少し強めに出る」だけで、実行はボスが握っている。

```ts
// contextGuard.ts
function isQuiescent(agents: AgentRecord[]): boolean {
  const master = agents.find((a) => a.id === "master");
  if (!master || master.status !== "idle") return false;
  return agents.every((a) => a.kind !== "dynamic" || a.status === "idle");
}
```

**注意**: `reply_to_master` の着弾直後は master が busy に振れる（PTY に注入文が描画されるため）。よって「完了報告を受けた直後」は idle 判定に自然に吸収され、数秒〜`idleThresholdMs` 後に quiescent になる。**別途エッジを取る必要はない**。

### 2.2 閾値とヒステリシス

3 段のレベル制ステートマシン。`agent.ts` の `lastIdleNotifyAt` によるクールダウン（`IDLE_NOTIFY_COOLDOWN_MS`）と同じ思想を踏襲する。

```
level: none(<65) → soft(>=65) → hard(>=70) → critical(>=85)
```

抑止ルール（3 重）:

1. **レベル上昇時のみ発火**。同レベル内では鳴らない。
2. **再武装は下げ幅マージン付き**（`REARM_MARGIN = 5pt`）。一度 hard(70) を鳴らしたら **65 未満に落ちるまで** none に戻さない。整数刻みで 69↔70 を往復してもチャタリングしない。`/clear` や compact で使用率が急落すれば自然に none へ戻り、次サイクルで再び機能する。
3. **クールダウン**（既定 10 分）。同レベルの再通知は原則しないが、critical だけは cooldown 経過で再送を許す（本当に危ないので）。

`soft(65)` の特則: **quiescent の時だけ発火**する。キリが悪ければ内部状態だけ soft に上げて通知は保留し、次に quiescent になった瞬間に一度だけ鳴らす（＝「65% 以上でキリが良ければ促す」を素直に実装）。`hard(70)` 以上は quiescent を問わず鳴らす（要件が「70% 超えたら通知」なので無条件）。

**null / stale の扱い**: `contextUsedPct === null` は判定スキップ（§1.1-2）。`Date.now() - updatedAt > STALE_MS`（既定 15 分）も**スキップ**し、レベルは据え置く（古い値で誤って上げも下げもしない）。

---

## 3. 通知経路

既存基盤への**相乗り**のみ。新規の通知チャンネルは作らない。

| 経路 | 使う既存機構 | 追加行数の見込み |
| --- | --- | --- |
| **ebi-team UI（Web/スマホ）** | `broadcast({ type: "notice", id: "context-guard", text })`。`NoticeBuffer`（`noticeBuffer.ts`）に自動で載るので、**通知時にブラウザを開いていなくても次回接続時に replay される**（`index.ts:504`）。2026-08-12 の「誰も見ていない時に流れて消えた」インシデント対策がそのまま効く | index.ts に 1 行 |
| **master セッションへの inject** | `registry.reverseInject("context-guard", "master", text, "reply")`。master は `notifySubscribe:false` なので**PTY 注入に固定**され確実に届く（config の `_comment_master_receive` 参照） | contextGuard.ts に数行 |
| **Discord 等** | **今回は実装しない**。master に届けば master が自分の判断でボスへ流せる。ebi-team サーバから直接外部送信する経路を新設するのは、既存の「外部送信は勝手にしない」方針に照らして過剰 | 0 |

master への inject 文面には**「master 自身が何をすべきか」**を書く（master は PM なので、ボスへ promptする側）。

### 通知文テンプレート（日本語・定型）

**soft(65%・キリ良し)**
```
[context-guard] master のコンテキスト使用率が 65%（1,000,000 tokens 中）に達しました。
現在キリの良いタイミングです（配下エビは全員 idle・走行中タスクなし）。
→ ボスに「ここで /clear（セッション切り直し）しませんか」と提案してください。
→ 提案時は、切り直し後に文脈を復元できるよう §4 のハンドオフ要約を先に残すこと。
```

**hard(70%)**
```
[context-guard] master のコンテキスト使用率が 70% を超えました（現在 XX%）。
このまま進むと自動 compact が走り、PM としての文脈（配下エビの状況・進行中の依頼）が失われます。
→ 走行中タスクの区切りを待たず、ボスに /clear を提案してください。
→ /clear の前に必ず §4 のハンドオフ要約を残すこと。
```

**critical(85%)**
```
[context-guard] master のコンテキスト使用率が 85% を超えました（現在 XX%）。compact が目前です。
→ 今すぐハンドオフ要約を書き出し、ボスに /clear を強く促してください。
```

---

## 4. 切り直し後の復帰手順への接続

`/clear` は文脈を消すので、**通知が「要約を残せ」まで含めて指示する**のが要件の核。既存運用に素直に接続する。

**既存の受け皿**

- `ops/daily-handoff/` — 日次ハンドオフ md の実績あり（`2026-07-25-spawn-delivery-fix.md`）。
- minaebi の MEMORY 運用 — 恒久的な知見はそちらへ。

**導線**: 通知文に以下の定型を含め、master が `/clear` 前にこれを実行する。

```
【/clear 前のハンドオフ手順】
1. ops/daily-handoff/<YYYY-MM-DD>-master-handoff.md に以下を書き出す:
   - 進行中のボス依頼（要件・承認状況）
   - 生存している配下エビの一覧（list_ebi の結果をそのまま貼る）と各自の担当タスク
   - 未回収の reply_to_master（待っている報告）
   - 次にやること（箇条書き 3〜5 行）
2. ボスに /clear を提案する。
3. 切り直し後、最初に上記 md を読み込んで PM 文脈を復元する。
```

**なぜ md か**: `/clear` はセッション内の文脈しか消さないので、ファイルに落ちていれば新セッションが `Read` で確実に復元できる。ハンドオフ生成そのものを ebi-team が自動化する案もあるが、**master のコンテキストを読む手段がサーバ側に無い**（scrollback は ANSI 混じりの生ログ）。素直に master 自身に書かせるのが最短かつ確実。

---

## 5. 実装手順

### 5.1 変更ファイルと見積り

| ファイル | 種別 | 行数 | 内容 |
| --- | --- | --- | --- |
| `src/server/contextGuard.ts` | 新規 | 約 150 | 本体。`ContextGuard` クラス（純粋なステートマシン＋通知コールバック） |
| `src/server/index.ts` | 変更 | 約 20 | `ContextGuard` を生成し、`ingestUsage()`（:329）の直後に `guard.observe()` を差す。通知コールバックで `broadcast(notice)` と `registry.reverseInject` |
| `src/shared/protocol.ts` | 変更 | 約 8 | `UsageAgent` は既存で足りる。必要なら `NoticeMessage` に `level?: "info"\|"warn"\|"critical"` を追加（UI の色分け用・任意） |
| `src/client/dashboard.ts` | 変更 | 約 15 | 使用率バーの 65/70 でのハイライト（任意・Phase2 可） |
| `test/contextGuard.test.ts` | 新規 | 約 130 | ユニットテスト（下記） |
| `.env.sample` | 変更 | 約 8 | 新規 env のドキュメント |
| `README.md` | 変更 | 約 20 | 機能説明の追記 |

**合計 約 350 行**。src の既存ロジックへの侵襲は `index.ts` の数行のみ。

### 5.2 インターフェース案

```ts
// src/server/contextGuard.ts
export type GuardLevel = "none" | "soft" | "hard" | "critical";

export interface ContextGuardConfig {
  softPct: number;      // 既定 65
  hardPct: number;      // 既定 70
  criticalPct: number;  // 既定 85
  rearmMarginPct: number; // 既定 5
  cooldownMs: number;   // 既定 600_000
  staleMs: number;      // 既定 900_000
  targetId: string;     // 既定 "master"
}

export interface GuardNotice { level: GuardLevel; usedPct: number; quiescent: boolean; text: string; }

export class ContextGuard {
  constructor(cfg: ContextGuardConfig, private onNotice: (n: GuardNotice) => void) {}
  /** usage 取り込みのたびに呼ぶ。判定と発火は同期・副作用は onNotice のみ。 */
  observe(usage: UsageAgent, agents: AgentRecord[], now: number = Date.now()): void;
  /** テスト用の内部状態参照。 */
  level(): GuardLevel;
}
```

**設計上の要点**: `ContextGuard` は**時計も registry も broadcast も知らない**（`now` は引数、agents は引数、通知はコールバック）。`supervisor.ts` が `EBI_SUMMARY_CMD` でスタブ可能にしているのと同じ思想で、**テストしやすさを型で強制する**。

### 5.3 env（`.env.sample` へ追記）

```
# master コンテキスト枯渇ガード（context-guard）
EBI_CTX_GUARD=on              # off/0/false で無効（既定 on）
EBI_CTX_GUARD_SOFT_PCT=65
EBI_CTX_GUARD_HARD_PCT=70
EBI_CTX_GUARD_CRITICAL_PCT=85
EBI_CTX_GUARD_COOLDOWN_MS=600000
EBI_CTX_GUARD_TARGET=master   # 監視対象エビ id
```

`EBI_IDLE_NOTIFY` と同じく `["off","0","false"]` 判定にそろえる（`agent.ts:213` の既存パターン流用）。

### 5.4 テスト方針

`npm run test:unit`（`node --import tsx --test test/*.test.ts`）に載せる。`ContextGuard` が純関数的なので**実プロセス・実 PTY・実サーバ不要**。

| ケース | 期待 |
| --- | --- |
| 64 → 通知なし | `level === "none"` |
| 65 かつ quiescent | soft 発火 1 回 |
| 65 かつ非 quiescent | 発火なし。その後 quiescent になった最初の observe で 1 回だけ発火 |
| 65 → 66 → 68 | soft は 1 回だけ（同レベル抑止） |
| 69 → 70 → 69 → 70 | hard は 1 回だけ（rearm マージンでチャタリングしない） |
| 70 → 60（下降）→ 70 | 60 で none に戻り、再度 hard 発火 |
| `contextUsedPct: null` | 判定スキップ・レベル据え置き |
| `updatedAt` が staleMs 超 | 判定スキップ・レベル据え置き |
| `EBI_CTX_GUARD=off` | 一切発火しない |
| quiescent 判定 | master busy / dynamic に busy が 1 匹 → いずれも false |

**e2e**（`scripts/e2e-context-guard.mjs`・約 80 行）: `scripts/e2e-usage.mjs` が既に「サンプル statusLine JSON を `/control/usage` に POST → WS `usage` に反映」を実証している。これを複製し、`used_percentage` を 60→66→72 と段階投入して WS `notice` に `id:"context-guard"` が期待回数だけ現れることを確認する。**既存 e2e の型がそのまま使えるので新規発明はゼロ。**

### 5.5 実装順

1. `contextGuard.ts` を書く（依存ゼロ・純粋）
2. `test/contextGuard.test.ts` を書いて green にする
3. `index.ts` へ配線（`ingestUsage` の直後・約 20 行）
4. `scripts/e2e-context-guard.mjs` で実サーバ疎通
5. `.env.sample` / `README.md` を追記
6. （任意・Phase2）`dashboard.ts` の色分け

---

## 6. ボス裁定が必要な点

| # | 論点 | 選択肢 | 推奨 |
| --- | --- | --- | --- |
| **X-1** | 閾値の数値 | 要件どおり 65/70 か、余裕を見て 60/70 か | **65/70 のまま**＋`critical=85` を追加。Fable 1M で 70%＝700k なので compact まではまだ距離があり、65 は保守的だが「キリの良さ待ち」を挟む以上むしろ妥当 |
| **X-2** | 通知先の範囲 | (a) UI notice のみ / (b) UI + master inject / (c) さらに Discord | **(b)**。master に届けば PM としてボスへ流せる。ebi-team サーバから外部送信を新設するのは方針（外部送信は勝手にしない）に照らして過剰 |
| **X-3** | 「キリが良い」の定義 | (a) 配下 dynamic 全員 idle のみ / (b) (a)＋master も idle / (c) さらに未 ACK 配送ゼロ | **(b)**。(c) は mailbox の内部状態に依存が増える割に効果が薄い。(a) だけだと master が喋っている最中に割り込む |
| **X-4** | JSONL フォールバックの実装 | 今回入れる / 見送る | **見送る**。session id の配線が新規に要り、`--resume` で誤爆する。§1.1 が stale になる実害が観測されてから入れる |
| **X-5** | soft の非 quiescent 時の扱い | (a) 保留して次の quiescent で鳴らす / (b) その場で鳴らす / (c) 捨てる | **(a)**。要件「65% 以上でキリが良いなら促す」に最も忠実 |
| **X-6** | `--autocompact` を master args に足すか | 足す（例 `--autocompact 900000`）/ 足さない | **まず実測してから**。フラグの実在は `claude --help` で確認済みだが発火閾値の意味論が未検証。本プランの実装とは独立に検証タスクを切るのが安全 |
| **X-7** | ガードの既定 on/off | 既定 on / 既定 off（env で opt-in） | **既定 on**。通知だけで副作用が無く、`npm start` が `EBI_IDLE_NOTIFY=off` を明示しているのとは事情が違う（idle 通知は洪水になるが、これはレベル上昇時のみで最大数回） |
| **X-8** | 監視対象を master 限定にするか | master のみ / 全エビ | **master のみ**（`EBI_CTX_GUARD_TARGET` で変更可）。動的エビは使い捨てなので溢れても kill すればよく、通知が洪水になる |

---

## 7. リスクと対策

| リスク | 影響 | 対策 |
| --- | --- | --- |
| statusLine が長時間走らず値が stale | 70% を跨いだのに気づかない | `staleMs` 超は判定スキップ＋（Phase2）UI に「usage が古い」表示。実運用では master が動けば必ず statusLine が走るので、動いていない＝溢れないため実害は小さい |
| `used_percentage` が整数刻み | 69↔70 のチャタリング | `rearmMarginPct=5` のヒステリシスで吸収（テストで固定） |
| Claude Code 版更新で statusLine JSON のスキーマが変わる | `contextUsedPct` が null 化して**無言で機能停止** | `usageStore` は既に best-effort な型付けで throw しない。**加えて「master の usage を N 回連続で受けたのに contextUsedPct が常に null」なら 1 回だけ notice を出す**健全性チェックを入れる（約 10 行）。無言の機能停止だけは避ける |
| master への inject が届かない | 通知が UI にしか出ない | master は `notifySubscribe:false` で PTY 注入固定＝最も堅い経路。加えて UI notice は `NoticeBuffer` で replay されるので二重化されている |
| 通知が出ても人が見ていない | 溢れる | 本件のスコープ外（要件が「促すだけ」）。X-2 で Discord を採る場合のみ解決する |

---

## 8. スコープ外（今回やらないこと）

- ebi-team による `/clear` / `/compact` の自動実行 — **既存方針どおり禁止**
- ハンドオフ md の自動生成 — サーバ側に master の文脈を読む手段が無い（§4）
- 動的エビのコンテキスト監視（X-8）
- Discord / 外部通知（X-2）
- `~/.claude/settings.json` の書き換え — 既存設定を壊さない方針（§1.1）
