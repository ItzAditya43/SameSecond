// Deploys Syncroom to Cloudflare and publishes a matching extension download.
// Usage: npm run deploy                     (finds your workers.dev address itself)
//        npm run deploy -- https://my.site  (for a custom domain)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cache = root + ".syncroom-url";
const shell = process.platform === "win32";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell });
  if (r.status !== 0) process.exit(r.status || 1);
}

// Shows Wrangler's output as it happens (it may ask questions on a first
// deploy) while keeping a copy to find the site's address in.
function deploy() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wrangler", "deploy"], { cwd: root, stdio: ["inherit", "pipe", "inherit"], shell });
    let output = "";
    child.stdout.on("data", (d) => { output += d; process.stdout.write(d); });
    child.on("close", (code) => {
      if (code !== 0) process.exit(code || 1);
      const m = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
      resolve(m ? m[0] : null);
    });
  });
}

const who = spawnSync("npx", ["wrangler", "whoami"], { cwd: root, encoding: "utf8", shell });
if (who.status !== 0 || /not authenticated|You are not logged in/i.test((who.stdout || "") + (who.stderr || ""))) {
  console.error("You're not logged in to Cloudflare. Run: npx wrangler login");
  process.exit(1);
}

run("node", ["scripts/copy-shared.mjs"]);

let url = process.argv[2] || process.env.SYNCROOM_URL || (existsSync(cache) ? readFileSync(cache, "utf8").trim() : "");
if (url && !/^https:\/\/[^\s"]+$/.test(url)) {
  console.error(`The site address must start with https:// (got ${url})`);
  process.exit(1);
}
if (!url) {
  console.log("\nFirst deploy: publishing once to find your site's address…\n");
  url = await deploy();
  if (!url) {
    console.error("\nCouldn't find the site address in Wrangler's output. Run again with it: npm run deploy -- https://your-address");
    process.exit(1);
  }
}
url = url.replace(/\/+$/, "");
writeFileSync(cache, url + "\n");

console.log(`\nBuilding the extension for ${url}…`);
run("node", ["scripts/pack-extension.mjs", url, "--target", "chrome", "--out", "public/downloads/syncroom-extension.zip"]);
run("node", ["scripts/pack-extension.mjs", url]);

console.log("\nPublishing…\n");
await deploy();

// Check the live site actually answers.
let healthy = false;
for (let i = 0; i < 10 && !healthy; i++) {
  try { healthy = (await fetch(`${url}/api/health`)).ok; } catch { /* not reachable yet */ }
  if (!healthy) await new Promise((r) => setTimeout(r, 3000));
}
console.log(`
${healthy ? "Syncroom is live" : "Deployed, but the site didn't answer yet (new workers.dev addresses can take a minute)"}: ${url}
Extension download:  ${url}/downloads/syncroom-extension.zip
Store uploads:       dist/syncroom-chrome.zip (Chrome, Edge, Opera)
                     dist/syncroom-firefox.zip (Firefox)
Privacy policy URL:  ${url}/privacy`);
