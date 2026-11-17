// セキュアモードの PreToolUse hook（claude の --settings から Bash ごとに呼ばれる）。
//
// 入力（stdin・claude 2.1.322 で実測）:
//   {"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"..."},
//    "tool_use_id":"toolu_...","cwd":"...","permission_mode":"bypassPermissions",...}
// 出力（stdout）:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny",
//    "permissionDecisionReason":"..."}}
//   何も出さずに exit 0 なら通常どおり（判定対象外のコマンド）。
//   bypassPermissions でも deny は効き、allow ならそのまま実行される（実機で確認）。
//
// git push・本番の操作は ebi-team の承認ブローカ（POST /control/secure-approval）へ回し、
// ボスがチャットで許可したときだけ allow を返す。サーバに届かない・壊れた応答は deny に倒す。
//
// 起動: node <dist>/mcp/secure-hook.js --url http://127.0.0.1:8787
//       （dev は node --import <tsx> src/mcp/secure-hook.ts --url ...）

import { classifySecureCommand } from "../shared/secureCommand.ts";
import { postLongPoll } from "./longPoll.ts";

interface HookInput {
  tool_name?: unknown;
  tool_input?: { command?: unknown } | null;
  tool_use_id?: unknown;
  cwd?: unknown;
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

function decide(decision: "allow" | "deny", reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    decide("deny", "セキュアモード: hook の入力を読めなかったため止めました");
    return;
  }
  if (input.tool_name !== "Bash") return;
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const verdict = classifySecureCommand(command);
  if (!verdict) return;
  if (verdict.kind === "deny") {
    decide("deny", `セキュアモードで禁止されています: ${verdict.reason}`);
    return;
  }

  const url = (argValue("--url") ?? process.env.EBI_CONTROL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  const r = await postLongPoll(`${url}/control/secure-approval`, {
    from: process.env.EBI_ID ?? null,
    tool: "Bash",
    label: verdict.label,
    command,
    cwd: typeof input.cwd === "string" ? input.cwd : null,
    toolUseId: typeof input.tool_use_id === "string" ? input.tool_use_id : null,
  });
  if (!r || !r.ok) {
    decide("deny", `セキュアモード: 承認サーバに届かないため止めました（${r ? r.error : "URL 不正"}）`);
    return;
  }
  const data = r.data as { behavior?: unknown; message?: unknown } | undefined;
  if (data?.behavior === "allow") {
    decide("allow", `ボスがチャットで承認しました: ${verdict.label}`);
    return;
  }
  const msg = typeof data?.message === "string" && data.message ? data.message : "ボスが承認しませんでした";
  decide("deny", `セキュアモード: ${verdict.label} は承認されませんでした（${msg}）`);
}

main().catch((err) => {
  decide("deny", `セキュアモード: hook の内部エラーのため止めました（${(err as Error).message}）`);
});
