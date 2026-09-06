// Wipe the build output directories before a production build.
//
// vite does not clean `dist-electron` between rebuilds, so in dev the folder
// accumulates one set of chunks per rebuild. Stable filenames (see
// vite.config.ts) stop NEW garbage appearing, but a machine that has been
// developing for a while already holds a pile of it, and electron-builder
// packages whatever it finds. This runs only for `npm run build` / `npm run
// dist` — never in watch mode, where deleting the output from under a running
// Electron process would be a fine way to break the dev loop.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const dir of ['dist', 'dist-electron']) {
  const full = path.join(root, dir);
  let freed = 0;
  let files = 0;
  try {
    for (const entry of fs.readdirSync(full, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) {
        files += 1;
        try {
          freed += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
        } catch {
          /* raced with something else; the size is only for the log line */
        }
      }
    }
    fs.rmSync(full, { recursive: true, force: true });
  } catch {
    continue; // never built here yet
  }
  if (files) console.log(`cleaned ${dir}: ${files} file(s), ${(freed / 1e6).toFixed(1)} MB`);
}
