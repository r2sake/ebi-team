// セキュアモード（security.ts / secureCommand.ts / secure-hook.ts / 承認の経路）のテスト。
//
// 実行: node --import tsx --test test/security.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  SecureModeRejection,
  buildSecureSettings,
  clampForSecurity,
  isSecretEnvKey,
  resolveApprovalTimeoutMs,
  resolveSecurityMode,
  secureApprovalTitle,
  shellQuote,
  stripSecretEnv,
} from "../src/server/security.ts";
import { classifySecureCommand } from "../src/shared/secureCommand.ts";
import { resolveSummaryEngine, secureSummaryArgs } from "../src/server/supervisor.ts";
import { PermissionBroker } from "../src/server/master/permission.ts";
import { createControlApi } from "../src/server/control.ts";
import { Registry } from "../src/server/registry.ts";

// ===== モードの解決 =====

test("モード: env > config > standard。env が config に勝つ", () => {
  assert.deepEqual(resolveSecurityMode({}), { mode: "standard", source: "default", warning: null });
  assert.equal(resolveSecurityMode({ config: "secure" }).mode, "secure");
  assert.equal(resolveSecurityMode({ config: "secure" }).source, "config");
  const r = resolveSecurityMode({ env: "standard", config: "secure" });
  assert.equal(r.mode, "standard");
  assert.equal(r.source, "env");
  assert.equal(resolveSecurityMode({ env: "", config: "secure" }).mode, "secure");
});

test("モード: 不正値は安全側（secure）に倒して警告を出す", () => {
  const r = resolveSecurityMode({ env: "secur" });
  assert.equal(r.mode, "secure");
  assert.match(r.warning ?? "", /不正/);
});

// ===== 秘密の env =====

test("秘密の env を抜く（EBI_AUTH_TOKEN・CLOUDFLARE_*・*_TOKEN 等）。値は返さない", () => {
  const { env, dropped } = stripSecretEnv({
    PATH: "/usr/bin",
    HOME: "/home/boss",
    EBI_ID: "engineer-1",
    EBI_CONTROL_URL: "http://127.0.0.1:8787",
    EBI_AUTH_TOKEN: "s1",
    CLOUDFLARE_API_TOKEN: "s2",
    CLOUDFLARE_ACCOUNT_ID: "s3",
    CF_API_KEY: "s4",
    GH_TOKEN: "s5",
    STRIPE_SECRET_KEY: "s6",
    DISCORD_WEBHOOK_URL: "s7",
    DATABASE_URL: "s8",
    EMDASH_PAT: "s9",
    CLAUDE_CODE_OAUTH_TOKEN: "keep",
    OPENAI_API_KEY: "keep2",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "EBI_CONTROL_URL",
    "EBI_ID",
    "HOME",
    "OPENAI_API_KEY",
    "PATH",
  ]);
  assert.equal(dropped.length, 9);
  assert.ok(!JSON.stringify(dropped).includes("s1"));
});

test("CLI 自身の認証に要る env は残す（落とすと起動しない）", () => {
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
    assert.equal(isSecretEnvKey(k), false, k);
  }
});

// ===== 起動引数の締め付け =====

const SETTINGS = "/srv/ebi/.ebi-team/secure-settings.json";

test("standard では引数を一切変えない", () => {
  const args = ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
  const r = clampForSecurity(
    { backend: "claude", args, requestedPermissionMode: "bypassPermissions", settingsPath: SETTINGS },
    "standard",
  );
  assert.deepEqual(r.args, args);
  assert.deepEqual(r.notes, []);
});

test("claude: --dangerously-skip-permissions を外し --settings を足す（bypass の役割既定は残す）", () => {
  const r = clampForSecurity(
    {
      backend: "claude",
      args: ["--model", "opus", "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"],
      settingsPath: SETTINGS,
    },
    "secure",
  );
  assert.deepEqual(r.args, ["--model", "opus", "--permission-mode", "bypassPermissions", "--settings", SETTINGS]);
  assert.equal(r.notes.length, 1);
});

