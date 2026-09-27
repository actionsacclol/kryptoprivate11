// Callout Farm — call flagged runners once they have PROVED they are running.
//
// Youtube Guide: https://www.youtube.com/watch?v=WBaRjgaLLgo
//
// This will on average breakeven or lose slightly, where we win is callout rewards
//
// The cycle per coin:
//   1. scanner flags a runner
//   2. flag-time filters (classic curve, creator <= 10 launches, creator not sold)
//   3. watch it for up to watchMins
//   4. confirm: >= 10 min after the flag, market cap >= $25k, 2 rising minute closes
//   5. buy a tiny bag (pump needs you holding >= $1 to call) and queue the callout
//   6. callout goes out 30-45 s later, then an update
//   7. sell at the take-profit or the timer — or at once if the creator sells
//
//
// The cycle per coin:
//   1. scanner flags a runner
//   2. filters it
//   3. buy
//   4. queue callout
//   5. callout goes out
//   6. update callout
//   7. sell after hold period — or at once if the creator sells (v2.2)
//
//
// DISCORD: set a webhook in the settings and each callout is posted there as
// an embed linking to the callout on pump.fun, and each update that goes out
// is posted as a reply link. An update only goes out while the callout still
// exists — i.e. the stop has not fired.
//

/* @inputs
{
  "curve": {
    "type": "select",
    "label": "Curve",
    "options": ["classic only", "any"],
    "default": "classic only",
    "help": "'mixed' is pump's mayhem mode (39/39 checked on-chain). Its 10x scores were wash trades with 2-4 holders that Jupiter marks unsellable. The mayhem rule skips them whatever this says."
  },

  "minOddsPct": {
    "type": "number",
    "label": "Minimum graduation odds (%)",
    "default": 0,
    "min": 0,
    "max": 100,
    "help": "The flag's own bucket rate: how many launches that looked like this one finished the curve. Buckets read about 9-11, 15 and 17-20. 0 = off."
  },

  "maxCurvePct": {
    "type": "number",
    "label": "Skip if the curve is already this full (%)",
    "default": 100,
    "min": 1,
    "max": 100,
    "help": "SOL-side curve fill at the flag. Rug share (low<0.3x) on 575 flags: <10% 3%, 10-20 6%, 20-30 25%, 30-40 38%, 40+ 81%. 100 = off; unknown is skipped below 100."
  },

  "minBuyers": {
    "type": "number",
    "label": "Minimum unique buyers",
    "default": 0,
    "min": 0,
    "max": 5000
  },

  "minMcUsd": {
    "type": "number",
    "label": "Minimum market cap (USD)",
    "default": 0,
    "min": 0,
    "max": 100000000,
    "step": 1000,
    "help": "0 = off. Was 12000 with the max at 7000, which passed nothing (09-26). Bigger caps at the flag rug MORE, so a floor only removes the safer coins."
  },

  "maxMcUsd": {
    "type": "number",
    "label": "Maximum market cap (USD)",
    "default": 0,
    "min": 0,
    "max": 100000000,
    "step": 500,
    "help": "At the FLAG. 0 = off (default here: the confirmation rule was measured on every classic flag; a flag-time cap only removes coins it could confirm)."
  },

  "minKryptScore": {
    "type": "number",
    "label": "Minimum Krypt score",
    "default": 0,
    "min": 0,
    "max": 100,
    "help": "0 = no floor, and no market lookup for it. Reads 68 on nearly every fresh coin (the winners too), so it does not separate them. Unknown never passes once a floor is set."
  },

  "maxDevLaunches": {
    "type": "number",
    "label": "Skip if the creator has launched more than this many coins",
    "default": 10,
    "min": 0,
    "max": 100000,
    "help": "The creator's launch count (bot.creator), looked up at the flag. 09-24: 17 of 18 losers came from creators with 24-5,376 launches, the winner 6. 0 = off. Unknown never passes."
  },

  "skipIfDevSold": {
    "type": "toggle",
    "label": "Skip if the creator has already sold",
    "default": true,
    "help": "Checked at the flag and again right before the buy. A creator selling inside the first two minutes is the rug starting."
  },

  "sellOnDevSell": {
    "type": "toggle",
    "label": "Sell everything if the creator sells while holding",
    "default": true,
    "help": "A creator selling in the first minutes is usually the rug starting (c0mputer10, 09-26: sold 59 s after the flag). Sells 100% at once, no call. Unknown never triggers it."
  },

  "links": {
    "type": "select",
    "label": "Links required",
    "options": ["X and website", "X only", "X or website", "none"],
    "default": "none",
    "help": "A website counts only when it is a homepage (bare domain or one short path) on a host that is not a social, chart, launchpad or search site. Most pump coins link X and no site."
  },

  "xOwnAccount": {
    "type": "toggle",
    "label": "X link must be the coin's own account",
    "default": true,
    "help": "The X handle must contain the ticker or a word of the name (yourdotagent for .agent). Catches borrowed posts (WatcherGuru, strangers). Only when X is what makes the coin pass."
  },

  "buySol": {
    "type": "range",
    "label": "Buy size (SOL)",
    "default": [0.013, 0.02],
    "min": 0.001,
    "max": 5,
    "step": 0.001,
    "help": "A fresh draw per buy (~$2-3). Bigger adds no callout benefit and scales the bleed. It must clear pump's $1 floor so the call can post."
  },

  "takeProfits": {
    "type": "toggle",
    "label": "Take profits on the way up",
    "default": true,
    "help": "Take-profit orders: 2x sells half, 4x half of the rest. The last ~25% is a moonbag left riding ONLY after a rung really filled (v2 fix). Off = the timed exit sells everything."
  },

  "stopLossPct": {
    "type": "number",
    "label": "Stop loss (% down from the buy)",
    "default": 0,
    "min": 0,
    "max": 95,
    "help": "0 = no stop. Placed once the app lists the position. A one-candle rug gaps through it (09-24: a 60% stop filled at -63% to -97%). A stop that fires before the call cancels the call."
  },

  "holdMins": {
    "type": "range",
    "label": "Hold for (minutes), then sell",
    "default": [5,5],
    "min": 1,
    "max": 10080,
    "step": 1,
    "help": "Timed exit after the buy. Measured on 148 confirmed calls: 2x take-profit else sell at 5 min lost least (-5% before the fixed priority fee); holding 30-60 min lost 15-26%."
  },

  "watchMins": {
    "type": "number",
    "label": "Watch each flag for (minutes)",
    "default": 60,
    "min": 1,
    "max": 120,
    "help": "After the flag the coin is watched this long; the call + buy happen the first minute the rule below holds. Not confirmed by then = never called."
  },

  "confirmMinAgeMins": {
    "type": "number",
    "label": "Confirm no earlier than (minutes after the flag)",
    "default": 10,
    "min": 1,
    "max": 120,
    "help": "Most flags rug inside the first minutes; waiting lets them. Counted in whole minutes from the flag."
  },

  "confirmMinX": {
    "type": "number",
    "label": "Confirm when price is at least this multiple of the flag",
    "default": 0,
    "min": 0,
    "max": 100,
    "step": 0.1,
    "help": "Minute close over the flag price. 0 = off."
  },

  "confirmMinMcUsd": {
    "type": "number",
    "label": "Confirm when market cap is at least (USD)",
    "default": 25000,
    "min": 0,
    "max": 100000000,
    "step": 1000,
    "help": "Minute close x the coin's cap per price at the flag. 0 = off. Unknown cap never confirms while this is set."
  },

  "confirmMaxDrawdownPct": {
    "type": "number",
    "label": "Confirm only within this far of its high (%)",
    "default": 100,
    "min": 1,
    "max": 100,
    "help": "Minute close vs the highest minute close since the flag. 100 = off."
  },

  "confirmRisingMins": {
    "type": "number",
    "label": "Confirm only after this many rising minutes in a row",
    "default": 2,
    "min": 0,
    "max": 5,
    "help": "Each of the last N minute closes above the one before. 0 = off."
  },

  "maxWatching": {
    "type": "number",
    "label": "Most flags watched at once",
    "default": 25,
    "min": 1,
    "max": 40,
    "help": "Each watched coin is a price subscription (the app allows 50 per script). When full, the watched coin furthest under its flag price is dropped."
  },

"comments": {
  "type": "lines",
  "label": "Callout lines",
  "default": [
    "{ticker} at {mc} with {buyers} buyers so far",
    "{buyers} buyers on {ticker} in the first couple minutes",
    "{name} holding {mc} after the first push",
    "grabbed some {ticker} around {mc}",
    "{ticker} has {holders} holders already",
    "in {ticker} at {mc}, chart has been steady",
    "{name} buyers keep stepping in, {buyers} so far",
    "took a small bag of {ticker}",
    "{ticker} bounced and held, sitting at {mc}",
    "{holders} holders on {name} this early",
    "{ticker} volume picking up, {buyers} buyers in",
    "small position in {name} at {mc}",
    "{ticker} dip got bought fast",
    "watching {ticker} at {mc}, liking how it holds",
    "{name} at {price} right now",
    "{ticker} with {liq} in the pool so far",
    "bought {ticker}, {buyers} others did too",
    "{name} got {buyers} buyers before most people saw it",
    "{ticker} sitting at {mc} with {holders} holders",
    "{ticker} chart is clean so far, {mc}",
    "got into {name}, will update",
    "{ticker} keeps printing higher lows",
    "{buyers} unique buyers on {ticker} already",
    "{name} climbing, {mc} now",
    "{ticker} is one of the few holding its bid rn",
    "entered {ticker} at {mc}",
    "{holders} holders and counting on {ticker}",
    "{name} flow looks solid, {buyers} buyers",
    "{ticker} sellers getting absorbed",
    "early bag in {name}",
    "{ticker} mc {mc}, buyers still coming",
    "{name} on the curve at {mc}",
    "{ticker} at {price}, in",
    "{buyers} buyers and {holders} holders on {ticker}",
    "{name} pulled back and got bought again",
    "taking a shot on {ticker} at {mc}",
    "{ticker}: {buyers} buyers, {mc} mc",
    "{name} is getting steady buys",
    "{ticker} looks healthy for its age",
    "added {ticker} to the bag",
    "{name} at {mc} with {liq} liquidity",
    "{ticker} holders growing, {holders} now",
    "{ticker} strong start, {mc}",
    "{name} buyers outpacing sellers so far",
    "{ticker} at {mc}, let's see",
    "in {name} early",
    "{ticker} has had {buyers} buyers so far",
    "{name} steady climb to {mc}",
    "{ticker} got my attention at {mc}",
    "{holders} holders on {ticker} before most saw it",
    "{ticker} sitting around {mc}, watching the flow here",
    "{name} picked up {buyers} buyers pretty quickly",
    "took a small entry on {ticker} near {mc}",
    "{ticker} holding up after the first move",
    "{name} has {holders} holders so far",
    "keeping an eye on {ticker}, currently around {mc}",
    "{buyers} buyers have stepped into {name} already",
    "grabbed a little {ticker}, seeing where it goes",
    "{ticker} pulled back but buyers showed up again",
    "{name} sitting near {mc} right now",
    "{ticker} has been holding its range pretty well",
    "small bag on {name}, entry around {mc}",
    "{holders} holders on {ticker} so far",
    "{ticker} getting consistent buys here",
    "{name} currently trading around {price}",
    "{ticker} has about {liq} liquidity at the moment",
    "took an entry on {ticker} after that pullback",
    "{name} already seeing {buyers} buyers",
    "{ticker} around {mc} with {holders} holders",
    "chart on {name} has been pretty steady so far",
    "picked up some {ticker}, will keep watching",
    "{ticker} making slightly higher lows here",
    "{name} has reached {buyers} unique buyers",
    "{ticker} moved up to around {mc}",
    "watching how {name} handles this level",
    "entered {ticker} near {mc}",
    "{ticker} holder count up to {holders}",
    "{name} seeing a steady stream of buys",
    "{ticker} selling pressure getting picked up pretty well",
    "got a small position in {name}",
    "{ticker} currently at roughly {mc}",
    "{name} moving along the curve around {mc}",
    "{ticker} trading near {price} right now",
    "{buyers} buyers and {holders} holders on {name}",
    "{ticker} dipped and recovered pretty quickly",
    "taking a small shot on {name} around {mc}",
    "{ticker} currently showing {buyers} buyers at {mc}",
    "{name} has been getting regular buys",
    "{ticker} holding together nicely so far",
    "added a little {name} to the bag",
    "{ticker} at {mc} with roughly {liq} in liquidity",
    "{name} holder count is up to {holders}",
    "{ticker} started fairly strong around {mc}",
    "buyers have been more active on {name} so far",
    "watching {ticker} around the {mc} area",
    "got into {name} fairly early",
    "{ticker} has seen {buyers} buyers up to this point",
    "{name} gradually moved toward {mc}",
    "{ticker} caught my eye around {mc}",
    "{holders} holders on {name} already"
    ],
    "help": "Filled by the script with the values when the call posts (not at the buy); a line with any unknown value is never used. Only facts the script measures."
  },

"updates": {
  "type": "lines",
  "label": "Update lines",
  "optional": true,
  "default": [
    "{ticker} {mc} now, {chg} since the call",
    "update: {ticker} at {mc}, {chg} since I called it",
    "{name} {chg} since the call, {mc} now",
    "{ticker}: called at {callmc}, {mc} now ({chg})",
    "{holders} holders on {ticker} now, {chg} since the call",
    "{ticker} at {mc} ({chg} from the call)",
    "checking back on {ticker}: {mc}, {chg} since the call",
    "{name} update: {mc}, {holders} holders, {chg} since the call",
    "{ticker} {chg} from my call at {callmc}",
    "{buyers} buyers on {ticker} now, mc {mc} ({chg})",
    "{ticker} still around {mc}",
    "{name} holding up at {mc}",
    "{ticker} now sitting near {price}",
    "{holders} holders on {name} now",
    "{ticker} still getting steady buys",
    "{name} checking in at {mc}",
    "{ticker} holding the same range",
    "{buyers} buyers on {name} so far",
    "{ticker} back around {mc}",
    "still watching {name} here",
    "{ticker} holding after the pullback",
    "{name} now at {price}",
    "{ticker} liquidity sitting at {liq}",
    "still in {ticker} for now",
    "{name} buyers still coming through",
    "{ticker} printed another higher low",
    "{name} at {mc} with {holders} holders",
    "{ticker} still moving steadily",
    "{name} pushed up to {mc}",
    "{holders} holders on {ticker} now",
    "{name} holding around {mc}",
    "quick update on {ticker}: {mc}",
    "{ticker} still seeing buyers step in",
    "{name} trading at {price} now",
    "{ticker} still holding around {mc}",
    "{name} up to {holders} holders",
    "{ticker} flow staying consistent",
    "{name}: {mc} now",
    "{ticker} dip got picked up again",
    "{name} has {buyers} buyers now",
    "still holding my {ticker} bag",
    "{ticker} sitting comfortably around {mc}",
    "{name} volume still coming through",
    "{ticker} update: {mc}, {holders} holders",
    "{name} still holding near {mc}",
    "{ticker} liquidity now {liq}",
    "{name} holder count at {holders}",
    "still keeping tabs on {ticker}",
    "{name} hasn't lost {mc} yet",
    "{ticker} around {mc}, staying in",
    "{name} up to {buyers} buyers",
    "{ticker} another check: {mc}",
    "{name} still looking steady here",
    "{ticker} holding up after that dip",
    "{name} at {buyers} buyers now",
    "{ticker} currently {price}",
    "{name} still sitting around {mc}",
    "{ticker} keeping its range so far",
    "{name} now has {holders} holders",
    "back checking {ticker}, still near {mc}"
    ],
    "help": "Replies to your call. {chg} is the real change since the call and {callmc} the cap then; a coin down past the dump check gets no update. Leave empty for none."
  },

  "firstUpdateMins": {
    "type": "range",
    "label": "First update (minutes after the buy)",
    "default": [3,4],
    "min": 1,
    "max": 240,
    "step": 1
  },

  "updatesPer": {
    "type": "number",
    "label": "Updates per coin",
    "default": 1,
    "min": 0,
    "max": 20
  },

  "callDelaySecs": {
    "type": "range",
    "label": "Call this long after the buy (seconds)",
    "default": [30,45],
    "min": 30,
    "max": 600,
    "step": 5,
    "help": "The call waits, then goes out only if the coin has not dumped since the buy. The watch already confirmed the run, so the wait is short; pump removed calls made 2-17 s after a buy."
  },

  "noCallDropPct": {
    "type": "number",
    "label": "No call / update when down this far from the fill (%)",
    "default": 20,
    "min": 1,
    "max": 95,
    "help": "Measured from the position's own fill (its pnl), not the flag price. Also blocks the call 30% off the high, or once the creator sold. Would have blocked 7 of 10 past updates."
  },

  "callHook": {
    "type": "webhook",
    "label": "Discord webhook: new callouts",
    "optional": true,
    "default": "",
    "help": "Each callout is posted here with its pump.fun link. Blank = off."
  },

  "updateHook": {
    "type": "webhook",
    "label": "Discord webhook: callout updates",
    "optional": true,
    "default": "",
    "help": "Each update and take-profit is posted here. Blank = off."
  }
}
*/

