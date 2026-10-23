// The extension on a video tab, synced with a web-app user. Chrome only:
// Firefox's automation protocol won't open extension pages, so the Firefox
// build is covered by bridge.mjs instead.
import puppeteer from "puppeteer-core";
import { APP, MEDIA_BASE, CHROME_ARGS, buildExtension } from "./env.mjs";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";

const MEDIA = MEDIA_BASE + "/test.mp4";
const here = new URL(".", import.meta.url).pathname;
const EXT = here + ".ext-build-chrome";
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

buildExtension("chrome", APP, EXT.replace(new URL("../..", import.meta.url).pathname, ""));

const media = spawn("node", [here + "media-server.mjs"], { stdio: "ignore" });
await sleep(500);

let browser, panelUrl;
{
  browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true, acceptInsecureCerts: true,
    pipe: true,
    enableExtensions: [EXT],
    args: [...CHROME_ARGS, "--autoplay-policy=no-user-gesture-required", "--no-sandbox"]
  });
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 10000 });
  const extId = new URL(swTarget.url()).host;
  check("extension loads", !!extId, extId);
  const sw = await swTarget.worker();
  sw.on("console", (m) => { if (m.type() === "error") console.log("  [bg]", m.text()); });
  panelUrl = `chrome-extension://${extId}/panel.html`;
  // What chrome://extensions (and a store reviewer) would flag about the package.
  const X = await browser.newPage();
  await X.goto("chrome://extensions");
  const info = await X.evaluate((id) => new Promise((resolve) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, (all) => {
    const me = all.find((e) => e.id === id) || {};
    resolve({ warnings: me.installWarnings || [], manifestErrors: (me.manifestErrors || []).map((e) => e.message) });
  })), extId);
  check("Chrome reports no manifest warnings or errors", info.warnings.length === 0 && info.manifestErrors.length === 0, JSON.stringify(info));
  await X.close();
}
await sleep(1000);

// Video tab.
const V = await browser.newPage();
V.on("console", (m) => { if (m.type() === "error") console.log("  [video]", m.text()); });
await V.goto(MEDIA);
await V.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 1; });
await V.evaluate(() => { const v = document.querySelector("video"); v.pause(); v.currentTime = 20; });
await sleep(500);

// Panel, opened as a tab for the test.
const P = await browser.newPage();
await P.goto(panelUrl);
await sleep(500);
const lobbyShown = await P.$eval("#lobby", (e) => !e.hidden);
check("panel shows the lobby", lobbyShown);
await P.evaluate(async (url) => {
  const [tab] = await chrome.tabs.query({ url });
  const port = chrome.runtime.connect({ name: "samesecond-panel" });
  port.postMessage({ type: "start", tabId: tab.id, name: "Aditya" });
}, MEDIA);
await P.waitForFunction(() => !document.getElementById("room").hidden && document.getElementById("invite").value, { timeout: 8000 });
const invite = await P.$eval("#invite", (e) => e.value);
check("room starts from the extension", /\/r\/[a-z0-9]{8}$/.test(invite), invite);
await sleep(1500);
const syncText = await P.$eval("#sync-text", (e) => e.textContent);
check("panel finds the video", /Paused · 0:20/.test(syncText), syncText);
await P.screenshot({ path: here + "shots/panel-room.png" });

// Web friend joins.
const ctxB = await browser.createBrowserContext();
const B = await ctxB.newPage();
await B.goto(invite, { waitUntil: "networkidle0" });
await B.type("#gate-name", "Sam");
await B.click(".stage-card button[type=submit]");
await B.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 1; }, { timeout: 10000 });
await sleep(1500);
const vt = (p) => p.evaluate(() => { const v = document.querySelector("video"); return { t: v.currentTime, paused: v.paused }; });
let b = await vt(B);
check("friend starts at the host's position", Math.abs(b.t - 20) < 0.5, b.t.toFixed(2));

