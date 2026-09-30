// Graduation Scalper — hold a pump.fun coin through its graduation and sell into the pool's first seconds.
//
// v2.0 (09-30) FINISHER MODE, the default. Why it changed:
//   • The v1 entry (buy the pool's first print, sell later) was re-tested on
//     156 fresh graduations (09-26..29): −3 % to −5 % a trade at every delay
//     and hold tried, CI below zero; runner-flagged only −4 % to −6 % (n 54).
//   • Three quarters of graduations are completed by one bundle and open
//     ~10x above the seed. The rest sit at 95 %+ for a while (median 14 s)
//     and their pool opens AT the seed, then rises: 1.07x at 8–12 s after the
//     curve completes (118 held-out pools; 1.070x on the day it was found).
//     Only a bag already held when the curve completes gets that.
//   • So: buy on the curve when it first reaches the entry % (95), hold
//     through graduation, sell ~8 s after the completion so the sell lands
//     ~9–10 s in. A 20 % curve stop and a 60 min timer end coins that never
//     finish. Held out at 0.5 SOL (owner, lean fees): +0.3 % [−6, +6] with no
//     stop, +3 % with the stop (picked from ~1,000 cells: not proven).
//     Selling at 1–6 s instead turned every cell negative. Paper fills have
//     no latency — the GRAD row logs compMs (completion → sell sent) so the
//     paper record can be checked against the window.
//   • Needs an app with the curveHigh event (5.5.2+). On an older app the
//     Finisher never hears a coin and buys nothing.
// The v1 mode is still here ("the pool's first print").
//
// v1 notes follow.
//
// PAPER FIRST. This ships switched off and in paper mode, and it should stay
// on paper until its own record says otherwise. What is known (09-28 tick
// study, 336 classic graduations on 09-16 plus 49 runner-flagged graduates on
// 09-10/11, real fill latency, pump's 1.25 % pool fee, the fixed priority
// fees, no Krypt fee):
//
//   • A pool's first print lands ~1 ms after the migration — it is the
//     sniper bundle. A fill 1.2 s later already pays a median 1.14x the
//     seed price; on a quarter of pools the first second is a >10x spike.
//   • From that fill the path is +0.2 % gross at 60 s, +1.0 % at 180 s and
//     −20 % at 600 s (median −44 %): whatever drift there is lives in the
//     first three minutes, then the pool bleeds.
//   • Net of fees, all graduations: hold 60 s −2.4 %, take 1.1x within
//     300 s −1.4 % [−3.5, +0.5] at 0.5 SOL; −8 % at 0.05 SOL, where the
//     fixed fees alone eat 8–10 %. Runner-flagged graduates only: +1.0 %
//     on 20 held-out coins (top three dropped: −3.0 %). Nothing ≥ 0 with
//     n ≥ 30 and the best three coins removed.
//   • Every second of lag costs 0.4–1 point. This app hears the pool's
//     first print, builds the buy and lands it about two seconds after —
//     it is not a bundle. Expect a few percent NEGATIVE per trade on
//     average; the point of running it is to measure that with real
//     latency, in paper, and let a hundred trades decide.
//
// Paper fills here are the last pool print with the fee model and NO
// latency, so a paper record flatters a live one by a point or two.
//
// The cycle per coin:
//   1. the app reports a migration (the curve completed)
//   2. classic pump coin? not a mayhem curve, creator has not sold, a slot is
//      free, the hourly cap has room
//   3. subscribe to its ticks and wait for the POOL's first print
//   4. buy on that print (or after the entry delay). The "skip a spike"
//      filter ships OFF: on 09-16 the pools that opened 3x+ above the seed
//      were the calmer, slightly positive ones; skipping them hurt every cell
//   5. sell everything at the take-profit, the stop, the timer, or at once
//      if the creator sells
//   5b. (v1.1) post a pump.fun callout 30-45 s after the buy, and if it went
//      out, sell DOWN to ~$1.50 at the exit and hold that until +15 min so
//      the call stays on pump's feed (it only shows callers who still hold)
//   6. one GRAD line per trade with seed / first / fill / exit prices, so the
//      record can be measured without believing the log

