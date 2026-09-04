import { createRequire } from "node:module";
import { writeFileSync, appendFileSync } from "node:fs";
const require = createRequire("/Users/yoimaro/workspace/GitHub/ebi-team/package.json");
const pty = require("node-pty");
const REPO="/Users/yoimaro/workspace/GitHub/ebi-team";
const WT=REPO+"/.worktrees/ebi-ebiteam-poc-codex";
const OUTF=process.argv[2]||"probe6.raw";
const approvalKey=process.argv[3]||"default_tools_approval_mode";
writeFileSync(OUTF,"");
const args=["--no-alt-screen","-s","read-only","-a","never",
 "-c","disable_paste_burst=true","-c","check_for_update_on_startup=false",
 "-c",`projects={"${REPO}"={trust_level="trusted"},"${WT}"={trust_level="trusted"}}`,
 "-c",`mcp_servers.ebi-control.command="node"`,
 "-c",`mcp_servers.ebi-control.args=["${REPO}/dist/server/mcp/control-server.js"]`,
 "-c",`mcp_servers.ebi-control.cwd="${REPO}"`,
 "-c",`mcp_servers.ebi-control.${approvalKey}="approve"`,
 "-c",`mcp_servers.ebi-control.env={EBI_CONTROL_URL="http://127.0.0.1:8787",EBI_MCP_ROLE="engineer",EBI_ID="poc-codex",EBI_NOTIFY_SUBSCRIBE="off"}`,
 `ebi-control の reply_to_master を1回だけ呼び、message に「[poc-codex] Codex PoC 疎通確認（PR0-C） nonce=${process.argv[4]||"X"}」を入れて送ってください。`];
const t0=Date.now();
const p=pty.spawn("codex",args,{name:"xterm-color",cols:80,rows:30,cwd:WT,env:process.env});
console.log("pid",p.pid,"key",approvalKey);
p.onData(d=>appendFileSync(OUTF,d));
p.onExit(e=>{console.log("EXIT t=",Date.now()-t0,JSON.stringify(e));process.exit(0);});
setTimeout(()=>{console.log("TIMEUP");try{p.kill();}catch{};setTimeout(()=>process.exit(0),400);},75000);
