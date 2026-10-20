// Two people in the web app watching the same direct video link.
// Usage: node web.mjs [chrome|firefox]
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";

const APP = "http://127.0.0.1:8799";
const MEDIA = "http://127.0.0.1:8800/test.mp4";
const OUT = new URL("./shots/", import.meta.url).pathname;
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

const media = spawn("node", [new URL("./media-server.mjs", import.meta.url).pathname], { stdio: "ignore" });
await sleep(800);

const which = process.argv[2] || "chrome";
const FIREFOX = process.env.FIREFOX_PATH || "/usr/bin/firefox";
const browser = which === "firefox"
  ? await puppeteer.launch({ browser: "firefox", executablePath: FIREFOX, headless: true, extraPrefsFirefox: {
      "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0,
      "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true,
      // Both test browsers are on one machine, so let calls use local addresses.
      "media.peerconnection.ice.loopback": true, "media.peerconnection.ice.obfuscate_host_addresses": false } })
  : await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
    });
const SHOT = (name) => OUT + name.replace(".png", which === "firefox" ? "-firefox.png" : ".png");
const ctxA = await browser.createBrowserContext();
const ctxB = await browser.createBrowserContext();
const A = await ctxA.newPage();
const B = await ctxB.newPage();
for (const [p, n] of [[A, "A"], [B, "B"]]) p.on("pageerror", (e) => console.log(`  [${n} page error] ${e.message}`));
await A.setViewport({ width: 1280, height: 800 });
await B.setViewport(which === "firefox" ? { width: 390, height: 844 } : { width: 390, height: 844, isMobile: true, hasTouch: true });

const vt = (p) => p.evaluate(() => { const v = document.querySelector("video"); return v ? { t: v.currentTime, paused: v.paused, rs: v.readyState, now: performance.timeOrigin + performance.now() } : null; });
// Gap between two players at the same instant, correcting for the time between the two reads.
const gap = (x, y) => Math.abs((x.t - (x.paused ? 0 : x.now / 1000)) - (y.t - (y.paused ? 0 : y.now / 1000)));

// A starts a room from the landing page.
await A.goto(APP + "/", { waitUntil: "networkidle0" });
await A.screenshot({ path: SHOT("home-desktop.png") });
await A.type("#start-name", "Aditya");
await A.type("#start-url", MEDIA);
await Promise.all([A.waitForNavigation(), A.click("#start-form button[type=submit]")]);
const roomUrl = A.url();
check("start room goes to an invite URL", /\/r\/[a-z0-9]{8}$/.test(roomUrl), roomUrl);
await A.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 1; }, { timeout: 10000 });
check("host's video loads", true);

// B opens the invite on a phone-sized screen.
await B.goto(roomUrl, { waitUntil: "networkidle0" });
await B.screenshot({ path: SHOT("invite-phone.png") });
await B.type("#gate-name", "Sam");
await B.click(".stage-card button[type=submit]");
await B.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 1; }, { timeout: 10000 });
check("friend's video loads", true);
await sleep(1500);
const people = await A.$eval("#people-count", (e) => e.textContent);
check("host sees two people", people === "2", people);

// A presses play.
await A.evaluate(() => document.querySelector("video").play());
await sleep(3000);
let a = await vt(A), b = await vt(B);
check("friend starts playing when host plays", b && !b.paused, JSON.stringify(b));
check("positions match within 0.6 s", Math.abs(a.t - b.t) < 0.6, `${a.t.toFixed(2)} vs ${b.t.toFixed(2)}`);

// A seeks.
await A.evaluate(() => { document.querySelector("video").currentTime = 60; });
await sleep(2500);
a = await vt(A); b = await vt(B);
check("friend follows a seek", Math.abs(a.t - b.t) < 0.6 && b.t > 55, `${a.t.toFixed(2)} vs ${b.t.toFixed(2)}`);

// B drifts behind on its own.
await B.evaluate(() => { document.querySelector("video").playbackRate = 0.5; });
await sleep(1200);
await B.evaluate(() => { document.querySelector("video").playbackRate = 1; });
await sleep(3500);
a = await vt(A); b = await vt(B);
check("drift is corrected", gap(a, b) < 0.12, `gap ${gap(a, b).toFixed(3)} s`);
let worst = 0;
for (let i = 0; i < 10; i++) { a = await vt(A); b = await vt(B); worst = Math.max(worst, gap(a, b)); await sleep(300); }
check("players stay within 0.12 s of each other", worst < 0.12, `worst ${worst.toFixed(3)} s over 3 s`);

// B pauses from the phone.
await B.evaluate(() => document.querySelector("video").pause());
await sleep(1500);
a = await vt(A);
check("host pauses when friend pauses", a.paused, JSON.stringify(a));
const toastText = await A.$eval("#toast", (e) => (e.hidden ? "" : e.textContent));
check("host sees who paused", /Sam paused/.test(toastText), toastText);

// Chat.
await B.type("#chat-input", "this scene!");
await B.click("#chat-form button");
await sleep(800);
const chat = await A.$eval("#chat-log", (e) => e.textContent);
check("chat arrives", chat.includes("this scene!"), chat.slice(0, 80));

// Voice: both join with fake microphones.
await A.click("#voice-toggle");
await B.click("#voice-toggle");
let voiceA = "", voiceB = "";
for (let i = 0; i < 30; i++) {
  await sleep(500);
  voiceA = await A.$eval("#voice-people", (e) => e.textContent);
  voiceB = await B.$eval("#voice-people", (e) => e.textContent);
  if (/Sam/.test(voiceA) && /Aditya/.test(voiceB) && !/connect/.test(voiceA + voiceB)) break;
}
check("both appear in voice", /Aditya/.test(voiceA) && /Sam/.test(voiceA), voiceA);
check("voice call connects both ways", !/connect/.test(voiceA + voiceB), `${voiceA} | ${voiceB}`);
const audioOk = await A.evaluate(() => [...document.querySelectorAll("audio")].some((x) => x.srcObject && x.srcObject.getAudioTracks().some((t) => t.readyState === "live")));
check("host receives friend's audio", audioOk);

// Host restricts control; the friend's pause is undone.
await A.click("#tab-people");
await A.select("#control-select", "host");
await A.evaluate(() => document.querySelector("video").play());
await sleep(2000);
await B.evaluate(() => document.querySelector("video").pause());
await sleep(2000);
b = await vt(B); a = await vt(A);
check("friend can't pause when control is host-only", !b.paused && !a.paused, JSON.stringify(b));

await A.screenshot({ path: SHOT("room-desktop.png") });
await B.screenshot({ path: SHOT("room-phone.png") });

// Dark mode look on the phone.
if (which !== "firefox") {
  await B.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await B.click("#tab-people");
  await sleep(300);
  await B.screenshot({ path: SHOT("room-phone-dark.png") });
}

await browser.close();
media.kill();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