// Fixed here, not in the form (the form holds 32; 31 are used). These are the
// ones nobody tunes. callDelaySecs / noCallDropPct moved back into the form
// on 09-26.
const LINK_WAIT_SECS = 6; // wait for unread X/website links, 0-10 (a handler has ~30 s in all)
const UPDATE_GAP_MINS = [5, 10]; // between further updates; only when updatesPer > 1
const DISCLOSE = true; // end the Discord call with "Not financial advice."
const NO_CALL_OFF_HIGH_PCT = 30; // no call/update this far under its high since the flag

/** Keep every pass short (fix 1). The sandbox asks at 3 s whether a handler
 *  is stuck and kills it at 30 s; a pass starts no new section after this. */
const PASS_BUDGET_MS = 15_000;
/** A sell that fails this many passes in a row is given up (fix 9). */
const MAX_SELL_TRIES = 6;
/** Below this many SOL of value a leftover is not worth a sell (fix 10):
 *  ten leftovers on 09-24/25 returned less than their own fee. */
const DUST_SOL = 0.002;
/** Two missed position reads this far apart before a bag counts as gone (fix 3). */
const MISS_GAP_MS = 60_000;
/** Mayhem / mixed coins are only re-priced this often between checkpoints. */
const NONCAND_PRICE_MS = 5 * 60_000;
/** v2.2: held bags checked for a creator sell per pass (free local reads,
 *  in parallel, each bounded); the rest are checked on later passes. */
const DEV_CHECKS_PER_PASS = 4;
let devCheckCursor = 0;


/** A line's {variables} filled from what the app knows now — the same
 *  sources the app's own fill reads. Null when any value is unknown, so a
 *  public line never goes out reading "at —". */
const shortUsd = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(0)}`;
  return `$${v.toPrecision(2)}`;
};

function fillLine(line, t) {
  const pos = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  let unknown = false;
  const out = line.replace(/[{<](\w+)[}>]/g, (whole, key) => {
    const k = key.toLowerCase();
    let v = null;
    if (k === 'ticker') v = t?.symbol || null;
    else if (k === 'name') v = t?.name || null;
    else if (k === 'mc') v = pos(t?.marketCapUsd) ? shortUsd(t.marketCapUsd) : null;
    else if (k === 'liq') v = pos(t?.liquidityUsd) ? shortUsd(t.liquidityUsd) : null;
    else if (k === 'price') v = pos(t?.priceUsd) ? `$${t.priceUsd < 0.01 ? t.priceUsd.toPrecision(2) : t.priceUsd.toFixed(t.priceUsd < 1 ? 4 : 2)}` : null;
    else if (k === 'holders') v = pos(t?.holders) ? String(Math.round(t.holders)) : null;
    else if (k === 'buyers') v = pos(t?.uniqueBuyers) ? String(Math.round(t.uniqueBuyers)) : null;
    else if (k === 'mint') v = t?.mint ? t.mint.slice(0, 8) : null;
    // Since the call (fix 11): the real change, down included.
    else if (k === 'callmc') v = pos(t?.callMc) ? shortUsd(t.callMc) : null;
    else if (k === 'chg') {
      if (pos(t?.callMc) && pos(t?.marketCapUsd)) {
        const c = Math.round((t.marketCapUsd / t.callMc - 1) * 100);
        v = c === 0 ? 'flat' : `${c > 0 ? '+' : ''}${c}%`;
      }
    }
    else return whole; // not a variable — leave it exactly as written
    if (v === null) unknown = true;
    return v ?? '';
  });
  return unknown ? null : out;
}

/** A random line, filled, from those whose values are all known. Null = none.
 *  `extra` adds what only the script knows (callMc for {chg} / {callmc}). */
async function pickLine(mint, lines, extra) {
  const t = await bot.token(mint).catch(() => null);
  const facts = t ? { ...t, ...(extra ?? {}) } : null;
  const ready = (lines ?? []).map((l) => fillLine(l, facts)).filter((l) => l);
  return ready.length ? PICK(ready) : null;
}

/**
 * Why this coin should NOT be shouted right now, or null when it looks fine.
 * {retry: true} = not known yet, ask again next pass. Free reads only.
 *
 * Fix 11: "down since the buy" is the POSITION's pnl (its real fill), falling
 * back to the flag price only when no position read answered — the flag price
 * sits ~19% under a live fill, so measuring from it hid most of the drop.
 * Fix 16: the high lives on the hold (hiPx), so it survives a restart; with
 * no high known the answer is "wait", never "fine".
 */
async function dumpReason(mint, hold, pos) {
  const px = await bot.price(mint).catch(() => null);
  if (!px) return { retry: true, why: 'price unknown' };
  const t = await bot.token(mint).catch(() => null);
  if (bot.input.skipIfDevSold !== false && t?.creatorSold === true) {
    return { why: 'the creator sold' };
  }
  const dropPct = bot.input.noCallDropPct ?? 20;
  const p = Array.isArray(pos) ? pos.find((x) => x.mint === mint) : null;
  // v2.1: measure from the PRICE read right after the fill (hold.px0) first.
  // A live position's pnlPct is against the ALL-IN cost — priority fee and the
  // token account's rent deposit included — so on a 0.016 SOL buy it reads
  // about -17% the moment the buy lands (HDL 09-26: 0.01642 SOL out, 0.01368
  // reached the curve) and a 20% gate tripped on a ~4% move.
  const px0 = hold?.px0 ?? null;
  if (px0) {
    if (px < px0 * (1 - dropPct / 100)) {
      return { why: `down ${Math.round((1 - px / px0) * 100)}% since the buy` };
    }
  } else if (p && typeof p.pnlPct === 'number') {
    // Adopted bags have no px0; all-in pnl is the only measure (it overstates
    // the drop by the fees, which errs toward NOT calling).
    if (p.pnlPct <= -dropPct) return { why: `down ${Math.round(-p.pnlPct)}% on cost (fees included)` };
  }
  const e = tracking.get(mint);
  const hiT = e?.px0 && e?.peak ? e.px0 * e.peak : null;
  const hi = Math.max(hold?.hiPx ?? 0, hiT ?? 0, px);
  if (!hold?.hiPx && !hiT) return { retry: true, why: 'its high is unknown (restart)' };
  if (px < hi * (1 - NO_CALL_OFF_HIGH_PCT / 100)) {
    return { why: `${Math.round((1 - px / hi) * 100)}% off its high` };
  }
  return null;
}

const PICK = (l) => l[Math.floor(Math.random() * l.length)];

const BETWEEN = ([lo, hi]) =>
  lo + Math.random() * (hi - lo);

const SOL = (r) =>
  Math.round(BETWEEN(r) * 10000) / 10000;

/**
 * Persist state without ever letting a failed write hurt the script.
 *
 * State is capped at 16 KB. Over the cap, bot.setState REJECTS, and a bare
 * `await bot.setState(x)` would throw straight out of the handler — which
 * (a) re-fires the action whose queue change was never saved, orphaning a
 * just-bought bag, and (b) counts toward the five-error auto-off that stops
 * the whole 30 s loop (no more timed exits -> naked bags). SAVE swallows the
 * failure: it trims the growable arrays and retries once, then gives up
 * quietly for this pass. Every setState in this script goes through it.
 */
async function SAVE(st0) {
  // No likes in this file: a like queue left in state by v2 is dropped here.
  const { likeq: _oldLikes, ...st } = st0 ?? {};
  try {
    await bot.setState(st);
    return;
  } catch (e) {
    bot.warn(`state save over the 16 KB cap (${e?.message ?? e}); trimming and retrying`);
  }
  // Fix 8: NEVER trim holds or callq — a trimmed hold is a bag with no exit.
  // Trim what can be lost: the in-flight scorecard copy, the dedupe list,
  // the scorecard totals, the released-mint list.
  try {
    await bot.setState({
      ...st,
      seen: (st.seen ?? []).slice(-20),
      rid: (st.rid ?? []).slice(-10),
      trk: undefined,
      wat: undefined,
      sc: undefined,
    });
  } catch (e2) {
    bot.warn(`state still over the limit after trimming (${e2?.message ?? e2}); not saved this pass`);
  }
}

// TAKE-PROFIT LADDER — the "bank fast, ride a moonbag" shape (2026-09-24).
//
// Real take_profit orders, armed ~30-60 s after the buy (once the app lists
// the position). They fire on the price tick, so they catch runners that HOLD
// their level and any spiker whose climb outlives that ~60 s arm delay. HONEST
// LIMIT: a coin that peaks and dumps INSIDE the first minute (before the rung
// is placed) is NOT caught — the order arms at the post-crash price.
//
//   x    = price multiple that arms the rung (2x = +100% profit).
//   sell = % of WHAT IS STILL HELD when it fires (take_profit is "% of
//          holdings"), so the rungs compound.
//
// The plan (measured 2026-09-24, after a hand-sold 14x):
//   • 2x (+100%): sell 50% of the position — banks ~1x the whole cost, so the
//     call is FREE from here and most of the money is off the table before the
//     fast-crashers (most runners peak then dump) can take it back.
//   • 4x (+300%): sell 50% of what's left = another 25% of the original —
//     locks in profit on top.
//   • the remaining ~25% is a MOONBAG that is NEVER auto-sold: the timed exit
//     leaves it riding (see the EXITS section) so a coin that goes to a
//     million-dollar cap overnight is still held. Sell it by hand if it moons.
//     It also keeps the callout alive as long as it is worth pump's $1 floor.
const TP_LADDER = [
  { x: 2, sell: 50 },
  { x: 4, sell: 50 },
];

const SHORT = (m) =>
  m.slice(0, 8);

/** "SYMBOL (full mint)" for log lines, so a coin can be pasted straight from the log. */
const NAME = (sym, mint) =>
  sym ? `${sym} (${mint})` : mint;

const USD = (n) =>
  n === null || n === undefined
    ? '—'
    : n >= 1e6
      ? `$${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `$${(n / 1e3).toFixed(1)}k`
        : `$${Math.round(n)}`;

/**
 * Post to one of the Discord webhooks in the settings, if it is set. Never
 * throws and never blocks the money path: a failed post is logged, dropped.
 */
async function toDiscord(field, embed) {
  if (!bot.input[field]) return null;
  try {
    const r = await WITHIN(bot.discord(field, embed), 8000);
    if (!r) {
      bot.warn('discord: no answer in 8 s — dropped');
      return null;
    }
    if (!r.ok) bot.warn(`discord: ${r.message}`);
    return r;
  } catch (e) {
    bot.warn(`discord: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Show how a call ENDED on the call itself (09-25): the Discord post is
 * edited — never deleted — to its result. A loss stays in the channel and
 * says it was a loss; a channel that only keeps its winners misleads the
 * people reading it. Needs app 5.1+ (bot.discordEdit and the message id);
 * on an older build this does nothing.
 *
 * how: 'closed' (timed exit), 'gone' (stop loss or a hand sell), 'moonbag',
 * 'devsold' (v2.2: sold because the creator sold).
 */
/** The Discord message of each call posted this run — the call's own post
 *  job may still be queued when its close is queued behind it. */
const callMsgByMint = new Map();

async function closeCall(h, how) {
  const msg = h?.callMsg ?? callMsgByMint.get(h?.mint) ?? null;
  if (!msg || !bot.input.callHook || typeof bot.discordEdit !== 'function') return;
  h = { ...h, callMsg: msg };
  try {
    const now2 = await coinFacts(h.mint);
    const x = now2.mc && h.callMc ? now2.mc / h.callMc : null;
    const mins = Math.round((bot.now() - (h.boughtAt ?? bot.now())) / 60_000);
    const up = x !== null && x >= 1;
    const label =
      how === 'moonbag' ? '🟢 Moonbag riding'
        : how === 'devsold' ? (up ? '🟡 Sold: the creator sold' : '🔴 Sold: the creator sold')
        : how === 'gone' ? (up ? '🟢 Out (stop or sold)' : '🔴 Stopped out')
          : up ? '🟢 Closed up' : '🔴 Closed down';
    const result =
      x === null
        ? 'Result unknown — the market cap could not be read.'
        : `**${x.toFixed(2)}×** since the call (${up ? '+' : ''}${Math.round((x - 1) * 100)}%) after ${mins} min.`;
    const disclose = exitLine();
    const r = await WITHIN(bot.discordEdit('callHook', h.callMsg, {
      author: { name: 'Krypto Bot · call closed', url: BOT_URL },
      title: `${label} · ${COIN(now2.name || h.name, now2.sym || h.symbol, h.mint)}`,
      url: h.link ?? `https://pump.fun/coin/${h.mint}`,
      description: [
        result,
        h.link ? `[→ The callout on pump.fun](${h.link})` : null,
        disclose ? `\n*${disclose}*` : null
      ].filter((x2) => x2 !== null).join('\n'),
      color: how === 'moonbag' || up ? 0x22c55e : 0xef4444,
      thumbnail: now2.image ? { url: now2.image } : undefined,
      fields: [
        { name: 'Called at', value: USD(h.callMc), inline: true },
        { name: 'Now', value: USD(now2.mc), inline: true },
        { name: 'Held', value: `${mins} min`, inline: true }
      ],
      footer: 'krypt.cc/bot'
    }), 8000);
    if (!r) bot.warn('discord edit: no answer in 8 s');
    else if (!r.ok) bot.warn(`discord edit: ${r.message}`);
    callMsgByMint.delete(h.mint);
  } catch (e) {
    bot.warn(`discord edit: ${e?.message ?? e}`);
  }
}

