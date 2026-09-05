import { createRequire } from "node:module";
import { writeFileSync, appendFileSync } from "node:fs";
const require = createRequire("/Users/yoimaro/workspace/GitHub/ebi-team/package.json");
const pty = require("node-pty");
const REPO="/Users/yoimaro/workspace/GitHub/ebi-team";
const mode = process.argv[2];  // prompt | mcp
const OUTF = process.argv[3];
writeFileSync(OUTF, "");
const base = ["--no-alt-screen","-s","read-only","-a","never","-c","disable_paste_burst=true"];
const mcp = ["-c",`mcp_servers.ebi-control.command="node"`,"-c",`mcp_servers.ebi-control.args=["${REPO}/dist/server/mcp/control-server.js"]`,"-c",`mcp_servers.ebi-control.cwd="${REPO}"`,"-c",`mcp_servers.ebi-control.env={EBI_CONTROL_URL="http://127.0.0.1:8787",EBI_MCP_ROLE="engineer",EBI_ID="poc-codex",EBI_NOTIFY_SUBSCRIBE="off"}`];
const args = mode === "prompt" ? [...base, "テストです。READY-0 とだけ返してください"] : [...base, ...mcp];
const t0=Date.now();
const p = pty.spawn("codex", args, { name:"xterm-256color", cols:100, rows:30, cwd: process.cwd(), env: process.env });
console.log("pid", p.pid, mode);
p.onData(d => appendFileSync(OUTF, d));
p.onExit(e => { console.log("EXIT t=", Date.now()-t0, JSON.stringify(e)); process.exit(0); });
setTimeout(() => { console.log("TIMEUP alive t=", Date.now()-t0); try{p.kill();}catch{}; setTimeout(()=>process.exit(0),500); }, 15000);
