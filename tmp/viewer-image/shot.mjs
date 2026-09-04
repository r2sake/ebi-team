// Playwright で 8799 の UI を開き、画像 viewer / md viewer のスクショを撮る。
import { chromium } from "/Users/yoimaro/.npm/_npx/db89d7302a373f10/node_modules/playwright/index.mjs";
const base = "http://127.0.0.1:8799";
const out = "tmp/viewer-image";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("requestfailed", (r) => errors.push(`requestfailed ${r.url()} ${r.failure()?.errorText}`));
await page.goto(base, { waitUntil: "networkidle" });
// viewer 行（画像）をクリック
await page.getByText("エビ生成画像").first().click();
await page.waitForSelector("img.viewer-img");
const dim = await page.$eval("img.viewer-img", (el) => ({ w: el.naturalWidth, h: el.naturalHeight, src: el.getAttribute("src") }));
console.log("img:", JSON.stringify(dim));
if (dim.w === 0) { console.error("画像が読み込めていない"); process.exitCode = 1; }
await page.screenshot({ path: `${out}/viewer-image-png.png`, fullPage: false });
// md viewer（挙動不変の確認）
await page.getByText("note.md").first().click();
await page.waitForSelector(".viewer-body.md h1");
await page.screenshot({ path: `${out}/viewer-md-unchanged.png` });
console.log("console errors:", errors.length ? errors : "(なし)");
await browser.close();
