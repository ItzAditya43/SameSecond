// Real-phone test over USB: Chrome on an Android phone joins a room hosted
// by a laptop browser, and must stay in sync, pause everyone and chat.
//
// Phone setup (once): Settings → About phone → tap "Build number" 7 times,
// then Settings → Developer options → turn on "USB debugging". Plug the phone
// in, unlock it and accept "Allow USB debugging?". Chrome must be installed.
//
// Usage: npm run test:android                 (Brave if installed, else Chrome)
//        ANDROID_BROWSER=chrome npm run test:android
// Needs adb, Chromium and the test media (npm run test:browser makes it once).
import puppeteer from "puppeteer-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const APP = "http://127.0.0.1:8799";
// The phone reaches the same server as "localhost" (also through the USB cable).
// Browsers keep permissions per address, so a block left from an earlier run on
// one address can be avoided with ANDROID_HOST.
const PHONE_APP = `http://${process.env.ANDROID_HOST || "localhost"}:8799`;
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

// Chrome and Brave (and other Chromium browsers) can be driven over USB.
const BROWSERS = { brave: "com.brave.browser", chrome: "com.android.chrome", edge: "com.microsoft.emmx" };
const installed = adb("-s", serial, "shell", "pm", "list", "packages").stdout;
const choice = process.env.ANDROID_BROWSER || ["brave", "chrome", "edge"].find((b) => installed.includes("package:" + BROWSERS[b] + "\n") || installed.includes("package:" + BROWSERS[b] + "\r"));
const pkg = BROWSERS[choice];
if (!pkg) { console.error("Install Chrome or Brave on the phone."); process.exit(1); }
console.log(`browser on the phone: ${choice}`);
// Open it so its debugging connection is available.
adb("-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", APP + "/", pkg);
let phoneBrowser = null;
for (let i = 0; i < 20 && !phoneBrowser; i++) {
  await sleep(1000);
  const info = await fetch("http://127.0.0.1:9333/json/version").then((r) => r.json()).catch(() => null);
  if (info && info["Android-Package"] !== pkg) {
    console.error(`Another browser (${info["Android-Package"]}) holds the debugging connection. Close it on the phone and run again.`);
    process.exit(1);
  }
  if (info) phoneBrowser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null }).catch(() => null);
}
if (!phoneBrowser) {
  console.error(`Couldn't connect to ${choice} on the phone. Unlock the phone, open ${choice} once, then run this again.`);
  process.exit(1);
}
const version = await phoneBrowser.version();
console.log(`connected: ${version}`);
const shots = here + "shots/";
mkdirSync(shots, { recursive: true });

