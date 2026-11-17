// 承認 / 質問（PR-M5）のテスト。**実プロセスも HTTP も起動しない**（純関数と台帳だけ）。
// 実 claude を通した往復は scripts/e2e-master-chat-approval.mjs（既定では走らせない）。
//
// 実行: node --import tsx --test test/masterPermission.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_USER_QUESTION_TOOL,
  MASTER_PERMISSION_PROMPT_TOOL,
  PermissionBroker,
  buildQuestionDecision,
  formatAnswerText,
  parseAskUserQuestionInput,
  type MasterPermissionDecision,
  type PermissionOutcome,
} from "../src/server/master/permission.ts";
import { buildClaudeHeadlessArgs } from "../src/server/master/claudeArgs.ts";
import { toChatEvent, unsettledRequestIds } from "../src/server/master/session.ts";
import type { MasterChatEnvelope, MasterChatEvent } from "../src/shared/protocol.ts";

/** 実測どおりの AskUserQuestion input（PoC 2 回目の run の実物を縮めたもの）。 */
const ASK_INPUT = {
  questions: [
    {
      question: "昼食は寿司とラーメンのどちらがよいですか？",
      header: "昼食選択",
      multiSelect: false,
      options: [
        { label: "寿司", description: "新鮮なネタ" },
        { label: "ラーメン", description: "温かい" },
      ],
    },
  ],
};

/** ブローカのイベントを配列に溜めるハンドラ束。 */
function collector() {
  const permissions: { id: string; toolName: string }[] = [];
  const questions: { id: string; question: string; multi: boolean; options: string[] }[] = [];
  const settled: { id: string; outcome: PermissionOutcome; answer: string | null }[] = [];
  const notices: string[] = [];
  return {
    permissions,
    questions,
    settled,
    notices,
    handlers: {
      onPermission: (ev: { id: string; toolName: string }) =>
        permissions.push({ id: ev.id, toolName: ev.toolName }),
      onQuestion: (ev: {
        id: string;
        question: string;
        multi: boolean;
        options: { label: string }[];
      }) =>
        questions.push({
          id: ev.id,
          question: ev.question,
          multi: ev.multi,
          options: ev.options.map((o) => o.label),
        }),
      onSettled: (ev: { id: string; outcome: PermissionOutcome; answer: string | null }) =>
        settled.push(ev),
      onNotice: (text: string) => notices.push(text),
    },
  };
}

// ===== 純関数 =====

test("parseAskUserQuestionInput は questions を正規化する", () => {
  const parsed = parseAskUserQuestionInput(ASK_INPUT);
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0]?.header, "昼食選択");
  assert.equal(parsed?.[0]?.multi, false);
  assert.deepEqual(
    parsed?.[0]?.options.map((o) => o.label),
    ["寿司", "ラーメン"],
  );
});

test("parseAskUserQuestionInput は形が想定外なら null（通常の承認へ倒す）", () => {
  assert.equal(parseAskUserQuestionInput(null), null);
  assert.equal(parseAskUserQuestionInput({ questions: [] }), null);
  assert.equal(parseAskUserQuestionInput({ foo: 1 }), null);
});

test("formatAnswerText は選択肢と自由入力を 1 本にまとめる", () => {
  assert.equal(formatAnswerText({ choice: ["A"] }), "A");
  assert.equal(formatAnswerText({ choice: ["A", "B"] }), "A, B");
  assert.equal(formatAnswerText({ choice: ["A"], note: "ただし夜は別" }), "A, ただし夜は別");
  assert.equal(formatAnswerText({ note: "  自由入力だけ  " }), "自由入力だけ");
  assert.equal(formatAnswerText({}), "");
});

test("buildQuestionDecision は input を保ったまま answers を質問文キーで足す（実測 §0.6-O）", () => {
  const parsed = parseAskUserQuestionInput(ASK_INPUT)!;
  const decision = buildQuestionDecision(ASK_INPUT, parsed, [{ choice: ["ラーメン"] }]);
  assert.equal(decision.behavior, "allow");
  const updated = (decision as { behavior: "allow"; updatedInput: Record<string, unknown> })
    .updatedInput;
  // 元の questions はそのまま残る（claude はこれを検証する）。
  assert.ok(Array.isArray(updated.questions));
  assert.deepEqual(updated.answers, {
    "昼食は寿司とラーメンのどちらがよいですか？": "ラーメン",
  });
});

// ===== PermissionBroker =====

test("承認: allow で updatedInput をそのまま返し、settled(allowed) が出る", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  const input = { command: "rm -f /tmp/x" };
  const p = broker.request({ toolName: "Bash", input, toolUseId: "toolu_1" });
  assert.deepEqual(c.permissions, [{ id: "toolu_1", toolName: "Bash" }]);
  assert.equal(broker.pendingCount, 1);
  broker.answer("toolu_1", { allow: true });
  const decision = await p;
  assert.deepEqual(decision, { behavior: "allow", updatedInput: input });
  assert.deepEqual(c.settled, [{ id: "toolu_1", outcome: "allowed", answer: "許可" }]);
  assert.equal(broker.pendingCount, 0);
});

