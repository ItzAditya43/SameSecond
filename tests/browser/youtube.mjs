// Real YouTube: two people in the web app (embedded player) and one with the
// extension on youtube.com, all in one room. Needs internet access.
import puppeteer from "puppeteer-core";
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";

const APP = "http://127.0.0.1:8799";
const VIDEO = process.env.YT_VIDEO || "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; // Big Buck Bunny, Blender Foundation
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const here = new URL(".", import.meta.url).pathname;
const EXT = here + ".ext-build-youtube";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

rmSync(EXT, { recursive: true, force: true });
cpSync(new URL("../../extension", import.meta.url).pathname, EXT, { recursive: true });
writeFileSync(EXT + "/config.js", readFileSync(EXT + "/config.js", "utf8").replace(/SYNCROOM_DEFAULT_SERVER = ".*?"/, `SYNCROOM_DEFAULT_SERVER = "${APP}"`));

const browser = await puppeteer.launch({
  executablePath: CHROMIUM, headless: true, pipe: true, enableExtensions: [EXT],
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", `--user-agent=${UA}`, "--mute-audio"]
});

// Reads the playing video's time in a page or in the YouTube frame inside it.
async function ytTime(page) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => /youtube(-nocookie)?\.com\/embed/.test(f.url()))];
  for (const f of frames.reverse()) {
    const r = await f.evaluate(() => {
      const v = document.querySelector("video");
      const ad = !!document.querySelector(".ad-showing");
      return v && v.readyState >= 1 ? { t: v.currentTime, paused: v.paused, ad, now: performance.timeOrigin + performance.now() } : null;
    }).catch(() => null);
    if (r) return r;
  }
  return null;
}
const gap = (x, y) => Math.abs((x.t - (x.paused ? 0 : x.now / 1000)) - (y.t - (y.paused ? 0 : y.now / 1000)));
async function waitFor(fn, ms, step = 500) {
  for (let i = 0; i < ms / step; i++) { const r = await fn(); if (r) return r; await sleep(step); }
  return null;
}

// A starts a room with a YouTube link.
const A = await (await browser.createBrowserContext()).newPage();
await A.goto(APP + "/");
await A.type("#start-name", "Aditya");
await A.type("#start-url", VIDEO);
await Promise.all([A.waitForNavigation(), A.click("#start-form button[type=submit]")]);
const invite = A.url();
const aReady = await waitFor(() => A.frames().some((f) => /youtube(-nocookie)?\.com\/embed/.test(f.url())), 25000);
check("YouTube player loads in the web app", !!aReady);
const title = await waitFor(async () => { const t = await A.$eval("#room-title", (e) => e.textContent); return t && t !== "YouTube" ? t : null; }, 10000);
check("room shows the video's title", !!title, title || "");

// Start playback with a real click on the player.
const box = await (await A.$(".stage iframe")).boundingBox();
await A.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
const aPlaying = await waitFor(async () => { const r = await ytTime(A); return r && !r.paused && r.t > 1 ? r : null; }, 20000);
check("host's YouTube player plays", !!aPlaying, aPlaying ? `t=${aPlaying.t.toFixed(1)}` : "");

// B joins in the web app.
const B = await (await browser.createBrowserContext()).newPage();
await B.goto(invite);
await B.type("#gate-name", "Sam");
await B.click(".stage-card button[type=submit]");
const bPlaying = await waitFor(async () => { const r = await ytTime(B); return r && !r.paused && r.t > 1 ? r : null; }, 25000);
check("friend's YouTube player starts on its own", !!bPlaying);
await sleep(8000);
// YouTube reports time in coarse steps, so judge on the median of several readings.
const samples = [];
for (let i = 0; i < 7; i++) { const x = await ytTime(A), y = await ytTime(B); if (x && y) samples.push(gap(x, y)); await sleep(300); }
samples.sort((x, y) => x - y);
const median = samples[Math.floor(samples.length / 2)];
check("web players in sync", median < 0.2, `median gap ${median.toFixed(3)} s`);
let a, b;

// C joins with the extension, which opens youtube.com.
const P = await browser.newPage();
const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
await P.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);
await P.type("#name", "Kai");
await P.type("#code", invite);
await P.click("#join-form button");
const C = await waitFor(async () => (await browser.pages()).find((p) => p.url().startsWith("https://www.youtube.com/watch")), 15000);
check("extension opens the video on youtube.com", !!C);
if (C) {
  const cReady = await waitFor(async () => { const r = await ytTime(C); return r && !r.ad && !r.paused && r.t > 1 ? r : null; }, 60000, 1000);
  check("youtube.com tab plays (after any advert)", !!cReady, cReady ? "" : JSON.stringify(await ytTime(C)));
  await sleep(6000);
  a = await ytTime(A); const c = await ytTime(C);
  check("youtube.com tab in sync with the web app", a && c && gap(a, c) < 0.15, a && c ? `gap ${gap(a, c).toFixed(3)} s` : "");

  // Pause from the web app reaches everyone.
  await B.evaluate(() => {}); // keep B alive
  const frameB = B.frames().find((f) => /youtube(-nocookie)?\.com\/embed/.test(f.url()));
  await frameB.evaluate(() => document.querySelector("video").pause());
  await sleep(3000);
  a = await ytTime(A); const c2 = await ytTime(C);
  check("pause in one embedded player pauses everyone", a.paused && c2.paused, `A paused=${a.paused} C paused=${c2.paused}`);
  const people = await P.$eval("#people", (e) => e.textContent);
  check("panel lists all three", /Aditya/.test(people) && /Sam/.test(people) && /Kai/.test(people));
}

await browser.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
