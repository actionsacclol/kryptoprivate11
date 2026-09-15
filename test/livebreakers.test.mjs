// Real-money execution rules (shared/liveBreakers.ts) plus source pins on
// the engine call sites that must consult them. The engine itself imports
// Electron and cannot be bundled here, so the rules are pure functions and
// the wiring is pinned by reading engine.ts — the same convention the
// order-safety rules use: each non-negotiable has a test that fails if it
// is quietly removed.
//
//   1. a PARTIAL sell that did not confirm is never rebuilt and re-sent
//      (a late-landing 50% + a retried 50% = 75% sold);
//   2. a `pending` result (may still land) is never retried, for any amount;
//   3. the losing-streak counter ignores unknown PnL and resets on a win;
//   4. the breaker blocks BUYS only, and user-facing buys consult it;
//   5. user 100% sells offer the local builder (relayer stays as fallback).

import assert from 'node:assert';
import fs from 'node:fs';
import { shouldRetrySell, shouldRetryPreBroadcast, nextConsecutiveLosses, liveBreakerReason, escalatedSellSlippagePct } from './.livebreakers.mjs';

let passed = 0;
let total = 0;
const test = (name, fn) => {
  total++;
  try {
    fn();
    console.log(`ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
};

const fail = (stage) => ({ ok: false, stage });

// ── 1 + 2: sell retry ─────────────────────────────────────────────────

test('a 100% sell that provably did not land may be retried', () => {
  assert.equal(shouldRetrySell('100%', fail('confirm')), true);
  assert.equal(shouldRetrySell('100%', fail('send')), true);
  assert.equal(shouldRetrySell(100, fail('confirm')), true);
});

test('a PARTIAL sell is NEVER retried after broadcast (50% twice = 75%)', () => {
  for (const amount of ['50%', '25%', '75%', '99%', 50]) {
    assert.equal(shouldRetrySell(amount, fail('confirm')), false, `${amount} confirm`);
    assert.equal(shouldRetrySell(amount, fail('send')), false, `${amount} send`);
  }
});

test('a PENDING result (may still land) is never retried, even at 100%', () => {
  assert.equal(shouldRetrySell('100%', fail('pending')), false);
  assert.equal(shouldRetrySell('50%', fail('pending')), false);
});

test('pre-broadcast failures and successes are not retried by this rule', () => {
  for (const stage of ['relayer', 'validate', 'simulate', 'guard', 'sign']) {
    assert.equal(shouldRetrySell('100%', fail(stage)), false, stage);
  }
  assert.equal(shouldRetrySell('100%', { ok: true, stage: 'done' }), false);
});

// ── 3: losing streak from realised PnL ────────────────────────────────

test('a realised loss increments the streak, a win resets it', () => {
  assert.equal(nextConsecutiveLosses(0, -0.01), 1);
  assert.equal(nextConsecutiveLosses(1, -0.5), 2);
  assert.equal(nextConsecutiveLosses(2, 0.001), 0);
});

test('unknown PnL (no basis) changes NOTHING — a breaker never counts a guess', () => {
  assert.equal(nextConsecutiveLosses(2, null), 2);
  assert.equal(nextConsecutiveLosses(2, NaN), 2);
  assert.equal(nextConsecutiveLosses(0, null), 0);
});

test('break-even is not a loss and not a win', () => {
  assert.equal(nextConsecutiveLosses(2, 0), 2);
});

// ONE sale must move the streak ONCE. Until 2026-09-13 two independent
// places counted the same sell: this rule, fed by the reconciled fill, and a
// wallet-balance delta taken right after the exit broadcast. A user watched
// a −0.0073 SOL loss land in the loss accounting twice and the app disarm
// itself on `loss_limit` — with the default limit of 2, the first loser was
// enough. The balance rule is gone; this is the only one. The engine holds
// the counter, so what a test can pin is the shape of the rule it must be
// driven by: fold ONCE per reconciled sell fill.
test('one losing sale moves the streak by exactly one', () => {
  const sells = [-0.0073];
  // The ledger-driven path: fold each reconciled sell fill exactly once.
  const streak = sells.reduce((n, pnl) => nextConsecutiveLosses(n, pnl), 0);
  assert.equal(streak, 1, 'a single sale is a single count');
  // What the removed balance-delta path did: the same sale, folded again.
  const doubled = sells.reduce((n, pnl) => nextConsecutiveLosses(nextConsecutiveLosses(n, pnl), pnl), 0);
  assert.equal(doubled, 2, 'the double-count that tripped a 2-loss limit on one trade');
  assert.notEqual(streak, doubled, 'which is exactly why there is now one rule, not two');
});

test('a win still resets a streak built from real losses', () => {
  let n = 0;
  for (const pnl of [-0.0073, -0.006]) n = nextConsecutiveLosses(n, pnl);
  assert.equal(n, 2);
  assert.equal(nextConsecutiveLosses(n, 0.02), 0);
});

// ── 4: breaker reason ─────────────────────────────────────────────────

const lim = { maxLiveSessionLossSol: 0.5, maxLiveConsecutiveLosses: 3 };

test('breaker is silent under the limits', () => {
  assert.equal(liveBreakerReason({ sessionLossSol: 0.49, consecutiveLosses: 2, hardPauseReason: null }, lim), null);
  assert.equal(liveBreakerReason({ sessionLossSol: -1, consecutiveLosses: 0, hardPauseReason: null }, lim), null);
});

test('breaker trips on the session loss limit', () => {
  const r = liveBreakerReason({ sessionLossSol: 0.5, consecutiveLosses: 0, hardPauseReason: null }, lim);
  assert.match(r ?? '', /loss limit/);
});

test('breaker trips on the losing streak', () => {
  const r = liveBreakerReason({ sessionLossSol: 0, consecutiveLosses: 3, hardPauseReason: null }, lim);
  assert.match(r ?? '', /3 live losses/);
});

test('a hard pause (decoder drift) wins over everything', () => {
  const r = liveBreakerReason({ sessionLossSol: 0, consecutiveLosses: 0, hardPauseReason: 'drift' }, lim);
  assert.equal(r, 'drift');
});

// ── Engine wiring pins ────────────────────────────────────────────────

const engineSrc = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const between = (startRe, endRe) => {
  const m = engineSrc.match(startRe);
  assert.ok(m, `engine.ts: cannot find ${startRe}`);
  const from = m.index;
  const rest = engineSrc.slice(from);
  const e = rest.search(endRe);
  return e < 0 ? rest : rest.slice(0, e);
};

test('engine: testTrade (every user-facing buy) consults the live breaker', () => {
  const body = between(/async testTrade\(/, /\n  async fanoutBuy\(/);
  assert.match(body, /liveBreakerReason\(\)/);
});

test('engine: fanoutBuy consults the live breaker', () => {
  // Since 2026-09-11 the gates live in `fanoutPreflight` (the launcher asks
  // it before creating a token); fanoutBuy must go through it, and it must
  // consult the breaker.
  const body = between(/async fanoutBuy\(/, /\n  private runLive\(/);
  assert.match(body, /fanoutPreflight\(/);
  const preflight = between(/async fanoutPreflight\(/, /\n  async fanoutBuy\(/);
  assert.match(preflight, /liveBreakerReason\(\)/);
  assert.match(preflight, /updateLiveBreakers\(\)/);
});

test('engine: sells NEVER consult the breaker (an exit is never blocked)', () => {
  const sell = between(/async manualSell\(/, /\n  private static readonly WSOL_MINT/);
  const sellAll = between(/sellAllHeld\(reason: string\)/, /\n  \/\*\* Close all zero-balance/);
  assert.doesNotMatch(sell, /liveBreakerReason|updateLiveBreakers/);
  assert.doesNotMatch(sellAll, /liveBreakerReason|updateLiveBreakers/);
});

test('engine: arm() captures the real-SOL baseline and resets the streak', () => {
  const body = between(/\n  arm\(hasWallet: boolean\)/, /\n  private async captureLiveBaseline/);
  assert.match(body, /liveBaselineLamports = this\.walletBalanceLamports/);
  assert.match(body, /liveConsecutiveLosses = 0/);
});

test('engine: the losing streak is fed from reconciled ledger sell fills', () => {
  assert.match(engineSrc, /ledger\.onSettled\(/);
  assert.match(engineSrc, /realizedPnlForSell\(/);
  assert.match(engineSrc, /nextConsecutiveLosses\(/);
});

test('engine: sellWithRetry uses the shared retry rule', () => {
  const body = between(/private async sellWithRetry\(/, /\n  \/\*\* Fire a real 100% sell/);
  assert.match(body, /shouldRetrySell\(params\.amount, res\)/);
});

// ── 5: user sells offer the local builder ─────────────────────────────

test('engine: manualSell passes `local` for EVERY sell, and the builder sizes partials itself', () => {
  // Until 2026-09-07 partials were withheld from the local builder because
  // it hardcoded the full balance — a "sold 25%" toast over an empty bag was
  // the failure being avoided. Now the builder takes `sellPct`, sells exactly
  // that share (pinned in txbuilder.test.mjs) and closes the ATA only at
  // 100%. The pin here is the whole chain: the engine offers `local` to every
  // sell, the signer forwards the share, and the builder gates the close.
  const body = between(/async manualSell\(/, /\n  private static readonly WSOL_MINT/);
  assert.match(body, /const localParams = await this\.localBuildParamsForSell\(mint\)/);
  assert.doesNotMatch(body, /pct >= 100 \?/, 'no percent gate in front of the local builder any more');
  const signer = fs.readFileSync(new URL('../electron/engine/liveSigner.ts', import.meta.url), 'utf8');
  assert.match(signer, /sellPct: sellPct \?\? undefined,/, 'the signer forwards the share to buildLocalTrade');
  assert.match(signer, /localCannotSize = p\.action === 'sell' && sellPct === null/, 'a token-denominated numeric sell still skips the local builder');
  const builder = fs.readFileSync(new URL('../electron/engine/txBuilder.ts', import.meta.url), 'utf8');
  assert.match(builder, /amount = sellAmountFor\(bal\.data, p\.sellPct\)/, 'the builder sizes the sell from the share');
  assert.match(builder, /p\.action === 'sell' && sellPctOf\(p\.sellPct\) >= 100\) \{/, 'the ATA close is gated on a 100% sell');
});

test('engine: the sell fee estimate never blocks the build', () => {
  // Only a relayer-built sell is billed from this estimate; a local or
  // Jupiter build prices itself from its own quote. Awaiting it here put a
  // token-balance RPC (~100 ms) in front of EVERY exit for a number the
  // default path throws away.
  const body = between(/async manualSell\(/, /\n  private static readonly WSOL_MINT/);
  assert.doesNotMatch(body, /await this\.estSellProceedsLamports/, 'the estimate must not be awaited before the build');
  assert.match(body, /this\.estSellProceedsLamports\(mint, pct\)\.catch/, 'it is started, left to resolve, and cannot reject');
  const all = between(/sellAllHeld\(reason: string\)/, /\n  \/\*\* Close all zero-balance/);
  assert.doesNotMatch(all, /await this\.estSellProceedsLamports/, 'sell-all does not block on it either');
});

test('engine: sellAllHeld passes `local` for every 100% sell', () => {
  const body = between(/sellAllHeld\(reason: string\)/, /\n  \/\*\* Close all zero-balance/);
  assert.match(body, /local: await this\.localBuildParamsForSell\(tkn\.mint\)/);
});

test('engine: the sell-side local lookup can never throw into the exit path', () => {
  const body = between(/private async localBuildParamsForSell\(/, /\n  \/\*\* Execute a sell/);
  assert.match(body, /try \{[\s\S]*catch \{[\s\S]*return undefined/);
});

test('engine: a pending buy/sell is booked to the ledger, not dropped', () => {
  const buy = between(/async testTrade\(/, /\n  async fanoutBuy\(/);
  const sell = between(/async manualSell\(/, /\n  private static readonly WSOL_MINT/);
  assert.match(buy, /res\.stage === 'pending'[\s\S]*ledger\.recordFill/);
  assert.match(sell, /res\.stage === 'pending'[\s\S]*ledger\.recordFill/);
});

// ── 6. a rate-limited refusal BEFORE broadcast is retried; after it, never ──
test('a pre-broadcast rate-limit refusal is retried once', () => {
  const r = (stage, message) => ({ ok: false, stage, message });
  assert.equal(shouldRetryPreBroadcast(r('simulate', 'Simulation call failed: RPC HTTP 429')), true);
  assert.equal(shouldRetryPreBroadcast(r('guard', 'Could not read pre/post balance for the loss guard (RPC HTTP 429) — refusing')), true);
  assert.equal(shouldRetryPreBroadcast(r('relayer', 'jupiter: quote: jupiter: rate limited (429) — pausing 20s')), true);
  // The chain answered: not a rate limit, not retried here.
  assert.equal(shouldRetryPreBroadcast(r('simulate', 'Simulation reverted: {"Custom":6004}')), false);
  // Anything at or after broadcast is post-broadcast state: never.
  assert.equal(shouldRetryPreBroadcast(r('send', 'RPC HTTP 429')), false);
  assert.equal(shouldRetryPreBroadcast(r('confirm', 'RPC HTTP 429')), false);
  assert.equal(shouldRetryPreBroadcast(r('pending', 'RPC HTTP 429')), false);
  assert.equal(shouldRetryPreBroadcast({ ok: true, stage: 'confirm', message: 'ok' }), false);
});

// The engine wiring for rule 6: sellWithRetry consults the pre-broadcast
// rule FIRST, so a stop-loss whose simulate got 'RPC HTTP 429' is sent
// again after a pause, and the wider-slippage rule judges the retried
// result. The 2026-09-06 incident: a 100% sell at a -35% stop died on
// exactly that string while other rules landed.
test('the engine retries a pre-broadcast rate-limit refusal before the wider-slippage rule', () => {
  const at = engineSrc.indexOf('private async sellWithRetry(');
  assert.ok(at > -1, 'sellWithRetry exists');
  const body = engineSrc.slice(at, at + 3000);
  const pre = body.indexOf('shouldRetryPreBroadcast(res)');
  const wide = body.indexOf('shouldRetrySell(params.amount, res)');
  assert.ok(pre > -1, 'the pre-broadcast rule is consulted');
  assert.ok(wide > -1, 'the wider-slippage rule is still consulted');
  assert.ok(pre < wide, 'rate-limit retry first, then the wider-slippage retry sees the retried result');
  assert.ok(body.slice(pre, wide).includes('res = await executeTrade(params)'), 'the retry re-sends the SAME params (same slippage: the host moved, not the price)');
  // And the stop-loss path reaches it: the advanced-order host sells through manualSell, which sells through sellWithRetry.
  const flat = engineSrc.replace(/\s+/g, ' ');
  assert.ok(flat.includes('sell: async (mint, percent) => { const r = await this.manualSell(mint, percent);'), 'advanced orders sell through manualSell');
  const ms = engineSrc.indexOf('async manualSell(');
  assert.ok(ms > -1 && engineSrc.slice(ms, ms + 4000).includes('this.sellWithRetry('), 'manualSell goes through sellWithRetry');
});

console.log(`livebreakers: ${passed}/${total} tests passed`);

// Live is the DEFAULT trading mode (2026-08-29): a fresh profile arms as soon
// as a wallet exists; Paper is the opt-in toggle.
{
  const src = fs.readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /liveEnabled: true,/, 'DEFAULT_SETTINGS.execution.liveEnabled must default to true');
  const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(ipc, /export function syncLiveMode/, 'boot/wallet arming helper must exist');
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(main, /syncLiveMode\(\);/, 'main must arm at boot');
  assert.match(main, /onDisarm = \(reason\)/, 'every disarm must persist the mode bit');
  console.log('ok  live is the default mode; boot arms; disarm persists Paper');
}

// Breakers are OPT-IN for a manual terminal (2026-08-29): two ordinary
// losing trades flipped a user to Paper. Session loss is REALISED PnL from
// reconciled sells, never a wallet-balance delta that counts a buy as a loss.
{
  const src = fs.readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /maxLiveSessionLossSol: 0,/, 'session-loss breaker defaults off');
  assert.match(src, /maxLiveConsecutiveLosses: 0,/, 'streak breaker defaults off');
  const eng = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = eng.slice(eng.indexOf('private liveSessionLossSol()'), eng.indexOf('private liveSessionLossSol()') + 700);
  assert.match(body, /realizedPnlForSell/, 'session loss is realised PnL from the ledger');
  assert.doesNotMatch(body, /liveBaselineLamports - this\.walletBalanceLamports/, 'no balance-delta loss');
  assert.equal(liveBreakerReason({ sessionLossSol: 5, consecutiveLosses: 9, hardPauseReason: null }, { maxLiveSessionLossSol: 0, maxLiveConsecutiveLosses: 0 }), null);
  console.log('ok  breakers default off and a 0 limit never trips; session loss is realised only');
}

// The mode bit is written AFTER arm()/disarm() push their status, so the
// switch must announce again once the bit is persisted — otherwise the top
// bar shows Paper while the engine is armed (seen 2026-08-29).
{
  const ipc = fs.readFileSync(new URL('../electron/ipc.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const h = ipc.slice(ipc.indexOf("ipcMain.handle('live:setLive'"));
  const persistIdx = h.indexOf('liveEnabled: false } });');
  const announceIdx = h.indexOf('announceStatus()');
  assert.ok(persistIdx > 0 && announceIdx > persistIdx, 'setLive must announce status AFTER persisting the mode bit');
  console.log('ok  live:setLive re-announces status after the mode bit is written');
}

// The disarm path must use the SAME rule as the buy gate. A direct
// `loss >= limit` comparison with the 0 default disarmed a user in Live mode
// on every balance poll ("loss limit (−0 SOL)", 2026-08-30).
{
  const eng = fs.readFileSync(new URL('../electron/engine/engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const i = eng.indexOf('private updateLiveBreakers()');
  const body = eng.slice(i, i + 1200);
  assert.match(body, /liveBreakerReason\(/, 'updateLiveBreakers must delegate to liveBreakerReason');
  assert.doesNotMatch(body, />= e\.maxLiveSessionLossSol/, 'no raw >= comparison against the session limit');
  assert.doesNotMatch(body, />= e\.maxLiveConsecutiveLosses/, 'no raw >= comparison against the streak limit');
  assert.equal(liveBreakerReason({ sessionLossSol: 0, consecutiveLosses: 0, hardPauseReason: null }, { maxLiveSessionLossSol: 0, maxLiveConsecutiveLosses: 0 }), null);
  assert.equal(liveBreakerReason({ sessionLossSol: 0.5, consecutiveLosses: 3, hardPauseReason: null }, { maxLiveSessionLossSol: 0, maxLiveConsecutiveLosses: 0 }), null);
  console.log('ok  a 0 limit never disarms, on the poll path or the buy gate');
}

// ── An exit that did not land retries wider ──────────────────────────
{
  // The first attempt uses the user's setting (floored at 15 by the caller).
  // The retry accepts a worse fill, because being stuck in a position you
  // asked to leave is the worse outcome — but it is bounded.
  assert.equal(escalatedSellSlippagePct(15), 38, '15 % → 38 % on the retry');
  assert.equal(escalatedSellSlippagePct(12), 35, 'a low setting still gets a real bump');
  assert.equal(escalatedSellSlippagePct(5), 35, 'the floor is the floor');
  assert.equal(escalatedSellSlippagePct(25), 50, 'and the ceiling is the ceiling');
  assert.equal(escalatedSellSlippagePct(50), 50, 'never past 50 %');
  assert.equal(escalatedSellSlippagePct(200), 50, 'a nonsense setting is still bounded');
  // Garbage in does not produce garbage out: a missing or broken value
  // falls back to the same floor the sell path uses.
  assert.equal(escalatedSellSlippagePct(0), 38);
  assert.equal(escalatedSellSlippagePct(-4), 38);
  assert.equal(escalatedSellSlippagePct(NaN), 38);
  console.log('ok  a failed exit retries at a wider, bounded slippage');
}
