// Publishes the extension packages as a GitHub release, so the website's
// download buttons (which point at the latest release) get them.
// Run after `npm run deploy`, since the packages need the live site address.
// Usage: npm run release                (uses the address from the last deploy)
//        npm run release -- https://my.site
// Bump the version first for each new release: npm version patch
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const shell = process.platform === "win32";
const fail = (msg) => { console.error(msg); process.exit(1); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell, ...opts });

const url = (process.argv[2] || (existsSync(root + ".syncroom-url") ? readFileSync(root + ".syncroom-url", "utf8") : "")).trim().replace(/\/+$/, "");
if (!url) fail("Deploy first (npm run deploy), or pass the site address: npm run release -- https://your-site");
if (!/^https:\/\/\S+$/.test(url)) fail(`The site address must start with https:// (got ${url})`);

if (run("gh", ["auth", "status"]).status !== 0) fail("Log in to GitHub first: gh auth login");
const version = JSON.parse(readFileSync(root + "package.json", "utf8")).version;
const tag = `v${version}`;
if (run("gh", ["release", "view", tag]).status === 0) fail(`Release ${tag} already exists. Bump the version first: npm version patch`);

for (const target of ["chrome", "firefox"]) {
  const r = run("node", ["scripts/pack-extension.mjs", url, "--target", target], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
}

const notes = `Syncroom extension ${version}, set up for ${url}

**Chrome, Edge, Brave or Opera:** download \`syncroom-chrome.zip\`, unzip it, open \`chrome://extensions\`, turn on Developer mode, click **Load unpacked** and pick the unzipped folder. Step-by-step pictures: ${url}/extension

**Firefox:** \`syncroom-firefox.zip\` is the package for Firefox Add-ons. Firefox only installs signed add-ons, so install it from Firefox Add-ons once it's listed.

Start a watch party: ${url}`;

const r = run("gh", ["release", "create", tag, "dist/syncroom-chrome.zip", "dist/syncroom-firefox.zip", "--title", `Syncroom ${version}`, "--notes", notes], { stdio: "inherit" });
if (r.status !== 0) process.exit(1);
console.log(`\nReleased ${tag}. The website's download buttons now serve these packages.`);
