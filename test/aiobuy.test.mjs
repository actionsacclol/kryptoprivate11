// "Buy anywhere" (electron/engine/aioBuy.ts + shared/aioConvert.ts), against
// a fake host: no chain, no Relay, no clock. What must hold:
//   · the buy is NEVER placed on money that has not arrived;
//   · one top-up per click — a double click cannot fund twice;
//   · the cheapest source that can actually pay is the one used, and a
//     source is never drawn below its own exit reserve;
//   · at least $25 moves when the source has it, else just what is needed;
//   · a costly top-up asks first; a stale plan is re-made, never reused.
import assert from 'node:assert';
import { plan, execute } from './.aiobuy.mjs';
import { topUpTarget, chooseSource, costVerdict, CHAIN_RESERVE, MIN_TOPUP_USD, ORDER_FEE_SHARE, fundedTarget } from './.aioconvert.mjs';

// ── pure rules ──────────────────────────────────────────────────────────
{
  assert.equal(topUpTarget({ buy: 0.1, held: 0.5, reserve: 0.015, priceUsd: 120 }), null, 'enough here: nothing to move');
  const t = topUpTarget({ buy: 0.1, held: 0.02, reserve: 0.015, priceUsd: 120 });
  assert.ok(Math.abs(t.need - (0.1 * (1 + ORDER_FEE_SHARE) + 0.015 - 0.02)) < 1e-12, 'need = buy + its own Krypt fee + reserve − held');
  assert.ok(Math.abs(t.target - MIN_TOPUP_USD / 120) < 1e-12, 'raised to the minimum top-up');
  const big = topUpTarget({ buy: 2, held: 0, reserve: 0.015, priceUsd: 120 });
  assert.equal(big.target, big.need, 'a need above the minimum is the need');
  assert.ok(Math.abs(topUpTarget({ buy: 0.1, held: 0, reserve: 0.015, priceUsd: null }).target - 0.1155) < 1e-12, 'no price: no minimum, just the need');
  // A large EVM buy sends amount + fee: the top-up must bring the fee too, or
  // the buy fails after the money moved (swarm 2026-10-03, MS-2).
  const large = topUpTarget({ buy: 1, held: 0, reserve: 0.0005, priceUsd: 600 });
  assert.ok(large.need >= 1 + 1 * ORDER_FEE_SHARE + 0.0005 - 1e-12, 'a 1 BNB buy is funded with its 0.005 BNB fee');
  assert.ok(Math.abs(fundedTarget(1, 0.0005) - 1.0055) < 1e-12);

  const q = (from, inAmount, spare, inUsd, outUsd, eta = 1) => ({ from, inAmount, spare, outAmount: 1, inUsd, outUsd, etaSec: eta, quoteId: from, expiresAt: 1e15 });
  assert.equal(chooseSource([q('bnb', 1, 2, 10, 9.8), q('robinhood', 1, 2, 10, 9.9)]).from, 'robinhood', 'cheapest wins');
  assert.equal(chooseSource([q('bnb', 3, 2, 10, 9.95), q('robinhood', 1, 2, 10, 9.8)]).from, 'robinhood', 'a source that cannot spare it is never used');
  assert.equal(chooseSource([q('bnb', 1, 2, null, null), q('robinhood', 1, 2, 10, 9.5)]).from, 'robinhood', 'unknown cost is never the cheapest');
  assert.equal(chooseSource([q('bnb', 3, 2, 10, 9)]), null);
  assert.deepEqual(costVerdict(0.2, 25), { pct: 0.8, ask: false });
  assert.equal(costVerdict(1, 25).ask, true, 'over 3% asks');
  assert.equal(costVerdict(null, 25).ask, true, 'unknown cost asks, never assumed fine');
  console.log('ok  how much, from where, and when to ask');
}

