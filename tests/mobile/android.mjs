// Real-phone test over USB: Chrome on an Android phone joins a room hosted
// by a laptop browser, and must stay in sync, pause everyone and chat.
//
// Phone setup (once): Settings → About phone → tap "Build number" 7 times,
// then Settings → Developer options → turn on "USB debugging". Plug the phone
// in, unlock it and accept "Allow USB debugging?". Chrome must be installed.
//
// Usage: npm run test:android
// Needs adb, Chromium and the test media (npm run test:browser makes it once).
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const APP = "http://127.0.0.1:8799";
const MEDIA = "http://127.0.0.1:8800/test.mp4";
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}
const adb = (...args) => spawnSync("adb", args, { encoding: "utf8" });

// --- Phone ---
const devices = adb("devices").stdout.split("\n").slice(1).filter((l) => /\tdevice$/.test(l));
if (!devices.length) {
  console.error("No phone found. Turn on USB debugging, plug the phone in, unlock it and accept the prompt. Then check: adb devices");
  process.exit(1);
}
const serial = devices[0].split("\t")[0];
const model = adb("-s", serial, "shell", "getprop", "ro.product.model").stdout.trim();
const android = adb("-s", serial, "shell", "getprop", "ro.build.version.release").stdout.trim();
console.log(`phone: ${model} (Android ${android})`);
if (!existsSync(root + "tests/browser/media/test.mp4")) { console.error("Run npm run test:browser once first to make the test media."); process.exit(1); }

// The phone reaches the laptop's servers through the USB cable at the same addresses.
adb("-s", serial, "reverse", "tcp:8799", "tcp:8799");
adb("-s", serial, "reverse", "tcp:8800", "tcp:8800");
adb("-s", serial, "forward", "tcp:9333", "localabstract:chrome_devtools_remote");

const dev = spawn("npx", ["wrangler", "dev", "--port", "8799", "--ip", "127.0.0.1", "--log-level", "warn"], { cwd: root, stdio: "ignore", detached: true });
const media = spawn("node", [root + "tests/browser/media-server.mjs"], { stdio: "ignore" });
for (let i = 0; ; i++) {
  try { if ((await fetch(APP + "/api/health")).ok) break; } catch { /* starting */ }
  if (i > 80) throw new Error("server did not start");
  await sleep(500);
}

// Open Chrome on the phone so its debugging port is available.
adb("-s", serial, "shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main", "-d", APP + "/");
let phoneBrowser = null;
for (let i = 0; i < 20 && !phoneBrowser; i++) {
  await sleep(1000);
  phoneBrowser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null }).catch(() => null);
}
if (!phoneBrowser) {
  console.error("Couldn't connect to Chrome on the phone. Open Chrome on the phone once, then run this again.");
  process.exit(1);
}
const shots = here + "shots/";
mkdirSync(shots, { recursive: true });

// --- Laptop host ---
const laptop = await puppeteer.launch({ executablePath: CHROMIUM, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const A = await laptop.newPage();
await A.goto(APP + "/");
await A.type("#start-name", "Laptop");
await A.type("#start-url", MEDIA);
await Promise.all([A.waitForNavigation(), A.click("#start-form button[type=submit]")]);
const invite = A.url();
await A.waitForFunction(() => document.querySelector("video") && document.querySelector("video").readyState >= 1);
await A.evaluate(() => document.querySelector("video").play());

const vt = (p) => p.evaluate(() => { const v = document.querySelector("video"); return v ? { t: v.currentTime, paused: v.paused, now: Date.now() } : null; });
const gap = (x, y) => Math.abs((x.t - (x.paused ? 0 : x.now / 1000)) - (y.t - (y.paused ? 0 : y.now / 1000)));

// --- Phone joins ---
const P = await phoneBrowser.newPage();
await P.goto(invite);
await P.waitForSelector("#gate-name", { timeout: 15000 });
await P.screenshot({ path: shots + "1-invite.png" });
await P.type("#gate-name", "Phone");
await P.tap(".stage-card button[type=submit]");
await P.waitForFunction(() => document.querySelector("video") && document.querySelector("video").readyState >= 1, { timeout: 20000 });
await sleep(3000);
if (await P.$eval("#unlock", (e) => !e.hidden)) {
  check("phone asks for a tap to start (autoplay rules)", true);
  await P.tap("#unlock-btn");
}
await sleep(5000);
let a = await vt(A), p = await vt(P);
check("phone video plays", p && !p.paused, JSON.stringify(p));
// Phone clocks can differ from the laptop's; compare using each side's own clock.
check("phone in sync with the laptop", p && gap(a, p) < 0.25, p ? `gap ${gap(a, p).toFixed(3)} s` : "");
await P.screenshot({ path: shots + "2-playing.png" });

await P.tap("#people-count").catch(() => {});
await P.tap("#tab-chat").catch(() => {});
await P.type("#chat-input", "hello from my phone");
await P.tap("#chat-form button");
await sleep(1500);
check("chat from the phone reaches the laptop", (await A.$eval("#chat-log", (e) => e.textContent)).includes("hello from my phone"));
await A.type("#chat-input", "hi phone");
await A.click("#chat-form button");
await sleep(1500);
check("chat from the laptop reaches the phone", (await P.$eval("#chat-log", (e) => e.textContent)).includes("hi phone"));

await P.evaluate(() => document.querySelector("video").pause());
await sleep(2000);
a = await vt(A);
check("pausing on the phone pauses the laptop", a.paused, JSON.stringify(a));
await A.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 70; v.play(); });
await sleep(4000);
a = await vt(A); p = await vt(P);
check("laptop seek + play reaches the phone", !p.paused && gap(a, p) < 0.25, `gap ${gap(a, p).toFixed(3)} s, phone at ${p.t.toFixed(1)}`);
await P.screenshot({ path: shots + "3-chat.png" });

// Layout: nothing wider than the phone's screen.
const overflow = await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check("room fits the phone screen (no sideways scrolling)", !overflow);

await P.close();
phoneBrowser.disconnect();
await laptop.close();
try { process.kill(-dev.pid); } catch { /* stopped */ }
media.kill();
adb("-s", serial, "reverse", "--remove-all");
adb("-s", serial, "forward", "--remove", "tcp:9333");
console.log(`screenshots from the phone: tests/mobile/shots/`);
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
