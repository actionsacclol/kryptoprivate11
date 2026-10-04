// The All-in-One wallet's pure rules (shared/aio.ts): the record, what the
// page is told about which chains it signs on, and the dollar total.
import assert from 'node:assert';
import { parseAioFile, aioFileBody, aioInfoOf, cleanAioLabel, summariseAioBalances, emptyAioInfo, mergeAllChainPositions, mergeAllChainTrips } from './.aio.mjs';

const SOL = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const EVM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const rec = {
  version: 1,
  label: 'All-in-One',
  solanaAddress: SOL,
  evmAddress: EVM,
  solanaWalletId: 'w_sol',
  evmWalletId: 'e_evm',
  phraseEnc: 'Y2lwaGVy',
  createdAt: 1,
  backedUpAt: null,
};

// ── the record: a file that is there but unreadable is NEVER "none" ────
{
  assert.deepEqual(parseAioFile(aioFileBody(rec)), rec, 'round trip');
  assert.equal(parseAioFile(aioFileBody(null)), null, 'an explicit "no wallet" body');
  assert.equal(parseAioFile(null), null);
  for (const bad of [{}, { version: 2, wallet: rec }, { version: 1 }, { version: 1, wallet: { ...rec, phraseEnc: '' } }, { version: 1, wallet: { ...rec, solanaAddress: 'nope' } }, { version: 1, wallet: { ...rec, evmAddress: '0x12' } }, 'text', 42]) {
    assert.equal(parseAioFile(bad), 'invalid', `refused: ${JSON.stringify(bad).slice(0, 60)}`);
  }
  const partial = parseAioFile({ version: 1, wallet: { ...rec, solanaWalletId: null, evmWalletId: '' } });
  assert.equal(partial.solanaWalletId, null, 'a key not yet added is a null id, not a parse failure');
  assert.equal(partial.evmWalletId, null);
  assert.equal(cleanAioLabel('   '), 'All-in-One');
  assert.equal(cleanAioLabel('x'.repeat(50)).length, 32);
  console.log('ok  an unreadable record is "invalid", never "no wallet" (it holds the phrase)');
}

// ── which chains it signs on, and which keys are gone ─────────────────
{
  const everywhere = aioInfoOf(rec, { solanaIds: ['w_sol', 'w_x'], evmIds: ['e_evm'], activeSolanaId: 'w_sol', activeEvmIds: { bnb: 'e_evm', robinhood: 'e_evm' } });
  assert.equal(everywhere.activeEverywhere, true);
  assert.deepEqual(everywhere.missing, []);
  assert.equal(everywhere.backedUp, false, 'not backed up until the user says so');

  const someplaces = aioInfoOf(rec, { solanaIds: ['w_sol'], evmIds: ['e_evm', 'e_other'], activeSolanaId: 'w_sol', activeEvmIds: { bnb: 'e_other', robinhood: 'e_evm' } });
  assert.deepEqual(someplaces.signingOn, { solana: true, bnb: false, robinhood: true });
  assert.equal(someplaces.activeEverywhere, false, 'BNB signs with another wallet');

  const removedByHand = aioInfoOf(rec, { solanaIds: ['w_x'], evmIds: ['e_evm'], activeSolanaId: 'w_x', activeEvmIds: { bnb: 'e_evm', robinhood: 'e_evm' } });
  assert.deepEqual(removedByHand.missing, ['solana'], 'a key removed from its store is reported, so Repair can put it back');
  assert.equal(removedByHand.solanaWalletId, null, 'and no id is offered for a wallet that is not there');
  assert.equal(removedByHand.signingOn.solana, false);

  const unread = emptyAioInfo('disk says no');
  assert.equal(unread.exists, false);
  assert.equal(unread.failure, 'disk says no', 'the failure travels to the page');
  console.log('ok  the page is told exactly where it signs and which key is missing');
}

