// HLS streams, blocked autoplay, reloads, three people with voice, hostile
// chat, and the static pages.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";

const APP = "http://127.0.0.1:8799";
const HLS = "http://127.0.0.1:8800/hls/index.m3u8";
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}
const vt = (p) => p.evaluate(() => { const v = document.querySelector("video"); return v ? { t: v.currentTime, paused: v.paused, now: performance.timeOrigin + performance.now() } : null; });
const gap = (x, y) => Math.abs((x.t - (x.paused ? 0 : x.now / 1000)) - (y.t - (y.paused ? 0 : y.now / 1000)));
const ready = (p) => p.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 1; }, { timeout: 15000 });

const media = spawn("node", [here + "media-server.mjs"], { stdio: "ignore" });
await sleep(500);

// No autoplay flag: like a phone, playback needs a tap first.
const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: true,
  args: ["--no-sandbox", "--autoplay-policy=document-user-activation-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
});
const ctx = () => browser.createBrowserContext();
const A = await (await ctx()).newPage();
const B = await (await ctx()).newPage();
const C = await (await ctx()).newPage();
const errors = [];
for (const [p, n] of [[A, "A"], [B, "B"], [C, "C"]]) p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));
await B.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

// HLS room.
await A.goto(APP + "/");
await A.type("#start-name", "Aditya");
await A.type("#start-url", HLS);
await Promise.all([A.waitForNavigation(), A.click("#start-form button[type=submit]")]);
const room = A.url();
await ready(A);
check("HLS stream loads", true);
await A.evaluate(() => document.querySelector("video").play());
await sleep(2500);
let a = await vt(A);
check("HLS stream plays", !a.paused && a.t > 1, JSON.stringify(a));

// B arrives with a saved name, so it joins without tapping anything.
await B.evaluateOnNewDocument(() => {
  try { localStorage.setItem("syncroom.name", "Sam"); } catch (e) { /* ignore */ }
  // Behave like a phone in every browser: refuse to start playback until the page has been tapped.
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!navigator.userActivation.hasBeenActive) return Promise.reject(new DOMException("Tap first", "NotAllowedError"));
    return play.call(this);
  };
});
await B.goto(room);
await B.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 1; }, { timeout: 15000, polling: 200 });
await sleep(4500);
const blocked = await B.$eval("video", (v) => ({ paused: v.paused }));
let b = { paused: blocked.paused };
const banner = await B.$eval("#unlock", (e) => !e.hidden);
check("blocked autoplay shows the tap-to-start bar", b.paused && banner, `paused=${b.paused} bar=${banner}`);
await B.tap("#unlock-btn");
await sleep(2500);
a = await vt(A); b = await vt(B);
check("tapping start joins playback in sync", !b.paused && gap(a, b) < 0.15, `gap ${gap(a, b).toFixed(3)}`);
check("bar hides once playing", await B.$eval("#unlock", (e) => e.hidden));

// Reload rejoins as the same person.
await B.reload();
await ready(B);
await sleep(3500);
const countAfterReload = await A.$eval("#people-count", (e) => e.textContent);
check("reload doesn't leave a ghost behind", countAfterReload === "2", countAfterReload);
await B.tap("#unlock-btn").catch(() => {});
await sleep(2500);
a = await vt(A); b = await vt(B);
check("back in sync after reload", !b.paused && gap(a, b) < 0.15, `gap ${gap(a, b).toFixed(3)}`);

// A third person.
await C.goto(room);
await C.type("#gate-name", "Kai");
await C.click(".stage-card button[type=submit]");
await ready(C);
await sleep(3000);
let c = await vt(C);
a = await vt(A);
check("third person plays in sync", !c.paused && gap(a, c) < 0.15, `gap ${gap(a, c).toFixed(3)}`);

// Three-way voice.
for (const p of [A, B, C]) await p.click("#voice-toggle");
let texts = [];
for (let i = 0; i < 30; i++) {
  await sleep(500);
  texts = await Promise.all([A, B, C].map((p) => p.$eval("#voice-people", (e) => e.textContent)));
  if (texts.every((t) => /Aditya/.test(t) && /Sam/.test(t) && /Kai/.test(t) && !/connect/.test(t))) break;
}
check("three-way voice connects everyone", texts.every((t) => /Aditya/.test(t) && /Sam/.test(t) && /Kai/.test(t) && !/connect/.test(t)), texts.join(" | "));
const streams = await A.evaluate(() => [...document.querySelectorAll("audio")].filter((x) => x.srcObject && x.srcObject.getAudioTracks().some((t) => t.readyState === "live")).length);
check("host hears both others", streams === 2, `${streams} audio streams`);
await B.click("#voice-toggle");
await sleep(2000);
const afterLeave = await A.$eval("#voice-people", (e) => e.textContent);
const streamsAfter = await A.evaluate(() => document.querySelectorAll("audio").length);
check("leaving voice drops that person's audio", !/Sam/.test(afterLeave) && streamsAfter === 1, `${afterLeave}; ${streamsAfter} audio`);
await C.click("#voice-mute");
check("mute button toggles", (await C.$eval("#voice-mute", (e) => e.textContent)) === "Unmute");

// Hostile chat is shown as text.
await C.type("#chat-input", '<img src=x onerror="window.__pwned=1"><b>bold</b>');
await C.click("#chat-form button");
await sleep(1000);
const raw = await A.$eval("#chat-log", (e) => e.innerHTML);
const pwned = await A.evaluate(() => window.__pwned === 1);
check("chat markup is shown as text, not run", !pwned && raw.includes("&lt;img") && !raw.includes("<b>bold"), raw.slice(-120));

// Pages.
const dl = await fetch(APP + "/downloads/syncroom-extension.zip");
const zipBytes = Buffer.from(await dl.arrayBuffer());
check("extension download is served as a zip", dl.ok && /zip|octet/.test(dl.headers.get("content-type") || "") && zipBytes.readUInt32LE(0) === 0x04034b50, dl.headers.get("content-type"));
await A.goto(APP + "/extension.html");
await sleep(800);
check("download button shows when a build is published", await A.$eval("#dl", (e) => !e.hidden));
await A.goto(APP + "/privacy.html");
check("privacy page loads", /What the room server receives/.test(await A.content()));
const bad = await A.goto(APP + "/r/doesnotexist1");
await A.waitForFunction(() => document.querySelector(".stage-card h2, .stage-card input"), { timeout: 5000 });
await A.evaluate(() => localStorage.setItem("syncroom.name", "Aditya"));
await A.reload();
await A.waitForFunction(() => /isn't available/.test(document.body.textContent), { timeout: 8000 }).then(() => check("a dead invite link says the room isn't available", true), () => check("a dead invite link says the room isn't available", false));

check("no script errors on any page", errors.length === 0, errors.join("; "));
await browser.close();
media.kill();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
