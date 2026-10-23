// Invite link -> "Open in the extension" -> synced tab, for a site the web
// app can't play. Usage: node bridge.mjs chrome|firefox
import puppeteer from "puppeteer-core";
import { APP, MEDIA_BASE, CHROME_ARGS, buildExtension } from "./env.mjs";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const which = process.argv[2] || "chrome";
const PAGE = MEDIA_BASE + "/watch.html";
const here = new URL(".", import.meta.url).pathname;
const EXT = here + ".ext-build-" + which;
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const FIREFOX = process.env.FIREFOX_PATH || "/usr/bin/firefox";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

buildExtension(which === "firefox" ? "firefox" : "chrome", APP, EXT.replace(new URL("../..", import.meta.url).pathname, ""));
const media = spawn("node", [here + "media-server.mjs"], { stdio: "ignore" });
await sleep(500);

// The host is a plain WebSocket client standing in for another person's extension.
const room = "br" + Math.random().toString(36).slice(2, 8);
const host = new WebSocket(`${APP.replace("http", "ws")}/api/rooms/${room}/ws`);
const hostInbox = [];
host.onmessage = (e) => hostInbox.push(JSON.parse(e.data));
await new Promise((r) => { host.onopen = r; });
host.send(JSON.stringify({ t: "hello", name: "Host", clientKey: "host-key", kind: "ext", create: { url: PAGE, title: "Episode 7", position: 30, playing: false } }));
await sleep(500);

const browser = which === "firefox"
  ? await puppeteer.launch({ browser: "firefox", executablePath: FIREFOX, headless: true, acceptInsecureCerts: true, extraPrefsFirefox: { "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0 } })
  : await puppeteer.launch({ executablePath: CHROMIUM, headless: true, acceptInsecureCerts: true, pipe: true, enableExtensions: [EXT], args: [...CHROME_ARGS, "--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
if (which === "firefox") {
  const id = await browser.installExtension(EXT);
  check("extension installs in Firefox", !!id, id);
}
await sleep(1500);

const I = await browser.newPage();
await I.goto(`${APP}/r/${room}`);
await I.waitForSelector("#gate-name");
await I.type("#gate-name", "Friend");
await I.click(".stage-card button[type=submit]");
await sleep(2000);
const card = await I.$eval("#stage", (e) => e.textContent);
check("invite page explains the site needs the extension", /127\.0\.0\.1/.test(card) && /Episode 7/.test(card), card.slice(0, 90));
const hasExt = await I.evaluate(() => !!document.documentElement.dataset.samesecondExt);
check("invite page detects the extension", hasExt);
await I.screenshot({ path: here + `shots/invite-ext-${which}.png` });

const pagesBefore = (await browser.pages()).length;
await I.evaluate(() => { for (const b of document.querySelectorAll(".stage-card button")) if (/extension/.test(b.textContent)) b.click(); });
let V = null;
for (let i = 0; i < 20 && !V; i++) {
  await sleep(500);
  for (const p of await browser.pages()) if (p.url() === PAGE) V = p;
}
check("extension opens the site in a new tab", !!V, `${pagesBefore} -> ${(await browser.pages()).length} tabs`);
if (V) {
  await sleep(3000);
  const vt = () => V.evaluate(() => { const v = document.querySelector("video"); return { t: v.currentTime, paused: v.paused }; });
  let v = await vt();
  check("tab jumps to the room's position", Math.abs(v.t - 30) < 0.6, v.t.toFixed(2));
  const members = hostInbox.filter((m) => m.t === "members").pop();
  check("host sees the friend join via extension", members && members.members.some((m) => m.name === "Friend" && m.kind === "ext"), JSON.stringify(members && members.members.map((m) => m.name + ":" + m.kind)));

  host.send(JSON.stringify({ t: "state", playing: true, position: 45 }));
  const sentAt = Date.now();
  await sleep(2500);
  v = await vt();
  const expected = 45 + (Date.now() - sentAt) / 1000;
  check("tab plays in sync with the host", !v.paused && Math.abs(v.t - expected) < 0.8, `${v.t.toFixed(2)} vs ${expected.toFixed(2)}`);

  host.send(JSON.stringify({ t: "state", playing: false, position: 50 }));
  await sleep(1500);
  v = await vt();
  check("tab pauses with the host", v.paused && Math.abs(v.t - 50) < 0.5, JSON.stringify(v));
}

host.close();
await browser.close();
media.kill();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
