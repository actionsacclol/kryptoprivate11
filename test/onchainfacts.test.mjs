// On-chain mint facts, and the security verdict they drive.
//
// The bug this pins (api-swarm-2026-09-09, fo-2): "the RPC returned no
// account" was marked `checked: true`. Downstream, a null authority on a
// CHECKED mint reads as "positively observed absent" — which in SPL is the
// SAFE state — so an unreadable mint rendered as
//   "Mint authority: Disabled. No new supply can be minted."
// sourced `onchain`, on the two heaviest security gates. Unknown must render
// as unknown, and the honest-null rule says an em dash, never a pass.

import assert from 'node:assert';
import * as onchain from './.onchain.mjs';
import { securityChecks } from './.marketshared.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const MINT = 'CopyMint111111111111111111111111111111111';
const RPC = 'https://rpc.example.invalid';

/** Stub the RPC transport. `body` is what the endpoint returns as `result`. */
function stubRpc(result, { status = 200 } = {}) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

const factsToSecurity = (facts, over = {}) => ({
  launchpad: 'unknown',
  bondingCurvePct: null,
  mint: {
    checked: facts.checked,
    message: facts.message,
    // The same mapping market.ts uses: a null authority is only "absent" when
    // the mint was actually read.
    mintAuthority: facts.checked ? facts.mintAuthority !== null : null,
    freezeAuthority: facts.checked ? facts.freezeAuthority !== null : null,
    isToken2022: facts.checked ? facts.isToken2022 : null,
  },
  liquidityUsd: null,
  liquiditySource: 'none',
  shares: {
    devPct: null, top10Pct: null, top20Pct: null, bundledPct: null, bundledHeldPct: null,
    bundleWallets: null, bundleStillHolding: null, sniperPct: null, sniperHeldPct: null,
    sniperWindowSlots: null, launchNote: null, concSource: 'none', launchSource: 'none',
  },
  rugcheck: { answered: false, creatorRugs: null, riskCount: 0 },
  insiders: { answered: false, networks: 0, largestSharePct: null },
  shield: { answered: false, notSellable: false, warnings: [] },
  creatorRecord: { launches: 0, rugs: 0, migrations: 0, source: 'none' },
  banned: null,
  localCreator: null,
  history: null,
  ...over,
});

const authorityRow = (facts) => securityChecks(factsToSecurity(facts)).find((c) => c.id === 'mint-authority');

test('a mint the RPC cannot find is UNKNOWN, not checked', async () => {
  stubRpc(null); // getAccountInfo -> {"result":null}
  const facts = await onchain.mintFacts(RPC, MINT);
  assert.equal(facts.checked, false, 'not found is not a reading');
  assert.equal(facts.mintAuthority, null);
  assert.equal(facts.freezeAuthority, null);
  assert.match(facts.message, /not found/i);
});

test('an unfindable mint NEVER scores a safety pass', async () => {
  stubRpc(null);
  const facts = await onchain.mintFacts(RPC, `${MINT.slice(0, -1)}2`);
  const row = authorityRow(facts);
  assert.equal(row.verdict, null, 'unknown renders as an em dash, never a pass');
  assert.match(row.detail, /not verified/i, 'and says why');
  assert.doesNotMatch(row.detail, /disabled|no new supply/i, 'it must not claim the authority is revoked');
});

test('a mint that really was read still scores normally', () => {
  // A genuine read where both authorities are absent IS the safe state, and
  // must keep passing — the fix must not make every mint unknown.
  const read = {
    checked: true,
    exists: true,
    isToken2022: false,
    mintAuthority: null,
    freezeAuthority: null,
    decimals: 6,
    supplyRaw: '1000000',
    uiSupply: 1,
    message: 'ok',
  };
  const row = authorityRow(read);
  assert.equal(row.verdict, 'pass');
  assert.match(row.detail, /disabled/i);
});

test('a mint with a live authority still fails', () => {
  const read = {
    checked: true,
    exists: true,
    isToken2022: false,
    mintAuthority: 'Auth1111111111111111111111111111111111111',
    freezeAuthority: null,
    decimals: 6,
    supplyRaw: '1000000',
    uiSupply: 1,
    message: 'ok',
  };
  assert.equal(authorityRow(read).verdict, 'fail');
});

const run = async () => {
  for (const c of cases) {
    try {
      await c.fn();
      passed += 1;
      console.log(`ok  ${c.name}`);
    } catch (e) {
      console.log(`FAIL ${c.name}\n  ${e.message}`);
    }
  }
  console.log(`onchainfacts: ${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exit(1);
};

await run();