test("制御 API / MCP からの明示の bypassPermissions 要求は拒否する", () => {
  assert.throws(
    () =>
      clampForSecurity(
        { backend: "claude", args: [], requestedPermissionMode: "bypassPermissions", settingsPath: SETTINGS },
        "secure",
      ),
    SecureModeRejection,
  );
  // 明示でも緩めない指定は通る
  const ok = clampForSecurity(
    { backend: "claude", args: [], requestedPermissionMode: "acceptEdits", settingsPath: SETTINGS },
    "secure",
  );
  assert.deepEqual(ok.args, ["--settings", SETTINGS]);
});

test("codex: danger-full-access を workspace-write に下げ、bypass 系フラグを外す", () => {
  const r = clampForSecurity(
    {
      backend: "codex",
      args: [
        "--no-alt-screen",
        "-s",
        "danger-full-access",
        "-a",
        "never",
        "--sandbox=danger-full-access",
        "-c",
        'sandbox_mode="danger-full-access"',
        "--dangerously-bypass-approvals-and-sandbox",
      ],
      settingsPath: SETTINGS,
    },
    "secure",
  );
  assert.deepEqual(r.args, [
    "--no-alt-screen",
    "-s",
    "workspace-write",
    "-a",
    "never",
    "--sandbox=workspace-write",
    "-c",
    'sandbox_mode="workspace-write"',
  ]);
  // codex には --settings を足さない（claude 方言）
  assert.ok(!r.args.includes("--settings"));
});

test("gemini: 書き込み役は起こさない。読み取り役（plan）は yolo を下げて通す", () => {
  assert.throws(
    () =>
      clampForSecurity(
        { backend: "gemini", args: [], permissionMode: "bypassPermissions", settingsPath: SETTINGS },
        "secure",
      ),
    SecureModeRejection,
  );
  assert.throws(
    () => clampForSecurity({ backend: "gemini", args: [], permissionMode: null, settingsPath: SETTINGS }, "secure"),
    SecureModeRejection,
  );
  const r = clampForSecurity(
    {
      backend: "gemini",
      args: ["-m", "gemini-flash", "--approval-mode", "yolo", "--yolo"],
      permissionMode: "plan",
      settingsPath: SETTINGS,
    },
    "secure",
  );
  assert.deepEqual(r.args, ["-m", "gemini-flash", "--approval-mode", "default"]);
});

test("スタブ起動（backend=null）の引数には触らない", () => {
  const r = clampForSecurity({ backend: null, args: ["-c", "echo hi"], settingsPath: SETTINGS }, "secure");
  assert.deepEqual(r.args, ["-c", "echo hi"]);
});

// ===== secure 設定（--settings） =====

test("secure 設定: 秘密の Read・設定の Edit・WebFetch・外部送信を deny し、Bash の hook を掛ける", () => {
  const s = buildSecureSettings({
    configPath: "/srv/ebi/ebi-team.config.json",
    settingsPath: SETTINGS,
    hookScriptPath: "/srv/ebi/dist/server/mcp/secure-hook.js",
    hookCommand: "node /srv/ebi/dist/server/mcp/secure-hook.js --url http://127.0.0.1:8787",
    approvalTimeoutMs: 600_000,
  }) as {
    permissions: { deny: string[] };
    hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[] };
  };
  const deny = s.permissions.deny;
  for (const rule of [
    "Read(**/.env)",
    "Read(**/*.env)",
    "Read(~/.secrets/**)",
    "Read(~/.cloudflare/**)",
    "Read(~/.claude/channels/**)",
    "Read(~/Library/Preferences/.wrangler/**)",
    "Edit(//srv/ebi/ebi-team.config.json)",
    "Edit(~/.claude/settings.json)",
    `Edit(/${SETTINGS})`,
    "WebFetch",
    "Bash(gh pr comment:*)",
    "Bash(gh issue comment:*)",
    "mcp__plugin_discord_discord",
    "mcp__plugin_slack_slack",
  ]) {
    assert.ok(deny.includes(rule), rule);
  }
  // git push は deny にしない（hook でチャット承認に回すため。deny にすると承認しても通らない）
  assert.ok(!deny.some((r) => r.includes("git push")));
  const pre = s.hooks.PreToolUse[0]!;
  assert.equal(pre.matcher, "Bash");
  assert.equal(pre.hooks[0]!.type, "command");
  // hook の timeout（秒）は承認の自動拒否より長い
  assert.ok(pre.hooks[0]!.timeout > 600);
});

