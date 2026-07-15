// 簡易 E2E 疎通テスト: サーバの WS へ繋ぎ spawn→output→input（生キー入力）を確認する。
// EBI_COMMAND=bash でサーバを起動した状態で実行する想定。
// 注: UI の @mention 注入（WS `inject`）は廃止したため、ここではペイン直接入力に相当する
// WS `input`（ターミナルへ生キーを書き込む経路・残存）で疎通を確認する。
import { WebSocket } from "ws";

const ws = new WebSocket("ws://localhost:8787/ws");
let spawnedId = null;
let sawOutput = false;
let sawInputEcho = false;

const fail = (m) => { console.error("NG:", m); process.exit(1); };
const t = setTimeout(() => fail("タイムアウト"), 8000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "spawn", cwd: process.cwd() }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "spawned") {
    spawnedId = msg.agent.id;
    console.log("spawned:", spawnedId, "pid:", msg.agent.pid);
    // bash プロンプトが落ち着くまで待ってから生キー入力（本文＋改行）を送る。
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "input", id: spawnedId, data: "echo INPUT_OK\r" }));
    }, 1500);
  }
  if (msg.type === "output" && msg.id === spawnedId) {
    sawOutput = true;
    if (msg.data.includes("INPUT_OK")) sawInputEcho = true;
  }
  if (msg.type === "status") {
    console.log("status:", msg.id, "->", msg.status);
  }
  if (sawOutput && sawInputEcho) {
    clearTimeout(t);
    console.log("E2E OK: output 受信 + input 反映を確認");
    ws.send(JSON.stringify({ type: "kill", id: spawnedId }));
    setTimeout(() => process.exit(0), 300);
  }
});

ws.on("error", (e) => fail(String(e)));
