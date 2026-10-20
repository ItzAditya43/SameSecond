// Copies the shared sync engine into the web app and the extension,
// which each need their own copy of the file.
import { copyFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
for (const dest of ["public/sync-core.js", "extension/sync-core.js"]) {
  copyFileSync(new URL("shared/sync-core.js", root), new URL(dest, root));
  console.log(`copied shared/sync-core.js -> ${dest}`);
}