test("shellQuote: 空白・引用符を含むパスを 1 引数にする", () => {
  assert.equal(shellQuote("/usr/bin/node"), "/usr/bin/node");
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`);
});

test("承認待ちの既定は 10 分・env で変えられる", () => {
  assert.equal(resolveApprovalTimeoutMs(undefined), 600_000);
  assert.equal(resolveApprovalTimeoutMs("1500"), 1500);
  assert.equal(resolveApprovalTimeoutMs("abc"), 600_000);
  assert.equal(secureApprovalTitle("engineer-3", "git push"), "git push（engineer-3・セキュアモード）");
});

// ===== Bash コマンドの判定 =====

test("判定: git push・本番の操作はチャット承認に回す", () => {
  for (const cmd of [
    "git push",
    "git push origin HEAD",
    "cd repo && git push -u origin feat/x",
    "git -C ../repo push",
    "git -c core.sshCommand=ssh push --force",
    "gh pr merge 12 --squash",
    "npx wrangler deploy",
    "wrangler pages deploy dist",
    "wrangler d1 execute DB --remote --command 'select 1'",
    "echo x | wrangler secret put API_KEY",
    "npm run deploy:prd",
    "node scripts/deploy.mjs --all-active",
  ]) {
    assert.equal(classifySecureCommand(cmd)?.kind, "approval", cmd);
  }
});

test("判定: 外部送信と秘密への言及は承認の余地なく止める", () => {
  for (const cmd of [
    "gh pr comment 12 --body hi",
    "gh issue comment 3 -b x",
    "curl -X POST https://discord.com/api/webhooks/1/abc -d '{}'",
    "curl https://hooks.slack.com/services/T/B/x",
    "cat .env",
    "cat ./apps/web/.env.local",
    "grep TOKEN prod.env",
    "cat ~/.secrets/cf",
    "ls $HOME/.cloudflare",
    "cat ~/Library/Preferences/.wrangler/config/default.toml",
    "cat .dev.vars",
    "ls ~/.claude/channels/discord",
  ]) {
    assert.equal(classifySecureCommand(cmd)?.kind, "deny", cmd);
  }
});

test("判定: 普段の作業コマンドは当てない（誤検知で作業を止めない）", () => {
  for (const cmd of [
    "git status",
    "git commit -m 'push の説明'",
    "git log --oneline",
    "npm test",
    "gh pr create --title x --body y",
    "gh pr view 12",
    "cat .env.example",
    "cp .env.sample config.sample",
    "node -e 'console.log(process.env.HOME)'",
    "wrangler dev",
    "wrangler d1 execute DB --local --command 'select 1'",
    "ls .envrc",
  ]) {
    assert.equal(classifySecureCommand(cmd), null, cmd);
  }
});

// ===== supervisor（ワンショット要約） =====

test("supervisor: secure では claude に --settings を足し、プロンプトは最後のまま", () => {
  const engine = resolveSummaryEngine({});
  const args = secureSummaryArgs(engine, "PROMPT", { mode: "secure", settingsPath: SETTINGS });
  assert.equal(args.at(-1), "PROMPT");
  const i = args.indexOf("--settings");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], SETTINGS);
  const plain = secureSummaryArgs(engine, "PROMPT", { mode: "standard", settingsPath: null });
  assert.ok(!plain.includes("--settings"));
});

// ===== 承認の経路 =====

test("ブローカ: abort の理由（自動拒否の文言）がそのまま拒否理由になる", async () => {
  const settled: string[] = [];
  const broker = new PermissionBroker({
    onPermission: () => {},
    onQuestion: () => {},
    onSettled: (ev) => settled.push(ev.outcome),
    onNotice: () => {},
  });
  const ac = new AbortController();
  const p = broker.request({ toolName: "git push（engineer-1・セキュアモード）", input: {}, toolUseId: null }, ac.signal);
  ac.abort("10 分応答が無かったため自動で拒否しました");
  const d = await p;
  assert.deepEqual(d, { behavior: "deny", message: "10 分応答が無かったため自動で拒否しました" });
  assert.deepEqual(settled, ["discarded"]);
});

test("ブローカ: ボスが許可したときだけ allow（allow 未指定は拒否）", async () => {
  const ids: string[] = [];
  const broker = new PermissionBroker({
    onPermission: (ev) => ids.push(ev.id),
    onQuestion: () => {},
    onSettled: () => {},
    onNotice: () => {},
  });
  const p1 = broker.request({ toolName: "git push", input: { command: "git push" }, toolUseId: "secure-a" });
  broker.answer("secure-a", {});
  assert.equal((await p1).behavior, "deny");
  const p2 = broker.request({ toolName: "git push", input: { command: "git push" }, toolUseId: "secure-b" });
  broker.answer("secure-b", { allow: true });
  assert.equal((await p2).behavior, "allow");
});

type ApprovalFn = NonNullable<Parameters<typeof createControlApi>[0]["requestSecureApproval"]>;

async function withControl<T>(
  requestSecureApproval: ApprovalFn | null,
  fn: (url: string) => Promise<T>,
): Promise<T> {
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
    resyncChatPending: null,
    requestSecureApproval,
    requestFileEdit: null,
    todos: null,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await handle(req, res, url.pathname, url.searchParams);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("制御 API: standard（null）では 404・command 欠落は 400・決定をそのまま返す", async () => {
  await withControl(null, async (url) => {
    const res = await fetch(`${url}/control/secure-approval`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
  });
  const seen: unknown[] = [];
  await withControl(
    async (req) => {
      seen.push(req);
      return { behavior: "allow" };
    },
    async (url) => {
      const bad = await fetch(`${url}/control/secure-approval`, { method: "POST", body: "{}" });
      assert.equal(bad.status, 400);
      const res = await fetch(`${url}/control/secure-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "engineer-1", label: "git push", command: "git push", cwd: "/w" }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { behavior: "allow" });
    },
  );
  assert.deepEqual(seen, [{ from: "engineer-1", label: "git push", command: "git push", cwd: "/w", toolUseId: null }]);
});

