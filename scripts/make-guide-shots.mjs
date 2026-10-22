// Takes the screenshots for the website's guide pages by running the real
// flows in Chrome. Starts its own server; needs Chromium, ffmpeg-made test
// media (npm run test:browser makes it once) and internet for YouTube.
// Usage: node scripts/make-guide-shots.mjs   → public/guide/*.webp
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const OUT = root + "public/guide/";
const TMP = root + "dist/guide-shots/";
const LOCAL = "http://127.0.0.1:8795";
// Friendly addresses for the pictures; Chrome maps them to the local servers.
const APP = "http://watch.syncroom.party";
const MEDIA = "http://www.testflix.tv";
const YT = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const EXT = root + "dist/guide-ext";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(root + "tests/browser/media/test.mp4")) throw new Error("Run npm run test:browser once first to make the test media.");
mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

spawnSync("node", [root + "scripts/copy-shared.mjs"]);
spawnSync("node", [root + "scripts/pack-extension.mjs", APP, "--target", "chrome", "--dir", "dist/guide-ext"]);
const dev = spawn("npx", ["wrangler", "dev", "--port", "8795", "--ip", "127.0.0.1", "--log-level", "warn"], { cwd: root, stdio: "ignore", detached: true });
const media = spawn("node", [root + "tests/browser/media-server.mjs"], { stdio: "ignore" });
for (let i = 0; ; i++) {
  try { if ((await fetch(LOCAL + "/api/health")).ok) break; } catch { /* starting */ }
  if (i > 80) throw new Error("server did not start");
  await sleep(500);
}

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const flags = ['--host-resolver-rules=MAP watch.syncroom.party:80 127.0.0.1:8795, MAP www.testflix.tv:80 127.0.0.1:8800',
  "--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--mute-audio", "--hide-scrollbars", `--user-agent=${UA}`,
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
// Each person gets their own browser (separate profiles ignore the address mapping).
const browsers = [];
async function launch(withExtension) {
  const b = await puppeteer.launch({ executablePath: CHROMIUM, headless: true, pipe: true, args: flags, ...(withExtension ? { enableExtensions: [EXT] } : {}) });
  browsers.push(b);
  return b;
}
const browser = await launch(true);
const shots = [];
async function shot(page, name, opts = {}) {
  const file = TMP + name + ".png";
  await page.screenshot({ path: file, ...opts });
  shots.push(name);
  console.log("  " + name);
}
// Outlines the element a step tells the reader to click.
const highlight = (page, fn) => page.evaluate(fn);

// --- Chrome: installing from the zip ---
const X = await browser.newPage();
await X.setViewport({ width: 1280, height: 720 });
await X.goto("chrome://extensions");
await sleep(800);
await X.evaluate(() => {
  const tb = document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-toolbar").shadowRoot;
  const t = tb.querySelector("#devMode");
  if (!t.checked) t.click();
});
await sleep(600);
await highlight(X, () => {
  const tb = document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-toolbar").shadowRoot;
  const el = tb.querySelector("#devMode").closest("div, label") || tb.querySelector("#devMode");
  el.style.outline = "4px solid #f0a25a"; el.style.outlineOffset = "6px"; el.style.borderRadius = "6px";
});
await shot(X, "chrome-1-developer-mode");
await highlight(X, () => {
  const tb = document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-toolbar").shadowRoot;
  const dm = tb.querySelector("#devMode").closest("div, label") || tb.querySelector("#devMode");
  dm.style.outline = "none";
  const b = tb.querySelector("#loadUnpacked");
  b.style.outline = "4px solid #f0a25a"; b.style.outlineOffset = "4px";
});
await shot(X, "chrome-2-load-unpacked");
await highlight(X, () => {
  const tb = document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-toolbar").shadowRoot;
  tb.querySelector("#loadUnpacked").style.outline = "none";
  const list = document.querySelector("extensions-manager").shadowRoot.querySelector("extensions-item-list").shadowRoot;
  const item = [...list.querySelectorAll("extensions-item")].find((i) => /Syncroom/.test(i.shadowRoot.textContent));
  const card = item.shadowRoot.querySelector("#card") || item;
  card.style.outline = "4px solid #f0a25a"; card.style.outlineOffset = "4px";
});
await shot(X, "chrome-3-installed");
const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const extId = new URL(swTarget.url()).host;
await X.close();

// --- Extension: starting a room on a video tab ---
const V = await browser.newPage();
await V.setViewport({ width: 1280, height: 720 });
await V.goto(MEDIA + "/watch.html");
await V.waitForFunction(() => document.querySelector("video") && document.querySelector("video").readyState >= 1);
await V.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 754; v.pause(); });
const P = await browser.newPage();
await P.setViewport({ width: 400, height: 720 });
await P.goto(`chrome-extension://${extId}/panel.html`);
await sleep(500);
await P.type("#name", "Aditya");
await P.evaluate(() => {
  document.getElementById("tab-info").textContent = "This tab: Episode 7 - TestFlix";
  document.getElementById("start").disabled = false;
  const b = document.getElementById("start");
  b.style.outline = "4px solid #f0a25a"; b.style.outlineOffset = "3px";
});
await shot(P, "ext-1-start-room");
await P.evaluate(() => { document.getElementById("start").style.outline = "none"; });
await P.evaluate(async (url) => {
  const [tab] = await chrome.tabs.query({ url });
  chrome.runtime.connect({ name: "syncroom-panel" }).postMessage({ type: "start", tabId: tab.id, name: "Aditya" });
}, MEDIA + "/watch.html");
await P.waitForFunction(() => document.getElementById("invite").value, { timeout: 8000 });
const invite = await P.$eval("#invite", (e) => e.value);

