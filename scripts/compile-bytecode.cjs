// Compile the obfuscated main-process chunks to V8 bytecode (.jsc).
//
// MUST run under Electron's V8 (via ELECTRON_RUN_AS_NODE — see
// harden-bytecode.mjs), because V8 bytecode is version-locked: bytecode built
// with system Node's V8 will not load in the shipped Electron. The launcher
// guarantees that.
//
// Each chunk X.js is compiled to X.jsc and its source replaced with a tiny
// loader stub. The stub holds no logic and no secrets — the code now lives as
// bytecode. Inter-chunk requires still say "./X.js", so they hit the stub,
// which loads the bytecode. This raises extraction well past reading obfuscated
// JS: there is no JS left to read for these modules.
//
// Left as plain JS on purpose:
//   • main.js  — 3-line bootstrap, no secrets, and it is Electron's entry.
//   • preload.js — Electron loads it by path as a preload, not via our require
//     hook, so it cannot be .jsc; it stays obfuscated (and holds only
//     contextBridge shims).

// Runs as an Electron MAIN script (app mode) — see harden-bytecode.mjs for
// why run-as-node bytecode is rejected from Electron 43 on. In app mode the
// process only ends when we say so, so every path below must reach exit().
const appMode = process.env.KRYPT_BYTECODE_APP_MODE === '1';
const electronApp = appMode ? require('electron').app : null;
const exit = (code) => {
  if (electronApp) electronApp.exit(code);
  else process.exit(code);
};
if (electronApp && !process.versions.electron) {
  console.error('compile-bytecode: expected to run under Electron in app mode');
  exit(1);
}

const bytenode = require('bytenode');
const fs = require('node:fs');
const path = require('node:path');

try {
const dir = path.join(__dirname, '..', 'dist-electron');
const SKIP = new Set(['main.js', 'preload.js']);

let count = 0;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.js') || SKIP.has(f)) continue;
  const jsPath = path.join(dir, f);
  const jscPath = jsPath + 'c'; // X.js -> X.jsc
  bytenode.compileFile({ filename: jsPath, output: jscPath, compileAsModule: true });
  const stub = `"use strict";require('bytenode');module.exports=require('./${path.basename(jscPath)}');\n`;
  fs.writeFileSync(jsPath, stub);
  count += 1;
  console.log(`  ${f} -> ${path.basename(jscPath)} (${(fs.statSync(jscPath).size / 1024).toFixed(0)}KB bytecode)`);
}

// The entry requires bytenode first so the .jsc handler is registered before
// the first stub runs.
const mainPath = path.join(dir, 'main.js');
let main = fs.readFileSync(mainPath, 'utf8');
if (!main.includes('bytenode')) {
  fs.writeFileSync(mainPath, `"use strict";require('bytenode');${main.replace(/^"use strict";/, '')}`);
}

console.log(`compiled ${count} chunk(s) to V8 bytecode`);

  // Prove the output loads in THIS process type before the build trusts it.
  // fanout.js has no electron dependency, so it can be required here as-is.
  const probe = require(path.join(dir, 'fanout.js'));
  if (typeof probe !== 'object' || probe === null) throw new Error('bytecode probe returned no module');
  console.log(`  bytecode probe: fanout.jsc loads in ${appMode ? 'app' : 'node'} mode`);
  exit(0);
} catch (e) {
  console.error('compile-bytecode failed:', e && e.stack ? e.stack : e);
  exit(1);
}
