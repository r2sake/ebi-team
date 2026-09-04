# サーバ再起動後の検証（2026-09-05）

- 対象コード: `main` = `b2142da`（PR-A〜PR-D マージ済み）
- 稼働 clone: `~/workspace/GitHub/ebi-team`（ポート 8787・2026-09-05 03:57 再起動）
- 検証 worktree: `.worktrees/ebi-ebiteam-post-restart-verify`（ブランチ `ebi/ebiteam-post-restart-verify`）
- 実行者: engineer エビ（使い捨てセッション）
- 前提のアカウント状態: Codex = 無料 ChatGPT 垢でログイン済み / Gemini = Workspace 垢（GCA Standard・`GOOGLE_CLOUD_PROJECT=engineering-478708`）

**結論: 全項目 PASS。特筆すべきは Codex e2e が 3/3 で通ったこと（PR-D 時点の実測 2/10 から改善）。**

---

## 1. 稼働サーバと購読プロセスの点検

| 項目 | 結果 |
|---|---|
| `reply_to_master` の着弾 | **OK**（`{"delivered":["master"],"via":"notify","confirmed":true,"queued":false}`） |
| master ブリッジの二重起動 | **無し**。`EBI_ID=master` で ebi-control を購読しているのは PID 49180 の 1 本のみ |
| 他の購読エビ | 49181=`minaebi` / 50031=`ebiteam-post-restart-verify`（自分） / 50598=`ebiteam-poc-imagegen` |
| 稼働プロセス | 49178(server) → 49179(supervisor/haiku) / 49180(master/fable) / 49181(minaebi/opus)、49440(control-server) すべて健在 |

`docs`（memory: ghost master bridge）の罠＝claude デーモンの予備セッションが `EBI_ID=master` で
二重購読する事象は、今回は再現していない。`ps -wwwE` で env を見ると daemon の spare
（`claude bg-pty-host` / `bg-spare`）にも `EBI_ID=master` が env として載っているが、
**ebi-control を読み込んでいるのは 49180 だけ**なので横取りは起きない状態。

## 2. 準備（検証 worktree 側）

```
npm ci        # node_modules 未作成だったため新規導入（144 packages）
npm run build # tsc -p tsconfig.server.json && vite build → 成功
npm run typecheck  # エラーなし
npm run test:unit  # 212 tests / pass 211 / fail 0 / skip 1
```

CLI バージョンは docs の検証済みと一致: `gemini 0.58.0` / `codex-cli 0.146.0`。

## 3. e2e 結果

すべて `env -u EBI_ID` で実行（自セッションの `EBI_ID` を子へ継承させない）。
どの e2e も稼働サーバ（8787）には触れず、専用ポート＋`mkdtemp` で完結する。

| # | コマンド | ポート | 結果 |
|---|---|---|---|
| 1 | `npm run e2e:send` | 8802 / 8803 | **9/9 OK** |
| 2 | `npm run e2e:spawn-delivery` | 8801 | **5/5 到達**（echo 痕跡 5/5） |
| 3 | `npm run e2e:delivery-hardening` | 8805 | **10/10 OK** |
| 4 | `npm run e2e:gemini`（10 回） | 8803 | **10/10**（reply 着弾 10・idle 復帰 10・kill 後残存 0 が 10） |
| 5 | `EBI_E2E_ROUNDS=3 npm run e2e:codex` | 8809 | **3/3 PASS** |

### 3.1 e2e:send（9/9）

`/control/send` 単体（未起動 + `spawnIfMissing` 無し→ not found／spawn→ready→送信／既存へ即送信）、
制御MCP stdio の `send_message`（tools/list に 10 ツール）、ready timeout 経路、すべて期待どおり。

### 3.2 e2e:spawn-delivery（5/5）

| round | acted | echo | via | 所要 |
|---|---|---|---|---|
| 1 | OK | OK | notify | 8s |
| 2 | OK | OK | **pty-fallback** | 14s |
| 3 | OK | OK | notify | 10s |
| 4 | OK | OK | notify | 8s |
| 5 | OK | OK | notify | 8s |

round 2 は `[delivery:echo-timeout]`（notification は ACK されたがタグエコーを 8000ms 以内に
確認できず）で PTY 注入へフォールバックし、**本文は失われずに到達**した。ハードニングが
設計どおり効いた例であり、失敗ではない。起動ゲート自動応答は 5 回作動。

### 3.3 e2e:delivery-hardening（10/10）

- A: 同一 id を名乗る 2 本目の購読を 409 で拒否（6 回）。先着ブリッジが 5/5 受信、幽霊の横取り 0
- B: 先着のコネクション断後、後着が失効待ちなしで購読・配送成功
- C: `duplicate-subscriber` / `ack-timeout` が配送ログに時刻つきで残る
- D: busy 滞留を `confirmed:false, queued:true` と正しく返し、idle 復帰後に flush

### 3.4 e2e:gemini（10/10・完全緑）