const BOT_URL = 'https://krypt.cc/bot';

/** "purple fish ($purplefish)", or whatever part of that is known. */
const COIN = (name, sym, mint) =>
  name && sym ? `${name} ($${sym})` : name || (sym ? `$${sym}` : SHORT(mint));

const NUM = (n) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US');

/** Market cap, holders and the image, fresh. One market lookup (one
 *  action); the feed's cached facts fill in when it does not answer. */
async function coinFacts(mint) {
  const m = await WITHIN(bot.market(mint), 5000);
  const t = await bot.token(mint).catch(() => null);
  return {
    mc: m?.marketCapUsd ?? t?.marketCapUsd ?? null,
    holders: m?.holders ?? t?.holders ?? null,
    image: m?.imageUrl ?? null,
    name: m?.name || t?.name || null,
    sym: m?.symbol || t?.symbol || null
  };
}

function linksField(mint, link, what) {
  return {
    name: 'Links',
    value: [
      link ? `[${what}](${link})` : null,
      `[DexScreener](https://dexscreener.com/solana/${mint})`,
      `[Krypto Bot](${BOT_URL})`
    ].filter(Boolean).join(' · '),
    inline: false
  };
}

function exitLine() {
  return DISCLOSE ? 'Not financial advice.' : null;
}

/** pump says the callout no longer exists (its spam filter removed it — 09-25). */
const CALL_GONE = (msg) =>
  /callout not found|have not called this coin/i.test(String(msg ?? ''));

/** pump temporarily restricted this account for spam. When this comes back,
 *  posting more only risks EXTENDING the restriction, so back off for a while
 *  rather than hammering a callout on every new coin. */
const SPAM_RESTRICTED = (msg) =>
  /temporarily restricted|flagged as spam|posting is.*restrict/i.test(String(msg ?? ''));

/** pump (or the app's dedupe) says this account already called the coin. */
const ALREADY_CALLED = (msg) =>
  /already (called|made|posted|have a callout)|already called that coin|one callout per/i.test(String(msg ?? ''));

/** How long to pause ALL callouts/replies after pump flags spam. */
const SPAM_PAUSE_MS = 20 * 60_000;


/**
 * Push this script's running totals and live queue depth to
 * its monitor widget. Cumulative counts live in st.counts so
 * they survive a restart; the widget itself does not.
 */
/** "3 / 10 / 25": peaked 2x within 30 min / under half at 30 min / scored. */
const SCORE_LINE = (g) =>
  g ? `${g.p2} / ${g.d} / ${g.n}` : '0 / 0 / 0';

/** Skip reasons as one short text stat (fix 14: the monitor holds 24 keys
 *  and the old layout used all 24). Biggest first, 80 chars max. */