test("承認: allow が明示されなければ拒否に倒す（fail-safe）", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  const p = broker.request({ toolName: "Bash", input: {}, toolUseId: null });
  const id = c.permissions[0]!.id;
  broker.answer(id, { allow: false, note: "危ないので却下" });
  const decision = await p;
  assert.deepEqual(decision, { behavior: "deny", message: "危ないので却下" });
  assert.equal(c.settled[0]?.outcome, "denied");
});

test("質問: 質問ごとにスロットが立ち、全部埋まって初めて claude へ返る", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  const input = {
    questions: [
      { question: "Q1", header: "H1", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
      { question: "Q2", header: "H2", options: [{ label: "C" }] },
    ],
  };
  let resolved: MasterPermissionDecision | null = null;
  const p = broker
    .request({ toolName: ASK_USER_QUESTION_TOOL, input, toolUseId: "toolu_q" })
    .then((d) => (resolved = d));
  assert.deepEqual(
    c.questions.map((q) => q.id),
    ["toolu_q#0", "toolu_q#1"],
  );
  assert.equal(c.questions[0]?.multi, true);
  assert.equal(broker.pendingCount, 2);

  broker.answer("toolu_q#0", { choice: ["A", "B"] });
  await Promise.resolve();
  assert.equal(resolved, null, "1 つ目だけでは返らない");
  assert.equal(broker.pendingCount, 1);

  broker.answer("toolu_q#1", { choice: ["C"], note: "補足あり" });
  const decision = await p.then(() => resolved!);
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(
    (decision as { behavior: "allow"; updatedInput: { answers: unknown } }).updatedInput.answers,
    { Q1: "A, B", Q2: "C, 補足あり" },
  );
  assert.equal(broker.pendingCount, 0);
});

test("未知 / 二重の answer は明示エラー（黙って捨てない）", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  assert.throws(() => broker.answer("nope", { allow: true }), /見つかりません/);
  const p = broker.request({ toolName: "Bash", input: {}, toolUseId: "t1" });
  broker.answer("t1", { allow: true });
  await p;
  assert.throws(() => broker.answer("t1", { allow: true }), /見つかりません/);
});

test("接続が切れたら（signal abort）保留は破棄され deny が返る", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  const ac = new AbortController();
  const p = broker.request({ toolName: "Bash", input: {}, toolUseId: "t1" }, ac.signal);
  ac.abort();
  const decision = await p;
  assert.equal(decision.behavior, "deny");
  assert.equal(c.settled[0]?.outcome, "discarded");
  assert.equal(broker.pendingCount, 0);
});

test("既に abort 済みの signal でも即座に破棄される（取りこぼさない）", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  const decision = await broker.request(
    { toolName: "Bash", input: {}, toolUseId: "t1" },
    AbortSignal.abort(),
  );
  assert.equal(decision.behavior, "deny");
  assert.equal(broker.pendingCount, 0);
});

test("discardAll は全保留を deny で畳み、件数を notice に出す", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  const a = broker.request({ toolName: "Bash", input: {}, toolUseId: "t1" });
  const b = broker.request({ toolName: "Edit", input: {}, toolUseId: "t2" });
  assert.equal(broker.discardAll("頭脳プロセスが終了しました"), 2);
  assert.equal((await a).behavior, "deny");
  assert.equal((await b).behavior, "deny");
  assert.equal(broker.pendingCount, 0);
  assert.deepEqual(
    c.settled.map((s) => s.outcome),
    ["discarded", "discarded"],
  );
  assert.match(c.notices[0] ?? "", /2 件を破棄/);
});

test("質問の一部だけ答えたあと破棄されると、残りのスロットだけが discarded になる", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  const input = {
    questions: [
      { question: "Q1", options: [{ label: "A" }] },
      { question: "Q2", options: [{ label: "B" }] },
    ],
  };
  const p = broker.request({ toolName: ASK_USER_QUESTION_TOOL, input, toolUseId: "q" });
  broker.answer("q#0", { choice: ["A"] });
  broker.discardAll("新しい会話を開始しました");
  assert.equal((await p).behavior, "deny");
  assert.deepEqual(
    c.settled.map((s) => `${s.id}:${s.outcome}`),
    ["q#0:allowed", "q#1:discarded"],
  );
});

