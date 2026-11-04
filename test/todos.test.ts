// ボスの TODO（台帳・制御API・UI からの回答・表示の純関数・MCP ティア）のユニットテスト。
//
// 検証する中核（設計: docs/plans/boss-todo-plan.md §6.2）:
//   - 番号は通し番号で使い回さない（追加 → 解決 → 追加で番号が増える）
//   - 再起動しても未解決と次の番号が戻る・atomic 書き込み（tmp を残さない）・壊れた JSON でも throw しない
//   - 入力の検証（kind・長さ・options・recommended）
//   - 消えた番号は「解決済み」、振っていない番号は「未発行」
//   - 制御API 4 本の 200 / 400 / 404
//   - UI からの回答: master へ本文を流し、受け付けられたら消す・送れなければ残す
//   - engineer ティアの MCP に todo_* が出ない（追加は master だけ）
//
// 実行: node --import tsx --test test/todos.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  TodoBoard,
  TodoError,
  answerTodo,
  normalizeTodoInput,
  parseTodoFile,
  todoAnswerText,
} from "../src/server/todos.ts";
import { createControlApi } from "../src/server/control.ts";
import { Registry } from "../src/server/registry.ts";
import {
  ageLabel,
  canSendAnswer,
  showsDoneButton,
  todoBreakdown,
  todoButtonText,
  todoMetaText,
} from "../src/client/todoModel.ts";
import type { TodoItem } from "../src/shared/protocol.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function makeStore(): Promise<{ dir: string; path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ebi-todos-"));
  return { dir, path: join(dir, ".ebi-team", "todos.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const Q = { title: "マージしてよいか", detail: "**PR #1**", kind: "question", options: [{ label: "A" }, { label: "B", description: "後で" }], recommended: "A" };

// ===== 台帳 =====

test("番号は通し番号で、解決しても使い回さない", async () => {
  const board = new TodoBoard({ storePath: null });
  const a = await board.add(Q);
  const b = await board.add({ title: "許可", kind: "permission" });
  assert.equal(a.no, 1);
  assert.equal(b.no, 2);
  assert.ok(await board.resolve(1));
  const c = await board.add({ title: "作業", kind: "action" });
  assert.equal(c.no, 3);
  assert.deepEqual(board.list().map((it) => it.no), [2, 3]);
});

test("消えた番号は resolved、振っていない番号は unknown", async () => {
  const board = new TodoBoard({ storePath: null });
  await board.add(Q);
  await board.resolve(1);
  assert.deepEqual(board.lookup(1), { found: false, status: "resolved" });
  assert.deepEqual(board.lookup(2), { found: false, status: "unknown" });
  assert.deepEqual(board.lookup(0), { found: false, status: "unknown" });
  assert.equal(await board.resolve(1), null);
});

test("再起動（新しいインスタンスの restore）で未解決と次の番号が戻る", async () => {
  const { path, dir, cleanup } = await makeStore();
  try {
    const board = new TodoBoard({ storePath: path, now: () => 1000 });
    await board.add(Q);
    await board.add({ title: "二件目", kind: "action", ebi: "engineer-3", project: "kakeba" });
    await board.resolve(2);
    const again = new TodoBoard({ storePath: path });
    assert.deepEqual(await again.restore(), { restored: 1, broken: false });
    assert.equal(again.nextNo, 3);
    const [item] = again.list();
    assert.equal(item!.no, 1);
    assert.equal(item!.createdAt, 1000);
    assert.equal(item!.recommended, "A");
    assert.equal((await again.add({ title: "三件目", kind: "action" })).no, 3);
    // tmp を残さない（atomic: tmp → rename）。
    assert.deepEqual(await readdir(join(dir, ".ebi-team")), ["todos.json"]);
    assert.equal(JSON.parse(await readFile(path, "utf8")).nextNo, 4);
  } finally {
    await cleanup();
  }
});

test("壊れた todos.json でも throw せず、退避して空で始める", async () => {
  const { path, dir, cleanup } = await makeStore();
  try {
    await new TodoBoard({ storePath: path }).add(Q); // ディレクトリを作る
    await writeFile(path, "{壊れた", "utf8");
    const board = new TodoBoard({ storePath: path, now: () => 42 });
    assert.deepEqual(await board.restore(), { restored: 0, broken: true });
    assert.equal(board.size, 0);
    const files = await readdir(join(dir, ".ebi-team"));
    assert.ok(files.includes("todos.json.broken-42"));
  } finally {
    await cleanup();
  }
});

test("保存値の nextNo が残っている番号より小さくても重ならない", () => {
  const parsed = parseTodoFile(
    JSON.stringify({ version: 1, nextNo: 2, items: [{ no: 5, createdAt: 1, title: "x", kind: "action" }] }),
  );
  assert.equal(parsed!.nextNo, 6);
  assert.equal(parseTodoFile("[]"), null);
});

test("入力の検証: kind・件名・options・recommended", () => {
  assert.throws(() => normalizeTodoInput({ title: "x", kind: "memo" }), TodoError);
  assert.throws(() => normalizeTodoInput({ title: "  ", kind: "action" }), TodoError);
  assert.throws(() => normalizeTodoInput({ title: "x", kind: "question", options: "A" }), TodoError);
  assert.throws(
    () => normalizeTodoInput({ title: "x", kind: "question", options: [{ label: "A" }, { label: "A" }] }),
    TodoError,
  );
  assert.throws(
    () => normalizeTodoInput({ title: "x", kind: "question", options: Array.from({ length: 7 }, (_, i) => `o${i}`) }),
    TodoError,
  );
  assert.throws(
    () => normalizeTodoInput({ title: "x", kind: "question", options: [{ label: "A" }], recommended: "Z" }),
    TodoError,
  );
  const n = normalizeTodoInput({ title: "a\nb\u0007", kind: "action", detail: "1\n2", ebi: "", project: " p " });
  assert.equal(n.title, "a b");
  assert.equal(n.detail, "1\n2");
  assert.equal(n.ebi, null);
  assert.equal(n.project, "p");
  assert.equal(normalizeTodoInput({ title: "x".repeat(500), kind: "action" }).title.length, 120);
});

test("変化のたびに onChange へ全件が渡る（WS todos の broadcast 用）", async () => {
  const seen: number[][] = [];
  const board = new TodoBoard({ storePath: null, onChange: (items) => seen.push(items.map((i) => i.no)) });
  await board.add(Q);
  await board.add(Q);
  await board.resolve(1);
  assert.deepEqual(seen, [[1], [1, 2], [2]]);
});

// ===== UI からの回答 =====

test("回答の本文: 選択・補足・対応済み", () => {
  const item = { no: 12, title: "件名" };
  assert.equal(todoAnswerText(item, { choice: "B", text: "急ぎで" }), "[TODO #12 への回答] 件名\n選択: B\n補足: 急ぎで");
  assert.equal(todoAnswerText(item, { done: true }), "[TODO #12 対応済み] 件名");
  assert.equal(todoAnswerText(item, { text: "  " }), null);
});

test("answerTodo: master が受け付けたら消える・送れなければ残す・選択肢外は弾く", async () => {
  const board = new TodoBoard({ storePath: null });
  await board.add(Q);
  const sent: string[] = [];

  const ng = await answerTodo(board, 1, { choice: "A" }, async () => ({ accepted: false, reason: "停止中" }));
  assert.equal(ng.ok, false);
  assert.equal(board.size, 1);

  const bad = await answerTodo(board, 1, { choice: "Z" }, async (t) => (sent.push(t), { accepted: true }));
  assert.equal(bad.ok, false);
  assert.equal(sent.length, 0);

  const ok = await answerTodo(board, 1, { choice: "A" }, async (t) => (sent.push(t), { accepted: true }));
  assert.equal(ok.ok, true);
  assert.equal(board.size, 0);
  assert.equal(sent[0], "[TODO #1 への回答] マージしてよいか\n選択: A");

  const again = await answerTodo(board, 1, { choice: "A" }, async () => ({ accepted: true }));
  assert.deepEqual(again, { ok: false, error: "TODO #1 はもう解決済みです" });
});

test("answerTodo: 同じ番号の二重送信は 1 回しか master へ流さない", async () => {
  const board = new TodoBoard({ storePath: null });
  await board.add(Q);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const deliver = async () => {
    calls += 1;
    await gate;
    return { accepted: true };
  };
  const first = answerTodo(board, 1, { choice: "A" }, deliver);
  const second = await answerTodo(board, 1, { choice: "A" }, deliver);
  assert.equal(second.ok, false);
  release();
  assert.equal((await first).ok, true);
  assert.equal(calls, 1);
});

// ===== 表示の純関数 =====

test("表示: ボタンの文言・内訳・経過時間・メタ・ボタンの出し分け", () => {
  const items = [{ kind: "question" }, { kind: "question" }, { kind: "permission" }] as Pick<TodoItem, "kind">[];
  assert.equal(todoButtonText(3), "📋 TODO 3");
  assert.equal(todoBreakdown(items), "ボスの TODO: 質問 2・許可 1");
  assert.equal(todoBreakdown([]), "ボスの TODO はありません");
  assert.equal(ageLabel(0, 30_000), "たった今");
  assert.equal(ageLabel(0, 5 * 60_000), "5 分前");
  assert.equal(ageLabel(0, 3 * 3600_000), "3 時間前");
  assert.equal(ageLabel(0, 2 * 86400_000), "2 日前");
  assert.equal(todoMetaText({ ebi: "engineer-3", project: "kakeba" }), "engineer-3 / kakeba");
  assert.equal(todoMetaText({ ebi: null, project: null }), "");
  assert.equal(showsDoneButton({ kind: "question" }), false);
  assert.equal(showsDoneButton({ kind: "action" }), true);
  assert.equal(canSendAnswer(null, " "), false);
  assert.equal(canSendAnswer("A", ""), true);
});

// ===== 制御API =====

async function withTodoApi<T>(board: TodoBoard | null, fn: (base: string) => Promise<T>): Promise<T> {
  const handle = createControlApi({
    registry: new Registry(),
    spawnAgent: async () => "ebi-1",
    inject: async () => ({ delivered: [], rejected: [], details: [] }),
    sendMessage: async () => ({ ok: false, error: "未使用", spawned: false }),
    broadcastRegistry: () => {},
    summarize: async () => ({ ok: false, reason: "未使用" }),
    ingestUsage: () => {},
    subscribe: async () => ({ messages: [] }),
    openViewer: async () => {
      throw new Error("未使用");
    },
    readViewerFile: async () => null,
    saveChatAttachment: null,
    readChatAttachment: null,
    shareChatImage: async () => null,
    requestChatPermission: null,
    requestFileEdit: null,
    todos: board,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    await handle(req, res, url.pathname, url.searchParams);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function call(base: string, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("制御API: add → list（詳細なし）→ get → resolve → get は解決済み", async () => {
  const board = new TodoBoard({ storePath: null });
  await withTodoApi(board, async (base) => {
    const add = await call(base, "POST", "/control/todo-add", Q);
    assert.equal(add.status, 200);
    assert.equal(add.json.no, 1);

    const list = await call(base, "GET", "/control/todos");
    assert.equal(list.status, 200);
    assert.equal(list.json.count, 1);
    const row = (list.json.items as Record<string, unknown>[])[0]!;
    assert.equal(row.title, Q.title);
    assert.equal("detail" in row, false);

    const get = await call(base, "GET", "/control/todo?no=1");
    assert.equal(get.status, 200);
    assert.equal((get.json.item as TodoItem).detail, "**PR #1**");

    const done = await call(base, "POST", "/control/todo-resolve", { no: 1 });
    assert.equal(done.status, 200);
    assert.equal(done.json.ok, true);

    const gone = await call(base, "GET", "/control/todo?no=1");
    assert.equal(gone.status, 404);
    assert.equal(gone.json.status, "resolved");
    const never = await call(base, "GET", "/control/todo?no=9");
    assert.equal(never.json.status, "unknown");
    assert.equal((await call(base, "POST", "/control/todo-resolve", { no: 1 })).status, 404);
  });
});

test("制御API: 検証失敗は 400・台帳が無ければ 404", async () => {
  await withTodoApi(new TodoBoard({ storePath: null }), async (base) => {
    assert.equal((await call(base, "POST", "/control/todo-add", { title: "x", kind: "memo" })).status, 400);
    assert.equal((await call(base, "GET", "/control/todo?no=abc")).status, 400);
    assert.equal((await call(base, "POST", "/control/todo-resolve", { no: "1" })).status, 400);
  });
  await withTodoApi(null, async (base) => {
    assert.equal((await call(base, "GET", "/control/todos")).status, 404);
  });
});

// ===== MCP ティア =====

async function listBridgeTools(role: "master" | "engineer"): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(ROOT, "src/mcp/control-server.ts")],
    cwd: ROOT,
    env: {
      ...(process.env as Record<string, string>),
      EBI_MCP_ROLE: role,
      EBI_NOTIFY_SUBSCRIBE: "off",
      // 稼働中のサーバ（8787）へは繋がない。ツール一覧だけを見る。
      EBI_CONTROL_URL: "http://127.0.0.1:9",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "todos-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

test("MCP: todo_* は master ティアにだけ出る（engineer ティアには出ない）", { timeout: 60000 }, async () => {
  const todoTools = ["todo_add", "todo_list", "todo_get", "todo_resolve"];
  const master = await listBridgeTools("master");
  for (const t of todoTools) assert.ok(master.includes(t), `master に ${t} が無い`);
  const engineer = await listBridgeTools("engineer");
  for (const t of todoTools) assert.equal(engineer.includes(t), false, `engineer に ${t} が出ている`);
});