// ===== hook スクリプト（実プロセス） =====

const HOOK = join(import.meta.dirname, "..", "src", "mcp", "secure-hook.ts");

function runHook(stdin: unknown, url: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", HOOK, "--url", url], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolve(out));
    p.stdin.end(JSON.stringify(stdin));
  });
}

function bashInput(command: string): unknown {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_x",
    cwd: "/w",
    permission_mode: "bypassPermissions",
  };
}

function decisionOf(out: string): { permissionDecision: string; permissionDecisionReason: string } | null {
  if (!out.trim()) return null;
  return (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } })
    .hookSpecificOutput;
}

test("hook: 判定対象外は何も出さない・外部送信は承認を待たずに deny", async () => {
  // サーバ不要（どちらも承認ブローカへ行かない）
  assert.equal(decisionOf(await runHook(bashInput("git status"), "http://127.0.0.1:9")), null);
  assert.equal(decisionOf(await runHook({ tool_name: "Read", tool_input: {} }, "http://127.0.0.1:9")), null);
  const d = decisionOf(await runHook(bashInput("gh pr comment 1 -b x"), "http://127.0.0.1:9"));
  assert.equal(d?.permissionDecision, "deny");
});

test("hook: git push はボスの決定に従う（allow / deny）。EBI_ID を from に載せる", async () => {
  let decision: unknown = { behavior: "allow" };
  const reqs: unknown[] = [];
  await withControl(
    async (req) => {
      reqs.push(req);
      return decision;
    },
    async (url) => {
      const a = decisionOf(await runHook(bashInput("git push origin HEAD"), url, { EBI_ID: "engineer-7" }));
      assert.equal(a?.permissionDecision, "allow");
      decision = { behavior: "deny", message: "ボスが拒否しました" };
      const b = decisionOf(await runHook(bashInput("git push"), url, { EBI_ID: "engineer-7" }));
      assert.equal(b?.permissionDecision, "deny");
      assert.match(b?.permissionDecisionReason ?? "", /ボスが拒否しました/);
    },
  );
  assert.equal((reqs[0] as { from: string }).from, "engineer-7");
  assert.equal((reqs[0] as { toolUseId: string }).toolUseId, "toolu_x");
});

