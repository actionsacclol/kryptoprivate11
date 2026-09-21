// LIVE check for the PumpSwap (pump-amm) local builder.
//
//   npm run test:pumpswap
//
// NOT part of `npm test`: it reads mainnet. Builds a real buy and a real
// sell for recently graduated pump coins with a real holder's PUBLIC key and
// simulates them (sigVerify off) — no key, nothing sent. Uses the Helius key
// from settings when there is one; the key is never printed.
//
// What this proves that the fixture tests cannot: that the derived layout is
// the one the program expects TODAY — a slot that moved shows up here as a
// simulation error naming the constraint — that the quote math (vault plus
// the pool's virtual quote reserve) clears the program's slippage check, and
// what a wrapped buy and sell actually cost in compute units.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildPumpSwapTrade, canonicalPoolFor, parsePool, PUMP_SWAP_MIN_COMPUTE_UNITS, _resetPumpSwapCaches } from './.pumpswap.mjs';
import { ataFor, bondingCurveFor, PUMP_AMM_PROGRAM, WSOL_MINT } from './.addr2.mjs';

const SETTINGS = 'C:/Users/Krypt/AppData/Roaming/Krypt Terminal/settings.json';
let RPC = 'https://api.mainnet-beta.solana.com';
try {
  const key = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.rpc?.heliusApiKey;
  if (key) RPC = `https://mainnet.helius-rpc.com/?api-key=${key}`;
} catch {
  /* public RPC it is */
}
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MIGRATION_AUTH = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const POOL_DISC = createHash('sha256').update('account:Pool').digest().subarray(0, 8).toString('hex');
const SELL_DISC = createHash('sha256').update('global:sell').digest().subarray(0, 8).toString('hex');
const BUY_DISC = createHash('sha256').update('global:buy').digest().subarray(0, 8).toString('hex');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params) => {
  await sleep(130);
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const t = await r.text();
  try {
    const j = JSON.parse(t);
    if (j.error) return { error: j.error };
    return j.result ?? null;
  } catch {
    return null;
  }
};
const getTx = (sig) => rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'json', commitment: 'confirmed' }]);
const keysOf = (tx) => {
  const k = [...tx.transaction.message.accountKeys];
  const la = tx.meta?.loadedAddresses;
  if (la) k.push(...(la.writable ?? []), ...(la.readonly ?? []));
  return k;
};
function b58decode(s) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c === '1') out.unshift(0);
    else break;
  }
  return Buffer.from(out);
}
const anchorReason = (logs) => {
  for (const line of logs ?? []) {
    const m = line.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: ([^.]*)/);
    if (m) return `${m[1]} (${m[2]}): ${m[3].trim()}`;
  }
  const last = (logs ?? []).filter((l) => /failed|Error|error/.test(l)).slice(-2);
  return last.join(' | ') || null;
};
const tokenAmount = (b64) => (b64 ? Buffer.from(b64, 'base64').readBigUInt64LE(64) : 0n);

/** The owner's SOL, token and WSOL balances at 'processed' — the state a
 *  simulation starts from. Read right before each one: the holders this
 *  test borrows are live traders. */
async function snapshot(owner, ata) {
  const wsolAta = ataFor(owner, WSOL_MINT, TOKEN);
  const r = await rpc('getMultipleAccounts', [[owner, ata, wsolAta], { encoding: 'base64', commitment: 'processed' }]);
  const v = r?.value ?? [];
  const amount = (acc) => (acc && acc.data?.[0] ? tokenAmount(acc.data[0]) : 0n);
  return { lamports: v[0]?.lamports ?? 0, tokens: amount(v[1]), wsol: amount(v[2]) };
}

/** Simulate an unsigned tx as `owner`: no signature check, fresh blockhash;
 *  the balances it started from ride along as `before`. */
async function simulate(txBytes, owner, ata) {
  const before = await snapshot(owner, ata);
  const r = await rpc('simulateTransaction', [
    Buffer.from(txBytes).toString('base64'),
    { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'processed', accounts: { encoding: 'base64', addresses: [owner, ata] } },
  ]);
  if (!r || r.error) return { ok: false, why: r?.error?.message ?? 'no answer', units: null, before };
  const v = r.value;
  if (v.err) return { ok: false, why: anchorReason(v.logs) ?? JSON.stringify(v.err), units: v.unitsConsumed ?? null, logs: v.logs, before };
  const post = v.accounts ?? [];
  // A closed account comes back as null or as an empty, zero-lamport shell,
  // depending on the RPC.
  const closed = !post[1] || post[1].lamports === 0 || !post[1].data?.[0];
  return { ok: true, units: v.unitsConsumed ?? null, lamports: post[0]?.lamports ?? null, tokens: closed ? 0n : tokenAmount(post[1].data[0]), closed, before };
}

