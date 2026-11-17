# PLAN: pty master fd リーク（/dev/ptmx 枯渇）の修正

- 対象事故: 2026-09-22、ebi-team サーバ（node）が /dev/ptmx を 508 本保持 → macOS `kern.tty.ptmx_max=511` に到達 → spawn が `posix_spawnp failed.` で連発失敗。復旧はサーバ再起動。
- 本ドキュメントは **調査と計測の結果＋修正案の比較** まで。実装・commit・push は未実施。

## 1. 結論（真因）

**ebi-team 側のコードに瑕疵はない。node-pty 1.1.0 の macOS 専用コードパスに fd リークのバグがある。**

`node_modules/node-pty/src/unix/pty.cc` の `pty_posix_spawn()`（`#if defined(__APPLE__)` のみ）:

```c
  int low_fds[3];
  size_t count = 0;
  for (; count < 3; count++) {
    low_fds[count] = posix_openpt(O_RDWR);
    if (low_fds[count] >= STDERR_FILENO)
      break;            // 通常はここで count == 0 のまま break
  }
  ...
done:
  ...
  for (; count > 0; count--) {   // ← count == 0 なので一度も回らない
    close(low_fds[count]);       // ← しかも添字が off-by-one（[count] ではなく [count-1] が正）
  }
```

`low_fds[]` は「stdin/stdout/stderr と衝突しない fd を確保するために捨て番として開く ptmx」。
通常環境では 1 回目の `posix_openpt` が既に fd >= 2 を返すため `count == 0` で break し、
後始末ループ `for (; count > 0; count--)` は **一度も実行されない**。
結果、**`pty.spawn()` 1 回につき /dev/ptmx が 1 本、恒久的にリークする**。

補足: `slave` も 1.1.0 では parent 側で `close()` されていない（後述の beta では `close(slave)` が追加されている）。
ただし実測では slave 側（/dev/ttysNNN）は master クローズ時に解放されており、**恒久的に残るのは ptmx 1 本/spawn** のみ。

### 事故のエラーメッセージとの整合

ptmx 枯渇時は `*master = posix_openpt(O_RDWR)` が -1 を返し、`*err` が初期値 -1 のまま復帰するため、
呼び出し元は一律 `throw Napi::Error::New(napiEnv, "posix_spawnp failed.")` を投げる（pty.cc L370 付近）。
事故時に観測された `posix_spawnp failed` は **spawn-helper の実行権限問題ではなく ptmx 枯渇** で説明がつく。
（既存の `scripts/fix-pty-helper.mjs` が対処しているのは別要因の同名エラー。今回の件とは無関係。）

### 「kill の仕方」は無関係（当初仮説の棄却）

- `Agent.kill()`（src/server/agent.ts L1223 付近）の `this.proc.kill()` は `process.kill(pid, SIGHUP)` 相当のみで fd に触れないが、
  node-pty 側は子の exit を検知したら 200ms 後に `_socket.destroy()` を行い **master fd は正しく閉じている**（実測で確認）。
- したがって「exit を待ってから破棄する」「`destroy()` を明示的に呼ぶ」といった **ebi-team 側の kill 改修では 1 本も減らない**（計測結果 §2-B/§2-C）。
- リークは kill 時ではなく **spawn 時**に発生している。

## 2. 計測結果（本番 8787 には一切触れず、別プロセスで実施）

計測方法: node-pty を直接叩く使い捨てスクリプトで `spawn` → `kill` を繰り返し、
自 PID の `lsof -p <pid> | grep /dev/ptmx` を毎回数える。検証プロセスと孫プロセスは終了時に全て kill 済み（残骸ゼロを確認）。

環境: macOS (Darwin 25.4.0, arm64) / Node v24.14.0 / node-pty 1.1.0（prebuilds/darwin-arm64 のバイナリ）/ `kern.tty.ptmx_max = 511`

### A. 現状（1.1.0・ebi と同じ kill 手順）

| spawn/kill 回数 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| 保持 ptmx 本数 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |

`onExit` は毎回発火（`exited=true`）しているのに 1 本ずつ増える＝**exit 検知と無関係な spawn 時リーク**。

### B. kill 後に `destroy()` も呼ぶ / C. `onExit` 到達を待ってから破棄

いずれも 6 回で 6 本、8 回で 8 本。**改善ゼロ**。
子の下に「pty slave を握ったまま生き残る孫」を作るシナリオ（claude 配下の stdio MCP 相当）でも結果は同じ＝孫の有無も無関係。

### D. 内訳の直接観測

1 回の spawn 直後に保持される fd:

```
fd 11  /dev/ptmx  (15,9)    ← low_fds[0]。誰も close しない＝リーク本体
fd 12  /dev/ptmx  (15,10)   ← JS 側 master（tty.ReadStream）
fd 13  /dev/ttys010         ← slave
```