test("hook: 承認サーバに届かないときは deny に倒す（黙って実行させない）", async () => {
  const d = decisionOf(await runHook(bashInput("git push"), "http://127.0.0.1:9"));
  assert.equal(d?.permissionDecision, "deny");
  assert.match(d?.permissionDecisionReason ?? "", /届かない/);
});

// ===== 追加要件（#1285）: engineer の既定権限・PermissionRequest・個別トークン・セッション・cwd =====

import { securePermissionMode, isPathUnderRoots, assertSecureCwd } from "../src/server/security.ts";
import {
  ControlTokenStore,
  callerMayActAs,
  decideSecureControlAccess,
} from "../src/server/controlAuth.ts";
import {
  SessionStore,
  authorize,
  buildAuthCookie,
  isHttpsRequest,
  loginPageHtml,
} from "../src/server/auth.ts";
import { BUILTIN_ROLES, registerCustomRoles, resolveRole } from "../src/server/roles.ts";
import { CONTROL_TOKEN_HEADER } from "../src/shared/controlToken.ts";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

test("permission: secure では明示されていない bypass（組込み engineer の既定）を auto に下げる", () => {
  const base = { requested: null, roleExplicit: false, fallback: "auto" as const };
  assert.equal(securePermissionMode("secure", { ...base, roleMode: "bypassPermissions" }), "auto");
  assert.equal(securePermissionMode("standard", { ...base, roleMode: "bypassPermissions" }), "bypassPermissions");
  // config で明示した bypass は opt-in として残す
  assert.equal(
    securePermissionMode("secure", { ...base, roleMode: "bypassPermissions", roleExplicit: true }),
    "bypassPermissions",
  );
  // 明示要求はそのまま（bypass の要求は clampForSecurity が別途拒否する）
  assert.equal(securePermissionMode("secure", { ...base, roleMode: "bypassPermissions", requested: "plan" }), "plan");
  assert.equal(securePermissionMode("secure", { ...base, roleMode: "acceptEdits" }), "acceptEdits");
});

test("roles: config に permissionMode を書いた役割だけ permissionModeExplicit が立つ", () => {
  assert.equal(BUILTIN_ROLES.engineer!.permissionModeExplicit, undefined);
  registerCustomRoles({
    "sec-test-a": { permissionMode: "bypassPermissions" },
    "sec-test-b": {},
  });
  assert.equal(resolveRole("sec-test-a")?.permissionModeExplicit, true);
  assert.equal(resolveRole("sec-test-b")?.permissionModeExplicit, undefined);
});

test("secure 設定: 権限の確認（PermissionRequest）も同じ hook でチャット承認へ回す", () => {
  const s = buildSecureSettings({
    configPath: "/c.json",
    settingsPath: SETTINGS,
    hookScriptPath: "/h.js",
    hookCommand: "node /h.js",
    approvalTimeoutMs: 1000,
  }) as { hooks: Record<string, { matcher: string; hooks: { command: string }[] }[]> };
  assert.equal(s.hooks.PermissionRequest?.[0]?.matcher, "*");
  assert.equal(s.hooks.PermissionRequest?.[0]?.hooks[0]?.command, "node /h.js");
});

