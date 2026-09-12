// The IPC contract, checked at the source: what preload SENDS is what main
// READS, in the same order.
//
// This exists because of a bug that shipped and sat unnoticed: preload sent
// `(chain, label)` to `evm:wallet:generate` and main read `(label)`, so the
// chain name became the wallet's label; `import` read the chain name as the
// private key and always failed; `rename` and `remove` read it as the id and
// always answered "No such wallet". Nothing typechecks an ipcRenderer.invoke
// against its ipcMain.handle — the channel is a string and the arguments are
// `unknown` — so the only thing that can catch a slot shift is a test that
// reads both files and compares.
//
// It reads SOURCE, deliberately. A runtime harness would need Electron; this
// needs a regex and runs in 10 ms, and the shape it checks is simple enough
// that the regex is the honest tool.

import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const preload = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8');

/** The positional arguments preload passes after the channel name. */
function sent(channel) {
  const re = new RegExp(`ipcRenderer\\.invoke\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'([^)]*)\\)`);
  const m = re.exec(preload);
  assert.ok(m, `preload invokes ${channel}`);
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    // `label ?? ''` is still the `label` slot.
    .map((s) => s.replace(/\s*\?\?.*$/, ''));
}

/** The parameter names main's handler declares after the event. */
function read(channel) {
  const re = new RegExp(`ipcMain\\.handle\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*(?:async\\s*)?\\(([^)]*)\\)`);
  const m = re.exec(ipc);
  assert.ok(m, `main handles ${channel}`);
  return m[1]
    .split(',')
    .map((s) => s.trim().split(':')[0].trim())
    .filter((s) => s && s !== '_e' && s !== '_event' && s !== 'e');
}

const CHANNELS = {
  // The five that were wrong, and the shape they must all share now.
  'evm:wallet:generate': ['chain', 'label'],
  'evm:wallet:import': ['chain', 'secret', 'label'],
  'evm:wallet:select': ['chain', 'id'],
  'evm:wallet:rename': ['chain', 'id', 'label'],
  'evm:wallet:remove': ['chain', 'id'],
  // Today's new ones, pinned before they can drift the same way.
  'evm:sellAll': ['chain'],
  'swap:balance': ['mint', 'chain'],
  'swap:quote': ['raw'],
  'swap:execute': ['raw', 'simulateOnly'],
  'bridge:quote': ['raw'],
  'bridge:send': ['raw', 'simulateOnly'],
  'launch:upload': ['filePath', 'fields'],
  'launch:preview': ['raw'],
  'launch:send': ['raw'],
};

for (const [channel, expected] of Object.entries(CHANNELS)) {
  const s = sent(channel);
  const r = read(channel);
  assert.equal(s.length, r.length, `${channel}: preload sends ${s.length} argument(s) [${s}], main reads ${r.length} [${r}]`);
  assert.equal(r.length, expected.length, `${channel}: main reads ${r.length}, expected ${expected.length} [${expected}]`);
  // Names may differ between the two sides (preload says `draft`, main says
  // `raw`); COUNT and the position of `chain` are what a slot shift breaks.
  const sc = s.indexOf('chain');
  const rc = r.indexOf('chain');
  assert.equal(sc, rc, `${channel}: preload puts chain at ${sc}, main reads it at ${rc}`);
  ok(`${channel} — ${s.length} argument(s), chain at ${sc === -1 ? 'n/a' : sc}, both sides agree`);
}

{
  // Every handler that takes a chain must validate it with chainOf, so a
  // string that is not a chain is refused rather than indexed.
  for (const channel of Object.keys(CHANNELS).filter((c) => CHANNELS[c].includes('chain'))) {
    const start = ipc.indexOf(`ipcMain.handle('${channel}'`);
    const body = ipc.slice(start, start + 600);
    assert.ok(/chainOf\(chain\)|=== 'robinhood' \|\| chain === 'bnb'/.test(body), `${channel} validates its chain argument`);
  }
  ok('every chain-taking handler validates the chain before using it');
}

console.log(`\nipccontract: ${passed}/${passed} passed`);