// --- Laptop host ---
const laptop = await puppeteer.launch({ executablePath: CHROMIUM, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const A = await laptop.newPage();
await A.goto(APP + "/");
await A.type("#start-name", "Laptop");
await A.type("#start-url", MEDIA);
await Promise.all([A.waitForNavigation(), A.click("#start-form button[type=submit]")]);
const invite = A.url();
await A.waitForFunction(() => document.querySelector("video") && document.querySelector("video").readyState >= 1);
await A.evaluate(() => document.querySelector("video").play());

const vt = (p) => p.evaluate(() => { const v = document.querySelector("video"); return v ? { t: v.currentTime, paused: v.paused, now: Date.now() } : null; });
// The phone's clock isn't exactly the laptop's. Measure the difference (best of
// several round trips) and convert phone readings to laptop time before comparing.
let phoneClockOffset = 0;
async function measureClock(page) {
  let best = null;
  for (let i = 0; i < 8; i++) {
    const t0 = Date.now();
    const phoneNow = await page.evaluate(() => Date.now());
    const t1 = Date.now();
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: phoneNow - (t0 + t1) / 2 };
  }
  phoneClockOffset = best.offset;
  return best;
}
const onLaptopClock = (r) => (r ? { ...r, now: r.now - phoneClockOffset } : r);
const gap = (x, y) => Math.abs((x.t - (x.paused ? 0 : x.now / 1000)) - (y.t - (y.paused ? 0 : y.now / 1000)));

// --- Phone joins ---
const P = await phoneBrowser.newPage();
// Start as a first-time visitor: forget the name saved by an earlier run.
await P.goto(PHONE_APP + "/privacy");
await P.evaluate(() => { try { localStorage.removeItem("samesecond.name"); } catch (e) { /* ignore */ } });
await P.goto(invite.replace(APP, PHONE_APP));
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
const clock = await measureClock(P);
console.log(`  phone clock is ${clock.offset.toFixed(0)} ms off the laptop's (measured over USB, ±${(clock.rtt / 2).toFixed(0)} ms)`);
let a = await vt(A), p = onLaptopClock(await vt(P));
check("phone video plays", p && !p.paused, JSON.stringify(p));
// Phone clocks can differ from the laptop's; compare using each side's own clock.
check("phone in sync with the laptop", p && gap(a, p) < 0.15, p ? `gap ${gap(a, p).toFixed(3)} s` : "");
const said = await P.$eval("#sync-text", (e) => e.textContent);
check("phone says it's in sync", said === "In sync", said);
await P.screenshot({ path: shots + "2-playing.png" });

await P.tap("#tab-chat").catch(() => {});
await P.type("#chat-input", "hello from my phone");
await P.keyboard.press("Enter");
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
// How long the phone takes to land on the new spot and settle within 0.1 s.
const seekAt = Date.now();
let settledAfter = null, trace = [];
for (let i = 0; i < 24 && settledAfter === null; i++) {
  await sleep(500);
  a = await vt(A); p = onLaptopClock(await vt(P));
  trace.push(gap(a, p).toFixed(2));
  if (!p.paused && gap(a, p) < 0.1) settledAfter = (Date.now() - seekAt) / 1000;
}
check("laptop seek + play reaches the phone and settles within 0.1 s", settledAfter !== null && settledAfter <= 8,
  settledAfter !== null ? `settled after ${settledAfter.toFixed(1)} s` : `gaps: ${trace.join(" ")}`);
await P.screenshot({ path: shots + "3-chat.png" });

// --- Voice with the phone's real microphone ---
// Brave and Android ask for microphone permission; tap "Allow" through adb.
function tapText(pattern) {
  adb("-s", serial, "shell", "uiautomator", "dump", "/sdcard/samesecond-ui.xml");
  const xml = adb("-s", serial, "shell", "cat", "/sdcard/samesecond-ui.xml").stdout;
  for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    if (pattern.test(m[1])) {
      const x = (Number(m[2]) + Number(m[4])) >> 1, y = (Number(m[3]) + Number(m[5])) >> 1;
      adb("-s", serial, "shell", "input", "tap", String(x), String(y));
      return m[1];
    }
  }
  return null;
}
await A.click("#voice-toggle");
await P.bringToFront(); // permission prompts only show for the tab in front
// Close the on-screen keyboard left open by the chat step, so the page doesn't shift under the tap.
await P.evaluate(() => document.activeElement && document.activeElement.blur());
adb("-s", serial, "shell", "input", "keyevent", "111");
await sleep(800);
await P.$eval("#voice-toggle", (b) => { b.scrollIntoView({ block: "center" }); b.click(); });
const tapped = [];
for (let i = 0; i < 6; i++) {
  await sleep(1500);
  const t = tapText(/^(While using the app|Allow this time|Only this time|Allow while visiting( the site)?|Allow)$/i);
  if (t) tapped.push(t);
  const joined = await P.$eval("#voice-toggle", (e) => e.textContent).catch(() => "");
  if (/Leave/.test(joined)) break;
}
if (tapped.length) console.log(`  (tapped on the phone: ${tapped.join(", ")})`);
let voiceA = "", voiceP = "";
for (let i = 0; i < 20; i++) {
  await sleep(500);
  voiceA = await A.$eval("#voice-people", (e) => e.textContent);
  voiceP = await P.$eval("#voice-people", (e) => e.textContent);
  if (/Phone/.test(voiceA) && /Laptop/.test(voiceP) && !/connect/.test(voiceA + voiceP)) break;
}
if (/Join/.test(await P.$eval("#voice-toggle", (e) => e.textContent))) {
  const state = await P.evaluate(async () => (await navigator.permissions.query({ name: "microphone" })).state).catch(() => "?");
  if (state === "denied") console.log(`  (the phone's browser has blocked the microphone for ${PHONE_APP}; allow it in the browser's site settings, or run with ANDROID_HOST=127.0.0.1)`);
}
check("voice call connects between the phone and the laptop", /Phone/.test(voiceA) && /Laptop/.test(voiceP) && !/connect/.test(voiceA + voiceP), `${voiceA} | ${voiceP}`);
const heard = await A.evaluate(() => [...document.querySelectorAll("audio")].some((x) => x.srcObject && x.srcObject.getAudioTracks().some((t) => t.readyState === "live")));
check("laptop receives the phone's microphone", heard);
await P.screenshot({ path: shots + "4-voice.png" });
await P.tap("#voice-toggle");
await A.click("#voice-toggle");

// Layout: nothing wider than the phone's screen.
const overflow = await P.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check("room fits the phone screen (no sideways scrolling)", !overflow);

// --- A Netflix-type room: the phone explains it needs a laptop, chat still works ---
const pageRoom = "ph" + Math.random().toString(36).slice(2, 8);
const host = new WebSocket(`${APP.replace("http", "ws")}/api/rooms/${pageRoom}/ws`);
const hostInbox = [];
host.onmessage = (e) => hostInbox.push(JSON.parse(e.data));
await new Promise((r) => { host.onopen = r; });
host.send(JSON.stringify({ t: "hello", name: "Laptop", clientKey: "android-host", kind: "ext", create: { url: "https://www.netflix.com/watch/81234567", title: "Episode 7", position: 30, playing: true } }));
await sleep(500);
await P.goto(`${PHONE_APP}/r/${pageRoom}`);
await sleep(3000);
const card = await P.$eval("#stage", (e) => e.textContent);
check("Netflix-type room explains the phone needs a laptop", /netflix\.com/.test(card) && /extension/.test(card), card.slice(0, 90));
await P.tap("#chat-input");
await P.type("#chat-input", "watching along on my phone");
await P.keyboard.press("Enter");
await sleep(1500);
check("phone can chat in a Netflix-type room", hostInbox.some((m) => m.t === "chat" && m.message.text === "watching along on my phone"));
await P.screenshot({ path: shots + "5-netflix-room.png" });
host.close();

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