const SKIP_ABBR = {
  mcap: 'mc', buyers: 'buy', dev: 'dev', devSold: 'sold', curveFull: 'crv',
  links: 'lnk', xOwn: 'x', score: 'ks', odds: 'odd', curve: 'mix', mayhem: 'mhm'
};
function skipLine() {
  const parts = Object.entries(skips)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${SKIP_ABBR[k] ?? k} ${n}`);
  return parts.length ? parts.join(' · ').slice(0, 80) : '—';
}

function reportStats(st) {
  const c =
    st.counts ?? {};

  bot.stats({
    'Buys / sells': `${c.buys ?? 0} / ${c.sells ?? 0}`,
    'Callouts / updates': `${c.callouts ?? 0} / ${c.updates ?? 0}`,
    'Take-profits filled': c.takeProfits ?? 0,
    'Holding': (st.holds ?? []).length,
    'Queued calls': (st.callq ?? []).length,
    'Skipped': skipLine(),
    'Stopped / gone': c.stops ?? 0,
    'Sold: creator sold': c.devSoldExits ?? 0,
    'Sells given up': c.sellGiveUp ?? 0,
    'Adopted bags': c.adopted ?? 0,
    'Callouts dropped (pump)': c.dropped ?? 0,
    'Not called (dumped)': c.noCall ?? 0,
    'Score bought (2x / dead / n)': SCORE_LINE(st.sc?.b),
    'Score skipped (2x / dead / n)': SCORE_LINE(st.sc?.s),
    'Tracking': tracking.size,
    'Watching / confirmed / expired': `${watchers.size} / ${c.confirmed ?? 0} / ${c.expired ?? 0}`,
    'Discord queue': discordJobs.length
  });
}

/**
 * Discord work waits here and later passes post it (fix 1): a webhook that
 * is slow must never hold the money path. In memory — a restart loses a post,
 * never a bag. At most DISCORD_PER_PASS jobs per pass, and only with time left.
 */
const discordJobs = [];
const DISCORD_PER_PASS = 2;

function queueDiscord(fn, label) {
  if (discordJobs.length >= 20) discordJobs.shift();
  discordJobs.push({ fn, label });
}

async function drainDiscord(late) {
  for (let i = 0; i < DISCORD_PER_PASS && discordJobs.length > 0; i++) {
    if (late()) return;
    const j = discordJobs.shift();
    try {
      await j.fn();
    } catch (e) {
      bot.warn(`discord (${j.label}): ${e?.message ?? e}`);
    }
  }
}


const SLEEP = (ms) =>
  new Promise((r) => setTimeout(r, ms));

/**
 * A market lookup waits in the app's shared provider queue, and a parked
 * provider can hold it far past the 30 s a handler is allowed — which is
 * what killed the runner handler. Give up after `ms` and treat it as
 * "no answer".
 */
function WITHIN(p, ms) {
  return Promise.race([
    p.catch(() => null),
    SLEEP(ms).then(() => null)
  ]);
}

/**
 * Many prices, a few at a time (2026-09-27). One pass can want 100+ prices
 * (scorecard + watch list + holds) and the app refuses a script's calls past
 * 60 a second ("dropped: ..."). Fired all at once they tripped that wall; on
 * builds without the 09-27 sandbox fix a dropped call was never answered, the pass hung
 * to the 30 s kill and the script restarted (09-26 22:16). Chunks of 15,
 * each capped at 4 s; a refused or slow one reads as unknown (null).
 */
async function PRICES(mints, chunk = 15) {
  const out = [];
  for (let i = 0; i < mints.length; i += chunk) {
    const part = await Promise.all(mints.slice(i, i + chunk).map((m) => WITHIN(bot.price(m), 4000)));
    out.push(...part);
  }
  return out;
}

/**
 * Why flags were skipped, counted per run and shown on the monitor, so a
 * quiet log is never a mystery again. In memory: a restart starts it over.
 */
const skips = {};

/** The reason the latest look at a coin ended, for the scorecard. */
const lastSkip = new Map();

function skip(t, why, detail) {
  skips[why] = (skips[why] ?? 0) + 1;
  lastSkip.set(t.mint, why);
  bot.log(`skipped ${NAME(t.symbol, t.mint)}: ${detail ?? why}`);
  return false;
}


/**
 * Hosts that are not a project's own website. A "website" pointing at any of
 * these (an X search, an Instagram page, a Reddit thread, the coin's own pump
 * page…) is the creator filling the box, not a site — it counts as NONE.
 * Matched on the host and every subdomain of it.
 */
const NOT_A_SITE = [
  // socials
  'x.com', 'twitter.com', 't.co', 'instagram.com', 'reddit.com', 'redd.it',
  'tiktok.com', 'youtube.com', 'youtu.be', 'facebook.com', 'fb.com',
  'threads.net', 'threads.com', 'bsky.app', 'truthsocial.com', 'twitch.tv',
  'kick.com', 'snapchat.com', 'pinterest.com', 'linkedin.com', 'tumblr.com',
  // chats
  't.me', 'telegram.me', 'telegram.org', 'discord.gg', 'discord.com', 'wa.me', 'whatsapp.com',
  // link-in-bio pages
  'linktr.ee', 'linktree.com', 'beacons.ai', 'bio.link', 'lnk.bio',
  // launchpads, charts, explorers, terminals
  'pump.fun', 'dexscreener.com', 'dextools.io', 'birdeye.so', 'solscan.io',
  'solana.fm', 'gmgn.ai', 'axiom.trade', 'photon-sol.tinyastro.io', 'bullx.io',
  'jup.ag', 'raydium.io', 'letsbonk.fun', 'bonk.fun', 'moonshot.money', 'stonkfun.xyz',
  // search, wikis, memes
  'google.com', 'bing.com', 'wikipedia.org', 'knowyourmeme.com', 'imgur.com', 'giphy.com',
  'urbandictionary.com',
];

/**
 * true = a real site, false = a social/search/chart page or not a homepage,
 * null = no address known.
 *
 * A project's site is its homepage: a bare domain or one short path segment
 * (/, /home, /en). A deep path or a query string is somebody's article or a
 * launchpad's token page — MEMELESS linked a news story, KIM a stonkfun
 * token page, goonette an Urban Dictionary entry (09-24).
 */
function realSite(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return false; // not even a URL
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (NOT_A_SITE.some((d) => host === d || host.endsWith('.' + d))) return false;
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length > 1) return false;
  if (segs.length === 1 && segs[0].length > 20) return false;
  if (u.search && u.search.length > 1) return false;
  return true;
}

/**
 * The website side: true = a real site, false = none (or a fake one),
 * null = not known yet. The app says a website EXISTS before it has the
 * address, so "exists, address unknown" is still unknown.
 */
function siteVerdict(t) {
  if (t.hasWebsite === false) return false;
  if (t.hasWebsite !== true) return null;
  return realSite(t.website);
}

function linksVerdict(t) {
  const mode =
    bot.input.links ?? 'X and website';

  const x = t.hasTwitter;
  const w = siteVerdict(t);

  if (mode === 'none') return true;

  if (mode === 'X only') {
    return x === true ? true : x === false ? false : null;
  }

  if (mode === 'X or website') {
    if (x === true || w === true) return true;
    if (x === false && w === false) return false;
    return null;
  }

  // X and website
  if (x === false || w === false) return false;
  if (x === true && w === true) return true;
  return null;
}


/** The handle an X link names, or null (a search, a community, not X). */
function xHandleOf(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^(www|mobile)\./, '');
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (!seg || /^(i|search|home|intent|hashtag|explore|communities)$/i.test(seg)) return null;
    return seg;
  } catch {
    return null;
  }
}

const NORM = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Words too common to tie a handle to a coin. */
const FILLER = new Set([
  'the', 'coin', 'token', 'official', 'sol', 'solana', 'pump', 'fun', 'inu',
  'and', 'app', 'meme', 'real', 'new', 'dog', 'cat'
]);

/**
 * Is the X link the coin's OWN account? Its handle must contain the ticker
 * or a word of the name (yourdotagent ↔ .agent, usephosphor ↔ PHOSPHOR), or
 * be contained in them. A post by WatcherGuru or a stranger is not.
 */
function xIsOwn(url, sym, name) {
  const h = NORM(xHandleOf(url));
  if (!h) return false;
  const words = [sym, ...String(name ?? '').split(/[\s\-_.]+/)]
    .map(NORM)
    .filter((w) => w.length >= 3 && !FILLER.has(w));
  if (words.some((w) => h.includes(w))) return true;
  return h.length >= 4 && NORM(`${name ?? ''}${sym ?? ''}`).includes(h);
}

/** Does the X rule apply to this coin under the chosen links mode? */
function xRuleApplies(t) {
  if (bot.input.xOwnAccount === false) return false;
  const mode = bot.input.links ?? 'X and website';
  if (mode === 'X and website' || mode === 'X only') return true;
  // "X or website": only when X is what carries it (no real site).
  if (mode === 'X or website') return siteVerdict(t) !== true;
  return false;
}


/** The creator's launch count, started early so it runs alongside the market
 *  lookup. Resolves to { n, truncated } or null (unknown). One per coin. */
const devLookups = new Map();

/**
 * Launches by this creator in the 24 h before this coin, as far as the
 * record can PROVE it: bot.creator carries only the first and last launch
 * times, so this is a floor — 0 when this is the creator's only launch,
 * >= 1 when an earlier launch is known to fall inside 24 h, and null
 * (unknown) otherwise. Never a guess of 0.
 */
function recent24h(c, createdAt) {
  if (!c || typeof c.launches !== 'number') return null;
  if (c.launches <= 1) return 0;
  const since = createdAt - 24 * 3600_000;
  const prior = c.launches - 1;
  if (typeof c.firstLaunchAt === 'number' && c.firstLaunchAt >= since && c.firstLaunchAt < createdAt - 60_000) return prior;
  if (typeof c.lastLaunchAt === 'number' && c.lastLaunchAt >= since && c.lastLaunchAt < createdAt - 60_000) return 1;
  return null;
}

/** Fix 7: started at the flag (for the SCORE row) whatever the dev rule is
 *  set to, and a null answer is NOT cached, so a later flag asks again. */
function devLookup(mint, createdAt) {
  if (typeof bot.creator !== 'function') return Promise.resolve(null);
  if (!devLookups.has(mint)) {
    const made = createdAt ?? bot.now();
    const p = WITHIN(bot.creator(mint), 8000).then((c) => {
      if (!c || typeof c.launches !== 'number') {
        devLookups.delete(mint);
        return null;
      }
      const d = {
        n: c.launches,
        truncated: !!c.truncated,
        grads: typeof c.graduated === 'number' ? c.graduated : null,
        d24: recent24h(c, made)
      };
      scoreNote(mint, { dev: d.n, devGrads: d.grads, d24: d.d24 });
      return d;
    });
    devLookups.set(mint, p);
    // Keep the map small — a flag re-fires at +60/+120 s, never later.
    if (devLookups.size > 80) devLookups.delete(devLookups.keys().next().value);
  }
  return devLookups.get(mint);
}

let warnedNoCreator = false;

/** When the coin was created, from its age at the flag (ms). */
const createdAtOf = (t) =>
  typeof t?.ageSec === 'number' ? bot.now() - t.ageSec * 1000 : bot.now();


/**
 * Everything except links and the creator record.
 *
 * False means skip permanently.
 */
async function passesFilters(t) {

  // Classic curves only when configured.
  if (
    bot.input.curve === 'classic only' &&
    t.curveRegime !== 'classic'
  ) {
    return skip(t, 'curve', `${t.curveRegime ?? 'unknown'} curve`);
  }

  // Mayhem coins excluded.
  if (t.isMayhem !== false) {
    return skip(t, 'mayhem', t.isMayhem ? 'mayhem coin' : 'mayhem unknown');
  }

  // The creator already sold: the rug is starting.
  if (bot.input.skipIfDevSold !== false && t.creatorSold === true) {
    scoreNote(t.mint, { devSold: true });
    return skip(t, 'devSold', 'creator already sold');
  }

  // Nearly sold out = buying the migration top. Unknown never passes a set ceiling.
  const maxCurve = bot.input.maxCurvePct ?? 100;
  if (maxCurve < 100) {
    const cp = t.curvePct;
    if (cp === null || cp === undefined) {
      return skip(t, 'curveFull', 'curve progress unknown');
    }
    if (cp >= maxCurve) {
      return skip(t, 'curveFull', `curve ${cp.toFixed(0)}% full >= ${maxCurve}%`);
    }
  }

  // Graduation odds: the flag's own bucket rate. Free — it rides on the flag.
  if (
    bot.input.minOddsPct > 0 &&
    (
      t.runnerOddsPct === null ||
      t.runnerOddsPct === undefined ||
      t.runnerOddsPct < bot.input.minOddsPct
    )
  ) {
    return skip(t, 'odds', `odds ${t.runnerOddsPct == null ? 'unknown' : t.runnerOddsPct.toFixed(1) + '%'} < ${bot.input.minOddsPct}%`);
  }

  // Buyer minimum.
  if (
    (t.uniqueBuyers ?? 0) <
    bot.input.minBuyers
  ) {
    return skip(t, 'buyers', `${t.uniqueBuyers ?? 0} buyers < ${bot.input.minBuyers}`);
  }

  // The creator lookup already started at the flag (scoreStart); this only
  // re-asks when that answer was null.
  devLookup(t.mint, createdAtOf(t));

  // MC and Krypt score both come off the same market lookup — fetch it
  // once when either is still unknown, rather than round-tripping twice.
  let mc = t.marketCapUsd;
  let kscore = t.kryptScore;

  const needMarket =
    mc === null ||
    mc === undefined ||
    (
      bot.input.minKryptScore > 0 &&
      (
        kscore === null ||
        kscore === undefined
      )
    );

  if (needMarket) {
    // A refusal (rate limit) is "no answer", not an error — five errors in
    // a row would switch the script off.
    const m =
      await WITHIN(bot.market(t.mint), 6000);

    if (
      mc === null ||
      mc === undefined
    ) {
      mc =
        m?.marketCapUsd ??
        null;
    }

    if (
      kscore === null ||
      kscore === undefined
    ) {
      kscore =
        m?.kryptScore ??
        null;
    }
  }

  scoreNote(t.mint, { mc0: mc });

  if (
    mc === null ||
    mc < bot.input.minMcUsd
  ) {
    return skip(t, 'mcap', mc === null ? 'market cap unknown' : `mc $${Math.round(mc)} < $${bot.input.minMcUsd}`);
  }

  // Ceiling (09-26): a flag that is already big ran before the flag fired.
  if (bot.input.maxMcUsd > 0 && mc >= bot.input.maxMcUsd) {
    return skip(t, 'mcap', `mc $${Math.round(mc)} >= max $${bot.input.maxMcUsd}`);
  }

  // Krypt score floor. Off at 0 (the default); unknown never passes once
  // the user has asked for a floor above zero.
  if (
    bot.input.minKryptScore > 0 &&
    (
      kscore === null ||
      kscore < bot.input.minKryptScore
    )
  ) {
    return skip(t, 'score', kscore === null ? 'Krypt score unknown' : `score ${kscore} < ${bot.input.minKryptScore}`);
  }

  t.marketCapUsd = mc;
  t.kryptScore = kscore;

  return true;
}


/**
 * The creator's record: skip a serial launcher. Unknown never passes while
 * the rule is on — except on an app build without bot.creator, where it is
 * waved through once with a warning rather than blocking every coin.
 */
async function passesDev(t) {
  const max = bot.input.maxDevLaunches ?? 0;
  if (max <= 0) return true;
  if (typeof bot.creator !== 'function') {
    if (!warnedNoCreator) {
      warnedNoCreator = true;
      bot.warn('this app build has no bot.creator — the serial-dev rule is OFF');
    }
    return true;
  }
  const d = await devLookup(t.mint, createdAtOf(t));
  if (!d) return skip(t, 'dev', 'creator record unknown');
  if (d.n > max) {
    return skip(t, 'dev', `creator has ${d.n}${d.truncated ? '+' : ''} launches > ${max}`);
  }
  return true;
}


/**
 * Buy, then queue the callout/update/exit.
 *
 * Fix 2: a PENDING hold is saved BEFORE bot.buy. If the handler is killed
 * while the order lands, the bag still has a hold (timed exit, stop) — the
 * next pass promotes it once the position shows, or drops it after
 * PENDING_MS when nothing arrived. Before this a kill between the buy and
 * the save left a bag nothing would ever sell.
 */
const PENDING_MS = 3 * 60_000;

async function enter(t) {

  const sol =
    SOL(bot.input.buySol);

  const now0 =
    bot.now();

  const holdMs =
    BETWEEN(bot.input.holdMins) *
    60_000;

  {
    const st0 = await bot.getState();
    const seen0 = new Set(st0.seen ?? []);
    seen0.add(t.mint);
    await SAVE({
      ...st0,
      seen: [...seen0].slice(-40),
      holds: [
        ...(st0.holds ?? []).filter((h) => h.mint !== t.mint),
        {
          mint: t.mint,
          symbol: t.symbol || null,
          pending: true,
          boughtAt: now0,
          sellAt: now0 + holdMs,
          px0: t.priceSol ?? null,
          hiPx: t.priceSol ?? null,
          bumps: 0,
          nextBumpAt: 0
        }
      ]
    });
  }

  // A rejection (over budget, rate-limited) is a refusal, never a throw out
  // of the handler: that would count toward the five-errors auto-off.
  let r;
  try {
    r = (await WITHIN(bot.buy(t.mint, sol), 15_000)) ??
      { ok: false, landing: true, message: 'buy still landing after 15 s — the pass adopts it if it lands (no call)' };
  } catch (e) {
    r = { ok: false, message: e?.message ?? String(e) };
  }

  // Read the state AFTER the buy: the 30 s timer may have sold or posted
  // while the order was landing, and writing an older copy back would undo it.
  const st =
    await bot.getState();

  if (!r.ok) {
    bot.log(
      `skipped ${NAME(t.symbol, t.mint)}: ${r.message}`
    );

    // The buy was refused: nothing is held, so the pending hold goes —
    // unless it may still land (runner build: kept for the adopt path).
    if (r.landing) return st;
    return {
      ...st,
      holds: (st.holds ?? []).filter((h) => !(h.mint === t.mint && h.pending))
    };
  }

  const now =
    bot.now();

  const firstUpdateAt =
    now +
    BETWEEN(
      bot.input.firstUpdateMins
    ) *
    60_000;

  // The stop is NOT placed here: straight after a buy the app has not
  // registered the position yet and refuses it ("nothing held in live
  // mode") — which is how every stop went missing on 09-23. The 30 s loop
  // places it once the position shows up (section 0b).

  const dev = tracking.get(t.mint)?.dev;

  bot.log(
    `bought ${sol} SOL of ${NAME(t.symbol, t.mint)} — ${
      t.uniqueBuyers
    } buyers, ${
      Math.round(
        t.marketCapUsd ?? 0
      )
    } mc, score ${
      t.kryptScore ?? '—'
    }, creator launches ${
      dev ?? '—'
    }; ` +
    `update in ${
      Math.round(
        (firstUpdateAt - now) /
        60_000
      )
    }m, out in ${
      Math.round(
        holdMs /
        60_000
      )
    }m`
  );

  // The price right after the fill: the dump check's fallback basis and the
  // start of the high-water mark (the flag price sits ~19% under a fill).
  const pxNow = (await bot.price(t.mint).catch(() => null)) ?? t.priceSol ?? null;

  const newSt = {
    ...st,

    counts: {
      ...(st.counts ?? {}),
      buys:
        (st.counts?.buys ?? 0) + 1
    },

    callq: [
      ...(st.callq ?? []).filter((j) => j.mint !== t.mint),

      {
        mint: t.mint,
        tries: 0,
        // Wait, then check it has not dumped before shouting it (09-25):
        // FOMOFY was called 20 s after it rugged. Never under ~30 s either —
        // pump removed calls made 2–17 s after the buy (09-23).
        notBefore:
          now +
          BETWEEN(bot.input.callDelaySecs ?? [75, 120]) *
          1000,
        // What the Discord post says about the coin AT THE BUY.
        f: {
          sym: t.symbol || null,
          name: t.name || null,
          mc: t.marketCapUsd ?? null,
          buyers: t.uniqueBuyers ?? null,
          curve: t.curvePct ?? null,
          conf: t._conf ?? null
        }
      }
    ],

    holds: [
      ...(st.holds ?? []).filter((h) => h.mint !== t.mint),

      {
        mint: t.mint,
        symbol: t.symbol || null,
        boughtAt: now,
        // Market cap at the buy — the Discord posts' baseline.
        entryMc: t.marketCapUsd ?? null,
        // Price at the buy (SOL per token): the dump check's fallback when
        // no position read answers.
        px0: pxNow,
        hiPx: Math.max(pxNow ?? 0, tracking.get(t.mint)?.px0 && tracking.get(t.mint)?.peak ? tracking.get(t.mint).px0 * tracking.get(t.mint).peak : 0) || null,
        sellAt:
          now + holdMs,

        bumps: 0,

        nextBumpAt:
          firstUpdateAt
      }
    ]
  };

  reportStats(newSt);

  return newSt;
}

/**
 * SCORECARD. In memory while a coin is being tracked (a restart loses the
 * coins in flight, never the totals); totals in state under `sc`.
 *
 * verdict: 'bought', or the skip reason ('curve', 'mcap', 'buyers', …).
 */
const tracking = new Map();
const SCORE_ROWS_PER_PASS = 12;
const CHECKS = [5, 15, 30];
/** How many coins are scored at once; the oldest non-candidate goes first. */
const MAX_TRACKED = 60;

/** Skips that are not "a runner we chose to pass on": the coin was never a
 *  candidate (a mixed wash-trade or a mayhem coin). Logged, not totalled. */
const NOT_A_CANDIDATE = new Set(['curve', 'mayhem']);

function scoreStart(t) {
  if (tracking.has(t.mint)) return;
  if (tracking.size >= MAX_TRACKED) {
    const drop = [...tracking.values()].find((e) => e.regime !== 'classic') ?? tracking.values().next().value;
    tracking.delete(drop.mint);
  }
  const now = bot.now();
  tracking.set(t.mint, {
    mint: t.mint,
    sym: t.symbol || null,
    at: now,
    ageS: typeof t.ageSec === 'number' ? Math.round(t.ageSec) : null,
    px0: t.priceSol ?? null,
    px0Late: null,
    mc0: t.marketCapUsd ?? null,
    ks: t.kryptScore ?? null,
    regime: t.curveRegime ?? null,
    mayhem: t.isMayhem ?? null,
    buyers: t.uniqueBuyers ?? null,
    curve: t.curvePct ?? null,
    odds: t.runnerOddsPct ?? null,
    devSold: t.creatorSold ?? null,
    dev: null,
    devGrads: null,
    d24: null,
    xOwn: null,
    site: null,
    verdict: 'pending',
    peak: null,
    low: null,
    lastPx: 0,
    x: {}
  });
  // Fix 7: the creator lookup starts at the flag, for EVERY classic flag, so
  // the SCORE rows carry it whatever the filters later decide (it was null on
  // all 2,527 rows because it only ran after the mc filter). One action each.
  if (t.curveRegime === 'classic' && t.isMayhem !== true) {
    devLookup(t.mint, createdAtOf(t));
  }
}

/** Add what a later step learned (market cap, creator launches, link checks). */
function scoreNote(mint, patch) {
  const e = tracking.get(mint);
  if (!e) return;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && v !== undefined && (e[k] === null || e[k] === undefined)) e[k] = v;
  }
}

function scoreVerdict(mint, verdict) {
  const e = tracking.get(mint);
  // A later flag that buys outranks an earlier skip of the same coin.
  if (e && (e.verdict === 'pending' || verdict === 'bought')) e.verdict = verdict;
}

const R3 = (n) => (n === null || n === undefined ? null : Math.round(n * 1000) / 1000);

/**
 * The app cuts a log line at 400 chars (MAX_LOG_LINE), which would leave a
 * SCORE row as broken JSON. Over that, unknown (null) fields are dropped
 * first — absent means unknown to the analysis — then `dropOrder`.
 */
const LOG_MAX = 400;
function logRow(prefix, row, dropOrder) {
  const r = { ...row };
  let s = prefix + JSON.stringify(r);
  if (s.length > LOG_MAX) {
    for (const k of Object.keys(r)) if (r[k] === null || r[k] === undefined) delete r[k];
    s = prefix + JSON.stringify(r);
  }
  for (const k of dropOrder ?? []) {
    if (s.length <= LOG_MAX) break;
    delete r[k];
    s = prefix + JSON.stringify(r);
  }
  bot.log(s.slice(0, LOG_MAX));
}

/**
 * One pass over the coins in flight (fix 1). Prices are read in PARALLEL —
 * the old loop awaited 60 of them one after another. A mayhem/mixed coin is
 * only priced at a checkpoint or every NONCAND_PRICE_MS. At most ONE
 * bot.market fallback per pass, for the most overdue checkpoint.
 */
async function scoreTick(st) {
  const now = bot.now();
  const list = [...tracking.values()];
  const want = list.filter((e) => {
    const ageMin = (now - e.at) / 60_000;
    const due = CHECKS.some((m) => ageMin >= m && e.x[m] === undefined);
    const cand = !NOT_A_CANDIDATE.has(e.verdict);
    return cand || due || now - (e.lastPx ?? 0) >= NONCAND_PRICE_MS;
  });
  const prices = await PRICES(want.map((e) => e.mint));
  let marketUsed = false;
  const done = [];
  for (let i = 0; i < want.length; i++) {
    const e = want[i];
    let px = prices[i];
    const ageMin = (now - e.at) / 60_000;
    const due = CHECKS.find((m) => ageMin >= m && e.x[m] === undefined);
    let tried = false;
    if ((px === null || px === undefined) && due !== undefined && !marketUsed) {
      marketUsed = true;
      tried = true;
      const m = await WITHIN(bot.market(e.mint), 5000);
      px = m?.priceSol ?? null;
    }
    if (px) e.lastPx = now;
    if (e.px0 === null && px) e.px0 = px; // first price we ever got
    // The price ~30 s after the flag: what a buy placed on the flag really
    // pays (measured ~1.19x the flag price on 18 live buys).
    if (e.px0Late === null && px && now - e.at >= 25_000) e.px0Late = px;
    if (px && e.px0) {
      const x = px / e.px0;
      e.peak = e.peak === null ? x : Math.max(e.peak, x);
      e.low = e.low === null ? x : Math.min(e.low, x);
      if (due !== undefined) e.x[due] = R3(x);
    } else if (due !== undefined && (tried || ageMin >= due + 2)) {
      e.x[due] = null; // unknown, never zero (else: ask again next pass)
    }
  }
  for (const e of list) {
    if ((now - e.at) / 60_000 >= CHECKS[CHECKS.length - 1] + 1) done.push(e);
  }
  // At most SCORE_ROWS_PER_PASS rows a pass; the rest stay tracked and are
  // written next pass. A burst (after a restart restores 20, or a stalled
  // pass) went over the app's 60-lines-a-second wall and the dropped rows
  // were lost from the log for good.
  done.splice(SCORE_ROWS_PER_PASS);

  const sc = { ...(st.sc ?? {}) };
  for (const e of done) {
    tracking.delete(e.mint);
    // New fields (09-26): t0 = flag time (unix s), ageS = coin age at the
    // flag, px0 = flag price (SOL, 4 sig.), pxL = price ~30 s after the flag
    // as a multiple of px0 (what a flag-time buy really pays), ks = Krypt
    // score, dg = creator's graduated coins, d24 = launches in the prior 24 h
    // (a floor; null = unprovable), rst = finished after a restart.
    const row = {
      mint: e.mint,
      sym: e.sym ? String(e.sym).slice(0, 14) : null,
      verdict: e.verdict,
      regime: e.regime,
      t0: Math.round(e.at / 1000),
      ageS: e.ageS,
      px0: e.px0 ? Number(e.px0.toPrecision(4)) : null,
      pxL: e.px0 && e.px0Late ? R3(e.px0Late / e.px0) : null,
      buyers: e.buyers,
      curve: e.curve === null ? null : Math.round(e.curve),
      mc0: e.mc0 === null ? null : Math.round(e.mc0),
      ks: e.ks,
      odds: e.odds,
      dev: e.dev,
      dg: e.devGrads,
      d24: e.d24,
      devSold: e.devSold,
      xOwn: e.xOwn,
      site: e.site,
      x5: e.x[5] ?? null,
      x15: e.x[15] ?? null,
      x30: e.x[30] ?? null,
      peak: R3(e.peak),
      low: R3(e.low),
      rst: e.restored ? 1 : undefined
    };
    logRow('SCORE ', row, ['site', 'xOwn', 'odds', 'ks', 'ageS', 't0']);
    if (NOT_A_CANDIDATE.has(e.verdict)) continue;
    // Totals: bought vs skipped. A 2x is the peak within 30 min.
    const g = e.verdict === 'bought' ? 'b' : 's';
    const cur = { ...(sc[g] ?? { n: 0, p2: 0, d: 0 }) };
    cur.n += 1;
    if (row.peak !== null && row.peak >= 2) cur.p2 += 1;
    if (row.x30 !== null && row.x30 < 0.5) cur.d += 1;
    sc[g] = cur;
  }
  return { ...st, sc, trk: packTracking() };
}

/**
 * Fix 16: a compact copy of the candidates in flight goes into state, so a
 * restart finishes their rows (marked "restored") instead of losing them.
 * Candidates only, newest 20: [mint, at, px0, peak, low, x5, x15, verdict, mc0, dev].
 */
function packTracking() {
  return [...tracking.values()]
    .filter((e) => !NOT_A_CANDIDATE.has(e.verdict) && e.px0)
    .slice(-20)
    .map((e) => [e.mint, e.at, e.px0, R3(e.peak), R3(e.low), e.x[5] ?? null, e.x[15] ?? null, e.verdict, e.mc0 === null ? null : Math.round(e.mc0), e.dev]);
}

let restoredTracking = false;

function unpackTracking(st) {
  if (restoredTracking) return;
  restoredTracking = true;
  for (const a of st.trk ?? []) {
    if (!Array.isArray(a) || tracking.has(a[0])) continue;
    const [mint, at, px0, peak, low, x5, x15, verdict, mc0, dev] = a;
    const x = {};
    if (x5 !== null) x[5] = x5;
    if (x15 !== null) x[15] = x15;
    tracking.set(mint, {
      mint, sym: null, at, ageS: null, px0, px0Late: null, mc0, ks: null,
      regime: 'classic', mayhem: false, buyers: null, curve: null, odds: null,
      devSold: null, dev, devGrads: null, d24: null, xOwn: null, site: null,
      verdict, peak, low, lastPx: 0, x, restored: true
    });
  }
}


/**
 * CONFIRMATION WATCH (scorenow.runner.js).
 *
 * A flag that passes the flag-time filters is not bought. It is watched for
 * watchMins: every price the script sees (its ticks, via bot.subscribe, and
 * the 30 s pass's bot.price) goes into the current minute; when a minute
 * ends, its close is judged against the rule. The first minute the rule
 * holds, the coin is bought (tiny bag) and its call queued — the same enter()
 * and callout path as scorenow.v2. Minutes are counted from the flag.
 *
 * In memory, with a compact copy in state (`wat`) so a restart keeps
 * watching; the minute closes are not saved (a rising-minutes rule starts
 * its count again after a restart). Bounded: maxWatching entries (<= 40),
 * six closes each.
 */
const watchers = new Map();
const WATCH_HARD_CAP = 40;
const WATCH_CONFIRMS_PER_PASS = 1;
let restoredWatch = false;

const watchCap = () =>
  Math.max(1, Math.min(WATCH_HARD_CAP, Math.round(bot.input.maxWatching ?? 25)));

function watchDrop(w, why, counted) {
  watchers.delete(w.mint);
  bot.unsubscribe(w.mint).catch(() => null);
  if (why) bot.log(`stopped watching ${NAME(w.sym, w.mint)}: ${why}`);
  return counted;
}

/** Start watching a flag. False when it cannot be watched (no price). */
function watchStart(t) {
  if (watchers.has(t.mint)) return false;
  const px0 = t.priceSol;
  if (!(typeof px0 === 'number' && px0 > 0)) {
    skip(t, 'noPrice', 'no price at the flag to measure a run from');
    return false;
  }
  if (watchers.size >= watchCap()) {
    // Full: drop the one furthest under its flag price (least likely to confirm).
    let worst = null;
    for (const w of watchers.values()) {
      if (!worst || w.last / w.px0 < worst.last / worst.px0) worst = w;
    }
    if (worst) watchDrop(worst, 'watch list full, weakest dropped');
  }
  const mc = t.marketCapUsd;
  watchers.set(t.mint, {
    mint: t.mint,
    sym: t.symbol || null,
    name: t.name || null,
    at: bot.now(),
    px0,
    hi: px0,
    last: px0,
    m: 0,
    cl: [],
    mcPerPx: typeof mc === 'number' && mc > 0 ? mc / px0 : null,
    fresh: false
  });
  bot.subscribe(t.mint).catch(() => null);
  return true;
}

/** A price for a watched coin. Closes any minute(s) that ended before it. */
function watchNote(w, px, now) {
  if (!(typeof px === 'number' && px > 0)) return;
  const m = Math.floor((now - w.at) / 60_000);
  if (m > w.m) {
    // Minutes with no price close flat at the last price (as a chart does).
    const n = Math.min(m - w.m, 6);
    for (let i = 0; i < n; i++) w.cl.push(w.last);
    if (w.cl.length > 6) w.cl = w.cl.slice(-6);
    w.hi = Math.max(w.hi, w.last);
    w.m = m;
    w.fresh = true;
  }
  w.last = px;
}

/**
 * The rule, on the minute that just closed. False, or what confirmed it.
 * i = that minute's index from the flag (0 = the flag's own minute).
 */
function watchVerdict(w) {
  const I = bot.input;
  const i = w.m - 1;
  if (i < Math.max(1, I.confirmMinAgeMins ?? 1)) return false;
  const c = w.cl[w.cl.length - 1];
  if (!(c > 0)) return false;
  const x = c / w.px0;
  if ((I.confirmMinX ?? 0) > 0 && x < I.confirmMinX) return false;
  const mc = w.mcPerPx ? c * w.mcPerPx : null;
  if ((I.confirmMinMcUsd ?? 0) > 0 && (mc === null || mc < I.confirmMinMcUsd)) return false;
  const dd = w.hi > 0 ? (1 - c / w.hi) * 100 : 100;
  if ((I.confirmMaxDrawdownPct ?? 100) < 100 && dd > I.confirmMaxDrawdownPct) return false;
  const n = Math.round(I.confirmRisingMins ?? 0);
  if (n > 0) {
    if (w.cl.length < n + 1) return false;
    for (let j = w.cl.length - n; j < w.cl.length; j++) {
      if (!(w.cl[j] > w.cl[j - 1])) return false;
    }
  }
  return { i, x, dd, mc };
}

/**
 * Confirmed: last checks, then the same buy + queued call as scorenow.v2.
 * The watcher is removed first — one shot per coin, whatever happens.
 */
async function watchConfirm(w, v, src) {
  watchers.delete(w.mint);
  const st0 = await bot.getState();
  if ((st0.seen ?? []).includes(w.mint) || (st0.holds ?? []).some((h) => h.mint === w.mint)) {
    bot.unsubscribe(w.mint).catch(() => null);
    return;
  }
  const t = await WITHIN(bot.token(w.mint), 5000);
  if (bot.input.skipIfDevSold !== false && t?.creatorSold === true) {
    bot.log(`not calling ${NAME(w.sym, w.mint)}: confirmed at +${v.i}m but the creator sold`);
    bot.unsubscribe(w.mint).catch(() => null);
    return;
  }
  const facts = {
    ...(t ?? {}),
    mint: w.mint,
    symbol: t?.symbol || w.sym,
    name: t?.name || w.name,
    priceSol: t?.priceSol ?? w.last,
    marketCapUsd: t?.marketCapUsd ?? v.mc ?? null,
    _conf: `+${v.i}m, ${v.x.toFixed(1)}x the flag`
  };
  logRow('CONF ', {
    mint: w.mint,
    sym: w.sym ? String(w.sym).slice(0, 14) : null,
    t0: Math.round(w.at / 1000),
    i: v.i,
    x: R3(v.x),
    dd: Math.round(v.dd),
    mc: v.mc === null ? null : Math.round(v.mc),
    src
  }, ['src']);
  const after = await enter(facts);
  const ok = (after.holds ?? []).some((h) => h.mint === w.mint && !h.pending);
  after.counts = { ...(after.counts ?? {}), confirmed: (after.counts?.confirmed ?? 0) + 1 };
  after.wat = packWatch();
  scoreVerdict(w.mint, ok ? 'bought' : 'buy failed');
  await SAVE(after);
  // A held position streams its own ticks; the watch subscription can go.
  bot.unsubscribe(w.mint).catch(() => null);
}

/** Compact copy for state: [mint, at, px0, hi, m, last, mcPerPx, sym]. */
function packWatch() {
  const P4 = (n) => (typeof n === 'number' && n > 0 ? Number(n.toPrecision(4)) : null);
  return [...watchers.values()].slice(-watchCap()).map((w) => [
    w.mint, w.at, P4(w.px0), P4(w.hi), w.m, P4(w.last),
    w.mcPerPx ? Math.round(w.mcPerPx) : null, w.sym ? String(w.sym).slice(0, 10) : null
  ]);
}

function unpackWatch(st) {
  if (restoredWatch) return;
  restoredWatch = true;
  for (const a of st.wat ?? []) {
    if (!Array.isArray(a) || watchers.has(a[0]) || !(a[2] > 0)) continue;
    const [mint, at, px0, hi, m, last, mcPerPx, sym] = a;
    watchers.set(mint, { mint, sym, name: null, at, px0, hi: hi ?? px0, last: last ?? px0, m: m ?? 0, cl: [], mcPerPx, fresh: false });
    bot.subscribe(mint).catch(() => null);
  }
}

/** Ticks of watched coins (held coins tick too — ignored here). */
bot.on('tick', async (t) => {
  const w = watchers.get(t.mint);
  if (!w) return;
  watchNote(w, t.priceSol, bot.now());
  if (!w.fresh) return;
  w.fresh = false;
  const v = watchVerdict(w);
  if (v) await watchConfirm(w, v, 'tick');
});

/** The pass's share: price every watched coin, expire, confirm (<= 1; ticks confirm too). */
async function watchPass(st, late) {
  unpackWatch(st);
  if (watchers.size === 0) {
    if ((st.wat ?? []).length) {
      st = { ...st, wat: [] };
      await SAVE(st);
    }
    return st;
  }
  const now = bot.now();
  const list = [...watchers.values()];
  const prices = await PRICES(list.map((w) => w.mint));
  let expired = 0;
  let confirmed = 0;
  let mcAsks = 0;
  for (let k = 0; k < list.length; k++) {
    const w = list[k];
    if (!watchers.has(w.mint)) continue;
    watchNote(w, prices[k], now);
    // The cap per price, when the flag did not know the cap (one ask a pass).
    if (!w.mcPerPx && (bot.input.confirmMinMcUsd ?? 0) > 0 && mcAsks < 1) {
      mcAsks++;
      const t = await WITHIN(bot.token(w.mint), 3000);
      if (t?.marketCapUsd > 0 && t?.priceSol > 0) w.mcPerPx = t.marketCapUsd / t.priceSol;
    }
    // Wall-clock, not w.m: w.m only moves when a price arrives, so a coin that
    // stopped trading (no ticks, no price) never expired and held a slot
    // (09-27: NEARKAT still watched at 74 min, WHYNNE 56, SCOBLE 34).
    if ((now - w.at) / 60_000 > (bot.input.watchMins ?? 30) + 1) {
      watchDrop(w, `not confirmed within ${bot.input.watchMins} min`);
      expired++;
      continue;
    }
    if (!w.fresh) continue;
    w.fresh = false;
    const v = watchVerdict(w);
    if (!v) continue;
    if (confirmed >= WATCH_CONFIRMS_PER_PASS || late(3_000)) {
      w.fresh = true; // judged again next pass (its close is kept)
      continue;
    }
    confirmed++;
    await watchConfirm(w, v, 'pass');
  }
  if (confirmed > 0) st = await bot.getState(); // enter() saved its own copy
  st = {
    ...st,
    counts: expired ? { ...(st.counts ?? {}), expired: (st.counts?.expired ?? 0) + expired } : st.counts,
    wat: packWatch()
  };
  await SAVE(st);
  return st;
}

/**
 * Flags being looked at right now, so the +60 s and +120 s flags for the
 * same coin do not start two looks at once.
 */
const looking =
  new Set();


/**
 * New runner event.
 *
 * The app now fills hasTwitter / hasWebsite from the coin's own metadata
 * (read at launch), so the links are almost always known at the flag. When
 * they are not, ask the provider once and re-check every 2 s for a few
 * SECONDS — never minutes; a runner moves too fast for that.
 */
bot.on(
  'runner',

  async (t) => {

    if (looking.has(t.mint)) {
      return;
    }

    const st =
      await bot.getState();

    // One position per coin.
    if (
      (st.seen ?? [])
        .includes(t.mint)
    ) {
      return;
    }

    looking.add(t.mint);
    scoreStart(t);

    try {

      if (
        !(await passesFilters(t))
      ) {
        return;
      }


      let facts =
        t;

      let links =
        linksVerdict(t);

      if (links === null) {

        const waitMs =
          Math.max(
            0,
            Math.min(
              10,
              LINK_WAIT_SECS
            )
          ) * 1000;

        const until =
          bot.now() + waitMs;

        if (waitMs > 0) {
          await WITHIN(bot.market(t.mint), Math.min(waitMs, 8000));
        }

        for (;;) {

          const fresh =
            await bot.token(t.mint);

          if (fresh) {
            facts = fresh;
          }

          links =
            fresh
              ? linksVerdict(fresh)
              : null;

          if (
            links !== null ||
            bot.now() >= until
          ) {
            break;
          }

          await SLEEP(2000);
        }

        if (links === null) {
          skip(t, 'links', `links still unknown after ${waitMs / 1000}s`);
          return;
        }
      }

      scoreNote(t.mint, { site: siteVerdict(facts) });

      if (links === false) {
        skip(t, 'links',
          facts.hasTwitter === false
            ? 'no X linked'
            : facts.hasWebsite === true && facts.website
              ? `"website" is not a project homepage: ${facts.website.slice(0, 80)}`
              : 'no website linked');
        return;
      }

      // The X link has to be the coin's own account, not a borrowed post.
      if (xRuleApplies(facts)) {
        const url = facts.twitter ?? t.twitter ?? null;
        const own = xIsOwn(url, facts.symbol || t.symbol, facts.name || t.name);
        scoreNote(t.mint, { xOwn: own });
        if (!own) {
          skip(t, 'xOwn', url
            ? `X link is not the coin's own account: ${String(url).slice(0, 80)}`
            : 'X address unknown');
          return;
        }
      }

      if (!(await passesDev(t))) {
        return;
      }

      // Last look before money moves: has the creator sold since the flag?
      if (bot.input.skipIfDevSold !== false) {
        const last = await bot.token(t.mint).catch(() => null);
        if (last?.creatorSold === true) {
          scoreNote(t.mint, { devSold: true });
          skip(t, 'devSold', 'creator sold while we were checking');
          return;
        }
      }

      // scorenow.runner: no buy at the flag. The coin is WATCHED; the call and
      // the buy happen when the confirmation rule holds (watchCheck).
      if (watchStart(t)) {
        scoreVerdict(t.mint, 'watching');
        bot.log(`watching ${NAME(t.symbol, t.mint)} for up to ${bot.input.watchMins} min`);
      }

    } finally {
      looking.delete(t.mint);
      // Whatever skip() said last, or 'buy failed' / 'bought' set above.
      scoreVerdict(t.mint, lastSkip.get(t.mint) ?? 'unknown');
      lastSkip.delete(t.mint);
    }
  }
);


