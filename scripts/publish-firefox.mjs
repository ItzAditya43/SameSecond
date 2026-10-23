// Submits the Firefox package to Firefox Add-ons (addons.mozilla.org) as a
// public listing, which also makes it installable on Firefox for Android.
//
// Needs:
//   - the live site address (run `npm run deploy` first), since the package has it built in
//   - Firefox Add-ons API keys: sign in at https://addons.mozilla.org/developers/addon/api/key/,
//     generate credentials, and put them in a file named .env.amo in the project folder:
//       AMO_API_KEY=user:12345:67
//       AMO_API_SECRET=abcdef...
//     (.env.amo is never committed)
//   - a license for the listing, set as "license" in package.json (e.g. "MIT")
//
// Usage: npm run publish:firefox
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fail = (msg) => { console.error(msg); process.exit(1); };
const shell = process.platform === "win32";

const url = (process.argv[2] || (existsSync(root + ".samesecond-url") ? readFileSync(root + ".samesecond-url", "utf8") : "")).trim().replace(/\/+$/, "");
if (!/^https:\/\/\S+$/.test(url)) fail("Deploy first (npm run deploy) so the package points at your live site.");

const env = {};
if (existsSync(root + ".env.amo")) {
  for (const line of readFileSync(root + ".env.amo", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
const key = process.env.AMO_API_KEY || env.AMO_API_KEY;
const secret = process.env.AMO_API_SECRET || env.AMO_API_SECRET;
if (!key || !secret) fail("Add your Firefox Add-ons API keys to .env.amo (see the top of this script).");

const pkg = JSON.parse(readFileSync(root + "package.json", "utf8"));
if (!pkg.license) fail('Choose a license for the listing and add it to package.json, e.g. "license": "MIT".');

const r = spawnSync("node", ["scripts/pack-extension.mjs", url, "--target", "firefox", "--dir", "dist/amo"], { cwd: root, stdio: "inherit", shell });
if (r.status !== 0) process.exit(1);

// Listing details sent with the first submission.
const listing = JSON.parse(readFileSync(root + "store/amo-listing.json", "utf8"));
listing.version = { license: pkg.license };
listing.homepage = { "en-US": url };
writeFileSync(root + "dist/amo-metadata.json", JSON.stringify(listing, null, 2));

const sign = spawnSync("npx", ["--yes", "web-ext", "sign", "--channel", "listed", "--source-dir", "dist/amo", "--artifacts-dir", "dist/amo-signed",
  "--amo-metadata", "dist/amo-metadata.json", "--api-key", key, "--api-secret", secret], { cwd: root, stdio: "inherit", shell });
if (sign.status !== 0) fail("\nSubmission failed (see above).");
console.log(`
Submitted to Firefox Add-ons. Mozilla reviews new listings, usually within a few days;
you'll get an email when it's live. Track it at https://addons.mozilla.org/developers/addons
Once it's live, put its address in public/extension.html so the site links to it.`);
