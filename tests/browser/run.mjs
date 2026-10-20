// Runs the browser tests against a local `wrangler dev`.
// Needs Chromium and ffmpeg (to make the test video). Options:
//   firefox  also run the web app and invite handoff in Firefox
//   youtube  also run the real-YouTube suite (needs internet)
// Usage: npm run test:browser -- firefox youtube
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
spawnSync("node", [root + "scripts/pack-extension.mjs", "http://localhost:8787", "--out", "public/downloads/syncroom-extension.zip"], { stdio: "inherit" });

const dev = spawn("npx", ["wrangler", "dev", "--port", "8799", "--ip", "127.0.0.1", "--log-level", "warn"], { cwd: root, stdio: "ignore", detached: true });
for (let i = 0; ; i++) {
  try { if ((await fetch("http://127.0.0.1:8799/api/health")).ok) break; } catch { /* starting */ }
  if (i > 80) { process.kill(-dev.pid); throw new Error("wrangler dev did not start"); }
  await new Promise((r) => setTimeout(r, 500));
}

const runs = [["web.mjs", "chrome"], ["extras.mjs"], ["ext.mjs"], ["bridge.mjs", "chrome"], ["resilience.mjs"]];
if (opts.includes("firefox")) runs.push(["web.mjs", "firefox"], ["bridge.mjs", "firefox"]);
if (opts.includes("youtube")) runs.push(["youtube.mjs"]);
const failed = [];
for (const [file, ...args] of runs) {
  const label = [file, ...args].join(" ");
  console.log(`\n${label}`);
  const r = spawnSync("node", [here + file, ...args], { stdio: "inherit" });
  if (r.status !== 0) failed.push(label);
}
try { process.kill(-dev.pid); } catch { /* already stopped */ }
console.log(failed.length ? `\nfailed: ${failed.join(", ")}` : `\nall ${runs.length} browser suites passed`);
process.exit(failed.length ? 1 : 0);
