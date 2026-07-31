// 実 claude を PTY 起動して「代替スクリーンに入らない（＝ブラウザ側でスクロールできる）」ことを
// 実測する live テスト。API 呼び出しは行わない（起動直後の描画だけを観測する）。
//
// 既定ではスキップする（実 claude / 認証環境に依存するため）。実行するときは:
//   EBI_LIVE_CLAUDE=1 node --import tsx --test test/inlineTui.test.ts
//
// 検証内容:
//   - buildSpawnEnv 由来の env で起動した claude は ESC[?1049h（代替スクリーン ON）を送らない。
//   - マウストラッキング（ESC[?1000h / 1002h / 1006h）も送らない。
//     これらが出ると xterm.js は scrollback を持てず／ホイールを奪われ、/compact 後に
//     ログを遡れなくなる（本件の根因）。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as pty from "node-pty";
import { buildSpawnEnv } from "../src/server/agent.ts";

const LIVE = process.env.EBI_LIVE_CLAUDE === "1";

/** claude を PTY 起動して指定時間ぶんの生出力を集める。 */
async function captureBoot(env: Record<string, string>, cwd: string, ms: number): Promise<string> {
  const proc = pty.spawn(process.env.EBI_CLAUDE_BIN ?? "claude", [], {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd,
    env,
  });
  const chunks: string[] = [];
  proc.onData((d) => chunks.push(d));
  await new Promise((r) => setTimeout(r, ms));
  try {
    proc.kill();
  } catch {
    // 既に終了していることがある。
  }
  return chunks.join("");
}

test(
  "インライン TUI env で起動した claude は代替スクリーン/マウストラッキングを使わない",
  { skip: LIVE ? false : "EBI_LIVE_CLAUDE=1 のときだけ実行する" },
  async () => {
    // 未 trust のディレクトリだと「Quick safety check」で止まり REPL まで到達せず、
    // 代替スクリーンにも入らないため偽 PASS になる。必ず trust 済みの cwd で回すこと。
    const cwd = process.env.EBI_LIVE_CWD ?? process.cwd();
    const raw = await captureBoot(buildSpawnEnv(process.env), cwd, 6000);
    assert.ok(raw.length > 0, "claude が何も出力しなかった（起動失敗の疑い）");
    assert.ok(
      !raw.replace(/\s+/g, "").includes("Quicksafetycheck"),
      `cwd が未 trust のため REPL まで到達していない（cwd=${cwd}）。EBI_LIVE_CWD に trust 済みパスを指定すること`,
    );
    assert.ok(!raw.includes("\x1b[?1049h"), "代替スクリーンに入っている（ESC[?1049h を検出）");
    for (const mode of ["1000", "1002", "1006"]) {
      assert.ok(
        !raw.includes(`\x1b[?${mode}h`),
        `マウストラッキング ESC[?${mode}h を検出（ホイールが奪われる）`,
      );
    }
  },
);