/**
 * A take-profit rung filled.
 *
 * Fix 4: this is where `tpFilled` is set — the timed exit lets a moonbag ride
 * ONLY when a rung really sold (WAIFU and PGPU rode at "0% up" with nothing
 * banked). Fix 13: the multiple posted is the POSITION's own (its fill
 * basis), not market cap over the flag's cap — PVE was posted as "1.4x" on a
 * 2x rung. The Discord post is queued, never awaited here (fix 1).
 */
bot.on('order', async (o) => {
  if (o.orderKind !== 'take_profit' || o.orderState !== 'filled') return;

  const st = await bot.getState();
  const hold = (st.holds ?? []).find((h) => h.mint === o.mint);
  if (!hold) return; // not one of ours (or already released) — don't post

  hold.tpFilled = true;
  st.counts = { ...(st.counts ?? {}), takeProfits: (st.counts?.takeProfits ?? 0) + 1 };
  await SAVE(st);

  // v2.1: the multiple is price over the price read right after the fill
  // (hold.px0). The position's pnlPct is against the ALL-IN cost (fees and
  // the token-account deposit), which showed a 2.35x fill as ~2.0x.
  const pxNow = await bot.price(o.mint).catch(() => null);
  let mult = pxNow && hold.px0 ? pxNow / hold.px0 : null;
  if (mult === null) {
    const pos = await WITHIN(bot.positions(), 8000); // a hung wallet read must not hang the pass (09-27 soak)
    const p = Array.isArray(pos) ? pos.find((x) => x.mint === o.mint) : null;
    mult = p && typeof p.pnlPct === 'number' ? 1 + p.pnlPct / 100 : null;
  }
  const pct = Math.round(o.orderAmount ?? 0);
  const sym = o.symbol || hold.symbol || null;

  bot.log(`take-profit filled on ${NAME(sym, o.mint)}: trimmed ~${pct}%${mult ? ` at ${mult.toFixed(2)}x the fill` : ''}`);

  const name = o.name || hold.name || null;
  queueDiscord(async () => {
    const facts = await coinFacts(o.mint);
    const link = `https://pump.fun/coin/${o.mint}`;
    await toDiscord('updateHook', {
      author: { name: 'Krypto Bot · took profit', url: BOT_URL },
      title: `🎯 Took profit — ${COIN(facts.name || name, facts.sym || sym, o.mint)}`,
      url: link,
      description: [
        `Trimmed ~**${pct}%** of the bag${mult ? ` at **${mult.toFixed(2)}x** our fill` : ''}${facts.mc ? ` · ${USD(facts.mc)} mc` : ''}.`,
        '',
        `**[→ ${sym ? '$' + sym : 'the coin'} on pump.fun](${link})**`,
        exitLine() ? `\n*${exitLine()}*` : null,
      ].filter((x) => x !== null).join('\n'),
      color: 0x22c55e,
      thumbnail: facts.image ? { url: facts.image } : undefined,
    });
  }, 'take-profit');
});