/* @inputs
{
  "which": {
    "type": "select",
    "label": "Which graduations",
    "options": ["any classic pump coin", "runner-flagged coins only"],
    "default": "any classic pump coin",
    "help": "Every classic pump.fun graduation the app hears (10-15 an hour when busy), or only coins the scanner flagged as runners in the last two hours (a few a day; +1% on 20 held-out coins, too few to call)."
  },

  "entry": {
    "type": "select",
    "label": "When to buy",
    "options": ["on the curve at the entry % (Finisher)", "the pool's first print (v1)"],
    "default": "on the curve at the entry % (Finisher)",
    "help": "Finisher: buy near the end of the curve, sell ~8 s after it completes (the only held-out cell at or above 0). v1: buy the pool's first print (−3..−5 % on 156 fresh graduations)."
  },

  "curveEntryPct": {
    "type": "number",
    "label": "Finisher: buy when the curve first reaches (%)",
    "default": 95,
    "min": 90,
    "max": 97,
    "step": 1,
    "help": "The app announces 90 / 93 / 95 / 97. 95 was chosen on 09-16; 97 looked better held out but was picked after looking. A coin sits at 95 %+ a median 14 s before it completes."
  },

  "sellAfterGradSecs": {
    "type": "number",
    "label": "Finisher: sell this long after the curve completes (seconds)",
    "default": 8,
    "min": 3,
    "max": 60,
    "help": "The pop peaks 8–12 s after completion and is flat before ~6 s; a sell landing at 1–6 s lost in every cell. The sell takes ~1.5 s to land, so 8 lands ~9.5 s in."
  },

  "curveStopPct": {
    "type": "number",
    "label": "Finisher: stop on the curve (% under the fill)",
    "default": 20,
    "min": 0,
    "max": 60,
    "help": "Coins that reach 95 % and then fall back are the loss side. 20 % turned −0.7 % into +3 % held out (selection-exposed). 0 = off."
  },

  "curveMaxMins": {
    "type": "number",
    "label": "Finisher: give up on the curve after (minutes)",
    "default": 60,
    "min": 1,
    "max": 240,
    "help": "Sold at this age if the curve never completes."
  },

  "lane": {
    "type": "select",
    "label": "Fee lane (buy and timed sell)",
    "options": ["lean", "fast"],
    "default": "lean",
    "help": "lean ~0.00001 SOL a side, landing speed unmeasured; fast pays the 0.001/0.002 floors + tips (2-4 % of a 0.1 SOL trade). Stops and creator-sell exits always go fast."
  },

  "buySol": {
    "type": "number",
    "label": "Buy size (SOL)",
    "default": 0.1,
    "min": 0.001,
    "max": 5,
    "step": 0.01,
    "help": "Fixed fees (priority, rent, tips) are ~0.0035 SOL a round trip whatever the size: 8-10% of 0.05 SOL, 4% of 0.25, 3.5% of 0.5. Under 0.05 the fees alone lose more than the drift ever pays."
  },

  "takeProfitX": {
    "type": "number",
    "label": "Take profit at (multiple of the fill price)",
    "default": 1.2,
    "min": 1.01,
    "max": 10,
    "step": 0.01,
    "help": "Sells 100% when a pool print reaches it. Measured on all graduations: 1.1x within 300 s was the least-bad cell (-1.4% at 0.5 SOL); 1.3x within 3 min -5%. Under +10% cannot clear the fees at 0.05 SOL."
  },

  "holdSecs": {
    "type": "number",
    "label": "Sell after (seconds), if the take-profit has not hit",
    "default": 180,
    "min": 15,
    "max": 1800,
    "help": "The timed exit. 60-180 s carried the whole drift; at 600 s the median pool is down 44%."
  },

  "stopLossPct": {
    "type": "number",
    "label": "Stop loss (% down from the fill)",
    "default": 0,
    "min": 0,
    "max": 90,
    "help": "0 = none. Measured: stops did nothing here - a pool that rugs gaps through them, and the timer is the real stop."
  },

  "entryDelaySecs": {
    "type": "number",
    "label": "Buy this long after the first pool print (seconds)",
    "default": 0,
    "min": 0,
    "max": 300,
    "help": "0 = buy on the first print. 60 s looked better on runner-flagged graduates in-sample (+2.4% hold-60) and worse on all graduations; untested held out."
  },

  "maxFirstPrintX": {
    "type": "number",
    "label": "Skip if the first print is already this many times the seed price",
    "default": 0,
    "min": 0,
    "max": 100,
    "step": 0.1,
    "help": "0 = off (default). Measured 09-16 on 336 pools: the ones that open 3x+ above the seed are the CALMER, slightly positive subset; skipping them lowered every held-out cell. Left in for experiments only."
  },

  "waitForPoolSecs": {
    "type": "number",
    "label": "Give up if the pool has not printed within (seconds)",
    "default": 30,
    "min": 5,
    "max": 300,
    "help": "The curve completes first; pump's migration and the first swaps usually follow within seconds. No print by then = skipped, nothing bought."
  },

  "maxOpen": {
    "type": "number",
    "label": "Most coins held or awaited at once",
    "default": 2,
    "min": 1,
    "max": 5,
    "help": "A coin counts from its buy (Finisher) or migration (v1) until it is sold or skipped. The script budget's open-positions cap applies on top."
  },

  "maxBuysPerHour": {
    "type": "number",
    "label": "Most buys per hour",
    "default": 12,
    "min": 1,
    "max": 120,
    "help": "The script budget's buys-per-day cap applies on top."
  },

  "skipIfDevSold": {
    "type": "toggle",
    "label": "Skip if the creator has already sold",
    "default": true,
    "help": "Read from the app's launch record at the migration - free. Unknown never skips."
  },

  "sellOnDevSell": {
    "type": "toggle",
    "label": "Sell everything if the creator sells while holding",
    "default": true
  },

  "callouts": {
    "type": "toggle",
    "label": "Post a pump.fun callout on each buy",
    "default": true,
    "help": "Live only: a paper script posts nothing. The call goes out after the delay below if the bag is still held; one call per coin per account. pump's rules on scripted calls apply (terms 7.1)."
  },

  "callDelaySecs": {
    "type": "range",
    "label": "Call this long after the buy (seconds)",
    "default": [30, 45],
    "min": 30,
    "max": 170,
    "step": 5,
    "help": "pump removed calls made 2-17 s after a buy. Must come before the timed exit to be worth making; a bag sold before its call is never called."
  },

  "comments": {
    "type": "lines",
    "label": "Callout lines",
    "default": [
      "{ticker} just graduated, pool live at {mc}",
      "{ticker} finished its curve, {mc} on the pool now",
      "{name} migrated, sitting at {mc}",
      "grabbed some {ticker} right after graduation at {mc}",
      "{ticker} fresh on the pool, {mc}",
      "in {ticker} off the graduation, {mc} now",
      "{name} just hit the pool at {mc}",
      "{ticker} graduated, took a bag at {mc}",
      "{ticker} out of the curve, {mc} mc",
      "small bag of {ticker} post-graduation, {mc}"
    ],
    "help": "Filled when the call posts: {ticker}, {name}, {mc} (the pool's cap now). A line with an unknown value is never used. pump deletes generic lines in ~30 s; lines naming the ticker and a number last."
  },

  "keepForCallUsd": {
    "type": "number",
    "label": "Keep this much (USD) after the exit, so the call stays up",
    "default": 1.5,
    "min": 0,
    "max": 100,
    "step": 0.5,
    "help": "pump's feed only shows callers who still hold (09-29: 0 of 1,702 feed calls had a caller at 0). A called coin is sold DOWN to this at the take-profit or timer. 0 = sell everything."
  },

  "keepForCallMins": {
    "type": "number",
    "label": "Keep it until (minutes after the buy), then sell the rest",
    "default": 15,
    "min": 1,
    "max": 240,
    "help": "How long the call should stay visible. The kept bag rides the pool meanwhile: at 10 min the median fresh pool is down ~44%, about $0.65 of a $1.50 bag."
  },

  "tradeHook": {
    "type": "webhook",
    "label": "Discord webhook: trade results",
    "optional": true,
    "default": "",
    "help": "One embed per closed trade. Blank = off."
  }
}
*/

