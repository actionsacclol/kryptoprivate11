// LIVE check for retroactive launch intel.
//
// NOT part of `npm test`: it hits swap-api.pump.fun, frontend-api-v3.pump.fun
// and a public Solana RPC. Run it by hand after touching anything under
// electron/data/, with `npm run test:launch`.
//
// What it proves that the unit tests cannot:
//
//   1. the swap-api trades route still exists and its cursor still SEEKS —
//      this whole feature rests on synthesising `0…0-<timestamp>` to jump to
//      a launch, which is undocumented and could vanish without notice;
//   2. `slotIndexId` is still slot-prefixed, checked against `getSlot`;
//   3. the launch window is genuinely reachable for an OLD token, not just
//      one that launched a minute ago — the retroactive claim is the feature;
//   4. the free RPC still serves getMultipleAccounts for derived ATAs, which
//      is what makes "still holding" free;
//   5. `/coins?creator=` still filters — the documented route for it is gone.

import { creatorHistory, launchIntel } from './.launchintelmain.mjs';

const RPC = 'https://api.mainnet-beta.solana.com';
const PUMP = 'https://frontend-api-v3.pump.fun';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const gj = async (u) => {
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  return JSON.parse(await r.text());
};
const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(2)}%`);

// ── Pick live subjects ────────────────────────────────────────────────

const migrated = await gj(`${PUMP}/coins?offset=0&limit=25&sort=last_trade_timestamp&order=DESC&complete=true`);
const fresh = await gj(`${PUMP}/coins?offset=0&limit=25&sort=created_timestamp&order=DESC&complete=false`);
check('pump.fun list route answers', Array.isArray(migrated) && migrated.length > 0);
if (!Array.isArray(migrated) || !migrated.length) process.exit(1);

const DAY = 86_400_000;
const now = Date.now();
const age = (c) => now - c.created_timestamp;
const oldestFirst = [...migrated].sort((a, b) => a.created_timestamp - b.created_timestamp);
const old = oldestFirst[0];
const young = fresh.find((c) => c.reply_count > 0) ?? fresh[0];

console.log(
  `
subjects: OLDEST ${old.symbol} (${(age(old) / DAY).toFixed(1)}d) · NEW ${young.symbol} (${(
    age(young) / 60_000
  ).toFixed(1)}m)
`,
);

// ── The oldest token: whatever happens, it must be honest ─────────────
//
// swap-api's index does NOT reach 2024 launches (measured: a 919-day-old
// token serves this month's trades and nothing near its launch). So the
// requirement here is not "it always works" — it is that it either works or
// says why, and never reports a cohort it could not measure.

const oldIntel = await launchIntel(old.mint, RPC);
console.log(
  `${old.symbol}: scanned=${oldIntel.analysis.tradesScanned} complete=${oldIntel.analysis.complete} ` +
    `dev=${pct(oldIntel.analysis.dev.boughtPct)} bundle=${pct(oldIntel.analysis.bundle.boughtPct)} ` +
    `snipers=${pct(oldIntel.analysis.snipers.boughtPct)}` +
    (oldIntel.note ? `
     note: ${oldIntel.note}` : ''),
);
check('supply resolves, so percentages are computable', oldIntel.supply !== null, `${oldIntel.supply}`);
check('a creator is identified', typeof oldIntel.creator === 'string');
if (!oldIntel.analysis.complete) {
  check('an unreachable launch reports NO cohort numbers', oldIntel.analysis.bundle.boughtPct === null);
  check('an unreachable launch explains itself', typeof oldIntel.note === 'string' && oldIntel.note.length > 20);
}

// ── The retroactive claim, tested where the index reaches ─────────────
//
// The feature's headline is "works for a CA you paste in cold", so a token
// that launched a minute ago proves nothing. Walk oldest-first until one
// analyses completely, and require that it is at least a day old.

let retro = null;
for (const c of oldestFirst) {
  if (retro || age(c) < DAY) continue;
  const r = await launchIntel(c.mint, RPC);
  if (r.analysis.complete && r.analysis.tradesScanned > 0) retro = { coin: c, intel: r };
}
check('a token at least a day old analyses retroactively', retro !== null);

if (retro) {
  const a = retro.intel.analysis;
  console.log(
    `
