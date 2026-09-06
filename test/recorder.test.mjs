// Launch-tape filter tests — the recorder mode that makes a week of tape
// affordable (firehose measured 15 GB/day; launch mode keeps creates, the
// first 30 min of each mint's trades under a per-mint cap, completions,
// metadata and health rows, and drops the rest).
//
// Pinned here:
// - create / complete / feed_health (and the other lifecycle kinds) are always kept
// - trades are kept only inside the mint's window and under the cap
// - trades for an unknown mint, or after the window, are dropped
// - old windows are evicted; the map is bounded
// - malformed payloads never throw
// - the `tape_` prefix and the engine's bare echoes follow the same rule

import assert from 'node:assert/strict';
import { LaunchFilter, baseKind, LAUNCH_WINDOW_MS, LAUNCH_MAX_TRADES_PER_MINT } from './.launchrecorder.mjs';

const T0 = 1_800_000_000_000;
const MIN = 60_000;

{
  assert.equal(baseKind('tape_trade'), 'trade');
  assert.equal(baseKind('trade'), 'trade');
  assert.equal(baseKind('feed_health'), 'feed_health');
  assert.equal(LAUNCH_WINDOW_MS, 30 * MIN);
  assert.equal(LAUNCH_MAX_TRADES_PER_MINT, 3000);
  console.log('ok  kind normalisation + defaults');
}

// Always-kept kinds, regardless of mint state or payload shape.
{
  const f = new LaunchFilter();
  for (const k of ['tape_create', 'create', 'tape_complete', 'complete', 'migrated', 'feed_health', 'decoder_drift', 'engine_start', 'engine_stop', 'armed', 'disarmed', 'tape_metadata', 'metadata', 'program_upgrade']) {
    assert.equal(f.accept(k, { mint: 'unknownMint' }, T0), true, k);
    assert.equal(f.accept(k, {}, T0), true, `${k} without mint`);
  }
  console.log('ok  create/complete/health/lifecycle kinds always kept');
}

// Everything else is dropped in launch mode.
{
  const f = new LaunchFilter();
  f.accept('tape_create', { mint: 'M' }, T0);
  for (const k of ['tape_amm', 'live_trade', 'decision', 'risk', 'position_open', 'shadow_send', 'dip_signal', 'strat_signal', 'orphaned', 'rent_sweep']) {
    assert.equal(f.accept(k, { mint: 'M' }, T0 + 1), false, k);
  }
  console.log('ok  non-launch kinds dropped (tape_amm, live_trade, decisions…)');
}

// Trades: only inside a known mint's window.
{
  const f = new LaunchFilter();
  assert.equal(f.accept('tape_trade', { mint: 'M' }, T0), false, 'trade before create is dropped');
  assert.equal(f.accept('tape_create', { mint: 'M' }, T0), true);
  assert.equal(f.accept('tape_trade', { mint: 'M' }, T0 + 1), true, 'trade right after create');
  assert.equal(f.accept('trade', { mint: 'M' }, T0 + 5 * MIN), true, 'bare engine echo follows the same window');
  assert.equal(f.accept('tape_trade', { mint: 'M' }, T0 + 30 * MIN), true, 'trade at exactly the window edge');
  assert.equal(f.accept('tape_trade', { mint: 'M' }, T0 + 30 * MIN + 1), false, 'trade after the window');
  assert.equal(f.has('M'), false, 'window closed on the first late trade');
  assert.equal(f.accept('tape_trade', { mint: 'M' }, T0 + 31 * MIN), false, 'stays dropped');
  assert.equal(f.accept('tape_trade', { mint: 'OTHER' }, T0 + 1), false, 'unknown mint');
  assert.equal(f.accept('tape_complete', { mint: 'M' }, T0 + 3 * 60 * MIN), true, 'completion hours later still kept');
  console.log('ok  trades kept only inside the window; unknown/late mints dropped');
}

// Per-mint cap.
{
  const f = new LaunchFilter({ maxTradesPerMint: 5 });
  f.accept('tape_create', { mint: 'M' }, T0);
  let kept = 0;
  for (let i = 0; i < 20; i++) if (f.accept('tape_trade', { mint: 'M' }, T0 + i)) kept++;
  assert.equal(kept, 5);
  assert.equal(f.stats().cappedMints, 1);
  // The engine's bare `trade` echo has its own budget — it never eats the tape's.
  let echo = 0;
  for (let i = 0; i < 20; i++) if (f.accept('trade', { mint: 'M' }, T0 + 100 + i)) echo++;
  assert.equal(echo, 5);
  assert.equal(f.accept('tape_trade', { mint: 'M' }, T0 + 200), false, 'tape budget still spent');
  // Another mint is unaffected by M's cap.
  f.accept('tape_create', { mint: 'N' }, T0);
  assert.equal(f.accept('tape_trade', { mint: 'N' }, T0 + 1), true);
  console.log('ok  per-mint trade cap');
}