// ── Fixed here, not in the form ─────────────────────────────────────────
/** A classic pump curve completes at this price (SOL per token: 115 SOL of
 *  virtual reserve over 2.799e8 virtual tokens, 85 SOL raised). The pool is
 *  seeded at the same price. Used only when the app cannot say whether a
 *  coin is a mayhem curve; a completion price this far off it is not a
 *  classic curve and is skipped. */
const CLASSIC_GRAD_PX = 4.108e-7;
const CLASSIC_TOLERANCE = 0.15;
/** Passes are short: the sandbox asks at 3 s and kills at 30 s. */
const PASS_BUDGET_MS = 12_000;
/** A sell that fails this many times in a row is given up (the bag stays in
 *  the wallet and the log says so). */
const MAX_SELL_TRIES = 6;
/** A buy still "pending" this long with no position listed never landed. */
const PENDING_GRACE_MS = 90_000;
/** Two sells on the same bag can race (a tick and the timer); one at a time. */
const SELL_LOCK_MS = 20_000;
/** The wallet must hold the buy plus this, or nothing is bought (the app
 *  refuses a buy under 0.03 SOL anyway). */
const WALLET_RESERVE_SOL = 0.05;
/** Runner flags are remembered this long for "runner-flagged coins only". */
const FLAG_TTL_MS = 2 * 3600_000;
const LOG_MAX = 380;

// ── Helpers ─────────────────────────────────────────────────────────────
const FINISHER = () => bot.input.entry !== "the pool's first print (v1)";
const LANE = () => (bot.input.lane === 'fast' ? 'fast' : 'lean');
const NAME = (sym, mint) => (sym ? `${sym} (${mint})` : mint);
const R3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const R4 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(4)) : null);
const PCT = (v) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const NUM = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Await something for at most `ms`; undefined when it has not answered. */
function WITHIN(p, ms) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((r) => { t = setTimeout(() => r(undefined), ms); }),
  ]);
}

function logRow(prefix, row) {
  let s = prefix + JSON.stringify(row);
  if (s.length > LOG_MAX) {
    const r = { ...row };
    for (const k of Object.keys(r)) if (r[k] === null || r[k] === undefined) delete r[k];
    s = prefix + JSON.stringify(r);
  }
  bot.log(s.slice(0, LOG_MAX));
}

const skips = {};
function skip(mint, sym, why, detail) {
  skips[why] = (skips[why] ?? 0) + 1;
  bot.log(`skipped ${NAME(sym, mint)}: ${detail ?? why}`);
}

/** Post a trade result to the webhook, if one is set. Never throws, never
 *  waits on the money path. */
async function post(embed) {
  if (!bot.input.tradeHook) return;
  try {
    await WITHIN(bot.discord('tradeHook', embed), 4000);
  } catch (e) {
    bot.warn(`discord: ${e?.message ?? e}`);
  }
}

// ── State ───────────────────────────────────────────────────────────────
// Persisted with bot.setState so a restart picks its bags back up.
//   seen:     mints already decided on (last 300)
//   watching: [{mint, sym, seedPx, at, deadline, firstPx, firstAt, buyAt}]
//   holds:    [{mint, sym, seedPx, firstPx, firstAt, fillPx, fillKnown, cost,
//               boughtAt, sellAt, hiPx, tries, pending, sellingAt}]
//   hourBuys: [ms...] buy times in the last hour
//   tally:    {trades, wins, netSol, rets: [ret...] (last 200), skipped}
const EMPTY = () => ({ seen: [], watching: [], holds: [], hourBuys: [], tally: { trades: 0, wins: 0, netSol: 0, rets: [], skipped: 0 } });

async function STATE() {
  const st = (await bot.getState()) ?? {};
  const e = EMPTY();
  return {
    seen: Array.isArray(st.seen) ? st.seen : e.seen,
    watching: Array.isArray(st.watching) ? st.watching : e.watching,
    holds: Array.isArray(st.holds) ? st.holds : e.holds,
    hourBuys: Array.isArray(st.hourBuys) ? st.hourBuys : e.hourBuys,
    tally: st.tally && typeof st.tally === 'object' ? { ...e.tally, ...st.tally, rets: Array.isArray(st.tally.rets) ? st.tally.rets : [] } : e.tally,
  };
}