test("同一 toolUseId の二重要求: UI 発火は 1 回・pendingCount 1・settled 1 回で 0 に戻る", async () => {
  // 実事象（2026-09-08）: MCP 側の permission_prompt が同じ tool_use_id で 2 回届き、
  // question が 2 本 UI へ出たのに settled は 1 回しか来ず、pending が 1 のまま残った。
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  const input = { questions: [{ question: "Q1", options: [{ label: "A" }] }] };
  const first = broker.request({ toolName: ASK_USER_QUESTION_TOOL, input, toolUseId: "dup" });
  const second = broker.request({ toolName: ASK_USER_QUESTION_TOOL, input, toolUseId: "dup" });
  assert.equal(c.questions.length, 1, "UI へは 1 回だけ出す");
  assert.equal(broker.pendingCount, 1);
  assert.deepEqual(broker.pendingIds(), ["dup#0"]);

  broker.answer("dup#0", { choice: ["A"] });
  const a = await first;
  const b = await second;
  // 2 本目の HTTP にも同じ決定を返す（片方だけ宙に浮かせない）。
  assert.deepEqual(a, b);
  assert.equal(a.behavior, "allow");
  assert.equal(c.settled.length, 1);
  assert.equal(broker.pendingCount, 0);
});

test("二重要求: 片方の接続だけ切れても保留は残り、全部切れたときに 1 回だけ破棄される", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const first = broker.request({ toolName: "Bash", input: {}, toolUseId: "dup" }, ac1.signal);
  const second = broker.request({ toolName: "Bash", input: {}, toolUseId: "dup" }, ac2.signal);
  assert.equal(c.permissions.length, 1);

  ac1.abort();
  assert.equal((await first).behavior, "deny");
  assert.equal(broker.pendingCount, 1, "もう 1 本の接続が生きているので保留は残る");
  assert.equal(c.settled.length, 0);

  ac2.abort();
  assert.equal((await second).behavior, "deny");
  assert.equal(broker.pendingCount, 0);
  assert.deepEqual(c.settled.map((s) => s.outcome), ["discarded"]);
});

test("toolUseId が無い要求にも一意の id が振られる", async () => {
  const c = collector();
  const broker = new PermissionBroker(c.handlers);
  broker.request({ toolName: "Bash", input: {}, toolUseId: null });
  broker.request({ toolName: "Bash", input: {}, toolUseId: "" });
  const ids = c.permissions.map((p) => p.id);
  assert.equal(new Set(ids).size, 2, `id が重複している: ${ids.join(",")}`);
});

// ===== 起動引数 =====

test("--permission-prompt-tool は指定したときだけ付き、--permission-mode の前に並ぶ", () => {
  const args = buildClaudeHeadlessArgs({
    model: "opus",
    permissionMode: "auto",
    systemPrompt: null,
    mcpConfigPath: "/tmp/m.json",
    resumeSessionId: null,
    permissionPromptTool: MASTER_PERMISSION_PROMPT_TOOL,
    extraArgs: [],
  });
  const i = args.indexOf("--permission-prompt-tool");
  assert.ok(i > 0);
  assert.equal(args[i + 1], MASTER_PERMISSION_PROMPT_TOOL);

  const without = buildClaudeHeadlessArgs({
    model: "opus",
    permissionMode: "auto",
    systemPrompt: null,
    mcpConfigPath: null,
    resumeSessionId: null,
    extraArgs: [],
  });
  assert.equal(without.includes("--permission-prompt-tool"), false);
});

// ===== ワイヤ写像 / 復元 =====

test("toChatEvent は permissionSettled をそのまま写す", () => {
  const chat = toChatEvent(
    { kind: "permissionSettled", id: "t1", outcome: "discarded", answer: null },
    0.1,
  );
  assert.deepEqual(chat, {
    kind: "permissionSettled",
    id: "t1",
    outcome: "discarded",
    answer: null,
  });
});

test("unsettledRequestIds は未決着の承認/質問だけを古い順に返す", () => {
  const env = (seq: number, event: MasterChatEvent): MasterChatEnvelope => ({ seq, ts: seq, event });
  const ids = unsettledRequestIds([
    env(1, { kind: "permission", id: "a", toolName: "Bash", input: null }),
    env(2, { kind: "permissionSettled", id: "a", outcome: "allowed", answer: "許可" }),
    env(3, { kind: "question", id: "b#0", header: "H", question: "Q", options: [], multi: false }),
    env(4, { kind: "permission", id: "c", toolName: "Edit", input: null }),
    env(5, { kind: "text", text: "hi", partial: false }),
  ]);
  assert.deepEqual(ids, ["b#0", "c"]);
});

test("id が会話を跨いで再利用されても、最後の状態で未決着を判定する", () => {
  const env = (seq: number, event: MasterChatEvent): MasterChatEnvelope => ({ seq, ts: seq, event });
  // 1 回目は決着済み、プロセスが入れ替わって同じ id が再登場（採番が振り出しに戻る）。
  const ids = unsettledRequestIds([
    env(1, { kind: "permission", id: "toolu_1", toolName: "Bash", input: null }),
    env(2, { kind: "permissionSettled", id: "toolu_1", outcome: "allowed", answer: "許可" }),
    env(3, { kind: "session", sessionId: "s2", model: null, apiKeySource: null, mcpServers: [], capabilities: [] }),
    env(4, { kind: "permission", id: "toolu_1", toolName: "Bash", input: null }),
  ]);
  assert.deepEqual(ids, ["toolu_1"]);
});