// Friend plays from the web app; the extension tab follows.
await B.evaluate(() => document.querySelector("video").play());
await sleep(3000);
let v = await vt(V); b = await vt(B);
check("extension tab plays when friend plays", !v.paused, JSON.stringify(v));
check("extension tab in sync", Math.abs(v.t - b.t) < 0.6, `${v.t.toFixed(2)} vs ${b.t.toFixed(2)}`);

// Friend seeks.
await B.evaluate(() => { document.querySelector("video").currentTime = 80; });
await sleep(2500);
v = await vt(V); b = await vt(B);
check("extension tab follows a seek", Math.abs(v.t - b.t) < 0.6 && v.t > 78, `${v.t.toFixed(2)} vs ${b.t.toFixed(2)}`);

// A real click-like pause in the extension tab is shared.
// (The test tool's script calls count as a user gesture.)
await V.evaluate(() => document.querySelector("video").pause());
await sleep(1500);
b = await vt(B);
check("user pause in extension tab reaches friend", b.paused, JSON.stringify(b));
const toast = await V.evaluate(() => {
  for (const el of document.querySelectorAll("div")) if (el.shadowRoot) return el.shadowRoot.querySelector(".t").textContent;
  return "";
});
check("on-video notice appears", /Sam/.test(toast), toast.slice(0, 80));

// Resume from friend, then the page pauses itself (no user gesture): not shared.
await B.evaluate(() => document.querySelector("video").play());
// A timer that fires after the gesture has expired (5 s) acts like the site pausing itself.
await V.evaluate(() => { setTimeout(() => document.querySelector("video").pause(), 6500); });
await sleep(8500);
v = await vt(V); b = await vt(B);
check("site-driven pause is not shared", !b.paused, JSON.stringify(b));
check("extension tab is pulled back to playing", !v.paused, JSON.stringify(v));

// Chat reaches the panel.
await B.type("#chat-input", "hello from my phone");
await B.click("#chat-form button");
await sleep(1000);
const log = await P.$eval("#log", (e) => e.textContent);
check("chat appears in the panel", log.includes("hello from my phone"), log.slice(0, 60));
const people = await P.$eval("#people", (e) => e.textContent);
check("panel lists both people", /Aditya/.test(people) && /Sam/.test(people), people.slice(0, 120));
await P.screenshot({ path: here + "shots/panel-chat.png", fullPage: true });

// Panel UI: chat, control setting.
await P.type("#chat", "typed in the panel");
await P.click("#chat-form button");
await sleep(1000);
check("chat sent from the panel reaches the friend", (await B.$eval("#chat-log", (e) => e.textContent)).includes("typed in the panel"));
await P.select("#control", "host");
await sleep(1000);
await B.evaluate(() => document.querySelector("video").pause());
await sleep(2000);
b = await vt(B);
check("host-only setting from the panel blocks the friend's pause", !b.paused, JSON.stringify(b));
await P.select("#control", "everyone");
await sleep(800);

// Leaving from the panel.
await P.click("#leave");
await sleep(1500);
const back = await P.$eval("#lobby", (e) => !e.hidden);
check("leave returns to the lobby", back);
const left = await B.$eval("#people-count", (e) => e.textContent);
check("friend sees the host leave", left === "1", left);

// Joining by pasting the invite into the panel.
await P.type("#code", invite);
await P.click("#join-form button");
let joinedTab = null;
for (let i = 0; i < 20 && !joinedTab; i++) {
  await sleep(500);
  const pages = (await browser.pages()).filter((p) => p.url() === MEDIA);
  if (pages.length > 1) joinedTab = pages[pages.length - 1];
}
check("joining from the panel opens the room's video", !!joinedTab);
await sleep(3000);
const rejoined = await B.$eval("#people-count", (e) => e.textContent);
check("friend sees them join again", rejoined === "2", rejoined);
if (joinedTab) {
  const j = await vt(joinedTab); b = await vt(B);
  check("joined tab is in sync", Math.abs(j.t - b.t) < 0.6 && j.paused === b.paused, `${j.t.toFixed(2)} vs ${b.t.toFixed(2)}`);
}

await browser.close();
media.kill();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