// A friend joins from the invite link on a phone (chat and voice; Netflix-style
// sites need the extension) and another on a laptop with the extension page.
const phone = await (await launch(false)).newPage();
await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await phone.goto(invite);
await phone.waitForSelector("#gate-name");
await shot(phone, "phone-1-invite");
await phone.type("#gate-name", "Sam");
await phone.click(".stage-card button[type=submit]");
await sleep(2500);
await shot(phone, "phone-2-extension-room");

await V.bringToFront();
await V.evaluate(() => document.querySelector("video").play());
await sleep(2500);
await phone.type("#chat-input", "this episode is so good");
await phone.click("#chat-form button");
await sleep(800);
await P.bringToFront();
await P.evaluate(() => {
  const b = document.getElementById("copy");
  b.style.outline = "4px solid #f0a25a"; b.style.outlineOffset = "3px";
});
await shot(P, "ext-2-room-panel", { fullPage: true });
await P.evaluate(() => { document.getElementById("copy").style.outline = "none"; });
// An on-video notice when someone else acts.
await V.bringToFront();
await sleep(500);
await V.evaluate(() => {
  for (const el of document.querySelectorAll("div")) if (el.shadowRoot) { el.style.display = ""; el.shadowRoot.querySelector(".t").textContent = "Sam: this episode is so good"; }
});
await shot(V, "ext-3-on-video-notice");

// --- Website: a YouTube room on a laptop and a phone ---
const L = await (await launch(false)).newPage();
await L.setViewport({ width: 1280, height: 760 });
await L.goto(APP + "/");
await L.type("#start-name", "Aditya");
await L.type("#start-url", YT);
await L.evaluate(() => {
  const b = document.querySelector("#start-form button[type=submit]");
  b.style.outline = "4px solid #f0a25a"; b.style.outlineOffset = "3px";
});
await shot(L, "web-1-start-room");
await Promise.all([L.waitForNavigation(), L.click("#start-form button[type=submit]")]);
const room = L.url();
await L.waitForFunction(() => document.querySelector(".stage iframe"), { timeout: 20000 });
// YouTube's time, read from inside its player frame.
async function ytState(page) {
  const f = page.frames().find((x) => /youtube(-nocookie)?\.com\/embed/.test(x.url()));
  return f ? f.evaluate(() => { const v = document.querySelector("video"); return v ? { t: v.currentTime, paused: v.paused } : null; }).catch(() => null) : null;
}
for (let i = 0; i < 8; i++) {
  await sleep(3000);
  const st = await ytState(L);
  if (st && !st.paused && st.t > 1) break;
  const box = await (await L.$(".stage iframe")).boundingBox();
  await L.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
// Skip ahead to a nicer scene.
const fr = L.frames().find((x) => /youtube(-nocookie)?\.com\/embed/.test(x.url()));
await fr.evaluate(() => { document.querySelector("video").currentTime = 95; });
await sleep(4000);
const ph = await (await launch(false)).newPage();
await ph.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await ph.goto(room);
await ph.waitForSelector("#gate-name");
await ph.type("#gate-name", "Sam");
await ph.click(".stage-card button[type=submit]");
for (let i = 0; i < 15; i++) { await sleep(2000); const st = await ytState(ph); if (st && !st.paused && st.t > 96) break; }
await sleep(4000);
await ph.type("#chat-input", "omg the bunny");
await ph.click("#chat-form button");
await sleep(1500);
await L.click("#tab-people");
await sleep(800);
await L.evaluate(() => {
  const b = document.getElementById("copy-invite");
  b.style.outline = "4px solid #f0a25a"; b.style.outlineOffset = "3px";
});
await shot(L, "web-2-room-laptop");
await shot(ph, "web-3-room-phone");

for (const b of browsers) await b.close();
try { process.kill(-dev.pid); } catch { /* stopped */ }
media.kill();

// Compress for the web.
for (const name of shots) {
  spawnSync("magick", [TMP + name + ".png", "-resize", "1280x1280>", "-strip", "-quality", "82", OUT + name + ".webp"]);
}
console.log(`${shots.length} screenshots → public/guide/`);
