// Regenerate the three README screenshots from assets/example-report.html.
// Drives a local Chromium via playwright-core (no MCP). Run after render-example.mjs
// whenever the design changes:
//   npm i -g playwright-core   # or install in scope; browsers via `npx playwright install chromium`
//   node scripts/screenshot-example.mjs
// Override the browser binary with CHROMIUM_EXE if the default path differs.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const SKILL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ASSETS = path.join(SKILL, "assets");
const REPORT = pathToFileURL(path.join(ASSETS, "example-report.html")).href;
const EXE =
  process.env.CHROMIUM_EXE ||
  "C:/Users/sate/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe";

// [name, startAnchorId|null, endAnchorId|null, endCardH3?]
// Start at top(startAnchorId)-pad (or page top). End at bottom of the card whose
// <h3> matches endCardH3, else at top(endAnchorId)-gap.
const SHOTS = [
  ["screenshot-overview", null, null, "Daily spend calendar"],
  ["screenshot-token-economics", "sec-token-economics", null, "Token composition by day"],
  ["screenshot-by-project", "sec-by-project", "sec-models"],
];

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await page.goto(REPORT, { waitUntil: "networkidle" });
// Hide sticky/fixed chrome, and flatten the position:fixed ambient glow to the
// solid --paper base. On a full-height capture viewport the glow gradient would
// stretch and cool the deeper sections, giving each screenshot a different tint.
await page.addStyleTag({
  content: ".topbar,.jump-nav{display:none!important} #glow,body::before{display:none!important}",
});
await page.waitForTimeout(1800); // let charts + reveal animations settle
// Grow the viewport to the full document height so clip regions past the first
// viewport still land inside the captured surface (clip is page-absolute).
const fullH = await page.evaluate(() => document.body.scrollHeight);
await page.setViewportSize({ width: 1280, height: Math.min(fullH, 16000) });
await page.waitForTimeout(400);

const topOf = (id) =>
  page.evaluate((i) => {
    if (!i) return 0;
    const r = document.getElementById(i).getBoundingClientRect();
    return r.top + window.scrollY;
  }, id);

const cardBottom = (h3text) =>
  page.evaluate((t) => {
    let b = 0;
    document.querySelectorAll("h3").forEach((h) => {
      if (h.textContent.trim() === t) {
        b = Math.round(h.closest(".card").getBoundingClientRect().bottom + window.scrollY);
      }
    });
    return b;
  }, h3text);

for (const [name, start, end, endCardH3] of SHOTS) {
  let y = (await topOf(start)) - (start ? 28 : 0);
  if (y < 0) y = 0;
  const endY = endCardH3 ? (await cardBottom(endCardH3)) + 14 : (await topOf(end)) - 32;
  const h = Math.round(endY - y);
  await page.screenshot({ path: path.join(ASSETS, `${name}.png`), clip: { x: 0, y, width: 1280, height: h } });
  console.log(name, "->", h, "px tall");
}

await browser.close();
