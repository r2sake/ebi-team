import { createRequire } from "node:module";
import { writeFileSync, appendFileSync } from "node:fs";
const require = createRequire("/Users/yoimaro/workspace/GitHub/ebi-team/package.json");
const pty = require("node-pty");
const REPO="/Users/yoimaro/workspace/GitHub/ebi-team";
const WT="/Users/yoimaro/workspace/GitHub/ebi-team/.worktrees/ebi-ebiteam-poc-codex";
const trustKey = process.argv[2]; // repo | wt | both
const OUTF=process.argv[3];
writeFileSync(OUTF,"");
const trust=[];
if (trustKey==="repo"||trustKey==="both") trust.push("-c",`projects."${REPO}".trust_level="trusted"`);
if (trustKey==="wt"||trustKey==="both") trust.push("-c",`projects."${WT}".trust_level="trusted"`);
const args=["--no-alt-screen","-s","read-only","-a","never","-c","disable_paste_burst=true","-c","check_for_update_on_startup=false",...trust];
const t0=Date.now();
const p=pty.spawn("codex",args,{name:"xterm-256color",cols:100,rows:30,cwd:WT,env:process.env});
console.log("pid",p.pid,"trust:",trustKey);
p.onData(d=>appendFileSync(OUTF,d));
p.onExit(e=>{console.log("EXIT t=",Date.now()-t0,JSON.stringify(e));process.exit(0);});
setTimeout(()=>{console.log("TIMEUP alive");try{p.kill();}catch{};setTimeout(()=>process.exit(0),500);},10000);