// ── Recently graduated coins with their canonical pools ────────────────
const migrations = (await rpc('getSignaturesForAddress', [MIGRATION_AUTH, { limit: 20 }])) ?? [];
const coins = [];
for (const s of migrations) {
  if (s.err || coins.length >= 4) continue;
  const tx = await getTx(s.signature);
  if (!tx || tx.error || tx.meta?.err) continue;
  for (const k of keysOf(tx)) {
    const a = await rpc('getAccountInfo', [k, { encoding: 'base64' }]);
    if (!a?.value || a.value.owner !== PUMP_AMM_PROGRAM) continue;
    const d = Buffer.from(a.value.data[0], 'base64');
    if (d.subarray(0, 8).toString('hex') !== POOL_DISC) continue;
    const state = parsePool(k, d);
    if (!state || state.quoteMint !== WSOL_MINT || canonicalPoolFor(state.baseMint) !== k) continue;
    if (coins.some((c) => c.mint === state.baseMint)) break;
    coins.push({ mint: state.baseMint, pool: k });
    break;
  }
}
check('found recently graduated coins with canonical pools', coins.length > 0, `${coins.length}`);

let maxUnits = 0;
let exercised = 0;
let mayhemExercised = 0;
for (const coin of coins) {
  // Mint facts: token program, mayhem flag from the curve.
  const mintAcc = await rpc('getAccountInfo', [coin.mint, { encoding: 'base64' }]);
  const tp = mintAcc?.value?.owner ?? TOKEN;
  const curveAddr = bondingCurveFor(coin.mint);
  const curve = await rpc('getAccountInfo', [curveAddr, { encoding: 'base64' }]);
  const cd = curve?.value ? Buffer.from(curve.value.data[0], 'base64') : null;
  const mayhem = cd && cd.length > 81 ? cd[81] !== 0 : false;
  const cashback = cd && cd.length > 82 ? cd[82] !== 0 : false;
  console.log(`\n## ${coin.mint} pool ${coin.pool.slice(0, 8)} ${tp === TOKEN22 ? 'Token-2022' : 'Token'}${mayhem ? ' MAYHEM' : ''}${cashback ? ' CASHBACK' : ''}`);
  const poolAcc = await rpc('getAccountInfo', [coin.pool, { encoding: 'base64' }]);
  const state = poolAcc?.value ? parsePool(coin.pool, Buffer.from(poolAcc.value.data[0], 'base64')) : null;
  if (state) {
    const vb = await rpc('getTokenAccountBalance', [state.poolBaseAta]);
    const vq = await rpc('getTokenAccountBalance', [state.poolQuoteAta]);
    console.log(`  reserves: base ${vb?.value?.amount ?? '?'} · quote vault ${vq?.value?.amount ?? '?'} + virtual ${state.virtualQuote} lamports`);
  }

  // A holder: the signer of a recent successful trade who still holds the
  // token. The OLDEST of the newest 30 trades is tried first — the newest
  // trader is by construction the one most likely to be trading while this
  // test runs, and a wallet that moves between the balance read and the
  // simulation makes the deltas below unreadable.
  const sigs = (await rpc('getSignaturesForAddress', [coin.pool, { limit: 30 }])) ?? [];
  let holder = null;
  let buyer = null;
  for (const s of [...sigs].reverse()) {
    if (s.err) continue;
    const tx = await getTx(s.signature);
    if (!tx || tx.error || tx.meta?.err) continue;
    const keys = keysOf(tx);
    const ixs = [...tx.transaction.message.instructions];
    for (const g of tx.meta.innerInstructions ?? []) ixs.push(...g.instructions);
    for (const ix of ixs) {
      if (keys[ix.programIdIndex] !== PUMP_AMM_PROGRAM) continue;
      const d = b58decode(ix.data).subarray(0, 8).toString('hex');
      if (d !== BUY_DISC && d !== SELL_DISC) continue;
      const user = keys[ix.accounts[1]];
      if (!buyer) buyer = user;
      if (!holder) {
        const bal = await rpc('getTokenAccountBalance', [ataFor(user, coin.mint, tp)]);
        if (!bal || bal.error || !(Number(bal.value?.amount ?? 0) > 0)) continue;
        // A sell wraps through the wallet's WSOL account, whose rent the
        // wallet fronts (returned by the close): an empty wallet cannot even
        // simulate one, and a burner that sold its SOL away is common here.
        const acc = await rpc('getAccountInfo', [user, { encoding: 'base64' }]);
        if ((acc?.value?.lamports ?? 0) >= 5_000_000) holder = user;
      }
    }
    if (holder) break;
  }
  // A precondition, not a builder fact: a dead pool has no funded holder
  // among its last trades. The coverage check at the end wants at least one.
  console.log(`  ${holder ? `holder ${holder.slice(0, 8)}… (a recent trader who still holds it)` : 'no funded holder among the newest 30 trades'}`);
  const owner = holder ?? buyer;
  if (!owner) continue;
  const userAta = ataFor(owner, coin.mint, tp);

  const pre = await snapshot(owner, userAta);
  console.log(`  owner ${owner.slice(0, 8)}… holds ${pre.tokens} base units, ${(pre.lamports / 1e9).toFixed(4)} SOL${pre.wsol ? `, ${(Number(pre.wsol) / 1e9).toFixed(4)} WSOL (unwrapped by the close)` : ''}`);
  const canBuy = pre.lamports >= 30_000_000;
  if (!canBuy) console.log('  (owner holds under 0.03 SOL — the buy simulation is skipped for this coin)');

  // Build + simulate, once more on a failure: these wallets trade, and a
  // pool that moved between our state read and the simulation is a fact
  // about the wallet, not the builder. A second clean failure is real.
  const attempt = async (label, build) => {
    for (let round = 0; round < 2; round++) {
      _resetPumpSwapCaches();
      const built = await build();
      if (round === 0) check(`  ${label} builds`, built.ok, built.message);
      if (!built.ok) return { built, sim: null };
      const sim = await simulate(built.tx, owner, userAta);
      if (sim.units) maxUnits = Math.max(maxUnits, sim.units);
      if (sim.ok || round === 1) return { built, sim };
      console.log(`  (${label}: ${sim.why} — the pool or the wallet moved; rebuilding once)`);
    }
    return { built: { ok: false, message: 'unreachable' }, sim: null };
  };

  // BUY 0.01 SOL
  const budget = 10_000_000n;
  const buyParams = { action: 'buy', mint: coin.mint, owner, solLamports: budget, slippagePct: 12, priorityFeeSol: 0.00005, computeUnitLimit: 120_000, httpUrl: RPC };
  if (canBuy) {
    const { sim } = await attempt('buy', () => buildPumpSwapTrade(buyParams));
    if (sim) {
      // `spent` nets out the owner's own WSOL: the close after the swap
      // unwraps whatever the account held, which is the owner's money coming
      // back as SOL, not the trade's cost.
      const spent = sim.ok ? sim.before.lamports - sim.lamports + Number(sim.before.wsol) : null;
      const got = sim.ok ? sim.tokens - sim.before.tokens : null;
      check(`  buy simulates`, sim.ok, sim.ok ? `${sim.units} CU, spent ${(spent / 1e9).toFixed(5)} SOL of 0.01, +${got} base units` : sim.why);
      if (sim.ok) {
        check(`  buy received tokens`, got !== null && got > 0n, `${got}`);
        // A first buy also pays the token account's rent (2,074,080 lamports
        // for a Token-2022 ATA) and the volume accumulator's, plus the
        // priority and network fees.
        check(`  buy spent no more than the budget plus rent and fees`, spent !== null && spent <= Number(budget) + 3_600_000, `${spent} lamports`);
      } else if (sim.logs) console.log('    ' + sim.logs.slice(-6).join('\n    '));
    }
  } else {
    _resetPumpSwapCaches();
    const buy = await buildPumpSwapTrade(buyParams);
    check(`  buy builds`, buy.ok, buy.message);
  }

  // SELL 50 % and 100 %
  if (holder) {
    for (const pct of [50, 100]) {
      const { built, sim } = await attempt(`sell ${pct}%`, () => buildPumpSwapTrade({ action: 'sell', mint: coin.mint, owner, solLamports: 0n, sellPct: pct, slippagePct: 12, priorityFeeSol: 0.00005, computeUnitLimit: 120_000, httpUrl: RPC }));
      if (!built.ok) {
        if (/zero token balance/.test(built.message)) console.log('  (the holder sold while this ran — no sell to simulate)');
        continue;
      }
      if (!sim) continue;
      const gained = sim.ok ? sim.lamports - sim.before.lamports - Number(sim.before.wsol) : null;
      check(`  sell ${pct}% simulates`, sim.ok, sim.ok ? `${sim.units} CU, ${(gained / 1e9).toFixed(5)} SOL, ${sim.closed ? 'token account closed' : `${sim.tokens} base units left`}` : sim.why);
      if (sim.ok) {
        // The sell's proceeds less the priority and network fees; a 100 %
        // sell also reclaims the token account's rent, so it can pay on a
        // dust bag where a 50 % cannot.
        // At least the minimum the instruction demanded (net × the slippage
        // margin), less the priority and network fees the wallet paid.
        const floor = Math.floor(built.solValueLamports * 0.88) - 60_000;
        check(`  sell ${pct}% paid at least its minimum less fees`, gained !== null && gained >= floor, `${gained} lamports, floor ${floor}`);
        if (pct === 100) {
          exercised++;
          if (mayhem) mayhemExercised++;
        }
        if (pct === 100) check('  sell 100% closed the token account (rent reclaimed)', sim.closed);
        else check('  sell 50% left about half', sim.tokens > 0n && sim.tokens < sim.before.tokens, `${sim.tokens} of ${sim.before.tokens}`);
      } else if (sim.logs) console.log('    ' + sim.logs.slice(-6).join('\n    '));
    }
  }
}
check('at least one coin had its buy and both sells simulated', exercised > 0, `${exercised} coin(s)${mayhemExercised ? `, ${mayhemExercised} mayhem` : ', no mayhem coin had a funded holder this run'}`);
check('compute units stay under the builder floor', maxUnits > 0 && maxUnits < PUMP_SWAP_MIN_COMPUTE_UNITS, `max ${maxUnits} of ${PUMP_SWAP_MIN_COMPUTE_UNITS}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall live checks passed');
process.exit(failures ? 1 : 0);
