// Builds the extension for each browser, with a server address baked in.
// Usage: node scripts/pack-extension.mjs [server-url] [--target chrome|firefox|all]
//                                        [--out file.zip] [--dir folder]
// Default: both targets, written to dist/samesecond-chrome.zip and dist/samesecond-firefox.zip.
// Chrome's build also covers Edge, Brave and Opera.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flagValues = new Set(["--out", "--dir", "--target"].map(flag).filter(Boolean));
const serverUrl = args.find((a) => !a.startsWith("--") && !flagValues.has(a));
const target = flag("--target") || "all";
const targets = target === "all" ? ["chrome", "firefox"] : [target];

if (serverUrl && !/^https?:\/\/[^\s"]+$/.test(serverUrl)) fail(`Not a server address: ${serverUrl}`);
if (!targets.every((t) => t === "chrome" || t === "firefox")) fail(`Unknown target: ${target}`);
if ((flag("--out") || flag("--dir")) && targets.length > 1) fail("--out and --dir need a single --target");

const extDir = join(root, "extension");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
})(extDir);

for (const t of targets) {
  const entries = files.map((full) => {
    const name = relative(extDir, full).split(sep).join("/");
    let data = readFileSync(name === "sync-core.js" ? join(root, "shared", "sync-core.js") : full);
    if (name === "config.js" && serverUrl) {
      data = Buffer.from(data.toString("utf8").replace(/SAMESECOND_DEFAULT_SERVER = ".*?"/, `SAMESECOND_DEFAULT_SERVER = "${serverUrl.replace(/\/+$/, "")}"`));
    }
    if (name === "manifest.json") data = Buffer.from(JSON.stringify(manifestFor(t, JSON.parse(data.toString("utf8"))), null, 2) + "\n");
    return { name, data };
  });
  const dir = flag("--dir");
  if (dir) {
    const base = join(root, dir);
    rmSync(base, { recursive: true, force: true });
    for (const e of entries) { mkdirSync(dirname(join(base, e.name)), { recursive: true }); writeFileSync(join(base, e.name), e.data); }
    console.log(`${relative(root, base) || base}/  (${t}, ${entries.length} files${serverUrl ? `, server ${serverUrl}` : ""})`);
  } else {
    const out = flag("--out") ? join(root, flag("--out")) : join(root, "dist", `samesecond-${t}.zip`);
    writeZip(out, entries);
    console.log(`${relative(root, out)}  (${t}, ${entries.length} files${serverUrl ? `, server ${serverUrl}` : ""})`);
  }
}

// Each browser gets only the manifest keys it understands, so neither shows warnings.
function manifestFor(t, m) {
  m = structuredClone(m);
  // One version number for the whole project: package.json's.
  m.version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (t === "chrome") {
    delete m.sidebar_action;
    delete m.browser_specific_settings;
    m.background = { service_worker: m.background.service_worker };
  } else {
    delete m.side_panel;
    m.permissions = m.permissions.filter((p) => p !== "sidePanel");
    m.background = { scripts: m.background.scripts };
  }
  return m;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Minimal zip writer (deflate, no external tools needed).
function writeZip(path, items) {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  // Fixed timestamp keeps builds reproducible: 2026-01-01 00:00.
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of items) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([...locals, ...centrals, end]));
}