async function SAVE(st) {
  st.seen = st.seen.slice(-300);
  st.tally.rets = st.tally.rets.slice(-200);
  const cutoff = bot.now() - 3600_000;
  st.hourBuys = st.hourBuys.filter((t) => t > cutoff);
  await bot.setState(st);
  paint(st);
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function paint(st) {
  const rets = st.tally.rets.filter((r) => typeof r === 'number');
  const med = median(rets);
  bot.stats({
    Held: st.holds.length,
    Awaiting: st.watching.length,
    Trades: st.tally.trades,
    Wins: st.tally.wins,
    'Net SOL': R4(st.tally.netSol),
    'Median %': med === null ? null : Math.round(med * 1000) / 10,
    'Mean %': rets.length ? Math.round((rets.reduce((a, b) => a + b, 0) / rets.length) * 1000) / 10 : null,
    Skipped: st.tally.skipped,
  });
}

// ── Runner flags (for "runner-flagged coins only") ───────────────────────
const flagged = new Map(); // mint -> flagged at (ms)
function noteFlag(mint) {
  if (!mint) return;
  flagged.set(mint, bot.now());
  if (flagged.size > 400) flagged.delete(flagged.keys().next().value);
}
function isFlagged(mint) {
  const at = flagged.get(mint);
  return typeof at === 'number' && bot.now() - at < FLAG_TTL_MS;
}
bot.on('runner', (t) => { if (t?.mint) noteFlag(t.mint); });

// ── Classic or not ──────────────────────────────────────────────────────
/** true = classic pump curve, false = not, null = cannot tell. The app says
 *  so from the create event when it can (isMayhem); else the completion
 *  price has to sit at the classic curve's end price. */
function classicVerdict(t) {
  if (typeof t.isMayhem === 'boolean') return !t.isMayhem;
  const px = NUM(t.priceSol, 0);
  if (!(px > 0)) return null;
  return Math.abs(px / CLASSIC_GRAD_PX - 1) <= CLASSIC_TOLERANCE;
}

// ── 1-2. A migration: decide, then wait for the pool ────────────────────
/** Mints being decided on right now. The app can report one migration on
 *  two paths within a millisecond; the check is synchronous, before the
 *  first await, so the second copy cannot slip past the saved state. */
const deciding = new Set();

bot.on('migration', async (t) => {
  if (!t || typeof t.mint !== 'string' || t.migrated !== true) return;
  const mint = t.mint;
  if (await graduated(mint)) return;
  if (FINISHER()) return;
  if (deciding.has(mint)) return;
  deciding.add(mint);
  try {
    await decide(t, mint);
  } finally {
    deciding.delete(mint);
  }
});

async function decide(t, mint) {
  const sym = t.symbol || null;
  const now = bot.now();
  const st = await STATE();
  if (st.seen.includes(mint) || st.watching.some((w) => w.mint === mint) || st.holds.some((h) => h.mint === mint)) return;
  st.seen.push(mint);

  const decline = async (why, detail) => {
    skip(mint, sym, why, detail);
    st.tally.skipped += 1;
    await SAVE(st);
  };

  if (!/pump$/.test(mint)) return decline('not-pump', 'not a pump.fun coin (the pool study covers pump.fun only)');
  const classic = classicVerdict(t);
  if (classic === false) return decline('mayhem', typeof t.isMayhem === 'boolean' ? 'a mayhem-mode curve' : `completed at ${R4(t.priceSol)} SOL, not the classic curve's ${CLASSIC_GRAD_PX}`);
  if (classic === null) return decline('unknown-curve', 'cannot tell a classic curve from a mayhem one (no price on the record)');
  if (bot.input.which === 'runner-flagged coins only') {
    let hit = isFlagged(mint);
    if (!hit) {
      const list = (await WITHIN(bot.runners(), 3000)) ?? null;
      if (Array.isArray(list)) for (const r of list) { noteFlag(r?.mint); if (r?.mint === mint) hit = true; }
    }
    if (!hit) return decline('not-flagged', 'the scanner never flagged it as a runner');
  }
  if (bot.input.skipIfDevSold !== false && t.creatorSold === true) return decline('dev-sold', 'the creator has already sold');
  const maxOpen = NUM(bot.input.maxOpen, 1);
  if (st.holds.length + st.watching.length >= maxOpen) return decline('slots-full', `${maxOpen} coin(s) already held or awaited`);
  const cutoff = now - 3600_000;
  st.hourBuys = st.hourBuys.filter((x) => x > cutoff);
  if (st.hourBuys.length >= NUM(bot.input.maxBuysPerHour, 12)) return decline('hourly-cap', `${st.hourBuys.length} buys in the last hour`);

  const seedPx = NUM(t.priceSol, 0) > 0 ? t.priceSol : null;
  try {
    await WITHIN(bot.subscribe(mint), 3000);
  } catch (e) {
    return decline('subscribe', `could not subscribe to its ticks: ${e?.message ?? e}`);
  }
  st.watching.push({ mint, sym, seedPx, at: now, deadline: now + NUM(bot.input.waitForPoolSecs, 30) * 1000, firstPx: null, firstAt: null, buyAt: null });
  await SAVE(st);
  bot.log(`migration: ${NAME(sym, mint)} completed at ${R4(seedPx)} SOL — awaiting the pool's first print`);
}

// ── Finisher: buy on the curve, sell into the pool's first seconds ──────
bot.on('curveHigh', async (t) => {
  if (!FINISHER() || !t || typeof t.mint !== 'string') return;
  if (!(NUM(t.curvePct, 0) >= NUM(bot.input.curveEntryPct, 95))) return;
  const mint = t.mint;
  if (deciding.has(mint)) return;
  deciding.add(mint);
  try {
    await decideCurve(t, mint);
  } finally {
    deciding.delete(mint);
  }
});

async function decideCurve(t, mint) {
  const sym = t.symbol || null;
  const now = bot.now();
  const st = await STATE();
  if (st.seen.includes(mint) || st.holds.some((h) => h.mint === mint)) return;
  st.seen.push(mint);
  const decline = async (why, detail) => {
    skip(mint, sym, why, detail);
    st.tally.skipped += 1;
    await SAVE(st);
  };
  if (!/pump$/.test(mint)) return decline('not-pump', 'not a pump.fun coin');
  // A mayhem curve's percentage is not a completion measure; unknown never buys.
  if (t.isMayhem !== false) return decline(t.isMayhem ? 'mayhem' : 'unknown-curve', t.isMayhem ? 'a mayhem-mode curve' : 'cannot tell a classic curve from a mayhem one');
  if (bot.input.which === 'runner-flagged coins only') {
    let hit = isFlagged(mint);
    if (!hit) {
      const list = (await WITHIN(bot.runners(), 3000)) ?? null;
      if (Array.isArray(list)) for (const r of list) { noteFlag(r?.mint); if (r?.mint === mint) hit = true; }
    }
    if (!hit) return decline('not-flagged', 'the scanner never flagged it as a runner');
  }
  if (bot.input.skipIfDevSold !== false && t.creatorSold === true) return decline('dev-sold', 'the creator has already sold');
  const maxOpen = NUM(bot.input.maxOpen, 2);
  if (st.holds.length + st.watching.length >= maxOpen) return decline('slots-full', `${maxOpen} coin(s) already held`);
  const cutoff = now - 3600_000;
  st.hourBuys = st.hourBuys.filter((x) => x > cutoff);
  if (st.hourBuys.length >= NUM(bot.input.maxBuysPerHour, 12)) return decline('hourly-cap', `${st.hourBuys.length} buys in the last hour`);
  const px = NUM(t.priceSol, 0);
  if (!(px > 0)) return decline('no-price', 'no curve price on the event');
  await WITHIN(bot.subscribe(mint), 3000).catch(() => undefined);
  bot.log(`curve ${R3(t.curvePct)}%: ${NAME(sym, mint)} at ${R4(px)} SOL — buying before it completes`);
  await enter(st, { mint, sym, seedPx: CLASSIC_GRAD_PX, firstPx: null, firstAt: null }, px, { fin: true, entryPct: NUM(t.curvePct, null) });
}

/**
 * A Finisher bag's curve completed (the migration event arrives at the
 * completion). The sell is timed from here, on its own timer — the 5 s pass
 * is too coarse for a 4 s window; the pass is the fallback. True when the
 * mint was a held Finisher bag.
 */
async function graduated(mint) {
  const st = await STATE();
  const h = st.holds.find((x) => x.mint === mint && x.phase === 'curve');
  if (!h) return false;
  const now = bot.now();
  const wait = NUM(bot.input.sellAfterGradSecs, 8) * 1000;
  h.phase = 'pool';
  h.compAt = now;
  h.sellAt = now + wait;
  await SAVE(st);
  bot.log(`${NAME(h.sym, h.mint)} completed its curve — selling into the pool in ${wait / 1000} s`);
  setTimeout(() => { timedGradSell(mint).catch((e) => bot.warn(`timed sell: ${e?.message ?? e}`)); }, wait);
  return true;
}

async function timedGradSell(mint) {
  const st = await STATE();
  const h = st.holds.find((x) => x.mint === mint && x.phase === 'pool');
  if (!h || h.pending || h.keepPhase) return; // pending: the 5 s pass sells it once the buy is adopted
  const px = NUM(await WITHIN(bot.price(mint), 1500).catch(() => null), h.fillPx);
  await exit(st, h, 'grad', px);
}

// ── 3-4. Ticks: the first pool print buys; a held bag checks its exits ───
bot.on('tick', async (t) => {
  if (!t || typeof t.mint !== 'string') return;
  const px = NUM(t.priceSol, 0);
  if (!(px > 0)) return;
  const st = await STATE();
  const w = st.watching.find((x) => x.mint === t.mint);
  if (w) {
    if (w.firstPx !== null) return; // waiting for the delayed entry (the timer buys)
    w.firstPx = px;
    w.firstAt = bot.now();
    const x = w.seedPx ? px / w.seedPx : null;
    const cap = NUM(bot.input.maxFirstPrintX, 0);
    if (cap > 0 && x !== null && x > cap) {
      st.watching = st.watching.filter((y) => y.mint !== w.mint);
      st.tally.skipped += 1;
      skip(w.mint, w.sym, 'spike', `first print ${R3(x)}x the seed price, over the ${cap}x cap`);
      await SAVE(st);
      await WITHIN(bot.unsubscribe(w.mint), 2000).catch(() => undefined);
      return;
    }
    const delay = NUM(bot.input.entryDelaySecs, 0);
    if (delay > 0) {
      w.buyAt = bot.now() + delay * 1000;
      await SAVE(st);
      bot.log(`${NAME(w.sym, w.mint)}: first print ${R4(px)} SOL (${R3(x)}x seed) — buying in ${delay} s`);
      return;
    }
    await enter(st, w, px);
    return;
  }
  const h = st.holds.find((x) => x.mint === t.mint);
  if (!h || h.pending) return;
  if (px > NUM(h.hiPx, 0)) h.hiPx = px;
  if (h.phase === 'curve') {
    const cs = NUM(bot.input.curveStopPct, 20);
    if (cs > 0 && h.fillPx > 0 && px <= h.fillPx * (1 - cs / 100)) return exit(st, h, 'curve-stop', px);
    await bot.setState(st);
    return;
  }
  if (h.phase === 'pool') { await bot.setState(st); return; } // the graduation timer sells
  const tp = NUM(bot.input.takeProfitX, 1.2);
  const stop = NUM(bot.input.stopLossPct, 0);
  if (!h.keepPhase && h.fillPx > 0 && px >= h.fillPx * tp) return exit(st, h, 'tp', px);
  if (stop > 0 && h.fillPx > 0 && px <= h.fillPx * (1 - stop / 100)) return exit(st, h, 'stop', px);
  await bot.setState(st);
});

// ── The buy ─────────────────────────────────────────────────────────────
async function enter(st, w, px, opt = {}) {
  const sol = NUM(bot.input.buySol, 0.1);
  const now = bot.now();
  const w0 = await WITHIN(bot.wallet(), 3000).catch(() => null);
  if (w0 && typeof w0.sol === 'number' && w0.sol < sol + WALLET_RESERVE_SOL) {
    st.watching = st.watching.filter((y) => y.mint !== w.mint);
    st.tally.skipped += 1;
    skip(w.mint, w.sym, 'wallet', `the wallet holds ${w0.sol.toFixed(4)} SOL, under the ${sol} SOL buy plus the ${WALLET_RESERVE_SOL} SOL reserve`);
    await SAVE(st);
    await WITHIN(bot.unsubscribe(w.mint), 2000).catch(() => undefined);
    return;
  }
  const h = {
    mint: w.mint, sym: w.sym, seedPx: w.seedPx, firstPx: w.firstPx, firstAt: w.firstAt,
    fillPx: px, fillKnown: false, cost: sol, boughtAt: now, sellAt: now + holdMs(opt.fin),
    hiPx: px, tries: 0, pending: true, sellingAt: 0,
    ...(opt.fin ? { phase: 'curve', entryPct: opt.entryPct ?? null } : {}),
  };
  st.watching = st.watching.filter((y) => y.mint !== w.mint);
  st.holds.push(h);
  st.hourBuys.push(now);
  await SAVE(st);

  let r;
  try {
    r = (await WITHIN(bot.buy(w.mint, sol, { lane: LANE() }), 15_000)) ?? { ok: false, landing: true, message: 'buy still landing after 15 s — adopted if it lands' };
  } catch (e) {
    r = { ok: false, message: e?.message ?? String(e) };
  }
  // Re-read: a tick may have moved the state while the order was landing.
  const st2 = await STATE();
  const h2 = st2.holds.find((x) => x.mint === w.mint);
  if (!r.ok) {
    if (!r.landing) {
      st2.holds = st2.holds.filter((x) => x.mint !== w.mint);
      st2.hourBuys.pop();
      st2.tally.skipped += 1;
      skip(w.mint, w.sym, 'buy', r.message);
      await SAVE(st2);
      await WITHIN(bot.unsubscribe(w.mint), 2000).catch(() => undefined);
    } else {
      bot.warn(`${NAME(w.sym, w.mint)}: ${r.message}`);
    }
    return;
  }
  if (h2) {
    h2.pending = false;
    h2.boughtAt = bot.now();
    // A Finisher bag that graduated while the buy was landing keeps its graduation timer.
    if (h2.phase !== 'pool') h2.sellAt = h2.boughtAt + holdMs(h2.phase === 'curve');
    if (bot.input.callouts !== false) h2.callAt = h2.boughtAt + BETWEEN(bot.input.callDelaySecs, [30, 45]) * 1000;
  }
  await SAVE(st2);
  bot.log(`bought ${sol} SOL of ${NAME(w.sym, w.mint)} at ~${R4(px)} SOL (${R3(w.seedPx ? px / w.seedPx : null)}x the seed, ${w.firstAt ? bot.now() - w.firstAt : '—'} ms after the first print): ${r.message}`);
}

/** The timed exit from the buy: v1's hold, or the Finisher's give-up age on the curve. */
function holdMs(fin) {
  return fin ? NUM(bot.input.curveMaxMins, 60) * 60_000 : NUM(bot.input.holdSecs, 180) * 1000;
}

// ── Callouts ────────────────────────────────────────────────────────────
/** A number from a range input [lo, hi], or the fallback. */
function BETWEEN(v, fallback) {
  const [lo, hi] = Array.isArray(v) && v.length === 2 ? v : fallback;
  return lo + Math.random() * Math.max(0, hi - lo);
}

const shortUsd = (v) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};