kill 後: fd 12・13 は消え、**fd 11 だけが残る**。`fs.closeSync(p.fd)` は EBADF（= JS 側 master は既に閉じている）。

### E. 修正版（node-pty 1.2.0-beta.15）での再計測

| spawn/kill 回数 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| 保持 ptmx 本数 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

beta 側のソースでは後始末が修正済み:

```c
done:
  ...
  if (slave != -1) { close(slave); }
  for (size_t i = 0; i <= count; i++) { close(low_fds[i]); }
```

### F. 稼働中サーバでの傍証（読み取りのみ）

2026-09-22 00:40 再起動後のサーバ pid 46042 は、生存エビ 4 体に対し ptmx を 6 本保持。
差分 2 本は再起動後に spawn→kill されたエビの残骸と整合する（1 体 = 1 本）。

運用ペース 40 体/日 なら **40 本/日**。511 本上限に対して 2 週間弱で枯渇し、
今回の 508 本という観測値とも桁が合う。

## 3. 修正案の比較

### 案A（推奨）: node-pty を 1.2.0-beta.15 に上げる

- 根拠: §2-E のとおり **実測でリーク 0**。修正はまさに上記 `low_fds` / `slave` の後始末。
- 互換性: ebi-team が使う API は `pty.spawn / onData / onExit / pid / write / resize / kill` のみ。
  1.1.0 → 1.2.0-beta.15 の `typings/node-pty.d.ts` 差分は「`resize` に任意第3引数 `pixelSize` 追加」「Windows `useConpty` を deprecated 化」「コメント修正」だけで、**利用箇所に破壊的変更なし**。
- 配布: darwin-arm64 / darwin-x64 / linux-* / win32-* の prebuild 同梱（1.1.0 より対象が増えている）。ローカルビルド不要。
- リスク: **stable ではなく beta**（npm の `latest` は依然 1.1.0）。
  → `package.json` で `1.2.0-beta.15` に **完全固定**（`^`/`~` を付けない）し、package-lock も固定する。
  → 既存 e2e（`npm run e2e:all-terminal`）で spawn/配信/kill の実挙動を確認してから採用。
- 戻し方: `npm i node-pty@1.1.0` に戻すだけ（コード変更なし）。

### 案B: 1.1.0 のまま postinstall でソースパッチ＋node-gyp rebuild

- `scripts/fix-pty-helper.mjs` という前例はあるが、こちらは **prebuild バイナリを捨ててソースビルドさせる**必要がある（`pty.cc` の 3 行修正 → prebuilds 削除 → `node-gyp rebuild`）。
- リスク: Xcode CLT / node-gyp 依存、Node のバージョンを上げるたびに再ビルド、CI や他マシンで壊れやすい。メンテコストが案A より明確に高い。
- 採用するとすれば「beta を本番に入れたくない」場合の代替。

### 案C: JS 側で漏れた fd を推測して close する

- `p.fd - 1` 付近の char device を探して `fs.closeSync` する、等。
- **非推奨**。libuv が握っている fd を誤って閉じるとサーバ全体が静かに壊れる。安全に特定する手段がない。

### 案D（却下）: kill 手順の改修（exit 待ち / destroy 明示）

- §2-B/§2-C のとおり **効果ゼロ**。今回の目的では入れない。
  （`Agent.awaitExit()` は既に別目的で存在し、registry 側の再 spawn 用途としては妥当なので現状維持。）

### 保険（案A と併せて入れる）: ptmx 本数の監視

- 起動時と定期（既定 5 分間隔）に **自プロセスの ptmx 保持本数**をログ出力し、閾値超えで警告。
- 実装は `lsof` を呼ばず自前で数える（実測で lsof と完全一致）:

```ts
// /dev/fd を走査し、char device かつ major == 15（macOS の ptmx）を数える
for (const name of fs.readdirSync("/dev/fd")) {
  const st = fs.fstatSync(Number(name));
  if (st.isCharacterDevice() && (st.rdev >> 24) === 15) n++;
}
```

- 閾値: `sysctl -n kern.tty.ptmx_max`（既定 511）の **60% で warn / 80% で error ログ＋master へ notice**。
  生存エビ数との差分（＝リーク疑い本数）も併記すると再発時に即断できる。
- darwin 以外では無効化（`process.platform !== "darwin"` なら何もしない）。

## 4. 変更ファイル（案A + 監視を採る場合）

