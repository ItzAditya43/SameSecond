// Shared settings for the browser tests. Set SYNCROOM_APP / SYNCROOM_MEDIA to
// run against another address (run.mjs does this for the HTTPS pass).
import { spawnSync } from "node:child_process";

export const APP = process.env.SYNCROOM_APP || "http://127.0.0.1:8799";
export const MEDIA_BASE = process.env.SYNCROOM_MEDIA || "http://127.0.0.1:8800";
export const HTTPS = APP.startsWith("https:");
export const CHROME_ARGS = HTTPS ? ["--ignore-certificate-errors"] : [];

// Builds the extension exactly as it ships, pointed at the given server.
export function buildExtension(target, server, dir) {
  const root = new URL("../..", import.meta.url).pathname;
  const r = spawnSync("node", [root + "scripts/pack-extension.mjs", server, "--target", target, "--dir", dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("extension build failed: " + r.stderr);
}

// Collects script errors and anything the page's security policy blocked.
export function watchPage(page, name, errors) {
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|connect|execute|frame)/i.test(t)) errors.push(`${name}: ${t}`);
  });
}