/** A line with every {value} filled, or null when one is unknown. */
function fillLine(line, vals) {
  let ok = true;
  const out = String(line).replace(/\{(\w+)\}/g, (_, k) => {
    const v = vals[k];
    if (v === null || v === undefined || v === '') { ok = false; return ''; }
    return String(v);
  });
  return ok ? out.slice(0, 280) : null;
}

/** Post the coin's callout. True when the state changed. */
async function postCall(h) {
  const px = NUM(await WITHIN(bot.price(h.mint), 2000).catch(() => null), 0);
  const usd = typeof bot.solUsd === 'function' ? NUM(await WITHIN(bot.solUsd(), 2000).catch(() => null), 0) : 0;
  // pump coins have a fixed 1,000,000,000 supply.
  const mc = px > 0 && usd > 0 ? shortUsd(px * 1e9 * usd) : null;
  const vals = { ticker: h.sym ? `$${h.sym}` : null, name: h.sym || null, mc };
  const lines = (Array.isArray(bot.input.comments) ? bot.input.comments : []).map((l) => fillLine(l, vals)).filter(Boolean);
  if (!lines.length) {
    h.callTries = (h.callTries ?? 0) + 1;
    if (h.callTries >= 3) { h.callAt = null; bot.log(`not calling ${NAME(h.sym, h.mint)}: no line has all its values known`); }
    else h.callAt = bot.now() + 10_000;
    return true;
  }
  const text = lines[Math.floor(Math.random() * lines.length)];
  let r;
  try {
    r = (await WITHIN(bot.callout(h.mint, text), 8000)) ?? { ok: false, message: 'no answer in 8 s' };
  } catch (e) {
    r = { ok: false, message: e?.message ?? String(e) };
  }
  if (r.ok) {
    h.calledAt = bot.now();
    h.calloutId = r.calloutId ?? null;
    bot.log(`called ${NAME(h.sym, h.mint)}: "${text}"${r.link ? ` — ${r.link}` : ''}${/paper/i.test(r.message ?? '') ? ' (paper: nothing posted)' : ''}`);
    return true;
  }
  h.callTries = (h.callTries ?? 0) + 1;
  if (h.callTries >= 3) { h.callAt = null; bot.warn(`gave up calling ${NAME(h.sym, h.mint)}: ${r.message}`); }
  else { h.callAt = bot.now() + 20_000; bot.log(`call on ${NAME(h.sym, h.mint)} failed (${r.message}) — retrying`); }
  return true;
}