| ファイル | 変更 |
|---|---|
| `package.json` | `node-pty` を `"1.2.0-beta.15"`（完全固定）へ |
| `package-lock.json` | 上記に伴う更新 |
| `src/server/ptmxWatch.ts`（新規） | ptmx 本数の計測・閾値判定の純関数＋定期タイマ |
| `src/server/index.ts` | 起動時に ptmxWatch を開始（`unref()` 付きタイマ／終了を妨げない） |
| `test/ptyLeak.test.ts`（新規・リーク本体は darwin 限定） | spawn→kill×8 で ptmx 増分 0 を assert＋閾値判定の純関数テスト |
| `src/server/agent.ts` | `pty.spawn` 失敗時に ptmx 本数／上限を添えてログ（一次切り分け用） |
| `scripts/fix-pty-helper.mjs` | 冒頭コメントに「`posix_spawnp failed` は ptmx 枯渇でも出る」注記を追加 |

## 5. テスト方針

1. `npm run typecheck` / `npm run test:unit`
2. 新規 `test/ptyLeak.test.ts`: 実 node-pty で spawn→kill を 8 回、`/dev/fd` 走査で ptmx 増分が 0 であること。
   （CI が Linux なら skip。ローカル macOS でのリグレッション錠前が目的）
3. `npm run e2e:all-terminal`（spawn・配信・reverse notify・kill の通し）で beta への差し替えが実挙動を壊さないこと。
4. 手動: **別ポートで**サーバを起動し、エビを 20 体 spawn→kill して `lsof -p <pid> | grep -c ptmx` が増えないこと。検証後はプロセスを kill し残骸ゼロを lsof で裏取り。

## 6. リスクと対策

| リスク | 対策 |
|---|---|
| beta 版の未知の不具合 | バージョン完全固定＋ e2e 通し確認。異常時は `node-pty@1.1.0` へ即ロールバック（コード変更なし） |
| prebuild と Node ABI の不一致 | 導入後に `node -e "require('node-pty')"` と e2e で起動確認。ABI 不一致なら起動時に即エラーになるので検知は容易 |
| 監視タイマがサーバ終了を妨げる | `timer.unref()`。`/dev/fd` 走査は数十 fd 程度で 1ms 未満 |
| 非 macOS 環境 | リークも監視も darwin 限定。Linux は該当コードパス自体が無い |

## 7. 要件外の気づき（提案のみ・今回は実装しない）

- 事故時のエラーメッセージ `posix_spawnp failed.` は node-pty が投げる汎用文言で、実際の原因（ptmx 枯渇）が判別できない。
  spawn 失敗時に **その時点の ptmx 本数と上限を添えてログする**と、次回以降の一次切り分けが数秒で済む。
- `scripts/fix-pty-helper.mjs` のコメントが「`posix_spawnp failed` = spawn-helper の実行権限」と断定しているため、
  今回のような別要因のときに誤診を誘う。1 行注記を足すと良い。
- 同じ off-by-one は upstream の stable（1.1.0＝npm latest）に残ったままなので、
  将来 stable が出たらそちらへ寄せる（beta 固定を恒久運用にしない）。

## 8. 実装結果（2026-09-22・案A で実施）

| 項目 | 内容 |
|---|---|
| node-pty | `^1.0.0`（実体 1.1.0）→ **`1.2.0-beta.15` 完全固定**。package-lock も更新 |
| 監視 | `src/server/ptmxWatch.ts` を新規追加。起動時＋5 分ごとに `[ebi-team] ptmx: N/M (x%) / 生存エビ k体（リーク疑い j本）` をログ。60% で warn / 80% で error ＋ UI notice（`id: "ptmx-watch"`）。darwin 以外は no-op、タイマは `unref()` |
| spawn 失敗ログ | `src/server/agent.ts` の `pty.spawn` を try/catch し、失敗時に ptmx 本数と上限を添えて `console.error` してから rethrow |
| 誤診対策 | `scripts/fix-pty-helper.mjs` 冒頭に「`posix_spawnp failed` は ptmx 枯渇でも出る」注記 |
| 回帰テスト | `test/ptyLeak.test.ts`（spawn→kill×8 で ptmx 増分 0／darwin 限定 skip、しきい値・整形の純関数テスト同梱） |

検証結果:

- `npm run typecheck`: PASS
- `npm run test:unit`: **505 件中 504 pass / 1 skip / 0 fail**（skip は既存の非 darwin 用）
- `node --import tsx --test test/ptyLeak.test.ts`: 5/5 PASS（1.1.0 なら 8 本増で落ちる内容）
- `npm run e2e:all-terminal`: **13 スクリプト全て OK**（exit 0）。起動ログに `[ebi-team] ptmx: 0/511 (0.0%)` が出ることも確認
- 検証で立てたプロセスは全て終了済み。`pgrep` / `lsof` で残骸ゼロを確認（本番 8787 の pid 46042 は終始 6 本のまま＝不介入）
