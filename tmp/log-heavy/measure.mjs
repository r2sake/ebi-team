import { chromium } from "/Users/yoimaro/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
const out = [];
import { readdirSync } from "node:fs";
const MAX_N = Math.max(
  ...readdirSync("tmp/log-heavy")
    .map((f) => /^events-(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((mm) => Number(mm[1])),
);
for (const n of [400, 1000, 4000, MAX_N]) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  await p.goto("http://localhost:5175/tmp/log-heavy/harness.html");
  await p.waitForFunction(() => !!window.__measure);
  const r = await p.evaluate((n) => window.__measure(n), n);
  const s = await p.evaluate(() => window.__stream(200));
  const sf = await p.evaluate(() => window.__streamFrame(200));
  out.push({ ...r, stream: s, streamFrame: sf });
  await p.close();
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
