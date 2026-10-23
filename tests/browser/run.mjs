// Runs the browser tests against a local `wrangler dev`.
// Needs Chromium and ffmpeg (to make the test video). Options:
//   firefox  also run the web app and invite handoff in Firefox
//   youtube  also run the real-YouTube suite (needs internet)
//   https    repeat the main suites over HTTPS, like the live site (needs openssl)
// Usage: npm run test:browser -- firefox youtube https
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const root = new URL("../..", import.meta.url).pathname;
const opts = process.argv.slice(2);
mkdirSync(here + "shots", { recursive: true });

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (r.status !== 0) { console.error("ffmpeg failed; install ffmpeg to make the test video"); process.exit(1); }
}
if (!existsSync(here + "media/test.mp4")) {
  console.log("making test video…");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "120", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24", "-c:a", "aac", "-movflags", "+faststart", here + "media/test.mp4"]);
}
if (!existsSync(here + "media/hls/index.m3u8")) {
  console.log("making test HLS stream…");
  mkdirSync(here + "media/hls", { recursive: true });
  ffmpeg(["-i", here + "media/test.mp4", "-c", "copy", "-hls_time", "4", "-hls_playlist_type", "vod",
    "-hls_segment_filename", here + "media/hls/seg%03d.ts", here + "media/hls/index.m3u8"]);
}
spawnSync("node", [root + "scripts/pack-extension.mjs", "http://localhost:8787", "--target", "chrome", "--out", "public/downloads/samesecond-extension.zip"], { stdio: "inherit" });

const dev = spawn("npx", ["wrangler", "dev", "--port", "8799", "--ip", "127.0.0.1", "--log-level", "warn"], { cwd: root, stdio: "ignore", detached: true });
for (let i = 0; ; i++) {
  try { if ((await fetch("http://127.0.0.1:8799/api/health")).ok) break; } catch { /* starting */ }
  if (i > 80) { process.kill(-dev.pid); throw new Error("wrangler dev did not start"); }
  await new Promise((r) => setTimeout(r, 500));
}

const runs = [["web.mjs", "chrome"], ["extras.mjs"], ["ext.mjs", "chrome"], ["bridge.mjs", "chrome"], ["resilience.mjs"]];
if (opts.includes("firefox")) runs.push(["web.mjs", "firefox"], ["bridge.mjs", "firefox"]);
if (opts.includes("youtube")) runs.push(["youtube.mjs"]);
const failed = [];
function suite(file, args, env = {}, tag = "") {
  const label = [file, ...args].join(" ") + tag;
  console.log(`\n${label}`);
  const r = spawnSync("node", [here + file, ...args], { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) failed.push(label);
}
for (const [file, ...args] of runs) suite(file, args);
try { process.kill(-dev.pid); } catch { /* already stopped */ }

// The live site runs on https:// and wss://, so repeat the main suites over HTTPS.
if (opts.includes("https")) {
  const tls = here + ".tls";
  mkdirSync(tls, { recursive: true });
  if (!existsSync(tls + "/cert.pem")) {
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tls + "/key.pem", "-out", tls + "/cert.pem",
      "-days", "30", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    if (r.status !== 0) { console.error("openssl is needed for the HTTPS pass"); process.exit(1); }
  }
  const secure = spawn("npx", ["wrangler", "dev", "--port", "8797", "--ip", "127.0.0.1", "--local-protocol", "https",
    "--https-key-path", tls + "/key.pem", "--https-cert-path", tls + "/cert.pem", "--log-level", "warn"], { cwd: root, stdio: "ignore", detached: true });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  for (let i = 0; ; i++) {
    try { if ((await fetch("https://127.0.0.1:8797/api/health")).ok) break; } catch { /* starting */ }
    if (i > 80) { process.kill(-secure.pid); throw new Error("HTTPS wrangler dev did not start"); }
    await new Promise((r) => setTimeout(r, 500));
  }
  const env = { SAMESECOND_APP: "https://127.0.0.1:8797", SAMESECOND_MEDIA: "https://127.0.0.1:8800", MEDIA_TLS: tls, NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  for (const [file, ...args] of [["web.mjs", "chrome"], ["extras.mjs"], ["ext.mjs", "chrome"], ["bridge.mjs", "chrome"]]) suite(file, args, env, " (https)");
  try { process.kill(-secure.pid); } catch { /* already stopped */ }
}
console.log(failed.length ? `\nfailed: ${failed.join(", ")}` : "\nall browser suites passed");
process.exit(failed.length ? 1 : 0);
