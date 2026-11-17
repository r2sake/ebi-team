// セキュアモードの hook（claude の --settings から呼ばれる）。PreToolUse と PermissionRequest の両方を受ける。
//
// 入力（stdin・claude 2.1.322 で実測）:
//   PreToolUse:        {"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"..."},
//                       "tool_use_id":"toolu_...","cwd":"...","permission_mode":"bypassPermissions",...}
//   PermissionRequest: {"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{...},
//                       "permission_suggestions":[...],"cwd":"...",...}（tool_use_id は無い）
// 出力（stdout）:
//   PreToolUse:        {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny",
//                       "permissionDecisionReason":"..."}}
//   PermissionRequest: {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
//                       "decision":{"behavior":"allow"|"deny","message"?:"..."}}}
//   何も出さずに exit 0 なら通常どおり（判定対象外）。
//   bypassPermissions でも PreToolUse の deny は効き、allow ならそのまま実行される（実機で確認）。
//
// git push・本番の操作（PreToolUse）と権限の確認（PermissionRequest）は ebi-team の承認ブローカ
// （POST /control/secure-approval）へ回し、ボスがチャットで許可したときだけ allow を返す。
// サーバに届かない・壊れた応答は deny に倒す。制御 API へはエビごとのトークン（EBI_CONTROL_TOKEN）で繋ぐ。
//
// 起動: node <dist>/mcp/secure-hook.js --url http://127.0.0.1:8787
//       （dev は node --import <tsx> src/mcp/secure-hook.ts --url ...）

import { classifySecureCommand } from "../shared/secureCommand.ts";
import { CONTROL_TOKEN_HEADER } from "../shared/controlToken.ts";
import { postLongPoll } from "./longPoll.ts";

interface HookInput {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: Record<string, unknown> | null;
  tool_use_id?: unknown;
  cwd?: unknown;
}

type Event = "PreToolUse" | "PermissionRequest";

/** 権限の確認を hook で扱わず、通常の流れに任せるツール（master の「ボスに聞く」を壊さない）。 */
const PASS_THROUGH_TOOLS = new Set(["AskUserQuestion"]);

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

function decide(event: Event, decision: "allow" | "deny", reason: string): void {
  const out =
    event === "PreToolUse"
      ? { hookEventName: event, permissionDecision: decision, permissionDecisionReason: reason }
      : {
          hookEventName: event,
          decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: reason },
        };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 承認バブルに出す 1 行（Bash はコマンド、ファイル系はパス、それ以外は入力の JSON を詰める）。 */
function describeInput(tool: string, input: Record<string, unknown> | null | undefined): string {
  if (!input) return tool;
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return `${tool}: ${input.file_path}`;
  if (typeof input.url === "string") return `${tool}: ${input.url}`;
  const json = JSON.stringify(input);
  return json.length > 400 ? `${json.slice(0, 400)}…` : json;
}

async function askBoss(
  event: Event,
  body: { label: string; command: string; cwd: string | null; toolUseId: string | null; kind: string },
): Promise<void> {
  const url = (argValue("--url") ?? process.env.EBI_CONTROL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const token = process.env.EBI_CONTROL_TOKEN;
  const r = await postLongPoll(
    `${url}/control/secure-approval`,
    { from: process.env.EBI_ID ?? null, tool: body.kind, ...body },
    undefined,
    token ? { [CONTROL_TOKEN_HEADER]: token } : undefined,
  );
  if (!r || !r.ok) {
    decide(event, "deny", `セキュアモード: 承認サーバに届かないため止めました（${r ? r.error : "URL 不正"}）`);
    return;
  }
  const data = r.data as { behavior?: unknown; message?: unknown } | undefined;
  if (data?.behavior === "allow") {
    decide(event, "allow", `ボスがチャットで承認しました: ${body.label}`);
    return;
  }
  const msg = typeof data?.message === "string" && data.message ? data.message : "ボスが承認しませんでした";
  decide(event, "deny", `セキュアモード: ${body.label} は承認されませんでした（${msg}）`);
}

/** 今処理している hook の種類（内部エラー時に正しい形で deny を返すため）。 */
let currentEvent: Event = "PreToolUse";

async function main(): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    decide("PreToolUse", "deny", "セキュアモード: hook の入力を読めなかったため止めました");
    return;
  }
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : null;

  if (input.hook_event_name === "PermissionRequest") {
    currentEvent = "PermissionRequest";
    if (PASS_THROUGH_TOOLS.has(tool)) return;
    await askBoss("PermissionRequest", {
      kind: "permission",
      label: `権限の確認: ${tool || "不明なツール"}`,
      command: describeInput(tool, input.tool_input),
      cwd,
      toolUseId: null,
    });
    return;
  }

  // PreToolUse（matcher は Bash）
  if (tool !== "Bash") return;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const verdict = classifySecureCommand(command);
  if (!verdict) return;
  if (verdict.kind === "deny") {
    decide("PreToolUse", "deny", `セキュアモードで禁止されています: ${verdict.reason}`);
    return;
  }
  await askBoss("PreToolUse", {
    kind: "Bash",
    label: verdict.label,
    command,
    cwd,
    toolUseId: typeof input.tool_use_id === "string" ? input.tool_use_id : null,
  });
}

main().catch((err) => {
  decide(currentEvent, "deny", `セキュアモード: hook の内部エラーのため止めました（${(err as Error).message}）`);
});
