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

{
  // The second way the two sides drift, and the one that actually shipped:
  // main REBUILDS the renderer's object field by field ("the renderer's
  // object is a claim"), and a field left out of that rebuild is silently
  // dropped. It had happened three times before anyone went looking —
  // `maxCopiesPerMinute` (fixed when a user noticed their rate limit did
  // nothing), then `chain` on BOTH save handlers: a script written on the BNB
  // tab was stored as a Solana script, and a copy config on an EVM chain was
  // judged by Solana's address rules and refused a valid 0x leader, so
  // following a leader on Robinhood or BNB was impossible from the form that
  // offers it. `walletId` went the same way — the wallet picked to copy with
  // fell back to the active signer.
  //
  // A field the renderer can set must be READ by the handler that rebuilds it.
  const REBUILDERS = [
    {
      channel: 'automation:save',
      until: 'automation:remove',
      source: '../shared/automation.ts',
      type: 'UserScript',
      // Ids and timestamps are assigned by main, and arming a script is its
      // own confirmed act (automation:setEnabled).
      ownedByMain: ['createdAt', 'updatedAt', 'enabled'],
    },
    {
      channel: 'copy:save',
      until: 'copy:remove',
      source: '../shared/copytrade.ts',
      type: 'CopyConfig',
      ownedByMain: ['createdAt'],
    },
    // The other three rebuilders. All complete when this was written
    // (2026-09-18) - they are here so the NEXT field added to one of these
    // types cannot be forgotten on the way across, which is the only way
    // this bug has ever happened.
    {
      channel: 'templates:save',
      until: 'templates:delete',
      source: '../shared/orderTemplates.ts',
      type: 'OrderTemplate',
      ownedByMain: [],
      chainless: true,
    },
    {
      channel: 'orders:create',
      until: 'orders:cancel',
      source: '../shared/orders.ts',
      type: 'NewOrderRequest',
      ownedByMain: [],
      chainless: true,
    },
    {
      channel: 'alerts:create',
      until: 'alerts:remove',
      source: '../shared/alerts.ts',
      type: 'NewAlertRequest',
      ownedByMain: [],
      chainless: true,
    },
  ];

  for (const r of REBUILDERS) {
    const src = fs.readFileSync(new URL(r.source, import.meta.url), 'utf8');
    const at = src.indexOf(`export interface ${r.type} {`);
    assert.ok(at > 0, `${r.source} declares ${r.type}`);
    const iface = src.slice(at, src.indexOf('\n}', at));
    const fields = [...iface.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    if (!r.chainless) {
      assert.ok(fields.includes('chain'), `${r.type} has a chain field to check for`);
    }
    const start = ipc.indexOf(`ipcMain.handle('${r.channel}'`);
    const end = ipc.indexOf(`ipcMain.handle('${r.until}'`);
    assert.ok(start > 0 && end > start, `found the ${r.channel} handler body`);
    const body = ipc.slice(start, end);
    // Each handler names the incoming payload differently - `r`, `t`,
    // `req`. Read the binding out of `const <name> = raw as ...` rather
    // than assuming one, so this pin does not quietly stop checking a
    // handler that renamed a local.
    const bind = new RegExp('const (\\w+) = raw as').exec(body);
    assert.ok(bind, `${r.channel} binds the raw payload to a local`);
    const v = bind[1];
    const owned = new Set(r.ownedByMain);
    const checked = fields.filter((f) => !owned.has(f));
    for (const f of checked) {
      assert.ok(body.includes(`${v}.${f}`), `${r.channel} reads ${v}.${f} — a ${r.type} field it drops is a field the user silently loses`);
    }
    // Reading it is not enough: `chain` was read, validated, and then left out
    // of the object that was actually saved.
    if (!r.chainless) {
      assert.ok(/\n\s+chain[,:]/.test(body), `${r.channel} puts the chain INTO the object it saves, not just into a local`);
    }
    ok(`${r.channel} rebuilds every user-set ${r.type} field (${checked.length} of them)${r.chainless ? '' : ' and saves the chain'}`);
  }
}

console.log(`\nipccontract: ${passed}/${passed} passed`);
