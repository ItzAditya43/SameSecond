// Renders the link-preview image and store promo tiles with Chromium.
// Usage: node store/make-assets.mjs   (needs CHROMIUM_PATH or /usr/bin/chromium)
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = fileURLToPath(new URL("..", import.meta.url));
const MARK = "data:image/png;base64," + readFileSync(root + "public/brand/mark.png").toString("base64");
const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });

function art(w, h, scale) {
  const s = (n) => Math.round(n * scale);
  return `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@500&family=JetBrains+Mono:wght@600&display=swap">
<style>
  html,body{margin:0;width:${w}px;height:${h}px;background:#11151f;color:#e9edf5;overflow:hidden}
  .wrap{position:absolute;inset:0;padding:${s(64)}px;display:flex;flex-direction:column;justify-content:space-between}
  .brand{display:flex;align-items:center;gap:${s(14)}px;font:700 ${s(34)}px "Bricolage Grotesque",sans-serif}
  .mark{width:${s(48)}px;height:${s(48)}px;display:block}
  .nm{font-weight:700}.nm span{color:#7ab2fa}
  h1{margin:0;font:700 ${s(68)}px/1.02 "Bricolage Grotesque",sans-serif;letter-spacing:-0.02em;max-width:${s(640)}px}
  p{margin:${s(18)}px 0 0;font:500 ${s(26)}px/1.35 Figtree,sans-serif;color:#9ba7bd;max-width:${s(600)}px}
  .players{position:absolute;right:${s(64)}px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:${s(18)}px}
  .pl{width:${s(330)}px;background:#1a2130;border:1px solid #2c374d;border-radius:${s(14)}px;padding:${s(18)}px ${s(20)}px;display:flex;flex-direction:column;gap:${s(12)}px}
  .who{font:500 ${s(18)}px Figtree,sans-serif;color:#9ba7bd;display:flex;justify-content:space-between}
  .who b{color:#7ab2fa;font-weight:500}
  .tc{font:600 ${s(40)}px "JetBrains Mono",monospace;letter-spacing:-0.02em}
  .bar{height:${s(8)}px;border-radius:${s(4)}px;background:#2c374d;overflow:hidden}
  .bar i{display:block;height:100%;width:58%;background:linear-gradient(90deg,#1a72fa,#7ab2fa)}
</style></head><body><div class="wrap">
  <div class="brand"><img class="mark" src="${MARK}" alt=""><b class="nm">Same<span>Second</span></b></div>
  <div><h1>Watch together, on the same second.</h1><p>Everyone plays their own video. No lag, no time limits, free.</p></div>
</div>
<div class="players">
  ${["Aditya · laptop", "Sam · phone", "Kai · Netflix tab"].map((n) => `<div class="pl"><div class="who">${n}<b>in sync</b></div><div class="tc">00:42:17</div><div class="bar"><i></i></div></div>`).join("")}
</div></body></html>`;
}

function tile(w, h) {
  return `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=JetBrains+Mono:wght@600&display=swap">
<style>
  html,body{margin:0;width:${w}px;height:${h}px;background:#11151f;color:#e9edf5;overflow:hidden;font-family:"Bricolage Grotesque",sans-serif}
  .c{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 36px;gap:14px}
  .brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:40px}
  .mark{width:52px;height:52px;display:block}
  .nm{font-weight:700}.nm span{color:#7ab2fa}
  .t{font-size:24px;line-height:1.2;color:#c8d0de}
  .tc{font:600 20px "JetBrains Mono",monospace;color:#7ab2fa}
</style></head><body><div class="c">
  <div class="brand"><img class="mark" src="${MARK}" alt=""><b class="nm">Same<span>Second</span></b></div>
  <div class="t">Watch together, on the same second.</div>
  <div class="tc">00:42:17 · 00:42:17 · 00:42:17</div>
</div></body></html>`;
}

const jobs = [
  ["public/og.png", 1200, 630, art(1200, 630, 1)],
  ["store/promo-marquee-1400x560.png", 1400, 560, art(1400, 560, 1)],
  ["store/promo-small-440x280.png", 440, 280, tile(440, 280)]
];
for (const [file, w, h, html] of jobs) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: root + file });
  await page.close();
  console.log(file);
}
await browser.close();
