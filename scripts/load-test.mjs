// Many rooms at once: checks every play/seek reaches everyone, measures how
// fast, and estimates how much use Cloudflare's free tier covers.
// Usage: node scripts/load-test.mjs            (starts wrangler dev itself)
//        SAMESECOND_URL=https://… ROOMS=20 PEOPLE=5 SECONDS=30 node scripts/load-test.mjs
import { spawn } from "node:child_process";

const ROOMS = Number(process.env.ROOMS || 40);
const PEOPLE = Number(process.env.PEOPLE || 6);
const SECONDS = Number(process.env.SECONDS || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let base = process.env.SAMESECOND_URL;
let dev = null;
if (!base) {
  base = "http://127.0.0.1:8796";
  dev = spawn("npx", ["wrangler", "dev", "--port", "8796", "--ip", "127.0.0.1", "--log-level", "warn"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore", detached: true });
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch { /* starting */ }
    if (i > 80) throw new Error("wrangler dev did not start");
    await sleep(500);
  }
}

function connect(room, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${room}/ws`);
    const c = { ws, got: new Map(), welcome: null, sent: 0 };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "welcome") { c.welcome = m; resolve(c); }
      if (m.t === "state" && m.state.marker) c.got.set(m.state.marker, Date.now());
      if (m.t === "state" && typeof m.state.position === "number") c.got.set(m.state.position, Date.now());
    };
    ws.onerror = () => reject(new Error("socket error"));
    ws.onopen = () => { ws.send(JSON.stringify(hello)); c.sent++; };
  });
}

console.log(`${ROOMS} rooms × ${PEOPLE} people for ${SECONDS} s against ${base}`);
const rooms = [];
const t0 = Date.now();
for (let r = 0; r < ROOMS; r++) {
  const id = "load" + r.toString(36) + Math.random().toString(36).slice(2, 7);
  const host = await connect(id, { t: "hello", name: "Host", clientKey: "h" + id, kind: "web", create: { url: "https://example.com/v.mp4" } });
  const others = await Promise.all(Array.from({ length: PEOPLE - 1 }, (_, i) => connect(id, { t: "hello", name: "P" + i, clientKey: `p${i}${id}`, kind: "web" })));
  rooms.push({ id, host, others });
}
console.log(`joined ${ROOMS * PEOPLE} people in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// Each host changes playback every 2 s; everyone also sends normal background traffic.
const sentAt = new Map();
let changes = 0;
const all = rooms.flatMap((r) => [r.host, ...r.others]);
const status = setInterval(() => all.forEach((c) => { c.ws.send(JSON.stringify({ t: "status", ready: true, playing: true, position: 1 })); c.sent++; }), 10_000);
const end = Date.now() + SECONDS * 1000;
let n = 0;
while (Date.now() < end) {
  for (const r of rooms) {
    // A unique position per change identifies it on arrival.
    const position = 1000 + n * 1000 + rooms.indexOf(r) + 0.5;
    sentAt.set(position, { at: Date.now(), room: r });
    r.host.ws.send(JSON.stringify({ t: "state", playing: n % 2 === 0, position, at: Date.now() }));
    r.host.sent++;
    changes++;
  }
  n++;
  await sleep(2000);
}
clearInterval(status);
await sleep(1500);

const latencies = [];
let missing = 0;
for (const [position, { at, room }] of sentAt) {
  for (const c of room.others) {
    const got = c.got.get(position);
    if (got) latencies.push(got - at);
    else missing++;
  }
}
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
console.log(`playback changes: ${changes}, deliveries: ${latencies.length}, lost: ${missing}`);
console.log(`delivery time: median ${pct(50)} ms, 95th ${pct(95)} ms, 99th ${pct(99)} ms, worst ${latencies[latencies.length - 1]} ms`);

// Free-tier estimate from the clients' real background cadence (status 10 s,
// clock ping 60 s, keep-alive 25 s), counted at Cloudflare's 20:1 rate for
// incoming WebSocket messages, plus a few one-off requests per visit.
const perHour = 3600 / 10 + 3600 / 60 + 3600 / 25;
const requestsPerViewerHour = perHour / 20;
const viewerHours = Math.floor(100_000 / (requestsPerViewerHour + 2));
console.log(`free tier: ~${requestsPerViewerHour.toFixed(0)} counted requests per viewer per hour → about ${viewerHours.toLocaleString()} viewer-hours a day`);
console.log(`           e.g. ${Math.floor(viewerHours / 10).toLocaleString()} two-hour movie nights of 5 people, every day`);

all.forEach((c) => c.ws.close());
if (dev) try { process.kill(-dev.pid); } catch { /* stopped */ }
const ok = missing === 0 && pct(95) < 1000;
console.log(ok ? "load test passed" : "load test FAILED");
process.exit(ok ? 0 : 1);
