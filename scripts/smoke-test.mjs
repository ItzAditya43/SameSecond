// End-to-end check of the room server plus unit checks of the sync engine.
// Starts `wrangler dev` itself unless SYNCROOM_URL points at a running server.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import "../shared/sync-core.js";

const SC = globalThis.SyncCore;
let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- sync engine ----------

console.log("sync engine");

await test("classifies YouTube links", () => {
  for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"]) {
    const c = SC.classifyUrl(u);
    assert.equal(c.kind, "youtube", u);
    assert.equal(c.id, "dQw4w9WgXcQ", u);
  }
  assert.equal(SC.classifyUrl("https://youtu.be/dQw4w9WgXcQ?t=42").start, 42);
});

await test("classifies files, streams and pages", () => {
  assert.equal(SC.classifyUrl("https://x.com/a/movie.mp4").kind, "file");
  assert.equal(SC.classifyUrl("https://x.com/live/index.m3u8?token=1").hls, true);
  assert.equal(SC.classifyUrl("https://www.netflix.com/watch/81234567").kind, "page");
  assert.equal(SC.classifyUrl("javascript:alert(1)").kind, "invalid");
  assert.equal(SC.classifyUrl("not a url").kind, "invalid");
});

await test("matches the same video across URL variations", () => {
  assert.equal(SC.urlKey("https://www.netflix.com/watch/81234567?trackId=1"), SC.urlKey("https://www.netflix.com/watch/81234567?trackId=2"));
  assert.equal(SC.urlKey("https://youtu.be/dQw4w9WgXcQ"), SC.urlKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x"));
  assert.notEqual(SC.urlKey("https://www.netflix.com/watch/1"), SC.urlKey("https://www.netflix.com/watch/2"));
});

await test("computes where playback should be", () => {
  assert.equal(SC.expectedPosition({ playing: false, position: 10, updatedAt: 0 }, 5000), 10);
  assert.equal(SC.expectedPosition({ playing: true, position: 10, updatedAt: 1000 }, 3500), 12.5);
});

await test("estimates clock offset from the fastest samples", () => {
  const c = new SC.ClockSync();
  c.add(1000, 6050, 1100); // rtt 100, offset 5000
  c.add(2000, 7500, 3000); // rtt 1000, poor sample
  c.add(3000, 8010, 3020); // rtt 20, offset 5000
  assert.ok(Math.abs(c.offset - 5000) < 200, `offset ${c.offset}`);
});

function fakePlayer(opts = {}) {
  const p = {
    t: opts.t ?? 0, paused: opts.paused ?? true, rate: 1, seeks: [], buffering: false,
    supportsRate: opts.supportsRate ?? true,
    isReady: () => true,
    getTime: () => p.t,
    isPaused: () => p.paused,
    isBuffering: () => p.buffering,
    play: () => { p.paused = false; },
    pause: () => { p.paused = true; },
    seek: (t) => { p.seeks.push(t); p.t = t; },
    setRate: (r) => { p.rate = r; }
  };
  return p;
}

await test("follower jumps to the room when far off", () => {
  const player = fakePlayer({ t: 0 });
  let now = 10_000;
  const c = new SC.SyncController({ player, send: () => {}, now: () => now });
  c.applyRemote({ playing: true, position: 100, updatedAt: 8_000 });
  assert.equal(player.paused, false);
  assert.ok(Math.abs(player.t - 102) < 0.01, `t=${player.t}`);
});

await test("follower speeds up slightly for small drift instead of jumping", () => {
  const player = fakePlayer({ t: 99.6, paused: false });
  const c = new SC.SyncController({ player, send: () => {}, now: () => 0 });
  c.applyRemote({ playing: true, position: 100, updatedAt: 0 });
  assert.equal(player.seeks.length, 0);
  assert.equal(player.rate, 1.1, "0.4 s behind plays 10% faster");
  player.t = 99.92;
  c.ignoreUntil = 0;
  c.reconcile(false);
  assert.equal(player.rate, 1.02, "0.08 s behind plays 2% faster");
  player.t = 100;
  c.ignoreUntil = 0;
  c.reconcile(false);
  assert.equal(player.rate, 1);
});

await test("follower waits instead of seeking while its video is loading", () => {
  const player = fakePlayer({ t: 10, paused: false });
  player.buffering = true;
  const c = new SC.SyncController({ player, send: () => {}, now: () => 0 });
  c.applyRemote({ playing: true, position: 50, updatedAt: 0 });
  assert.equal(player.seeks.length, 0);
});

await test("local pause is sent to the room once", async () => {
  const player = fakePlayer({ t: 20, paused: false });
  const sent = [];
  const c = new SC.SyncController({ player, send: (m) => sent.push(m), now: () => 0 });
  c.applyRemote({ playing: true, position: 20, updatedAt: 0 });
  c.ignoreUntil = 0;
  player.paused = true;
  c.onLocalEvent("pause");
  c.onLocalEvent("pause");
  await sleep(200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { t: "state", playing: false, position: 20, at: 0 });
});

await test("events caused by the room itself are not echoed back", async () => {
  const player = fakePlayer({ t: 0 });
  const sent = [];
  const c = new SC.SyncController({ player, send: (m) => sent.push(m), now: () => 0 });
  c.applyRemote({ playing: true, position: 30, updatedAt: 0 });
  c.onLocalEvent("play");
  c.onLocalEvent("seeked");
  await sleep(200);
  assert.equal(sent.length, 0);
});

await test("viewers without control are pulled back", async () => {
  const player = fakePlayer({ t: 40, paused: false });
  const sent = [];
  let notice = "";
  const c = new SC.SyncController({ player, send: (m) => sent.push(m), now: () => 0, canControl: () => false, onNotice: (n) => { notice = n; } });
  c.applyRemote({ playing: true, position: 40, updatedAt: 0 });
  c.ignoreUntil = 0;
  player.paused = true;
  c.onLocalEvent("pause");
  await sleep(200);
  assert.equal(sent.length, 0);
  assert.equal(player.paused, false);
  assert.match(notice, /host/);
});

await test("a seek on a player stuck paused never pauses the room", async () => {
  const player = fakePlayer({ t: 0, paused: true });
  player.play = () => {}; // the browser refuses to start
  const sent = [];
  const c = new SC.SyncController({ player, send: (m) => sent.push(m), now: () => 0 });
  c.applyRemote({ playing: true, position: 1.8, updatedAt: 0 });
  c.onLocalEvent("seeked");
  c.ignoreUntil = 0;
  player.t = 30;
  c.onLocalEvent("seeked");
  await sleep(200);
  assert.ok(sent.every((m) => m.playing === true), JSON.stringify(sent));
});

await test("a player locked by autoplay rules stays out of the room's way", async () => {
  const player = fakePlayer({ t: 0, paused: true });
  player.locked = true;
  player.isLocked = () => player.locked;
  const sent = [];
  const c = new SC.SyncController({ player, send: (m) => sent.push(m), now: () => 0 });
  c.applyRemote({ playing: true, position: 50, updatedAt: 0 });
  c.onLocalEvent("pause");
  c.tick(); c.bufferSince -= 5000; c.tick();
  await sleep(200);
  assert.equal(sent.length, 0, "locked player sent " + JSON.stringify(sent));
  assert.equal(player.seeks.length, 0);
  player.locked = false;
  c.reconcile(true);
  assert.equal(player.paused, false);
  assert.equal(player.t, 50);
});

await test("buffering is reported after a second and cleared after", () => {
  const player = fakePlayer({ t: 0, paused: false });
  const sent = [];
  const c = new SC.SyncController({ player, send: (m) => sent.push(m), now: () => 0 });
  c.applyRemote({ playing: true, position: 0, updatedAt: 0 });
  player.buffering = true;
  c.tick();
  c.bufferSince -= 1500;
  c.tick();
  player.buffering = false;
  c.tick();
  assert.deepEqual(sent.map((m) => m.on), [true, false]);
});

// ---------- room server ----------

let base = process.env.SYNCROOM_URL;
let dev = null;
if (!base) {
  base = "http://127.0.0.1:8799";
  dev = spawn("npx", ["wrangler", "dev", "--port", "8799", "--ip", "127.0.0.1", "--log-level", "warn"], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  dev.stdout.on("data", (d) => { log += d; });
  dev.stderr.on("data", (d) => { log += d; });
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (i > 60) { console.log(log); throw new Error("wrangler dev did not start"); }
    await sleep(500);
  }
}

class Client {
  constructor(room, hello) {
    this.inbox = [];
    this.waiters = [];
    this.ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${room}/ws`);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => (w.test(m) ? (w.resolve(m), false) : true));
    };
    this.closed = new Promise((r) => { this.ws.onclose = (e) => r(e.code); });
    this.opened = new Promise((r) => { this.ws.onopen = () => { this.send(hello); r(); }; });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  next(test, ms = 3000) {
    const found = this.inbox.find(test);
    if (found) { this.inbox.splice(this.inbox.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((resolve, reject) => {
      const w = { test, resolve: (m) => { clearTimeout(timer); this.inbox.splice(this.inbox.indexOf(m), 1); resolve(m); } };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error("timed out waiting for message")); }, ms);
      this.waiters.push(w);
    });
  }
  drain() { this.inbox = []; }
  close() { this.ws.close(); }
}
const is = (t, extra = () => true) => (m) => m.t === t && extra(m);

console.log(`room server (${base})`);
const room = "test" + Math.random().toString(36).slice(2, 8);
const video = "https://www.netflix.com/watch/81234567";
let a, b;

await test("health check responds", async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal((await r.json()).ok, true);
});

await test("web app is served, including invite paths", async () => {
  const home = await fetch(`${base}/`);
  assert.match(await home.text(), /Syncroom/);
  const invite = await fetch(`${base}/r/${room}`);
  assert.equal(invite.status, 200);
  assert.match(await invite.text(), /app\.js/);
});

await test("unknown room reports it doesn't exist", async () => {
  const r = await fetch(`${base}/api/rooms/${room}`);
  assert.equal((await r.json()).exists, false);
});

await test("joining a room that doesn't exist is refused", async () => {
  const c = new Client("nosuchroom1", { t: "hello", name: "X", clientKey: "kx", kind: "web" });
  const err = await c.next(is("error"));
  assert.equal(err.code, "no-room");
  assert.equal(await c.closed, 4004);
});

await test("host creates a room", async () => {
  a = new Client(room, { t: "hello", name: "Aditya", clientKey: "key-a", kind: "ext", create: { url: video, title: "Episode 1", position: 42, playing: false } });
  const w = await a.next(is("welcome"));
  assert.equal(w.host, true);
  assert.equal(w.state.url, video);
  assert.equal(w.state.position, 42);
  assert.equal(w.title, "Episode 1");
});

await test("friend joins and gets the room's state", async () => {
  b = new Client(room, { t: "hello", name: "Sam", clientKey: "key-b", kind: "web" });
  const w = await b.next(is("welcome"));
  assert.equal(w.host, false);
  assert.equal(w.state.position, 42);
  assert.equal(w.members.length, 2);
  const m = await a.next(is("members", (x) => x.members.length === 2));
  assert.ok(m.members.some((x) => x.name === "Sam"));
});

await test("room info is public for the invite page", async () => {
  const info = await (await fetch(`${base}/api/rooms/${room}`)).json();
  assert.equal(info.exists, true);
  assert.equal(info.url, video);
  assert.equal(info.members, 2);
});

await test("clock ping returns server time", async () => {
  b.send({ t: "ping", c: 123 });
  const p = await b.next(is("pong"));
  assert.equal(p.c, 123);
  assert.ok(Math.abs(p.s - Date.now()) < 5000);
});

await test("play from one person reaches the other", async () => {
  a.drain(); b.drain();
  a.send({ t: "state", playing: true, position: 100 });
  const s = await b.next(is("state"));
  assert.equal(s.state.playing, true);
  assert.equal(s.state.position, 100);
  assert.ok(s.by);
});

await test("play is timed from when it was sent, not when it arrived", async () => {
  a.drain(); b.drain();
  const at = Date.now() - 300;
  a.send({ t: "state", playing: true, position: 100, at });
  const s = await b.next(is("state", (m) => m.state.position === 100));
  assert.equal(s.state.updatedAt, at);
  a.send({ t: "state", playing: true, position: 100, at: Date.now() + 60_000 });
  const s2 = await b.next(is("state", (m) => m.state.updatedAt !== at));
  assert.ok(s2.state.updatedAt <= Date.now(), "future timestamps must be ignored");
});

await test("room holds while someone buffers, then resumes", async () => {
  a.drain(); b.drain();
  b.send({ t: "buffering", on: true });
  const held = await a.next(is("state", (m) => m.state.waitingFor.length > 0));
  assert.equal(held.state.playing, false);
  assert.equal(held.state.intendsToPlay, true);
  assert.deepEqual(held.state.waitingFor, ["Sam"]);
  await sleep(300);
  b.send({ t: "buffering", on: false });
  const resumed = await a.next(is("state", (m) => m.state.seq > held.state.seq));
  assert.equal(resumed.state.playing, true);
  assert.deepEqual(resumed.state.waitingFor, []);
  assert.ok(resumed.state.position >= held.state.position);
  assert.ok(resumed.state.position - held.state.position < 0.2, "clock should not advance while held");
});

await test("chat is delivered to everyone", async () => {
  b.send({ t: "chat", text: "  hi there  " });
  const ma = await a.next(is("chat"));
  const mb = await b.next(is("chat"));
  assert.equal(ma.message.text, "hi there");
  assert.equal(mb.message.name, "Sam");
});

await test("host can restrict control to themselves", async () => {
  a.drain(); b.drain();
  b.send({ t: "settings", control: "host" });
  await sleep(300);
  assert.equal(a.inbox.filter(is("members", (m) => m.control === "host")).length, 0, "non-host changed settings");
  a.send({ t: "settings", control: "host" });
  await a.next(is("members", (m) => m.control === "host"));
  b.drain();
  b.send({ t: "state", playing: false, position: 5 });
  await sleep(400);
  assert.equal(a.inbox.filter(is("state")).length, 0, "non-host changed playback");
});

await test("navigate moves the room to a new video", async () => {
  a.drain(); b.drain();
  a.send({ t: "navigate", url: "https://www.netflix.com/watch/81234568", title: "Episode 2", position: 0, playing: true });
  const s = await b.next(is("state"));
  assert.equal(s.state.url, "https://www.netflix.com/watch/81234568");
  assert.equal(s.state.playing, true);
  a.send({ t: "navigate", url: "javascript:alert(1)" });
  await sleep(300);
  assert.equal(b.inbox.filter(is("state")).length, 0, "unsafe URL accepted");
});

await test("voice signalling is relayed to one person", async () => {
  const wa = (await fetch(`${base}/api/rooms/${room}`)).ok;
  assert.ok(wa);
  a.send({ t: "voice", on: true });
  const members = await b.next(is("members", (m) => m.members.some((x) => x.voice)));
  const aid = members.members.find((x) => x.name === "Aditya").id;
  b.send({ t: "signal", to: aid, data: { sdp: { type: "offer", sdp: "x" } } });
  const sig = await a.next(is("signal"));
  assert.equal(sig.data.sdp.type, "offer");
});

await test("everyone can control again when the host leaves", async () => {
  a.close();
  await b.next(is("members", (m) => m.members.length === 1 && m.hostOnline === false));
  b.drain();
  const c = new Client(room, { t: "hello", name: "Kai", clientKey: "key-c", kind: "web" });
  await c.next(is("welcome"));
  b.send({ t: "state", playing: false, position: 7 });
  const s = await c.next(is("state"));
  assert.equal(s.state.position, 7);
  c.close();
});

await test("host gets host rights back on reconnect", async () => {
  a = new Client(room, { t: "hello", name: "Aditya", clientKey: "key-a", kind: "ext" });
  const w = await a.next(is("welcome"));
  assert.equal(w.host, true);
  assert.equal(w.chat.length, 1, "chat history kept");
  a.close();
  b.close();
});

await test("invite links get a link preview naming the video", async () => {
  const html = await (await fetch(`${base}/r/${room}`)).text();
  assert.match(html, /property="og:title" content="Join my watch party: Episode 2"/);
  assert.match(html, /property="og:description" content="Watching on netflix\.com with Syncroom\./);
  assert.match(html, new RegExp(`property="og:image" content="${base.replace(/[.]/g, "\\.")}/og\\.png"`));
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /og:title" content="Join my watch party on Syncroom"/);
  const og = await fetch(`${base}/og.png`);
  assert.equal(og.headers.get("content-type"), "image/png");
});

await test("room titles are escaped in link previews", async () => {
  const id = "xss" + Math.random().toString(36).slice(2, 8);
  const c = new Client(id, { t: "hello", name: "X", clientKey: "kx2", kind: "web", create: { url: "https://example.com/a.mp4", title: '"><script>alert(1)</script>' } });
  await c.next(is("welcome"));
  const html = await (await fetch(`${base}/r/${id}`)).text();
  const tag = html.split("\n").find((l) => l.includes('property="og:title"'));
  assert.ok(tag.includes("&quot;"), "quote should be escaped");
  assert.ok(!tag.includes('""><script>') && !/content="[^"]*"><script>/.test(tag), "title broke out of the attribute");
  c.close();
});

await test("bad room ids are rejected", async () => {
  const r = await fetch(`${base}/api/rooms/BAD!id`);
  assert.equal(r.status, 400);
  const r2 = await fetch(`${base}/api/rooms/ab`);
  assert.equal(r2.status, 400);
});

await test("malformed, oversized and unknown messages are ignored", async () => {
  const id = "junk" + Math.random().toString(36).slice(2, 8);
  const c = new Client(id, { t: "hello", name: "J", clientKey: "kj", kind: "web", create: { url: "https://example.com/a.mp4" } });
  await c.next(is("welcome"));
  c.ws.send("not json");
  c.ws.send(JSON.stringify({ nope: 1 }));
  c.ws.send(JSON.stringify({ t: "explode" }));
  c.ws.send(JSON.stringify({ t: "chat", text: "x".repeat(20000) }));
  c.ws.send(JSON.stringify({ t: "state", playing: true, position: -5 }));
  c.ws.send(JSON.stringify({ t: "state", playing: true, position: "abc" }));
  c.ws.send(JSON.stringify({ t: "chat", text: "y".repeat(800) }));
  const m = await c.next(is("chat"));
  assert.equal(m.message.text.length, 500, "long chat should be trimmed to 500");
  await sleep(300);
  assert.equal(c.inbox.filter(is("state")).length, 0, "invalid state accepted");
  c.send({ t: "ping", c: 1 });
  await c.next(is("pong"));
  c.close();
});

await test("renaming updates the people list", async () => {
  const id = "ren" + Math.random().toString(36).slice(2, 8);
  const c = new Client(id, { t: "hello", name: "Old", clientKey: "kr", kind: "web", create: { url: "https://example.com/a.mp4" } });
  await c.next(is("welcome"));
  c.send({ t: "rename", name: "  New name  " });
  const m = await c.next(is("members", (x) => x.members[0].name === "New name"));
  assert.ok(m);
  c.close();
});

await test("a stuck loader can't hold the room forever", async () => {
  const id = "stk" + Math.random().toString(36).slice(2, 8);
  const h = new Client(id, { t: "hello", name: "H", clientKey: "kh", kind: "web", create: { url: "https://example.com/a.mp4", playing: true } });
  await h.next(is("welcome"));
  const f = new Client(id, { t: "hello", name: "F", clientKey: "kf", kind: "web" });
  await f.next(is("welcome"));
  f.send({ t: "buffering", on: true });
  await h.next(is("state", (m) => m.state.waitingFor.length === 1));
  f.close();
  const freed = await h.next(is("state", (m) => m.state.waitingFor.length === 0));
  assert.equal(freed.state.playing, true, "room should resume when the loader leaves");
  h.close();
});

await test("ICE server list is available for voice", async () => {
  const r = await (await fetch(`${base}/api/ice`)).json();
  assert.ok(Array.isArray(r.iceServers) && r.iceServers.length > 0);
});

if (dev) dev.kill();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