// ── a fake world ────────────────────────────────────────────────────────
function world(opts = {}) {
  const held = { solana: 0.02, bnb: 0.2, robinhood: 0.002, ...opts.held };
  const price = { solana: 120, bnb: 600, robinhood: 2700, ...opts.price };
  const log = [];
  let now = 1_000_000;
  let pendingArrival = null;
  const host = {
    offReason: () => opts.off ?? null,
    enabled: () => true,
    nativeHeld: async (c) => {
      if (pendingArrival && now >= pendingArrival.at) {
        held[pendingArrival.chain] += pendingArrival.amount;
        pendingArrival = null;
      }
      return opts.unread === c ? null : held[c];
    },
    priceUsd: async (c) => price[c],
    quoteTopUp: async (from, to, outRaw) => {
      const dec = to === 'solana' ? 9 : 18;
      const out = Number(outRaw) / 10 ** dec;
      const outUsd = out * price[to];
      const cost = opts.costUsd ?? 0.12;
      const inUsd = outUsd + cost;
      const decFrom = from === 'solana' ? 9 : 18;
      log.push(`quote ${from}->${to} ${out.toFixed(6)}`);
      return {
        ok: true,
        message: 'ok',
        quote: {
          from,
          to,
          fromAmountRaw: String(BigInt(Math.round((inUsd / price[from]) * 1e9)) * 10n ** BigInt(decFrom - 9)),
          toAmountRaw: outRaw.toString(),
          toAmountMinRaw: outRaw.toString(),
          toDecimals: dec,
          fromUsd: inUsd,
          toUsd: outUsd,
          durationSec: 1,
          quoteId: `q-${from}-${log.length}`,
          rail: 'relay',
        },
      };
    },
    sendTopUp: async (id) => {
      log.push(`send ${id}`);
      if (opts.sendFails) return { ok: false, message: 'refused' };
      const m = /q-(\w+)-/.exec(id);
      // The money arrives after a delay — or never.
      if (!opts.neverArrives) pendingArrival = { chain: opts.dest ?? 'solana', amount: opts.arrives ?? 0.25, at: now + (opts.arrivalMs ?? 1500) };
      held[m[1]] -= 0.04;
      return { ok: true, message: 'sent', txHash: `tx-${id}` };
    },
    buy: async (c, token, amount, heldNow) => {
      log.push(`buy ${c} ${amount} with ${held[c].toFixed(4)} held, told ${heldNow === null ? 'nothing' : heldNow.toFixed(4)}`);
      if (opts.buyFails) return { ok: false, message: 'slippage.' };
      return { ok: true, message: 'Bought' };
    },
    chargeMoveFee: async (from, to, inAmount, outAmount) => {
      log.push(`fee ${from}->${to} on ${outAmount.toFixed(6)}`);
      return { amount: outAmount * 0.005, symbol: 'BNB' };
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  return { host, log, held };
}

// ── planning ────────────────────────────────────────────────────────────
{
  const w = world({ held: { solana: 1 } });
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  assert.equal(p.kind, 'direct', 'enough on the chain: just buy');
  assert.equal(w.log.length, 0, 'and nothing was even quoted');

  const off = await plan({ chain: 'solana', amount: 0.1 }, world({ off: 'Switch Solana to Live' }).host);
  assert.equal(off.kind, 'off');

  const unread = await plan({ chain: 'solana', amount: 0.1 }, world({ unread: 'solana' }).host);
  assert.equal(unread.kind, 'direct', 'an unread balance is not "short" — never move money on a guess');

  const w2 = world();
  const c = await plan({ chain: 'solana', amount: 0.1 }, w2.host);
  assert.equal(c.kind, 'convert');
  assert.equal(c.convert.from, 'bnb', 'from the chain that can spare it (Robinhood holds too little)');
  assert.ok(Math.abs(c.convert.outAmount - 25 / 120) < 1e-6, 'at least $25 moves');
  assert.match(c.message, /no Krypt fee/);

  // A source that cannot spare the minimum still covers the need.
  const w3 = world({ held: { bnb: 0.0005 + 0.02 } }); // spare 0.02 BNB = $12 < $25, > need
  const lean = await plan({ chain: 'solana', amount: 0.05 }, w3.host);
  assert.equal(lean.kind, 'convert');
  assert.ok(lean.convert.outAmount < 25 / 120, 'just the need when the minimum does not fit');
  assert.ok(w3.log.filter((l) => l.startsWith('quote bnb')).length === 2, 'tried the minimum first, then the need');

  const none = await plan({ chain: 'solana', amount: 0.1 }, world({ held: { bnb: CHAIN_RESERVE.bnb, robinhood: CHAIN_RESERVE.robinhood } }).host);
  assert.equal(none.kind, 'refuse', 'nothing to spare anywhere: refuse, with the reason');
  assert.match(none.message, /no other chain can spare/);

  const pricey = await plan({ chain: 'solana', amount: 0.1 }, world({ costUsd: 2 }).host);
  assert.equal(pricey.kind, 'ask', '$2 to move $25 is 8%: ask first');
  console.log('ok  planning: direct, convert, the lean fallback, refuse, ask');
}

// ── execution ───────────────────────────────────────────────────────────
{
  const w = world();
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  const r = await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert?.quoteId }, w.host);
  assert.equal(r.ok, true, r.message);
  const order = w.log.filter((l) => !l.startsWith('quote'));
  assert.ok(order[0].startsWith('send'), 'top-up first');
  assert.ok(order[1].startsWith('buy solana 0.1'), 'then the buy');
  assert.ok(Number(/with ([\d.]+) held/.exec(order[1])[1]) >= 0.1 + CHAIN_RESERVE.solana, 'and only once the money was ON the chain');
  assert.ok(Number(/told ([\d.]+)/.exec(order[1])[1]) >= 0.1 + CHAIN_RESERVE.solana, 'the buy is TOLD the balance that arrived, not left to a stale cache');
  assert.ok(!w.log.some((l) => l.startsWith('fee')), 'a buy that went through bills no move fee');
  assert.ok(r.timings.arrivalMs >= 1500, 'it waited for the arrival');
  assert.match(r.message, /funded from BNB Chain/);
  console.log('ok  top-up, wait for the money on chain, then buy');
}
{
  const w = world({ neverArrives: true });
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  const r = await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert?.quoteId }, w.host);
  assert.equal(r.ok, false);
  assert.ok(!w.log.some((l) => l.startsWith('buy')), 'money that never arrived is never bought with');
  assert.match(r.message, /buy was NOT placed/);
  console.log('ok  a top-up that does not arrive places no buy');
}
{
  const w = world({ sendFails: true });
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  const r = await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert?.quoteId }, w.host);
  assert.equal(r.ok, false);
  assert.ok(!w.log.some((l) => l.startsWith('buy')), 'a refused top-up places no buy');
  console.log('ok  a refused top-up places no buy');
}
{
  const w = world();
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  const [a, b] = await Promise.all([
    execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert?.quoteId }, w.host),
    execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert?.quoteId }, w.host),
  ]);
  assert.equal([a, b].filter((x) => x.ok).length, 1, 'one of two simultaneous clicks runs');
  assert.match((a.ok ? b : a).message, /already being funded/);
  assert.equal(w.log.filter((l) => l.startsWith('send')).length, 1, 'ONE top-up');
  console.log('ok  a double click cannot fund twice');
}
{
  const w = world({ costUsd: 2 });
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  const r = await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert?.quoteId }, w.host);
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm.kind, 'ask', 'a costly top-up comes back as a question');
  assert.ok(!w.log.some((l) => l.startsWith('send')), 'and nothing moved');
  const yes = await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: r.needsConfirm.convert.quoteId, acceptAsk: true }, w.host);
  assert.equal(yes.ok, true, 'the yes goes through');
  console.log('ok  a costly top-up asks first, and moves only on yes');
}
{
  const w = world();
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  await w.host.sleep(40_000); // past the quote's life
  await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert.quoteId }, w.host);
  const sends = w.log.filter((l) => l.startsWith('send'));
  assert.equal(sends.length, 1);
  assert.notEqual(sends[0], `send ${p.convert.quoteId}`, 'an expired plan is re-made, never sent');
  console.log('ok  a stale plan is quoted again, never reused');
}

