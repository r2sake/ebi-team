import { createRequire } from "node:module";
import { writeFileSync, appendFileSync } from "node:fs";
const require = createRequire("/Users/yoimaro/workspace/GitHub/ebi-team/package.json");
const pty = require("node-pty");
const ANSWER = process.argv[2] || "none";           // none | enter | one
const OUTF = process.argv[3] || "probe.raw";
writeFileSync(OUTF, "");
const t0 = Date.now();
const p = pty.spawn("codex", ["--no-alt-screen","-s","read-only","-a","never","-c","disable_paste_burst=true"], {
  name: "xterm-256color", cols: 100, rows: 30, cwd: process.cwd(), env: process.env,
});
console.log("pid", p.pid);
p.onData(d => appendFileSync(OUTF, d));
p.onExit(e => { console.log("EXIT t=", Date.now()-t0, JSON.stringify(e)); process.exit(0); });
setTimeout(() => {
  if (ANSWER === "enter") { console.log("send enter"); p.write("\r"); }
  if (ANSWER === "one") { console.log("send 1"); p.write("1"); setTimeout(()=>p.write("\r"), 300); }
}, 2500);
setTimeout(() => { console.log("TIMEUP alive t=", Date.now()-t0); try{p.kill();}catch{}; setTimeout(()=>process.exit(0), 500); }, 20000);
