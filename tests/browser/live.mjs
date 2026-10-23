import puppeteer from "puppeteer-core";
import { buildExtension } from "./env.mjs";
// Checks a deployed site with a real online video, as friends would use it.
// Usage: npm run test:live  (uses the address from the last deploy, or SAMESECOND_URL)
import { readFileSync, existsSync } from "node:fs";
const cache = new URL("../../.samesecond-url", import.meta.url).pathname;
const APP = (process.env.SAMESECOND_URL || (existsSync(cache) ? readFileSync(cache, "utf8") : "https://samesecond.itzaditya43.workers.dev")).trim().replace(/\/+$/, "");
const VIDEO = "https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${d ? "  (" + d + ")" : ""}`); if (!ok) failures++; };
const vt = (p) => p.evaluate(() => { const v = document.querySelector("video"); return v ? { t: v.currentTime, paused: v.paused, now: performance.timeOrigin + performance.now() } : null; });
const gap = (x, y) => Math.abs((x.t - (x.paused ? 0 : x.now / 1000)) - (y.t - (y.paused ? 0 : y.now / 1000)));
const ready = (p) => p.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 3; }, { timeout: 60000 });
buildExtension("chrome", APP, "tests/browser/.ext-build-live");
const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, pipe: true, enableExtensions: [new URL(".ext-build-live", import.meta.url).pathname],
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--mute-audio", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const A = await (await browser.createBrowserContext()).newPage();
await A.goto(APP + "/");
await A.type("#start-name", "Aditya"); await A.type("#start-url", VIDEO);
await Promise.all([A.waitForNavigation(), A.click("#start-form button[type=submit]")]);
const invite = A.url();
await ready(A);
await A.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 60; v.play(); });
const B = await (await browser.createBrowserContext()).newPage();
await B.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await B.goto(invite); await B.type("#gate-name", "Sam"); await B.click(".stage-card button[type=submit]");
await ready(B); await sleep(7000);
let a = await vt(A), b = await vt(B);
check("live: two website users in sync", !b.paused && gap(a, b) < 0.15, `gap ${gap(a, b).toFixed(3)} s`);
await B.evaluate(() => document.querySelector("video").pause()); await sleep(1500);
check("live: pause reaches the other person", (await vt(A)).paused);
await B.type("#chat-input", "live chat works"); await B.click("#chat-form button"); await sleep(1200);
check("live: chat", (await A.$eval("#chat-log", (e) => e.textContent)).includes("live chat works"));
await A.click("#voice-toggle"); await B.click("#voice-toggle");
let va = ""; for (let i = 0; i < 20; i++) { await sleep(500); va = await A.$eval("#voice-people", (e) => e.textContent); if (/Sam/.test(va) && !/connect/.test(va)) break; }
check("live: voice connects", /Sam/.test(va) && !/connect/.test(va), va);
// Extension user joins from the invite page.
const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const P = await browser.newPage();
await P.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
await P.type("#name", "Kai"); await P.type("#code", invite); await P.click("#join-form button");
let C = null; for (let i = 0; i < 30 && !C; i++) { await sleep(500); C = (await browser.pages()).find((p) => /archive\.org/.test(p.url()) && p !== A && p !== B); }
check("live: extension opens the room's video", !!C);
if (C) {
  await ready(C);
  await A.evaluate(() => document.querySelector("video").play()); await sleep(8000);
  a = await vt(A); const c = await vt(C);
  check("live: extension tab in sync with the website", !c.paused && gap(a, c) < 0.15, `gap ${gap(a, c).toFixed(3)} s`);
}
const preview = await (await fetch(invite)).text();
check("live: invite link preview names the video", /og:title" content="Join my watch party/.test(preview));
await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