{
  // The owner's rule (2026-10-03): the top-up is free only because the buy pays.
  const w = world({ buyFails: true });
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  const r = await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert?.quoteId }, w.host);
  assert.equal(r.ok, false);
  const i = w.log.findIndex((l) => l.startsWith('buy'));
  assert.ok(i >= 0 && w.log.slice(i + 1).some((l) => l.startsWith('fee bnb->solana')), 'a top-up that funded no buy is billed as a move, after the failed buy');
  assert.match(r.message, /counts as a move between chains/);
  const w2 = world({ neverArrives: true });
  const p2 = await plan({ chain: 'solana', amount: 0.1 }, w2.host);
  await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p2.convert?.quoteId }, w2.host);
  assert.ok(!w2.log.some((l) => l.startsWith('fee')), 'money that never arrived is not billed');
  console.log('ok  a top-up that funded no buy is billed as an ordinary move');
}

{
  // Swarm 2026-10-03: a quote far above what the money is worth by the
  // app's OWN prices is refused (MS-6); an expensive-but-real one still asks.
  const wild = await plan({ chain: 'solana', amount: 0.1 }, world({ costUsd: 6 }).host);
  assert.equal(wild.kind, 'refuse', 'Relay asking $31 for $25 of SOL is refused outright');
  assert.match(wild.message, /app's own prices/);
  // An unread source is "could not check", never "cannot spare" (UX-4).
  const blind = await plan({ chain: 'solana', amount: 0.1 }, world({ unread: 'bnb', held: { robinhood: CHAIN_RESERVE.robinhood } }).host);
  assert.equal(blind.kind, 'direct', 'unknown is not short: the buy uses what is here');
  assert.match(blind.message, /could not be checked/);
  console.log('ok  own prices bound a quote; unknown sources are not called short');
}
{
  // The source is re-read right before the send (MS-3): spent elsewhere in
  // the meantime, nothing moves.
  const w = world();
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  w.held.bnb = CHAIN_RESERVE.bnb + 0.001;
  const r = await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert?.quoteId }, w.host);
  assert.equal(r.ok, false);
  assert.ok(!w.log.some((l) => l.startsWith('send')), 'a source that no longer has it sends nothing');
  assert.match(r.message, /Nothing was sent/);
  console.log('ok  the source is re-checked right before the top-up');
}

{
  // A top-up Relay refunded ends the wait at once — no buy, no fee, no
  // 90 s spinner for money that is going back (Relay research, 2026-10-03).
  const w = world({ neverArrives: true });
  w.host.transferEnded = (tx) => (tx.startsWith('tx-') ? 'refunded' : null);
  const p = await plan({ chain: 'solana', amount: 0.1 }, w.host);
  const r = await execute({ chain: 'solana', token: 'MINT', amount: 0.1, quoteId: p.convert?.quoteId }, w.host);
  assert.equal(r.ok, false);
  assert.match(r.message, /refunded/);
  assert.ok(r.timings.arrivalMs < 5_000, 'it stopped at the first look, not after the timeout');
  assert.ok(!w.log.some((l) => l.startsWith('buy') || l.startsWith('fee')), 'no buy, no fee');
  console.log('ok  a refunded top-up stops the wait at once — no buy, no fee');
}

console.log('\naio buy: never buys on money that has not arrived');