// ── the total: honest null, partial reads, dust ─────────────────────────
{
  const a = (chain, symbol, amount, usd, kind = 'token') => ({ chain, symbol, name: null, token: kind === 'native' ? null : symbol, amount, usd, priceSource: usd === null ? null : 'market', kind });
  const b = summariseAioBalances(
    [
      { chain: 'solana', ok: true, assets: [a('solana', 'SOL', 1.5, 300, 'native'), a('solana', 'USDC', 20, 20, 'stable'), a('solana', 'MEME', 1000, null), a('solana', 'DUST', 1, 0.001)] },
      { chain: 'bnb', ok: true, assets: [a('bnb', 'BNB', 0, 0, 'native')] },
      { chain: 'robinhood', ok: false, message: 'no answer in 9s', assets: [a('robinhood', 'ETH', 5, 20000, 'native')] },
      { chain: 'base', ok: true, assets: [a('base', 'ETH', 0, null, 'native'), a('base', 'USDC', 12.5, 12.5, 'stable')] },
    ],
    123,
  );
  assert.equal(b.totalUsd, 332.5, 'priced assets on chains that answered — nothing else');
  assert.equal(b.unpriced, 1, 'MEME has no price: listed, counted as unpriced, never as $0');
  assert.equal(b.partial, true, 'Robinhood did not answer, so the total is a floor');
  assert.equal(b.chains.find((c) => c.chain === 'robinhood').usd, null, 'an unread chain has no value, not $0');
  assert.equal(b.chains.find((c) => c.chain === 'robinhood').message, 'no answer in 9s');
  assert.ok(!b.assets.some((x) => x.symbol === 'ETH' && x.chain === 'robinhood'), "an unread chain's leftovers are not shown as holdings");
  // 10-03: dust is listed (flagged) but still never counted in the total.
  assert.equal(b.assets.find((x) => x.symbol === 'DUST')?.dust, true, 'dust is listed, flagged');
  assert.ok(b.assets.some((x) => x.chain === 'bnb' && x.symbol === 'BNB'), 'a native coin shows even at zero');
  assert.deepEqual(b.assets.map((x) => x.symbol).slice(0, 3), ['SOL', 'USDC', 'USDC'], 'largest first');
  assert.equal(b.assets.at(-1).symbol === 'MEME' || b.assets.at(-1).usd === null, true, 'unpriced after priced');
  assert.equal(b.chains.find((c) => c.chain === 'bnb').usd, 0, 'a chain that answered "nothing" is $0 — it said so');

  // No chain answered at all: no number, not $0.00.
  const none = summariseAioBalances([{ chain: 'solana', ok: false, message: 'down', assets: [] }, { chain: 'bnb', ok: false, message: 'down', assets: [] }], 1);
  assert.equal(none.totalUsd, null, 'nothing read is unknown, never $0');
  assert.equal(none.partial, true);

  // The coin balance answered, the token list did not: SOL counts, flagged.
  const half = summariseAioBalances([{ chain: 'solana', ok: true, partial: true, message: 'tokens not read — 429', assets: [a('solana', 'SOL', 2, 400, 'native')] }], 1);
  assert.equal(half.totalUsd, 400, 'what was read still counts');
  assert.equal(half.partial, true, 'and the total says it is a floor');
  assert.equal(half.chains[0].partial, true);
  assert.equal(half.chains[0].message, 'tokens not read — 429');
  console.log('ok  the total counts only what is priced, and says when it is a floor');
}

// ── ALL views: every chain in dollars, paper never mixed in ────────────
{
  const sol = {
    solUsd: 200,
    positions: [
      { mint: 'M1', symbol: 'AAA', name: 'A', amount: 10, valueUsd: null, valueSol: 0.5, unrealizedPnlSol: 0.1, unrealizedPnlPct: 25, basisKnown: true },
      { mint: 'M2', symbol: 'PAP', name: 'P', amount: 1, valueUsd: 999, valueSol: 5, unrealizedPnlSol: 1, unrealizedPnlPct: 1, basisKnown: true, paper: true },
      { mint: 'M3', symbol: 'NOP', name: 'N', amount: 1, valueUsd: null, valueSol: null, unrealizedPnlSol: null, unrealizedPnlPct: null, basisKnown: false },
    ],
  };
  const evm = [{ chain: 'bnb', nativeUsd: null, positions: [{ token: '0xt', symbol: 'BBB', name: 'B', amount: 3, valueNative: 2, unrealizedPnlNative: 1, unrealizedPnlPct: 50, basisKnown: true }] }];
  const rows = mergeAllChainPositions(sol, evm);
  assert.equal(rows.length, 3, 'the paper position is not money and is left out');
  assert.equal(rows[0].symbol, 'AAA');
  assert.equal(rows[0].valueUsd, 100, 'SOL value converted at the SOL price when no USD value came');
  assert.ok(Math.abs(rows[0].pnlUsd - 20) < 1e-9);
  const bbb = rows.find((r) => r.symbol === 'BBB');
  assert.equal(bbb.valueUsd, null, 'no BNB price → no dollar value, never $0');
  assert.equal(bbb.pnlUsd, null);
  assert.equal(rows.at(-1).valueUsd, null, 'unpriced rows sort last');

  const trips = mergeAllChainTrips([
    { chain: 'solana', nativeSymbol: 'SOL', nativeUsd: 200, trips: [{ mint: 'M1', symbol: 'AAA', closedAt: 100, holdMs: 5, pnlSol: -0.05, pnlPct: -10 }] },
    { chain: 'robinhood', nativeSymbol: 'ETH', nativeUsd: null, trips: [{ mint: '0xr', symbol: 'RRR', closedAt: 300, holdMs: 9, pnlSol: 0.01, pnlPct: 4 }] },
  ]);
  assert.deepEqual(trips.map((t) => t.symbol), ['RRR', 'AAA'], 'newest first, across chains');
  assert.equal(trips[0].nativeSymbol, 'ETH', 'each trip keeps its own coin');
  assert.equal(trips[0].pnlUsdNow, null, 'unknown ETH price → no dollar figure');
  assert.equal(trips[1].pnlUsdNow, -10);
  console.log('ok  ALL views merge every chain in dollars, paper and unknown prices kept honest');
}

console.log('\nall-in-one wallet: rules hold');