// Duplicate create does not reset the window or the counter.
{
  const f = new LaunchFilter({ maxTradesPerMint: 2 });
  f.accept('tape_create', { mint: 'M' }, T0);
  f.accept('tape_trade', { mint: 'M' }, T0 + 1);
  f.accept('tape_trade', { mint: 'M' }, T0 + 2);
  assert.equal(f.accept('tape_create', { mint: 'M' }, T0 + 3), true, 'create is still written');
  assert.equal(f.accept('tape_trade', { mint: 'M' }, T0 + 4), false, 'cap not reset by a duplicate create');
  console.log('ok  duplicate create keeps the original window');
}

// Eviction: windows age out on sweep, and the map is bounded oldest-first.
{
  const f = new LaunchFilter({ maxMints: 3 });
  f.accept('tape_create', { mint: 'A' }, T0);
  f.accept('tape_create', { mint: 'B' }, T0 + 1);
  f.accept('tape_create', { mint: 'C' }, T0 + 2);
  f.accept('tape_create', { mint: 'D' }, T0 + 3);
  assert.equal(f.stats().mints, 3);
  assert.equal(f.has('A'), false, 'oldest evicted when full');
  assert.equal(f.has('D'), true);
  assert.equal(f.accept('tape_trade', { mint: 'A' }, T0 + 4), false, 'evicted mint trades are dropped');
  f.sweep(T0 + 31 * MIN);
  assert.equal(f.stats().mints, 0, 'all aged windows swept');
  assert.equal(f.stats().evicted, 4);
  console.log('ok  eviction — oldest-first when full, aged-out on sweep');
}

// The sweep also runs on its own (by count or by time) without being asked.
{
  const f = new LaunchFilter();
  f.accept('tape_create', { mint: 'OLD' }, T0);
  // A minute later a different record arrives — the time-based sweep runs.
  f.accept('feed_health', {}, T0 + 31 * MIN);
  assert.equal(f.has('OLD'), false);
  console.log('ok  automatic sweep');
}

// Clock: receivedAt in the payload is the default clock.
{
  const f = new LaunchFilter();
  f.accept('tape_create', { mint: 'M', receivedAt: T0 });
  assert.equal(f.accept('tape_trade', { mint: 'M', receivedAt: T0 + MIN }), true);
  assert.equal(f.accept('tape_trade', { mint: 'M', receivedAt: T0 + 31 * MIN }), false);
  console.log('ok  receivedAt is the default clock');
}

// Malformed payloads never throw.
{
  const f = new LaunchFilter();
  const bad = [null, undefined, 42, 'str', [], { mint: 7 }, { mint: '' }, { mint: null, receivedAt: 'x' }, { receivedAt: NaN }];
  for (const p of bad) {
    assert.doesNotThrow(() => f.accept('tape_trade', p, T0));
    assert.equal(f.accept('tape_trade', p, T0), false, 'bad trade is dropped');
    assert.doesNotThrow(() => f.accept('tape_create', p, T0));
    assert.equal(f.accept('tape_create', p, T0), true, 'bad create is still written');
    assert.doesNotThrow(() => f.accept('feed_health', p));
  }
  assert.doesNotThrow(() => f.accept(undefined, {}, T0));
  assert.doesNotThrow(() => f.accept(123, { mint: 'M' }));
  assert.equal(f.stats().mints, 0, 'no window opened for a mint-less create');
  console.log('ok  malformed payloads never throw');
}

// Stats + reset.
{
  const f = new LaunchFilter();
  f.accept('tape_create', { mint: 'M' }, T0);
  f.accept('tape_trade', { mint: 'M' }, T0 + 1);
  f.accept('tape_amm', {}, T0 + 2);
  const s = f.stats();
  assert.equal(s.kept.tape_create, 1);
  assert.equal(s.kept.tape_trade, 1);
  assert.equal(s.dropped.tape_amm, 1);
  assert.deepEqual(f.config(), { windowMs: 30 * MIN, maxTradesPerMint: 3000, maxMints: 20000 });
  f.reset();
  assert.equal(f.stats().mints, 0);
  assert.deepEqual(f.stats().kept, {});
  console.log('ok  stats + reset');
}

console.log('recorder (launch tape) tests passed');