test("制御 API: engineer のトークンでは spawn / inject / send / kill を拒否し、配送の足回りは通す", () => {
  const eng = { agentId: "engineer-1", role: "engineer" as const };
  const v = (method: string, pathname: string, caller: typeof eng | null, extra?: Partial<{ browser: boolean; remoteAuthed: boolean }>) =>
    decideSecureControlAccess({ method, pathname, caller, browser: false, remoteAuthed: false, ...extra });
  for (const p of ["/control/spawn", "/control/inject", "/control/send", "/control/kill", "/control/todo-add", "/control/open-viewer"]) {
    const r = v("POST", p, eng);
    assert.equal(r.ok, false, p);
    assert.equal(!r.ok && r.status, 403, p);
  }
  for (const [m, p] of [
    ["POST", "/control/reverse-inject"],
    ["GET", "/control/subscribe"],
    ["POST", "/control/ack"],
    ["GET", "/control/agents"],
    ["POST", "/control/secure-approval"],
  ] as const) {
    assert.equal(v(m, p, eng).ok, true, p);
  }
  // master / fixed（範囲外の固定エビ）は全部通る
  assert.equal(v("POST", "/control/spawn", { agentId: "master", role: "master" } as never).ok, true);
  assert.equal(v("POST", "/control/inject", { agentId: "minaebi", role: "fixed" } as never).ok, true);
  // トークン無し: statusLine の usage だけ通す・他は 401
  assert.equal(v("POST", "/control/usage", null).ok, true);
  const no = v("POST", "/control/spawn", null);
  assert.equal(!no.ok && no.status, 401);
  // ボスのブラウザは画像・添付だけトークン無しで通す
  assert.equal(v("GET", "/control/viewer-file", null, { browser: true }).ok, true);
  assert.equal(v("POST", "/control/spawn", null, { browser: true }).ok, false);
  // 非 loopback で EBI_AUTH_TOKEN 認証済み（ボスのリモート）は従来どおり
  assert.equal(v("POST", "/control/spawn", null, { remoteAuthed: true }).ok, true);
});

test("制御 API: engineer は自分の id でしか名乗れない・トークンは発行し直すと古いものが無効", () => {
  const eng = { agentId: "engineer-1", role: "engineer" as const };
  assert.equal(callerMayActAs(eng, "engineer-1"), true);
  assert.equal(callerMayActAs(eng, "master"), false);
  assert.equal(callerMayActAs({ agentId: "master", role: "master" }, "engineer-9"), true);
  assert.equal(callerMayActAs(null, "anyone"), true);
  const store = new ControlTokenStore();
  const t1 = store.issue("engineer-1", "engineer");
  assert.deepEqual(store.resolve(t1), eng);
  const t2 = store.issue("engineer-1", "engineer");
  assert.equal(store.resolve(t1), null);
  assert.deepEqual(store.resolve(t2), eng);
  store.revoke("engineer-1");
  assert.equal(store.resolve(t2), null);
  assert.equal(store.resolve(""), null);
});

function fakeReq(headers: Record<string, string>, encrypted = false): IncomingMessage {
  return { headers, socket: { remoteAddress: "100.64.0.2", encrypted } } as unknown as IncomingMessage;
}

test("認証: secure の Cookie はセッション ID だけ受け、共有トークンそのもの・?token= は受けない", () => {
  const config = { token: "shared-secret" };
  let now = 1000;
  const sessions = new SessionStore(60_000, () => now);
  const sid = sessions.create();
  const secure = { sessions };
  assert.equal(authorize(fakeReq({ cookie: `ebi_auth=${sid}` }), false, config, undefined, secure).ok, true);
  assert.equal(authorize(fakeReq({ cookie: "ebi_auth=shared-secret" }), false, config, undefined, secure).ok, false);
  assert.equal(
    authorize(fakeReq({}), false, config, new URLSearchParams({ token: "shared-secret" }), secure).ok,
    false,
  );
  assert.equal(authorize(fakeReq({ authorization: "Bearer shared-secret" }), false, config, undefined, secure).ok, true);
  // 有効期限切れ
  now += 60_001;
  assert.equal(authorize(fakeReq({ cookie: `ebi_auth=${sid}` }), false, config, undefined, secure).ok, false);
  // standard は従来どおり（Cookie にトークン・?token= 可）
  assert.equal(authorize(fakeReq({ cookie: "ebi_auth=shared-secret" }), false, config).ok, true);
  assert.equal(authorize(fakeReq({}), false, config, new URLSearchParams({ token: "shared-secret" })).ok, true);
});