retroactive subject ${retro.coin.symbol} (${(age(retro.coin) / DAY).toFixed(1)}d old): ` +
      `scanned=${a.tradesScanned} wallets=${a.wallets.length} dev=${pct(a.dev.boughtPct)} ` +
      `bundle=${pct(a.bundle.boughtPct)} snipers=${pct(a.snipers.boughtPct)} | ` +
      `bundle still holds ${pct(a.bundle.heldPct)} (${a.bundle.stillHolding ?? '—'}/${a.bundle.wallets} wallets)`,
  );
  check('a launch slot is identified', typeof a.launchSlot === 'number' && a.launchSlot > 0, String(a.launchSlot));
  check(
    'cohort shares are individually sane',
    [a.dev, a.bundle, a.snipers].every((c) => c.boughtPct === null || (c.boughtPct >= 0 && c.boughtPct <= 100)),
  );
  check(
    'launch-window buys cannot exceed supply',
    a.dev.boughtPct + a.bundle.boughtPct + a.snipers.boughtPct <= 100.001,
    `${pct(a.dev.boughtPct + a.bundle.boughtPct + a.snipers.boughtPct)} of supply`,
  );
  check('balances were priced keylessly', a.priced === true, retro.intel.balancesNote ?? '');
  check(
    'held never exceeds bought for a cohort',
    [a.dev, a.bundle, a.snipers].every((c) => c.retainedPct === null || c.retainedPct <= 100),
  );
  check(
    'every wallet carries the slot offset it was classified by',
    a.wallets.every((w) => w.cohort === 'dev' || (w.slotOffset >= 0 && Number.isFinite(w.slotOffset))),
  );
  check(
    'the dev is never counted inside the bundle',
    !a.wallets.some((w) => w.cohort === 'bundle' && w.address === retro.intel.creator),
  );
  const slotRes = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
  });
  const chainSlot = JSON.parse(await slotRes.text()).result;
  check(
    'the parsed launch slot is a plausible mainnet slot',
    a.launchSlot > chainSlot - 200_000_000 && a.launchSlot <= chainSlot,
    `launch ${a.launchSlot} vs chain ${chainSlot}`,
  );
  // The slot must also match the token's age: ~2.5 slots a second.
  const expected = chainSlot - (age(retro.coin) / 1000) * 2.5;
  check(
    'the launch slot matches the age pump.fun reports',
    Math.abs(a.launchSlot - expected) < 3_000_000,
    `slot ${a.launchSlot}, expected ~${Math.round(expected)}`,
  );
}

// ── The fresh case ────────────────────────────────────────────────────

const youngIntel = await launchIntel(young.mint, RPC);
console.log(
  `\n${young.symbol}: scanned=${youngIntel.analysis.tradesScanned} complete=${youngIntel.analysis.complete} ` +
    `wallets=${youngIntel.analysis.wallets.length} dev=${pct(youngIntel.analysis.dev.boughtPct)} ` +
    `bundle=${pct(youngIntel.analysis.bundle.boughtPct)}` + (youngIntel.note ? `\n     note: ${youngIntel.note}` : ''),
);
check('a brand-new token produces an answer or an honest note', youngIntel.analysis.tradesScanned > 0 || !!youngIntel.note);

// ── Creator track record ──────────────────────────────────────────────

const hist = await creatorHistory(old.creator);
console.log(
  `\ncreator ${old.creator.slice(0, 6)}: launches=${hist?.launches ?? '—'} graduated=${hist?.graduated ?? '—'} ` +
    `busiestDay=${hist?.launchesInBusiestDay ?? '—'} medianAth=$${hist?.medianAthUsd?.toFixed(0) ?? '—'}`,
);
check('the creator filter on /coins still works', hist !== null && hist.launches >= 1);
if (hist) {
  // `recent` is deliberately the newest 12 for the table, so a 297-day-old
  // token is legitimately absent from it. What must hold is that it appears
  // when the slice could contain it.
  check(
    'the token under test appears in its creator history when the slice can hold it',
    hist.recent.some((l) => l.mint === old.mint) || hist.launches > hist.recent.length,
    `${hist.launches} launches, showing ${hist.recent.length}`,
  );
  check(
    'every listed launch carries the fields the panel renders',
    hist.recent.every((l) => typeof l.mint === 'string' && typeof l.createdAt === 'number' && l.createdAt > 0),
  );
  check('graduation count never exceeds launches', hist.graduated <= hist.launches);
  check('the busiest day never exceeds total launches', hist.launchesInBusiestDay <= hist.launches);
}

// ── Non-pump mint ─────────────────────────────────────────────────────

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const foreign = await launchIntel(USDC, RPC);
check(
  'a non-pump mint degrades to an honest note',
  foreign.analysis.tradesScanned === 0 && typeof foreign.note === 'string',
  foreign.note ?? '',
);

console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