/**
 * Sell a called coin DOWN to keepForCallUsd and hold the rest until
 * keepForCallMins after the buy. True when it handled the exit (the bag is
 * kept); false to fall through to a full sell.
 */
async function keepForCall(h, now) {
  const keepUsd = NUM(bot.input.keepForCallUsd, 0);
  const keepMins = NUM(bot.input.keepForCallMins, 0);
  const until = (h.boughtAt ?? now) + keepMins * 60_000;
  if (!(keepUsd > 0) || !(keepMins > 0) || now >= until) return false;
  const pos = ((await WITHIN(bot.positions(), 4000).catch(() => null)) ?? []).find((x) => x.mint === h.mint);
  const vSol = pos && typeof pos.costSol === 'number' && typeof pos.pnlSol === 'number' ? pos.costSol + pos.pnlSol : null;
  const usd = typeof bot.solUsd === 'function' ? NUM(await WITHIN(bot.solUsd(), 2000).catch(() => null), 0) : 0;
  if (vSol === null || !(usd > 0)) return false; // cannot size it: sell all, as before
  const vUsd = vSol * usd;
  const pct = Math.floor(100 * (1 - keepUsd / vUsd));
  const st = await STATE();
  const hs = st.holds.find((x) => x.mint === h.mint);
  if (!hs) return false;
  if (pct >= 10) {
    let r;
    try {
      r = (await WITHIN(bot.sell(h.mint, pct), 15_000)) ?? { ok: false, message: 'sell still landing after 15 s' };
    } catch (e) {
      r = { ok: false, message: e?.message ?? String(e) };
    }
    if (!r.ok) {
      hs.sellingAt = 0;
      await SAVE(st);
      bot.log(`partial sell on ${NAME(h.sym, h.mint)} failed (${r.message}) — selling it all next pass`);
      hs.keepPhase = true; // do not try the partial again
      hs.sellAt = now;
      await SAVE(st);
      return true;
    }
    if (typeof r.realizedSol === 'number' && Number.isFinite(r.realizedSol)) hs.partialRealized = NUM(hs.partialRealized, 0) + r.realizedSol;
    bot.log(`sold ${pct}% of ${NAME(h.sym, h.mint)}, keeping ~$${keepUsd} so the call stays up until +${keepMins} min`);
  } else {
    bot.log(`keeping all of ${NAME(h.sym, h.mint)} (~$${vUsd.toFixed(2)}) so the call stays up until +${keepMins} min`);
  }
  hs.keepPhase = true;
  hs.sellAt = until;
  hs.sellingAt = 0;
  await SAVE(st);
  return true;
}

