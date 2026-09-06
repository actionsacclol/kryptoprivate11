// Profile continuity — the rename must never hide a wallet.
import assert from 'node:assert';
import { pickUserDataDir, LEGACY_PROFILE_NAMES, WALLET_FILE } from './.profile.mjs';

const join = (...p) => p.join('/');
const fsOf = (present) => (p) => present.has(p);
const NEW = 'AppData/Krypto Terminal';
const OLD = 'AppData/Krypt Terminal';
const DEV = 'AppData/krypt-terminal';

{
  // The 2026-09-02 incident: new folder already has settings.json (the app
  // created it) but NO wallet; the old folder has the wallet.
  const exists = fsOf(new Set([`${NEW}/settings.json`, `${NEW}/legal-acceptance.jsonl`, `${OLD}/${WALLET_FILE}`, `${OLD}/settings.json`]));
  const r = pickUserDataDir({ current: NEW, legacy: [OLD, DEV], exists, join });
  assert.equal(r.dir, OLD, 'the folder with the wallet wins even after the new one was created');
  assert.equal(r.redirectedFrom, NEW);
  console.log('ok  a wallet in the legacy folder beats a fresh new-name profile that has none');
}
{
  // Fresh install: nothing anywhere → the new folder.
  const r = pickUserDataDir({ current: NEW, legacy: [OLD, DEV], exists: fsOf(new Set()), join });
  assert.equal(r.dir, NEW);
  assert.equal(r.redirectedFrom, null);
  console.log('ok  a fresh install uses the new folder');
}
{
  // Migrated by hand (or a later build that copies): the new folder has the
  // wallet → never bounce back to the old one.
  const exists = fsOf(new Set([`${NEW}/${WALLET_FILE}`, `${OLD}/${WALLET_FILE}`]));
  const r = pickUserDataDir({ current: NEW, legacy: [OLD, DEV], exists, join });
  assert.equal(r.dir, NEW);
  console.log('ok  a wallet in the new folder keeps the new folder');
}
{
  // Legacy names are tried in order; the dev-style name is a fallback only.
  const exists = fsOf(new Set([`${DEV}/${WALLET_FILE}`]));
  const r = pickUserDataDir({ current: NEW, legacy: [OLD, DEV], exists, join });
  assert.equal(r.dir, DEV);
  // Newest legacy name first: a user coming from the most recent rename is
  // the likeliest case, and every earlier name still has to be reachable.
  assert.equal(LEGACY_PROFILE_NAMES[0], 'Krypto Terminal', 'the most recent former name is checked first');
  for (const name of ['Krypto Terminal', 'Krypt Terminal', 'krypt-terminal', 'Krypt Sniper']) {
    assert.ok(LEGACY_PROFILE_NAMES.includes(name), `${name} must stay reachable — a dropped name is a lost wallet`);
  }
  console.log('ok  legacy names are tried in preference order');
}
console.log('profile continuity: all tests passed');