/**
 * One pass every 30 seconds.
 *
 * Money first, social actions afterward. Fix 1: the pass has a deadline —
 * no new section starts after PASS_BUDGET_MS, and Discord work runs last from
 * its queue. Fix 9: the exits no longer end the pass.
 */
bot.every(
  30,

  async () => {

    const passStart =
      bot.now();

    const late = (ms = PASS_BUDGET_MS) =>
      bot.now() - passStart > ms;

    let st =
      await bot.getState();

    const now =
      bot.now();

    unpackTracking(st);

    // Scorecard before anything else. Free local reads, in parallel.
    if (tracking.size > 0) {
      st = await scoreTick(st);
      await SAVE(st);
    }

    // W. CONFIRMATION WATCH (scorenow.runner): price every watched flag,
    // close its minutes, confirm or expire. Returns the state re-read after
    // any buy (enter() saves its own copy).
    st = await watchPass(st, late);

    reportStats(st);

    // Prune finished orders every pass (the 200-order cap). Costs no action.
    if (typeof bot.clearCompletedOrders === 'function') {
      await WITHIN(bot.clearCompletedOrders(), 3000);
    }

    const pos =
      await WITHIN(bot.positions(), 8000); // a hung wallet read must not hang the pass (09-27 soak)

    const posOk =
      Array.isArray(pos);

    const heldMap =
      new Map(posOk ? pos.filter((p) => p.held !== false).map((p) => [p.mint, p]) : []);

    const valueOf = (p) =>
      p && typeof p.costSol === 'number' && typeof p.pnlSol === 'number'
        ? p.costSol + p.pnlSol
        : null;


    // ─────────────────────────────────────────
    // 0a. PENDING BUYS + ADOPT (fix 2)
    // A pending hold (saved before bot.buy) is promoted once the position
    // shows, or dropped after PENDING_MS with nothing held. Any position this
    // script opened in the last 2 h that has NO hold — a handler killed
    // between the buy and its save — is adopted: it gets a timed exit (and
    // the stop, below), never a callout.
    // ─────────────────────────────────────────

    if (posOk) {
      let touched = false;
      const keep = [];

      for (const h of st.holds ?? []) {
        if (h.pending) {
          if (heldMap.has(h.mint)) {
            touched = true;
            bot.log(`the buy of ${NAME(h.symbol, h.mint)} landed after its handler stopped — now managed`);
            keep.push({ ...h, pending: false });
            continue;
          }
          if (now - (h.boughtAt ?? now) > PENDING_MS) {
            touched = true;
            bot.log(`the buy of ${NAME(h.symbol, h.mint)} never showed as held — dropped`);
            continue;
          }
        }
        keep.push(h);
      }

      const known =
        new Set([...keep.map((h) => h.mint), ...(st.rid ?? [])]);

      let adopted = 0;
      const rid = [...(st.rid ?? [])];

      for (const p of heldMap.values()) {
        if (known.has(p.mint)) continue;
        // Only recent bags: an old one is a moonbag this script released on
        // purpose (its mint may have aged out of `rid`).
        if (typeof p.holdMinutes !== 'number' || p.holdMinutes > 120) continue;
        const v = valueOf(p);
        if (v !== null && v < DUST_SOL) {
          rid.push(p.mint);
          touched = true;
          bot.log(`leftover ${NAME(p.symbol, p.mint)} worth ~${v.toFixed(4)} SOL — under the fee a sell costs, left alone`);
          continue;
        }
        const boughtAt = now - p.holdMinutes * 60_000;
        keep.push({
          mint: p.mint,
          symbol: p.symbol || null,
          boughtAt,
          sellAt: Math.max(now + 60_000, boughtAt + BETWEEN(bot.input.holdMins) * 60_000),
          px0: null,
          hiPx: null,
          bumps: 0,
          nextBumpAt: 0,
          adopted: true
        });
        adopted += 1;
        touched = true;
        bot.warn(`adopted ${NAME(p.symbol, p.mint)}: held with no record (a handler was cut off after the buy) — timed exit set, no callout`);
      }

      if (touched) {
        st = {
          ...st,
          holds: keep,
          rid: rid.slice(-30),
          counts: { ...(st.counts ?? {}), adopted: (st.counts?.adopted ?? 0) + adopted }
        };
        await SAVE(st);
      }
    }


    // ─────────────────────────────────────────
    // 0. GONE (stop loss or hand sell) — fix 3
    // Two missed reads at least MISS_GAP_MS apart, never one. The first miss
    // cancels nothing: on 09-24 a single missed read released 5 of 20 bags
    // and cancelled their stops, and one rode ~9.5 h with no stop.
    // ─────────────────────────────────────────

    if (posOk) {
      let touched = false;
      const gone = [];

      for (const h of st.holds ?? []) {
        if (h.pending || now - (h.boughtAt ?? now) <= 120_000) continue;
        if (heldMap.has(h.mint)) {
          if (h.missAt) {
            delete h.missAt;
            touched = true;
          }
          continue;
        }
        if (!h.missAt) {
          h.missAt = now;
          touched = true;
          bot.log(`${NAME(h.symbol, h.mint)} missing from one positions read — checking again before treating it as sold`);
          continue;
        }
        if (now - h.missAt >= MISS_GAP_MS) gone.push(h);
      }

      if (gone.length > 0) {
        const goneMints = gone.map((h) => h.mint);

        for (const h of gone) {
          bot.log(`no longer held (stop loss or hand sell): ${NAME(h.symbol, h.mint)}`);
          const hc = { ...h };
          queueDiscord(() => closeCall(hc, 'gone'), 'close');
          // Rungs left on a coin nobody holds count against the order cap.
          await WITHIN(bot.cancelOrders(h.mint), 4000);
        }

        st = {
          ...st,
          counts: {
            ...(st.counts ?? {}),
            stops: (st.counts?.stops ?? 0) + gone.length
          },
          holds: (st.holds ?? []).filter((h) => !goneMints.includes(h.mint)),
          callq: (st.callq ?? []).filter((j) => !goneMints.includes(j.mint))
        };
        touched = true;
      }

      if (touched) {
        await SAVE(st);
        reportStats(st);
      }
    }


    // ─────────────────────────────────────────
    // 0e. THE CREATOR SOLD WHILE WE HOLD (v2.2)
    // Up to DEV_CHECKS_PER_PASS held bags per pass (rotating), each read
    // bounded to 2 s, all in parallel: bot.token(mint).creatorSold === true
    // — the same fact dumpReason refuses a call on; null / unknown never
    // triggers. A hit drops the coin's queued call and updates now and
    // marks the hold `devSold`; the EXITS section below sells it FIRST, this
    // same pass, through the timed exit's own path. Runs early (before the
    // re-arm / stop / take-profit sections) so the time goes to the sell.
    // ─────────────────────────────────────────

    if (bot.input.sellOnDevSell !== false && posOk && !late()) {
      const cands = (st.holds ?? []).filter((h) => !h.pending && !h.devSold && heldMap.has(h.mint));
      if (cands.length > 0) {
        const start = devCheckCursor % cands.length;
        const pick = [...cands.slice(start), ...cands.slice(0, start)].slice(0, DEV_CHECKS_PER_PASS);
        devCheckCursor = start + pick.length;
        const ts = await Promise.all(pick.map((h) => WITHIN(bot.token(h.mint), 2000)));
        const hit = pick.filter((h, i) => ts[i]?.creatorSold === true);
        if (hit.length > 0) {
          const hitMints = hit.map((h) => h.mint);
          for (const h of hit) {
            h.devSold = true;
            h.devSoldAt = now;
            h.nextBumpAt = 0;
            bot.warn(`the creator of ${NAME(h.symbol, h.mint)} sold while we hold it — selling everything, no call`);
          }
          st = {
            ...st,
            callq: (st.callq ?? []).filter((j) => !hitMints.includes(j.mint))
          };
          await SAVE(st);
        }
      }
    }


    // ─────────────────────────────────────────
    // 0a2. RE-ARM ORDERS AN APP RESTART PAUSED (v2.1)
    // Every restart brings the app's armed orders back PAUSED and never
    // resumes them by itself (a safety rule). This script remembered its stop
    // and rungs as placed, so a bag held across a restart rode with NOTHING
    // armed: WAIFU and PGPU at 09-25 10:36 kept 3 paused orders each until the
    // timed exit. Each pass, a held bag's paused orders are re-placed as they
    // were (same kind, trigger and size; the app anchors 'pct' on the
    // position's entry again), then the paused copies are cancelled. A rung
    // that already FILLED is not paused, so it is never placed twice.
    // ─────────────────────────────────────────

    if (posOk && !late()) {
      let touched = false;

      for (const h of st.holds ?? []) {
        if (late()) break;
        if (h.pending || h.devSold || !heldMap.has(h.mint)) continue;
        if (!h.stopPlaced && !h.tpPlaced && !(h.rearm ?? []).length) continue;

        let todo = h.rearm ?? [];

        if (!todo.length) {
          const os = (await WITHIN(bot.orders(h.mint), 3000)) ?? [];
          const open = (Array.isArray(os) ? os : []).filter((o) => o.state === 'armed' || o.state === 'paused');
          if (!open.some((o) => o.state === 'paused')) continue;
          // An order that was EXECUTING when the app stopped may have sold
          // already: re-placing it could sell twice. Leave the whole coin to
          // the user (the Orders page says "check your wallet").
          // An app build without the `interrupted` field cannot tell them
          // apart, so nothing is re-armed there either.
          if (open.some((o) => o.interrupted === true || !('interrupted' in o))) {
            if (!h.rearmHeld) {
              h.rearmHeld = true;
              touched = true;
              bot.warn(`${NAME(h.symbol, h.mint)}: orders came back paused and ${open.some((o) => o.interrupted === true) ? 'one was mid-sell when the app stopped' : 'this app build cannot say whether one was mid-sell'} — NOT re-arming; check the wallet and resume them on the Orders page`);
            }
            continue;
          }
          // Every open order is re-placed, armed ones too: cancelOrders takes
          // them all, and one door keeps the ladder whole.
          todo = open.map((o) => ({ kind: o.kind, triggerBasis: o.triggerBasis, triggerValue: o.triggerValue, amount: o.amount }));
          await WITHIN(bot.cancelOrders(h.mint), 4000);
          bot.warn(`${NAME(h.symbol, h.mint)}: ${open.filter((o) => o.state === 'paused').length} order(s) came back paused after an app restart — re-arming ${todo.length}`);
          touched = true;
        }

        const left = [];
        for (const spec of todo) {
          const r = (await WITHIN(bot.order({ mint: h.mint, ...spec }), 5000)) ?? { ok: false, message: 'no answer' };
          if (!r.ok) left.push(spec);
        }
        if (left.length) {
          h.rearmTries = (h.rearmTries ?? 0) + 1;
          bot.warn(`${NAME(h.symbol, h.mint)}: ${left.length} order(s) not re-armed yet (try ${h.rearmTries}/10)`);
        }
        h.rearm = left.length && h.rearmTries < 10 ? left : [];
        if (!h.rearm.length && left.length) {
          // Given up: let the normal placement try the stop again.
          if (left.some((x) => x.kind === 'stop_loss')) h.stopPlaced = false;
        }
        touched = true;
      }

      if (touched) {
        await SAVE(st);
      }
    }


    // ─────────────────────────────────────────
    // 0b. STOP LOSSES — once the app lists the position; up to 10 passes.
    // ─────────────────────────────────────────

    const stopPct =
      bot.input.stopLossPct ?? 0;

    if (stopPct > 0 && posOk && !late()) {
      let touched = false;

      for (const h of st.holds ?? []) {
        if (late()) break;
        if (h.pending || h.devSold || h.stopPlaced || (h.stopTries ?? 0) >= 10 || !heldMap.has(h.mint)) continue;

        const so =
          (await WITHIN(bot.order({
            mint: h.mint,
            kind: 'stop_loss',
            triggerBasis: 'pct',
            triggerValue: stopPct,
            amount: 100
          }), 5000)) ?? { ok: false, message: 'no answer' };

        touched = true;

        if (so.ok) {
          h.stopPlaced = true;
          bot.log(`stop loss −${stopPct}% placed on ${NAME(h.symbol, h.mint)}`);
        } else {
          h.stopTries = (h.stopTries ?? 0) + 1;
          if (h.stopTries >= 10) {
            bot.warn(`gave up placing a stop on ${NAME(h.symbol, h.mint)}: ${so.message} — the timed exit still applies`);
          }
        }
      }

      if (touched) {
        await SAVE(st);
      }
    }


    // ─────────────────────────────────────────
    // 0c. TAKE-PROFIT LADDER — same wait as the stop; up to 10 passes.
    // ─────────────────────────────────────────

    if (bot.input.takeProfits && posOk && !late()) {
      let touchedTp = false;

      for (const h of st.holds ?? []) {
        if (late()) break;
        if (h.pending || h.devSold || h.tpPlaced || (h.tpTries ?? 0) >= 10 || !heldMap.has(h.mint)) continue;

        const done = new Set(h.tpDone ?? []);

        for (const rung of TP_LADDER) {
          if (done.has(rung.x)) continue;

          const o =
            (await WITHIN(bot.order({
              mint: h.mint,
              kind: 'take_profit',
              triggerBasis: 'pct',
              triggerValue: (rung.x - 1) * 100,
              amount: rung.sell
            }), 5000)) ?? { ok: false };

          touchedTp = true;

          if (o.ok) {
            done.add(rung.x);
          } else {
            break; // the rest next pass
          }
        }

        h.tpDone = [...done];

        if (done.size >= TP_LADDER.length) {
          h.tpPlaced = true;
          bot.log(
            `take-profit ladder armed on ${NAME(h.symbol, h.mint)} — ${
              TP_LADDER.map((r) => `${r.x}x/${r.sell}%`).join(', ')
            }`
          );
        } else {
          h.tpTries = (h.tpTries ?? 0) + 1;
          if (h.tpTries >= 10) {
            bot.warn(`gave up arming take-profits on ${NAME(h.symbol, h.mint)} — the timed exit still applies`);
          }
        }
      }

      if (touchedTp) {
        await SAVE(st);
      }
    }


    // ─────────────────────────────────────────
    // 0d. HIGH-WATER MARK per hold (fix 16) — parallel free reads.
    // ─────────────────────────────────────────

    if ((st.holds ?? []).length > 0 && !late()) {
      const hs = st.holds;
      const pxs = await PRICES(hs.map((h) => h.mint));
      let moved = false;
      hs.forEach((h, i) => {
        const px = pxs[i];
        if (px && (!h.hiPx || px > h.hiPx)) {
          h.hiPx = px;
          moved = true;
        }
      });
      if (moved) await SAVE(st);
    }


    // ─────────────────────────────────────────
    // 1. EXITS — up to 3 per pass; never ends the pass (fix 9)
    // ─────────────────────────────────────────

    if (!late()) {
      const holds =
        st.holds ?? [];

      // v2.2: a creator-sold bag is due now and goes first; one loop sells
      // both kinds, so a coin is never sold twice in a pass.
      const due =
        [
          ...holds.filter((h) => !h.pending && h.devSold),
          ...holds.filter((h) => !h.pending && !h.devSold && now >= h.sellAt)
        ].slice(0, 3);

      if (due.length > 0) {
        let sold = 0;
        let gaveUp = 0;
        let devSoldOut = 0;
        const exitRow = (h, ok, extra) => {
          logRow('EXIT ', {
            mint: h.mint,
            sym: h.symbol ? String(h.symbol).slice(0, 14) : null,
            why: 'dev sold',
            ok,
            heldS: Math.round((now - (h.boughtAt ?? now)) / 1000),
            sinceSellS: h.devSoldAt ? Math.round((now - h.devSoldAt) / 1000) : null,
            called: h.calledAt ? 1 : 0,
            ...(extra ?? {})
          }, ['sinceSellS', 'called']);
        };
        const out = []; // leaves management: sold, moonbag, dust, given up
        const rid = [...(st.rid ?? [])];
        const tp = bot.input.takeProfits;

        for (const h of due) {
          if (late()) break;

          const p = heldMap.get(h.mint);

          // A read that answered without it: the GONE section decides that
          // (two misses). Selling "nothing held" would only burn a try.
          if (posOk && !p) continue;

          // MOONBAG (fix 4): only when a take-profit rung REALLY filled and
          // the position is known to be up. Unknown or never-trimmed closes.
          // Never a moonbag once the creator sold (v2.2).
          if (tp && !h.devSold && h.tpFilled && p && typeof p.pnlPct === 'number' && p.pnlPct >= 0) {
            await WITHIN(bot.cancelOrders(h.mint), 4000);
            out.push(h.mint);
            rid.push(h.mint);
            const hc = { ...h };
            queueDiscord(() => closeCall(hc, 'moonbag'), 'close');
            bot.log(`moonbag left riding on ${NAME(h.symbol, h.mint)} (${Math.round(p.pnlPct)}% up, a take-profit filled) — sell it by hand if it runs`);
            continue;
          }

          // Fix 10: a LEFTOVER (what a filled take-profit left, or an
          // adopted remainder) worth less than a sell's fee is left alone. A
          // main bag is always sold, however low: the sell also frees the
          // script's open-position slot.
          const v = valueOf(p);
          if ((h.tpFilled || h.adopted) && v !== null && v < DUST_SOL) {
            await WITHIN(bot.cancelOrders(h.mint), 4000);
            out.push(h.mint);
            rid.push(h.mint);
            bot.log(`not selling ${NAME(h.symbol, h.mint)}: worth ~${v.toFixed(4)} SOL, under the fee a sell costs`);
            if (h.devSold) exitRow(h, false, { dust: 1 });
            continue;
          }

          let r;
          try {
            r = await bot.sell(h.mint, 100);
          } catch (e) {
            r = { ok: false, message: e?.message ?? String(e) };
          }

          if (r.ok) {
            // A full close makes every rung moot; free the slots.
            await WITHIN(bot.cancelOrders(h.mint), 4000);
            sold += 1;
            out.push(h.mint);
            const hc = { ...h };
            queueDiscord(() => closeCall(hc, h.devSold ? 'devsold' : 'closed'), 'close');
            bot.log(`sold ${NAME(h.symbol, h.mint)}${h.devSold ? ' (the creator sold)' : ''}: ${r.message}`);
            if (h.devSold) {
              devSoldOut += 1;
              exitRow(h, true, { pnl: p && typeof p.pnlPct === 'number' ? Math.round(p.pnlPct) : null });
            }
          } else {
            // Orders stay armed on a failed sell: the stop still protects it.
            h.sellTries = (h.sellTries ?? 0) + 1;
            if (h.sellTries >= MAX_SELL_TRIES) {
              gaveUp += 1;
              out.push(h.mint);
              rid.push(h.mint);
              bot.warn(`gave up selling ${NAME(h.symbol, h.mint)} after ${h.sellTries} tries: ${r.message} — any stop stays armed; sell it by hand`);
              if (h.devSold) exitRow(h, false, { tries: h.sellTries });
            } else {
              bot.log(`sell failed on ${NAME(h.symbol, h.mint)} (try ${h.sellTries}/${MAX_SELL_TRIES}): ${r.message}`);
            }
          }
        }

        st = {
          ...st,
          rid: rid.slice(-30),
          counts: {
            ...(st.counts ?? {}),
            sells: (st.counts?.sells ?? 0) + sold,
            sellGiveUp: (st.counts?.sellGiveUp ?? 0) + gaveUp,
            devSoldExits: (st.counts?.devSoldExits ?? 0) + devSoldOut
          },
          holds: holds.filter((h) => !out.includes(h.mint)),
          callq: (st.callq ?? []).filter((j) => !out.includes(j.mint))
        };

        await SAVE(st);
        reportStats(st);
      }
    }


    // ─────────────────────────────────────────
    // 2-5. ONE SOCIAL ACTION per pass (call or update)
    // ─────────────────────────────────────────

    if (!late()) {
      st = await socialStep(st, now, pos);
    }

    // Discord last, with whatever time is left.
    await drainDiscord(() => late(10_000));
    reportStats(st);
  }
);