// ── The sell ────────────────────────────────────────────────────────────
async function exit(st, h, how, px) {
  const now = bot.now();
  if (h.sellingAt && now - h.sellingAt < SELL_LOCK_MS) { await bot.setState(st); return; }
  h.sellingAt = now;
  await bot.setState(st);
  // A call went out and should stay on the feed: sell DOWN to the kept bag,
  // not to zero, and end it at keepForCallMins. Never after a creator sell.
  if (h.calledAt && !h.keepPhase && how !== 'devsell' && (await keepForCall(h, now))) return;
  // The call has not gone out yet: it never will on a sold bag.
  if (!h.calledAt) h.callAt = null;
  let r;
  try {
    const lane = how === 'grad' || how === 'time' || how === 'curve-time' ? LANE() : 'fast';
    r = (await WITHIN(bot.sell(h.mint, { pct: 100, lane }), 15_000)) ?? { ok: false, message: 'sell still landing after 15 s' };
  } catch (e) {
    r = { ok: false, message: e?.message ?? String(e) };
  }
  const st2 = await STATE();
  const h2 = st2.holds.find((x) => x.mint === h.mint) ?? h;
  if (!r.ok) {
    h2.tries = (h2.tries ?? 0) + 1;
    h2.sellingAt = 0;
    if (h2.tries >= MAX_SELL_TRIES) {
      bot.error(`${NAME(h.sym, h.mint)}: sell failed ${h2.tries} times (${r.message}) — giving up; the bag is still in the wallet`);
      st2.holds = st2.holds.filter((x) => x.mint !== h.mint);
      await SAVE(st2);
      await WITHIN(bot.unsubscribe(h.mint), 2000).catch(() => undefined);
    } else {
      bot.warn(`${NAME(h.sym, h.mint)}: sell (${how}) failed, try ${h2.tries}/${MAX_SELL_TRIES}: ${r.message}`);
      await SAVE(st2);
    }
    return;
  }
  const realizedLast = typeof r.realizedSol === 'number' && Number.isFinite(r.realizedSol) ? r.realizedSol : null;
  const realized = realizedLast === null ? null : realizedLast + NUM(h2.partialRealized, 0);
  const ret = realized !== null && h2.cost > 0 ? realized / h2.cost : null;
  const secs = Math.round((now - (h2.boughtAt ?? now)) / 1000);
  st2.holds = st2.holds.filter((x) => x.mint !== h.mint);
  st2.tally.trades += 1;
  if (ret !== null) {
    st2.tally.rets.push(R3(ret));
    if (ret > 0) st2.tally.wins += 1;
    st2.tally.netSol += realized;
  }
  await SAVE(st2);
  await WITHIN(bot.unsubscribe(h.mint), 2000).catch(() => undefined);
  logRow('GRAD ', {
    mint: h.mint, sym: h2.sym, how, secs,
    mode: h2.phase ? 'fin' : 'v1', entryPct: h2.entryPct ?? null,
    compMs: h2.compAt ? now - h2.compAt : null,
    curveMs: h2.compAt && h2.boughtAt ? h2.compAt - h2.boughtAt : null,
    seed: R4(h2.seedPx), first: R4(h2.firstPx), fill: R4(h2.fillPx), exit: R4(px),
    xFirst: h2.seedPx && h2.firstPx ? R3(h2.firstPx / h2.seedPx) : null,
    xFill: h2.seedPx && h2.fillPx ? R3(h2.fillPx / h2.seedPx) : null,
    xExit: h2.fillPx && px ? R3(px / h2.fillPx) : null,
    hi: h2.fillPx && h2.hiPx ? R3(h2.hiPx / h2.fillPx) : null,
    lagMs: h2.firstAt && h2.boughtAt ? h2.boughtAt - h2.firstAt : null,
    fillKnown: h2.fillKnown === true ? 1 : 0,
    called: h2.calledAt ? 1 : 0,
    kept: h2.keepPhase ? 1 : 0,
    cost: R4(h2.cost), realized: R4(realized), ret: R3(ret),
  });
  bot.log(`sold ${NAME(h2.sym, h.mint)} (${how}) after ${secs} s: ${realized === null ? r.message : `${realized >= 0 ? '+' : ''}${realized.toFixed(4)} SOL (${PCT(ret)})`}`);
  await post({
    title: `${h2.sym ?? h.mint.slice(0, 6)} — ${how} after ${secs} s: ${PCT(ret)}`,
    url: `https://pump.fun/coin/${h.mint}`,
    color: ret === null ? 0x888888 : ret >= 0 ? 0x2ecc71 : 0xe74c3c,
    fields: [
      { name: 'Fill / seed', value: h2.seedPx && h2.fillPx ? `${R3(h2.fillPx / h2.seedPx)}x` : '—', inline: true },
      { name: 'Exit / fill', value: h2.fillPx && px ? `${R3(px / h2.fillPx)}x` : '—', inline: true },
      { name: 'Realized', value: realized === null ? '—' : `${realized >= 0 ? '+' : ''}${realized.toFixed(4)} SOL`, inline: true },
    ],
    footer: 'Graduation Scalper — one trade, not a forecast. Not financial advice.',
  });
}

