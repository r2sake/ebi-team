import { createRequire } from "node:module";
import { writeFileSync, appendFileSync } from "node:fs";
const require = createRequire("/Users/yoimaro/workspace/GitHub/ebi-team/package.json");
const pty = require("node-pty");
const REPO="/Users/yoimaro/workspace/GitHub/ebi-team";
const term = process.argv[2]; const cols=Number(process.argv[3]); const OUTF=process.argv[4];
writeFileSync(OUTF,"");
const args=["--no-alt-screen","-s","read-only","-a","never","-c","disable_paste_burst=true",
 "-c",`mcp_servers.ebi-control.command="node"`,"-c",`mcp_servers.ebi-control.args=["${REPO}/dist/server/mcp/control-server.js"]`,
 "-c",`mcp_servers.ebi-control.cwd="${REPO}"`,
 "-c",`mcp_servers.ebi-control.env={EBI_CONTROL_URL="http://127.0.0.1:8787",EBI_MCP_ROLE="engineer",EBI_ID="poc-codex",EBI_NOTIFY_SUBSCRIBE="off"}`,
 "これは接続テストです。ツールは使わず、次の一語だけを返してください: READY-0"];
const t0=Date.now();
const p=pty.spawn("codex",args,{name:term,cols,rows:30,cwd:process.cwd(),env:{...process.env,CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN:"1"}});
console.log("pid",p.pid,term,cols);
p.onData(d=>appendFileSync(OUTF,d));
p.onExit(e=>{console.log("EXIT t=",Date.now()-t0,JSON.stringify(e));process.exit(0);});
setTimeout(()=>{console.log("TIMEUP alive t=",Date.now()-t0);try{p.kill();}catch{};setTimeout(()=>process.exit(0),500);},15000);
