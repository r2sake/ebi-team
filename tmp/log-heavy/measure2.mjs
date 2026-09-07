import { chromium } from "/Users/yoimaro/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
const out = [];
for (const n of [400, 22710]) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  await p.goto("http://localhost:5175/tmp/log-heavy/harness.html");
  await p.waitForFunction(() => !!window.__streamNoFollow);
  const base = await p.evaluate((n) => window.__measure(n), n);
  const follow = await p.evaluate(() => window.__stream(200));
  const noFollow = await p.evaluate(() => window.__streamNoFollow(200));
  const scroll = await p.evaluate(() => window.__scrollCost(200));
  out.push({ n, items: base.items, follow: follow.perTokenMs, noFollow: noFollow.perTokenMs, scrollOnly: scroll.perCallMs });
  await p.close();
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