// ── 5. The creator sold ─────────────────────────────────────────────────
bot.on('devSell', async (t) => {
  if (bot.input.sellOnDevSell === false || !t?.mint) return;
  const st = await STATE();
  const h = st.holds.find((x) => x.mint === t.mint);
  if (!h || h.pending) return;
  bot.warn(`${NAME(h.sym, h.mint)}: the creator sold — selling`);
  await exit(st, h, 'devsell', NUM(t.priceSol, h.fillPx));
});

bot.on('fill', (f) => {
  if (f && f.ok === false) bot.warn(`fill failed: ${f.side} ${f.mint}`);
});

// ── Every 5 s: timers, delayed entries, adopted fills, housekeeping ─────
bot.every(5, async () => {
  const started = bot.now();
  const st = await STATE();
  let touched = false;

  // Watches that never saw a print, and delayed entries that are due.
  for (const w of [...st.watching]) {
    if (bot.now() - started > PASS_BUDGET_MS) break;
    if (w.firstPx === null && started >= w.deadline) {
      st.watching = st.watching.filter((y) => y.mint !== w.mint);
      st.tally.skipped += 1;
      skip(w.mint, w.sym, 'no-print', `no pool print within ${NUM(bot.input.waitForPoolSecs, 30)} s of the migration`);
      touched = true;
      await WITHIN(bot.unsubscribe(w.mint), 2000).catch(() => undefined);
      continue;
    }
    if (w.buyAt !== null && started >= w.buyAt) {
      const px = NUM(await WITHIN(bot.price(w.mint), 2000).catch(() => null), 0);
      if (!(px > 0)) continue;
      await enter(st, w, px);
      return; // enter() saved; the next pass picks up the rest
    }
  }

  // Held bags: adopt the real fill price, drop buys that never landed, time out.
  let positions = null;
  const needPositions = st.holds.some((h) => h.pending || !h.fillKnown);
  if (needPositions) positions = (await WITHIN(bot.positions(), 4000).catch(() => null)) ?? null;
  for (const h of [...st.holds]) {
    if (bot.now() - started > PASS_BUDGET_MS) break;
    const pos = Array.isArray(positions) ? positions.find((p) => p.mint === h.mint) : undefined;
    if (h.pending) {
      if (pos) {
        h.pending = false;
        h.boughtAt = h.boughtAt ?? started;
        if (h.phase !== 'pool') h.sellAt = h.boughtAt + holdMs(h.phase === 'curve');
        touched = true;
        bot.log(`${NAME(h.sym, h.mint)}: the buy landed (adopted)`);
      } else if (Array.isArray(positions) && started - h.boughtAt > PENDING_GRACE_MS) {
        st.holds = st.holds.filter((x) => x.mint !== h.mint);
        st.tally.skipped += 1;
        skip(h.mint, h.sym, 'never-landed', `no position listed ${Math.round(PENDING_GRACE_MS / 1000)} s after the buy`);
        touched = true;
        await WITHIN(bot.unsubscribe(h.mint), 2000).catch(() => undefined);
        continue;
      } else continue;
    }
    if (!h.fillKnown && pos) {
      const e = NUM(pos.entryPriceSol, 0);
      if (e > 0) { h.fillPx = e; h.fillKnown = true; touched = true; }
      const c = NUM(pos.costSol, 0);
      if (c > 0) { h.cost = c; touched = true; }
      if (h.fillKnown && h.firstPx) bot.log(`${NAME(h.sym, h.mint)}: filled at ${R4(h.fillPx)} SOL (${R3(h.fillPx / h.firstPx)}x the first print)`);
    }
    if (h.callAt && !h.calledAt && started >= h.callAt && started < h.sellAt && !h.sellingAt) {
      touched = (await postCall(h)) || touched;
    }
    if (started >= h.sellAt) {
      const px = NUM(await WITHIN(bot.price(h.mint), 2000).catch(() => null), h.fillPx);
      await exit(st, h, h.keepPhase ? 'keep-end' : h.phase === 'pool' ? 'grad' : h.phase === 'curve' ? 'curve-time' : 'time', px);
      return; // exit() saved
    }
  }

  if (touched) await SAVE(st);
  else paint(st);
});

// ── Start: pick up what a restart left ──────────────────────────────────
{
  const st = await STATE();
  for (const x of [...st.watching, ...st.holds]) await WITHIN(bot.subscribe(x.mint), 2000).catch(() => undefined);
  try {
    const list = (await WITHIN(bot.runners(), 3000)) ?? null;
    if (Array.isArray(list)) for (const r of list) noteFlag(r?.mint);
  } catch { /* the list is optional */ }
  paint(st);
  bot.log(`Graduation Scalper up (${FINISHER() ? `Finisher: buy at ${NUM(bot.input.curveEntryPct, 95)}% curve, sell ${NUM(bot.input.sellAfterGradSecs, 8)} s after it completes, stop -${NUM(bot.input.curveStopPct, 20)}%` : 'v1: pool first print'}, ${LANE()} lane): ${bot.input.which}, ${NUM(bot.input.buySol, 0.1)} SOL a trade, take ${NUM(bot.input.takeProfitX, 1.2)}x or sell at ${NUM(bot.input.holdSecs, 180)} s${NUM(bot.input.stopLossPct, 0) > 0 ? `, stop -${bot.input.stopLossPct}%` : ', no stop'}; ${st.holds.length} held, ${st.watching.length} awaited`);
}
