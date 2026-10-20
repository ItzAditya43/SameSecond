// Deploys Syncroom to Cloudflare and publishes a matching extension download.
// Usage: npm run deploy                     (finds your workers.dev address itself)
//        npm run deploy -- https://my.site  (for a custom domain)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cache = root + ".syncroom-url";
const run = (cmd, args, capture) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", shell: process.platform === "win32" });
  if (capture && r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) process.exit(r.status || 1);
  return r.stdout || "";
};
const deploy = () => {
  const output = run("npx", ["wrangler", "deploy"], true);
  const m = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  return m ? m[0] : null;
};

run("node", ["scripts/copy-shared.mjs"]);

let url = process.argv[2] || process.env.SYNCROOM_URL || (existsSync(cache) ? readFileSync(cache, "utf8").trim() : "");
if (!url) {
  console.log("\nFirst deploy: publishing once to find your site's address…\n");
  url = deploy();
  if (!url) {
    console.error("\nCouldn't find the site address in Wrangler's output. Run again with it: npm run deploy -- https://your-address");
    process.exit(1);
  }
}
url = url.replace(/\/+$/, "");
writeFileSync(cache, url + "\n");

console.log(`\nBuilding the extension for ${url}…`);
run("node", ["scripts/pack-extension.mjs", url, "--out", "public/downloads/syncroom-extension.zip"]);
run("node", ["scripts/pack-extension.mjs", url]);

console.log("\nPublishing…\n");
deploy();
console.log(`\nSyncroom is live at ${url}
Extension download: ${url}/downloads/syncroom-extension.zip
Store upload file:  dist/syncroom-extension.zip`);
