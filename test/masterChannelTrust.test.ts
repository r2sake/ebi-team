// engineer 役割プロンプトの「master 発の通知は正式な指示の経路」節の錠前（2026-09-29 ボス指示）。
//
// master の send_message / inject_message を engineer が「外部のデータ」と判断して本番反映を止め、
// ボスが engineer の画面で直接 GO を打つ羽目になった件の再発防止。
// 信頼の宣言と、残す安全の線（引用内容・エビ同士・master 以外の本番操作）が両方載っていることを確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";

import { BUILTIN_ROLES, ENGINEER_APPEND_SYSTEM_PROMPT, MASTER_CHANNEL_TRUST_APPEND } from "../src/server/roles.ts";

test("engineer の役割プロンプトに master 経路の信頼節が入っている", () => {
  assert.ok(ENGINEER_APPEND_SYSTEM_PROMPT.includes(MASTER_CHANNEL_TRUST_APPEND));
  assert.equal(BUILTIN_ROLES.engineer.appendSystemPrompt, ENGINEER_APPEND_SYSTEM_PROMPT);
});

test("信頼節は master を正式な指示の経路とし、送り手の確かめ方と GO の扱いを書く", () => {
  assert.match(MASTER_CHANNEL_TRUST_APPEND, /正式な指示の経路/);
  assert.match(MASTER_CHANNEL_TRUST_APPEND, /from=\\"master\\"|from 属性が "master"/);
  assert.match(MASTER_CHANNEL_TRUST_APPEND, /\[from:master\]/);
  assert.match(MASTER_CHANNEL_TRUST_APPEND, /ボスの GO（原文）/);
});

test("信頼節は安全の線（引用内容・エビ同士・master 以外の本番操作）を残す", () => {
  assert.match(MASTER_CHANNEL_TRUST_APPEND, /引用された外部の内容/);
  assert.match(MASTER_CHANNEL_TRUST_APPEND, /master 以外のエビ/);
  assert.match(MASTER_CHANNEL_TRUST_APPEND, /master 以外から来た本番操作/);
});