```
round  1: delivered=OK idle=OK 残存=0 21s      round  6: delivered=OK idle=OK 残存=0 18s
round  2: delivered=OK idle=OK 残存=0 19s      round  7: delivered=OK idle=OK 残存=0 20s
round  3: delivered=OK idle=OK 残存=0 18s      round  8: delivered=OK idle=OK 残存=0 17s
round  4: delivered=OK idle=OK 残存=0 19s      round  9: delivered=OK idle=OK 残存=0 21s
round  5: delivered=OK idle=OK 残存=0 19s      round 10: delivered=OK idle=OK 残存=0 18s
==== reply 着弾 10/10 / idle 復帰 10/10 / kill 後残存 0 が 10/10 ====
```

- 全ラウンドで `GEMINI.md=2`（グローバル `~/.gemini/GEMINI.md` ＋ per-エビ役割プロンプトの両方が
  読まれている）＝ `docs/backends/gemini.md` §6 の設計どおり
- 配送は全ラウンド `via=pty`（`supportsChannelInject: false` のとおり購読待ちなし）
- 所要は 17〜21 秒で安定。Workspace 垢（GCA Standard）のままで枠エラー・404 は 1 件も出ていない
- 終了後 `pgrep -f 'npm-global.*gemini'` = 0 件

### 3.5 e2e:codex（3/3 PASS）— docs §7.1 の仮説との突き合わせ

```
round 1: ok=true replied=true idle=true via=pty spawn=0.6s reply=33.3s mcp=3 codex=1->1
round 2: ok=true replied=true idle=true via=pty spawn=0.3s reply=32.9s mcp=3 codex=1->1
round 3: ok=true replied=true idle=true via=pty spawn=0.3s reply=32.9s mcp=3 codex=1->0
[read_scrollback] 「reply_to_master ツールが利用できません」系の応答は 0 件
===== 結果: 3/3 =====  終了後 codex=0 / control-server はベースライン差 0  → PASS
```

`docs/backends/codex.md` §7.1 が記録する失敗の型（エビが「この環境では reply_to_master ツールが
利用できません」と答えて終わる静かな故障）は、**今回 3 ラウンドとも 1 件も出ていない**。

| §7.1 の仮説 | 今回の観測 |
|---|---|
| 1. モデル側のツール可視性のばらつき | 該当症状 0 件。制御MCP プロセスは毎ラウンド期待数（+3）立ち上がり、`reply_to_master` は 3/3 着弾 |
| 2. 連続 spawn による `~/.codex` セッション状態の競合 | 3 連続でも劣化なし（reply 所要 33.3 / 32.9 / 32.9 秒とほぼ一定） |
| 3. 報告経路をファイル受け渡しにする代替案 | **現時点では着手不要**（PTY + MCP 経路で足りている） |

**統計的な注意**: 3 回は少ない。仮に真の成功率が PR-D 時点の 2/10（20%）のままなら 3 連続成功は
確率 0.8% なので、成績が実際に改善している可能性が高い一方、3/3 だけで「解決」と断定はできない。

変わった条件として観測できたのは次の 3 点（いずれも今回の検証で新たに生じた差分）:

1. サーバ再起動でホスト側のプロセス状態がリセットされた（PR-D の測定時は長時間稼働中だった）
2. 検証 worktree で `npm ci` → `npm run build` を新規に実行し、**dist が作りたて**の状態で e2e を回した
   （§5-1 の「dev(tsx) 起動だと制御MCP の起動が遅く静かに失敗する」罠の裏返しで、
   dist の鮮度・依存の整合が効いている可能性）
3. 直前に gemini e2e を 10 回回した後の実行で、ホストが暖まった状態だった

## 4. 稼働環境への影響（不可侵の確認）

| 確認 | 結果 |
|---|---|
| 8787 サーバ | 生存（HTTP 応答あり）。PID 49178/49179/49180/49181/49440 すべて再起動前のまま |
| 自分が起動したプロセス | 全て終了。`pgrep -x codex` = 0 / gemini = 0 / e2e ポート（8801,8802,8803,8805,8809）の LISTEN 無し |
| `git status` | クリーン（`.ebi-team/` は ignore 済み。worktree は汚れていない） |
| `~/.codex/config.toml` / `~/.gemini/settings.json` | 触っていない（e2e は `-c` インラインと per-エビ settings のみ） |
| `git push` | 実行していない |

## 5. 提案（要件外なので実施していない）

1. **Codex e2e を 10 回で再測定する**。3/3 は良い兆候だが、`docs/backends/codex.md` §7.1 の
   「2/10」を上書きするには 10 回連続の実測が要る。合わせて「dist を作り直した直後かどうか」で
   成績が変わるかを 2 条件で比べると、§5-1 の罠が根因だったのか切り分けられる。
2. **codex.md §7.1 の更新は 1 の結果を待つ**。今の 3/3 だけで「解決済み」と書き換えると、
   再発時に判断を誤らせる。本ファイルへの参照を 1 行足す程度に留めるのが安全。
3. **`e2e:spawn-delivery` の echo-timeout（8000ms）は今回も 5 回中 1 回発生**している。
   フォールバックで救えているので実害は無いが、頻度が上がるようなら閾値か ACK 判定の見直しを検討。
4. **ゴースト master ブリッジの点検を e2e 化する余地**。今回は手で `ps -wwwE` を見て確認したが、
   「ebi-control を購読している `EBI_ID=master` のプロセスが 1 本であること」は
   `/control/*` から機械的に検査できると再発検知が早い。
