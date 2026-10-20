// The server restarting mid-room, and the browser stopping the extension's
// background worker. Runs its own server on port 8798.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";

const APP = "http://127.0.0.1:8798";
const MEDIA = "http://127.0.0.1:8800/test.mp4";
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const here = new URL(".", import.meta.url).pathname;
const root = new URL("../..", import.meta.url).pathname;
const EXT = here + ".ext-build-resilience";
const STATE = here + ".wrangler-state";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}
const vt = (p) => p.evaluate(() => { const v = document.querySelector("video"); return { t: v.currentTime, paused: v.paused, now: performance.timeOrigin + performance.now() }; });
const gap = (x, y) => Math.abs((x.t - (x.paused ? 0 : x.now / 1000)) - (y.t - (y.paused ? 0 : y.now / 1000)));

let server = null;
async function startServer() {
  server = spawn("npx", ["wrangler", "dev", "--port", "8798", "--ip", "127.0.0.1", "--persist-to", STATE, "--log-level", "warn"], { cwd: root, stdio: "ignore", detached: true });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(APP + "/api/health")).ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error("server did not start");
}
function stopServer() {
  try { process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ }
}

rmSync(STATE, { recursive: true, force: true });
rmSync(EXT, { recursive: true, force: true });
cpSync(root + "extension", EXT, { recursive: true });
writeFileSync(EXT + "/config.js", readFileSync(EXT + "/config.js", "utf8").replace(/SYNCROOM_DEFAULT_SERVER = ".*?"/, `SYNCROOM_DEFAULT_SERVER = "${APP}"`));
const media = spawn("node", [here + "media-server.mjs"], { stdio: "ignore" });
await startServer();

const browser = await puppeteer.launch({
  executablePath: CHROMIUM, headless: true, pipe: true, enableExtensions: [EXT],
  args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"]
});
const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
const extId = new URL(swTarget.url()).host;

// Extension host on the video tab.
const V = await browser.newPage();
await V.goto(MEDIA);
await V.waitForFunction(() => document.querySelector("video") && document.querySelector("video").readyState >= 1);
const P = await browser.newPage();
await P.goto(`chrome-extension://${extId}/panel.html`);
await P.evaluate(async (url) => {
  const [tab] = await chrome.tabs.query({ url });
  chrome.runtime.connect({ name: "syncroom-panel" }).postMessage({ type: "start", tabId: tab.id, name: "Aditya" });
}, MEDIA);
await P.waitForFunction(() => document.getElementById("invite").value, { timeout: 8000 });
const invite = await P.$eval("#invite", (e) => e.value);

// Web friend.
const B = await (await browser.createBrowserContext()).newPage();
await B.goto(invite);
await B.type("#gate-name", "Sam");
await B.click(".stage-card button[type=submit]");
await B.waitForFunction(() => document.querySelector("video") && document.querySelector("video").readyState >= 1);
await B.evaluate(() => document.querySelector("video").play());
await B.type("#chat-input", "before the restart");
await B.click("#chat-form button");
await sleep(3000);
let v = await vt(V), b = await vt(B);
check("room is playing in sync before anything breaks", !v.paused && gap(v, b) < 0.15, `gap ${gap(v, b).toFixed(3)}`);

// 1. Server dies.
stopServer();
await sleep(2500);
const syncDown = await B.$eval("#sync-text", (e) => e.textContent);
check("web app shows it's reconnecting", /Reconnecting/.test(syncDown), syncDown);
v = await vt(V); b = await vt(B);
check("playback carries on while the server is down", !v.paused && !b.paused);

// 2. Server comes back.
await startServer();
let back = false;
for (let i = 0; i < 40 && !back; i++) {
  await sleep(500);
  back = !/Reconnecting/.test(await B.$eval("#sync-text", (e) => e.textContent)) && /Connected/.test(await P.$eval("#conn", (e) => e.textContent));
}
check("both reconnect after the server returns", back);
await sleep(2500);
v = await vt(V); b = await vt(B);
check("still in sync after the restart", !v.paused && !b.paused && gap(v, b) < 0.15, `gap ${gap(v, b).toFixed(3)}`);
const people = await B.$eval("#people-count", (e) => e.textContent);
check("people list is right after the restart", people === "2", people);
const chat = await B.$eval("#chat-log", (e) => e.textContent);
check("chat history survives the restart", chat.includes("before the restart"));
await B.evaluate(() => document.querySelector("video").pause());
await sleep(1500);
v = await vt(V);
check("controls work after the restart", v.paused);

// 3. Browser stops the extension's background worker.
await B.evaluate(() => document.querySelector("video").play());
await sleep(1500);
let stopped = false;
browser.on("targetdestroyed", (t) => { if (t.type() === "service_worker" && t.url().includes(extId)) stopped = true; });
const cdp = await P.createCDPSession();
await cdp.send("ServiceWorker.enable");
await cdp.send("ServiceWorker.stopAllWorkers");
const bcdp = await browser.target().createCDPSession();
const { targetInfos } = await bcdp.send("Target.getTargets");
for (const t of targetInfos) if (t.type === "service_worker" && t.url.includes(extId)) await bcdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
await sleep(1500);
check("background worker was stopped", stopped);
await sleep(6000);
const revived = (await browser.targets()).some((t) => t.type() === "service_worker" && t.url().includes(extId));
check("background worker comes back on its own", revived);
await B.evaluate(() => { const x = document.querySelector("video"); x.currentTime = 90; });
await sleep(3000);
v = await vt(V); b = await vt(B);
check("extension tab follows a seek after the worker restarted", gap(v, b) < 0.2 && v.t > 88, `${v.t.toFixed(2)} vs ${b.t.toFixed(2)}`);
const count = await B.$eval("#people-count", (e) => e.textContent);
check("no duplicate person after the worker restarted", count === "2", count);

await browser.close();
stopServer();
media.kill();
rmSync(STATE, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