test("認証: secure の Cookie は短い Max-Age・HTTPS なら Secure。ログイン画面は localStorage に残さない", () => {
  assert.match(buildAuthCookie("sid", { maxAgeSec: 43200, secure: true }), /Max-Age=43200; Secure$/);
  assert.doesNotMatch(buildAuthCookie("tok"), /Secure/);
  assert.equal(isHttpsRequest(fakeReq({ "x-forwarded-proto": "https" })), true);
  assert.equal(isHttpsRequest(fakeReq({}, true)), true);
  assert.equal(isHttpsRequest(fakeReq({})), false);
  const securePage = loginPageHtml({ rememberToken: false, nonce: "abc" });
  assert.doesNotMatch(securePage, /localStorage\.setItem/);
  assert.match(securePage, /localStorage\.removeItem/);
  assert.match(securePage, /<script nonce="abc">/);
  assert.match(loginPageHtml(), /localStorage\.setItem/);
});

test("cwd: secure では許可ルートの外（symlink 越しを含む）を拒否する", () => {
  const root = mkdtempSync(join(tmpdir(), "ebi-sec-root-"));
  const outside = mkdtempSync(join(tmpdir(), "ebi-sec-out-"));
  try {
    mkdirSync(join(root, "repo"));
    symlinkSync(outside, join(root, "link"));
    assert.equal(isPathUnderRoots(join(root, "repo"), [root]), true);
    assert.equal(isPathUnderRoots(root, [root]), true);
    assert.equal(isPathUnderRoots(outside, [root]), false);
    assert.equal(isPathUnderRoots(join(root, "link"), [root]), false);
    assert.equal(isPathUnderRoots(join(root, "..", "x"), [root]), false);
    assert.throws(() => assertSecureCwd("secure", [outside], [root]), SecureModeRejection);
    assertSecureCwd("standard", [outside], [root]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function permissionInput(tool: string, toolInput: unknown): unknown {
  return { hook_event_name: "PermissionRequest", tool_name: tool, tool_input: toolInput, cwd: "/w", permission_suggestions: [] };
}

function prDecision(out: string): { behavior: string; message?: string } | null {
  if (!out.trim()) return null;
  return (JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; decision: { behavior: string; message?: string } } })
    .hookSpecificOutput.decision;
}

test("hook: 権限の確認（PermissionRequest）はボスの決定に従い、トークンを付けて送る", async () => {
  let decision: unknown = { behavior: "allow" };
  const seen: unknown[] = [];
  await withControl(
    async (req) => {
      seen.push(req);
      return decision;
    },
    async (url) => {
      const a = prDecision(await runHook(permissionInput("Bash", { command: "python3 x.py" }), url, { EBI_CONTROL_TOKEN: "tok-1" }));
      assert.equal(a?.behavior, "allow");
      decision = { behavior: "deny", message: "ボスが拒否しました" };
      const b = prDecision(await runHook(permissionInput("Edit", { file_path: "/w/a.ts" }), url));
      assert.equal(b?.behavior, "deny");
      assert.match(b?.message ?? "", /ボスが拒否しました/);
      // AskUserQuestion は素通し（master の「ボスに聞く」を壊さない）
      assert.equal(prDecision(await runHook(permissionInput("AskUserQuestion", { questions: [] }), url)), null);
    },
  );
  assert.equal(seen.length, 2);
  assert.equal((seen[0] as { label: string }).label, "権限の確認: Bash");
  assert.equal((seen[0] as { command: string }).command, "python3 x.py");
  assert.equal((seen[1] as { command: string }).command, "Edit: /w/a.ts");
});

test("hook: EBI_CONTROL_TOKEN を x-ebi-control-token ヘッダで送る", async () => {
  const headers: string[] = [];
  const server = createServer((req, res) => {
    headers.push(String(req.headers[CONTROL_TOKEN_HEADER] ?? ""));
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ behavior: "allow" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    await runHook(bashInput("git push"), `http://127.0.0.1:${port}`, { EBI_CONTROL_TOKEN: "tok-xyz" });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.deepEqual(headers, ["tok-xyz"]);
});