/**
 * The social half of a pass: at most one callout or one update.
 * Returns the state it saved. Every public call is wrapped (fix 5): a
 * refusal or a rate limit is a retry, never a throw that ends the pass
 * unsaved and counts toward the five-errors auto-off.
 */
async function socialStep(st, now, pos) {

  // ── 3. QUEUED CALLOUT ──
  const callq =
    st.callq ?? [];

  // The first DUE job, not the head: a head waiting out a 30 s retry must
  // not hold back a later coin's call (review 09-26).
  const qi =
    now >= (st.calloutsPausedUntil ?? 0)
      ? callq.findIndex((j) => now >= (j.notBefore ?? 0))
      : -1;

  if (qi >= 0) {

    const job =
      callq[qi];

    const hold =
      (st.holds ?? []).find((h) => h.mint === job.mint);

    // Fix 12: a call that is dropped or gives up ends the updates too.
    const giveUp = (why, warn) => {
      callq.splice(callq.indexOf(job), 1);
      if (hold) hold.nextBumpAt = 0;
      (warn ? bot.warn : bot.log)(`${warn ? 'gave up calling' : 'not calling'} ${NAME(job.f?.sym, job.mint)}: ${why}`);
    };

    // Not held any more (sold, stopped, released): pump would refuse it
    // (the $1 rule) and a refused attempt still counts against the coin.
    if (!hold) {
      giveUp('no longer held', false);
      const newSt = { ...st, callq };
      await SAVE(newSt);
      return newSt;
    }

    const bad =
      await dumpReason(job.mint, hold, pos);

    if (bad && !bad.retry) {
      giveUp(bad.why, false);
      st.counts = { ...(st.counts ?? {}), noCall: (st.counts?.noCall ?? 0) + 1 };
      const newSt = { ...st, callq };
      await SAVE(newSt);
      reportStats(newSt);
      return newSt;
    }

    const line =
      bad ? null : await pickLine(job.mint, bot.input.comments);

    if (!line) {
      job.tries = (job.tries ?? 0) + 1;
      const why = bad ? bad.why : 'no line has all its values known yet';
      if (job.tries >= 10) {
        giveUp(why, true);
      } else {
        job.notBefore = now + 30_000;
        bot.log(`not calling ${SHORT(job.mint)} yet: ${why}`);
      }
      const newSt = { ...st, callq };
      await SAVE(newSt);
      reportStats(newSt);
      return newSt;
    }

    const answer =
      await WITHIN(bot.callout(job.mint, line), 10_000);

    // pump answered: it allows three attempts per coin, so the third refusal
    // ends the job (a rejection or a timeout may never have reached it).
    if (answer) job.posts = (job.posts ?? 0) + 1;

    const r =
      answer ??
      { ok: false, message: 'no answer (refused or rate-limited) — retrying' };

    if (r.ok) {

      callq.splice(callq.indexOf(job), 1);

      st.counts = {
        ...(st.counts ?? {}),
        callouts: (st.counts?.callouts ?? 0) + 1
      };

      bot.log(
        `called ${job.mint}${r.calloutId ? ` (callout ${r.calloutId})` : ''}: ${r.thesis}`
      );

      // Remember what the call was made at, for the updates.
      const held = (st.holds ?? []).find((h) => h.mint === job.mint);
      const tNow = await bot.token(job.mint).catch(() => null);
      if (held) {
        held.callMc = tNow?.marketCapUsd ?? job.f?.mc ?? null;
        held.name = tNow?.name || job.f?.name || null;
        held.link = r.link ?? null;
        held.calledAt = now;
      }

      // Fix 2: saved the moment it posted, before anything slow.
      const newSt = { ...st, callq };
      await SAVE(newSt);
      reportStats(newSt);

      // The call, to Discord — queued, posted later in this or a later pass.
      const f = job.f ?? {};
      const thesis = r.thesis ?? '';
      const link = r.link ?? null;
      const mint = job.mint;
      queueDiscord(async () => {
        const now2 = await coinFacts(mint);
        const name = now2.name || f.name;
        const sym = now2.sym || f.sym;
        const disclose = exitLine();
        const posted = await toDiscord('callHook', {
          author: { name: 'Krypto Bot · new call', url: BOT_URL },
          title: `📣 ${COIN(name, sym, mint)}`,
          url: link ?? `https://pump.fun/coin/${mint}`,
          description: [
            `> ${thesis}`,
            '',
            link ? `**[→ Open the callout on pump.fun](${link})**` : null,
            disclose ? `\n*${disclose}*` : null
          ].filter((x) => x !== null).join('\n'),
          color: 0x22c55e,
          thumbnail: now2.image ? { url: now2.image } : undefined,
          fields: [
            { name: 'Market cap', value: USD(now2.mc ?? f.mc), inline: true },
            { name: 'Holders', value: NUM(now2.holders), inline: true },
            { name: 'Buyers', value: NUM(f.buyers), inline: true },
            { name: 'Curve', value: f.curve === null || f.curve === undefined ? '—' : `${Math.round(f.curve)}%`, inline: true },
            f.conf ? { name: 'Confirmed', value: String(f.conf).slice(0, 60), inline: true } : null,
            linksField(mint, link, 'Callout')
          ].filter(Boolean),
          footer: 'krypt.cc/bot'
        });
        if (posted?.messageId) {
          callMsgByMint.set(mint, posted.messageId);
          const s2 = await bot.getState();
          const h2 = (s2.holds ?? []).find((h) => h.mint === mint);
          if (h2) {
            h2.callMsg = posted.messageId;
            await SAVE(s2);
          }
        }
      }, 'call');

      return newSt;

    } else if (SPAM_RESTRICTED(r.message)) {

      // The account, not the coin: pause every callout/reply, keep the coin.
      st.calloutsPausedUntil = now + SPAM_PAUSE_MS;
      bot.warn(`pump flagged spam — pausing all callouts for ${Math.round(SPAM_PAUSE_MS / 60_000)} min.`);

    } else if (ALREADY_CALLED(r.message)) {

      // An earlier attempt that timed out here did post; there is no id or
      // cap for it, so no updates — and never a second post.
      giveUp(`pump says it is already called: ${r.message}`, false);

    } else {

      job.tries = (job.tries ?? 0) + 1;
      if (job.tries >= 10 || (job.posts ?? 0) >= 3) {
        giveUp(r.message, true);
      } else {
        job.notBefore = now + 30_000;
        bot.log(`not calling ${SHORT(job.mint)} yet: ${r.message}`);
      }
    }

    const newSt = { ...st, callq };
    await SAVE(newSt);
    reportStats(newSt);
    return newSt;
  }


  // ── 5. ONE UPDATE ──
  const cap =
    bot.input.updatesPer;

  const lines =
    bot.input.updates ?? [];

  if (cap === 0 || lines.length === 0) return st;

  if (now < (st.calloutsPausedUntil ?? 0)) return st;

  const holds =
    st.holds ?? [];

  const ready =
    holds.find(
      (h) =>
        h.nextBumpAt > 0 &&
        (h.calledAt || h.callMc) &&
        now >= h.nextBumpAt &&
        (h.bumps ?? 0) < cap &&
        !callq.some((j) => j.mint === h.mint)
    );

  if (!ready) return st;

  // Same check as the call: never bump a coin that is dumping.
  const badUp =
    await dumpReason(ready.mint, ready, pos);

  if (badUp && !badUp.retry) {
    ready.nextBumpAt = 0;
    bot.log(`no more updates on ${NAME(ready.symbol, ready.mint)}: ${badUp.why}`);
    await SAVE(st);
    return st;
  }

  const upLine =
    badUp ? null : await pickLine(ready.mint, lines, { callMc: ready.callMc });

  if (!upLine) {
    ready.nextBumpAt = now + 30_000;
    await SAVE(st);
    return st;
  }

  const r =
    (await WITHIN(bot.calloutReply(ready.mint, upLine), 10_000)) ??
    { ok: false, message: 'no answer (refused or rate-limited) — retrying' };

  if (r.ok) {
    ready.bumps = (ready.bumps ?? 0) + 1;
    st.counts = { ...(st.counts ?? {}), updates: (st.counts?.updates ?? 0) + 1 };
    bot.log(`updated ${ready.mint} (${ready.bumps}/${cap}): ${r.thesis}`);

    const link = r.link ?? null;
    const thesis = r.thesis ?? '';
    const h = { ...ready };
    const bumps = ready.bumps;
    queueDiscord(async () => {
      const now2 = await coinFacts(h.mint);
      const since = now2.mc && h.callMc ? `${(now2.mc / h.callMc).toFixed(2)}×` : '—';
      await toDiscord('updateHook', {
        author: { name: `Krypto Bot · call update ${bumps}/${cap}`, url: BOT_URL },
        title: `🔁 ${COIN(now2.name || h.name, now2.sym || h.symbol, h.mint)}`,
        url: link ?? `https://pump.fun/coin/${h.mint}`,
        description: [
          `> ${thesis}`,
          '',
          link ? `**[→ Open the update on pump.fun](${link})**` : null
        ].filter((x) => x !== null).join('\n'),
        color: 0x3b82f6,
        thumbnail: now2.image ? { url: now2.image } : undefined,
        fields: [
          { name: 'Market cap', value: USD(now2.mc), inline: true },
          { name: 'Holders', value: NUM(now2.holders), inline: true },
          { name: 'Since the call', value: since, inline: true },
          { name: 'In for', value: `${Math.round((bot.now() - (h.boughtAt ?? bot.now())) / 60_000)} min`, inline: true },
          linksField(h.mint, link, 'Update')
        ],
        footer: 'krypt.cc/bot'
      });
    }, 'update');

    ready.nextBumpAt = now + BETWEEN(UPDATE_GAP_MINS) * 60_000;
  } else if (CALL_GONE(r.message)) {
    bot.log(`no update on ${ready.mint}: ${r.message}`);
    ready.nextBumpAt = 0;
    st.counts = { ...(st.counts ?? {}), dropped: (st.counts?.dropped ?? 0) + 1 };
  } else if (SPAM_RESTRICTED(r.message)) {
    st.calloutsPausedUntil = now + SPAM_PAUSE_MS;
    bot.warn(`pump flagged spam on an update — pausing callouts for ${Math.round(SPAM_PAUSE_MS / 60_000)} min.`);
  } else {
    // A refusal or a rate limit: try again next pass.
    ready.nextBumpAt = now + 30_000;
    bot.log(`no update on ${ready.mint} yet: ${r.message}`);
  }

  const newSt = { ...st, holds };
  await SAVE(newSt);
  reportStats(newSt);
  return newSt;
}
