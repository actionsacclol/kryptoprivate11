// Wallet Lab — random trading ("warming") on a group of the user's own
// wallets.
//
// What it is: a utility that buys a random liquid token with a random size,
// holds a random while, sells, waits a random gap, and repeats across the
// group's wallets — under a HARD stop at a loss cap, a per-hour cap and a
// per-wallet open cap. What it is not: a strategy. It is expected to lose
// fees and slippage, and the page says so.
//
// Every trade is a normal executeTrade with that wallet's id: simulation,
// loss guard, breakers, platform fee, confirm socket. The loss cap is on
// realised cash from the ledger's reconciled fills — cash in minus cash out,
// fees and tips included — with bags still held counted AT COST, so a run
// that is merely holding is not stopped for "losing" the money it deployed.
//
// A fill that cannot be priced is NOT zero (audit 2026-09-09, lab-1). A fresh
// fill is `pending` until the ledger reads it back off the chain, and the
// cash delta excludes it — so a cap fed only the sum saw "0.000 realised"
// while the group was really down 0.066 SOL and never fired. The ledger now
// also reports how many signatures it could not price; while that count is
// above zero the run reports realised as NULL (an em dash, never a 0), buys
// nothing, and stops outright if the blindness persists.
//
// Bags are never abandoned (2026-09-03 review): open positions and the
// run's signatures are persisted to userData and restored on start-up, a
// disarmed or failed sell retries with backoff up to a cap and then says
// exactly which wallet holds what, and every timer callback is guarded so a
// throw cannot strand a position or raise a crash.

import fs from 'node:fs';
import path from 'node:path';
import { between, lossCapHit, pickTradeSol, type LabGroupConfig, type RandomOpen, type RandomRunStatus } from '@shared/lab';

export interface RandomHost {
  armed(): boolean;
  config(groupId: string): LabGroupConfig | null;
  members(groupId: string): Array<{ id: string; label: string; publicKey: string }>;
  activePublicKey(): string | null;
  balanceSol(publicKey: string): Promise<number | null>;
  /** Candidate tokens from the chosen Discover column, already liquidity-filtered. */
  candidates(universe: 'trending' | 'graduating' | 'new', minLiquidityUsd: number): Promise<Array<{ mint: string; symbol: string }>>;
  /**
   * `stage` is how far the trade got. 'pending' means it was BROADCAST and a
   * fill was recorded against it — real SOL left the wallet — but the
   * confirmation had not come back, so `ok` is false. A bag opened that way
   * is a real bag and must be tracked (audit lab-3); its signature is real
   * cash and must count towards the loss cap. Anything else with ok:false
   * spent nothing that the ledger knows about, so its signature must NOT
   * enter the run's cash set — there would be no fill to price it with.
   */
  buy(walletId: string, mint: string, sol: number): Promise<{ ok: boolean; message: string; signature: string | null; costSol: number | null; stage?: string | null }>;
  sell(walletId: string, mint: string): Promise<{ ok: boolean; message: string; signature: string | null; stage?: string | null }>;
  /**
   * Realised SOL (cash delta) across the given signatures, from reconciled
   * fills, PLUS how many of those signatures could not be priced at all
   * (still pending, terminally unreadable, or never recorded). `unknown > 0`
   * means the answer is "I do not know" — `sol` is then only the part that
   * could be read and must not be used as the whole.
   */
  realizedFor(signatures: string[]): { sol: number; unknown: number };
  log(level: 'info' | 'warn' | 'error', line: string): void;
  emit(runs: RandomRunStatus[]): void;
}

interface Run {
  /** Bumped on every start(); a callback from an older generation bails. */
  gen: number;
  status: RandomRunStatus;
  walletFilter: Set<string> | null;
  signatures: string[];
  /**
   * Signatures that are NOT this run's business: everything already realised
   * when start() was called, so a restarted run is judged from zero. Kept as
   * a set rather than a precomputed number because a fill that could not be
   * priced at start() must not freeze a wrong baseline into the run — an
   * excluded signature simply cancels out of both sides of the difference.
   */
  excluded: Set<string>;
  /** Bags carried in at start(); their cost sits in the baseline, so it comes
   *  off again when this run closes one. */
  baselineOpen: RandomOpen[];
  /** When the loss cap first became unjudgeable, or null while it is known. */
  blindSince: number | null;
  tradeStamps: number[];
  nextTimer: NodeJS.Timeout | null;
  sellTimers: Map<string, NodeJS.Timeout>;
  busy: boolean;
}

/** Sell retries: 2 min, 4 min, 8 min, 16 min, 32 min — then the bag is
 *  handed to the user by name. */
const SELL_RETRY_MAX = 5;
const SELL_RETRY_BASE_MS = 120_000;
/** While disarmed a sell cannot be signed; look again every minute. */
const DISARMED_RETRY_MS = 60_000;

/** How long the loss cap may stay unjudgeable before the run stops. A fill
 *  is `pending` for a few seconds while the ledger reads it back off the
 *  chain, and stopping on that would end a run on every single sell. Past
 *  this it is not a hiccup, it is blindness. Nothing is bought in the
 *  meantime — the wait is a refusal, not a grace period for trading. */
let unknownGraceMs = 60_000;

let host: RandomHost | null = null;
let file = '';
/**
 * Set when lab-runs.json exists but could not be read or parsed. That file is
 * the ONLY record of which lab wallet holds which bag — the engine's holdings
 * and portfolio key off the ACTIVE wallet, so a lab bag that falls out of it
 * is unattributed and effectively lost. So an unreadable file is NOT an empty
 * one: this session refuses to write over it, and says so. Absent file =
 * fresh install.
 */
let loadFailure: string | null = null;
const runs = new Map<string, Run>();

/** Why the lab run file is read-only this session, or null. */
export function failure(): string | null {
  return loadFailure;
}

function persist(): void {
  if (!file || loadFailure) return;
  try {
    const rows = [...runs.values()].map((r) => ({ groupId: r.status.groupId, open: r.status.open, signatures: r.signatures.slice(-400) }));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs: rows }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort; the in-memory state is what trades */
  }
}

/**
 * Load persisted open bags so a restart never forgets what a wallet holds.
 *
 * Fails CLOSED: a missing file is a fresh install, but a file that exists and
 * cannot be read or parsed leaves `loadFailure` set — this session then never
 * writes over it, so the bags it records stay recoverable by hand instead of
 * being replaced by an empty file the moment any group is started.
 */
export function init(userDataDir: string): number {
  file = path.join(userDataDir, 'lab-runs.json');
  loadFailure = null;
  runs.clear();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${file} could not be read (${(e as Error).message})`;
      console.warn(`[sniper] lab: ${loadFailure} — open bags recorded there are NOT loaded and the file will not be overwritten`);
    }
    return 0;
  }
  let raw: { runs?: Array<{ groupId: string; open: RandomOpen[]; signatures: string[] }> };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch (e) {
    loadFailure = `${file} is corrupt (${(e as Error).message})`;
    console.warn(`[sniper] lab: ${loadFailure} — open bags recorded there are NOT loaded and the file will not be overwritten`);
    return 0;
  }
  let restored = 0;
  for (const row of raw?.runs ?? []) {
    if (!row?.groupId) continue;
    const open = Array.isArray(row.open) ? row.open.filter((o) => o && typeof o.walletId === 'string' && typeof o.mint === 'string') : [];
    const run: Run = {
      gen: 0,
      status: {
        groupId: row.groupId,
        walletIds: null,
        running: false,
        startedAt: null,
        stoppedAt: null,
        stopReason: open.length ? 'restored after restart — open bags still sell on their timers' : null,
        buys: 0,
        sells: 0,
        failed: 0,
        // Last session's fills are not this session's realised PnL, and the
        // cap is not known until status() reads it off the group config.
        realizedSol: null,
        maxLossSol: 0,
        open,
        nextActionAt: null,
        lastLine: open.length ? `${open.length} open position(s) restored from the last session` : null,
      },
      walletFilter: null,
      signatures: Array.isArray(row.signatures) ? row.signatures.filter((s) => typeof s === 'string') : [],
      excluded: new Set(),
      baselineOpen: [],
      blindSince: null,
      tradeStamps: [],
      nextTimer: null,
      sellTimers: new Map(),
      busy: false,
    };
    runs.set(row.groupId, run);
    for (const o of open) armSell(row.groupId, o, Math.max(5_000, o.sellAt - Date.now()));
    restored += open.length;
  }
  return restored;
}

export function attach(h: RandomHost): void {
  host = h;
}

/** Realised cash on this run's closed trades, or null when it is not
 *  knowable — with the number of fills that could not be priced. */
interface Realized {
  sol: number | null;
  unknown: number;
}

/**
 * What the buy that opened this bag actually took out of the wallet, in SOL,
 * from the CHAIN — never the size we asked for (the requested amount omits
 * the priority fee, the tip, the ATA rent and the slippage, and is wrong in
 * the user's favour every time). Null when that fill cannot be priced.
 */
function costOf(o: RandomOpen): number | null {
  if (!host || !o.buySig) return null;
  const r = host.realizedFor([o.buySig]);
  // A buy's cash delta is negative; the cost is its magnitude.
  return r.unknown > 0 ? null : -r.sol;
}

function realizedOf(run: Run): Realized {
  if (!host) return { sol: null, unknown: 1 };
  // Cash delta of this run's own fills (everything realised before start()
  // is excluded and cancels), PLUS the cost of bags this run still holds — a
  // buy is not a loss until its sell lands — MINUS the cost of bags it
  // inherited and has since closed, which the baseline was carrying.
  const sigs = run.signatures.filter((s) => !run.excluded.has(s));
  const cash = host.realizedFor(sigs);
  let unknown = cash.unknown;
  let sol = cash.sol;

  for (const o of run.status.open) {
    // A bag that cannot name its buy has no honest cost; it is not priced
    // from the requested size, it is reported as unknown.
    if (!o.buySig) {
      unknown += 1;
      continue;
    }
    if (run.excluded.has(o.buySig)) continue; // carried in and still held — cancels
    const c = costOf(o);
    if (c === null) continue; // its signature is already in cash.unknown
    sol += c;
  }
  const stillOpen = new Set(run.status.open.map((o) => key(o.walletId, o.mint)));
  for (const o of run.baselineOpen) {
    if (stillOpen.has(key(o.walletId, o.mint))) continue; // still held — cancels
    if (!o.buySig) continue; // never entered the accounting; nor did its sell
    const c = costOf(o);
    if (c === null) {
      unknown += 1; // excluded from `sigs`, so not counted above
      continue;
    }
    sol -= c;
  }
  return unknown > 0 ? { sol: null, unknown } : { sol, unknown: 0 };
}

export function status(): RandomRunStatus[] {
  const out: RandomRunStatus[] = [];
  for (const r of runs.values()) {
    if (r.status.startedAt === null) {
      // Restored from disk and never started this session. Its signatures
      // belong to the LAST session, so its realised PnL is not a number this
      // one may claim; the cap, on the other hand, is knowable — it is the
      // group's configured one (a stored 0 would pin the page's loss bar at
      // 100 % against any negative figure).
      out.push({
        ...r.status,
        realizedSol: null,
        maxLossSol: host?.config(r.status.groupId)?.random.maxLossSol ?? r.status.maxLossSol,
        open: [...r.status.open],
        loadFailure,
      });
      continue;
    }
    r.status.realizedSol = realizedOf(r).sol;
    out.push({ ...r.status, open: [...r.status.open], loadFailure });
  }
  return out;
}

function push(): void {
  host?.emit(status());
}

function key(walletId: string, mint: string): string {
  return `${walletId}:${mint}`;
}

export function start(groupId: string, walletIds?: string[]): { ok: boolean; message: string; status?: RandomRunStatus } {
  if (!host) return { ok: false, message: 'Lab not attached' };
  const cfg = host.config(groupId);
  if (!cfg) return { ok: false, message: 'No such group' };
  if (!host.armed()) return { ok: false, message: 'Arm live execution first — random trading spends real SOL' };
  const filter = walletIds && walletIds.length ? new Set(walletIds) : null;
  const members = host
    .members(groupId)
    .filter((m) => m.publicKey !== host?.activePublicKey())
    .filter((m) => !filter || filter.has(m.id));
  if (!members.length) return { ok: false, message: filter ? 'None of the chosen wallets is a group member other than the active wallet' : 'The group has no wallets besides the active one' };
  const existing = runs.get(groupId);
  if (existing?.status.running) return { ok: false, message: 'Already running' };
  const inheritedSigs = existing?.signatures ?? [];
  const inheritedOpen = existing?.status.open ?? [];
  const run: Run = {
    gen: (existing?.gen ?? 0) + 1,
    walletFilter: filter,
    status: {
      groupId,
      walletIds: filter ? [...filter] : null,
      running: true,
      startedAt: Date.now(),
      stoppedAt: null,
      stopReason: null,
      buys: 0,
      sells: 0,
      failed: 0,
      realizedSol: 0,
      maxLossSol: cfg.random.maxLossSol,
      open: inheritedOpen,
      nextActionAt: null,
      lastLine: inheritedOpen.length ? `started — ${inheritedOpen.length} bag(s) carried over, judged from zero` : 'started',
    },
    signatures: inheritedSigs,
    // Judge this run from zero: every fill that already existed is excluded
    // (it cancels out of both sides), and inherited bags are carried at the
    // cost the baseline already holds — so closing one here shows the whole
    // round trip, not just its proceeds. A snapshot, not a frozen number:
    // a fill that is unreadable today must not become a wrong baseline.
    excluded: new Set(inheritedSigs),
    baselineOpen: [...inheritedOpen],
    blindSince: null,
    tradeStamps: [],
    nextTimer: null,
    sellTimers: existing?.sellTimers ?? new Map(),
    busy: false,
  };
  runs.set(groupId, run);
  host.log('info', `lab random: started on group ${groupId} (${members.length} wallet(s), loss cap ${cfg.random.maxLossSol} SOL)`);
  if (loadFailure) {
    run.status.lastLine = `started — WARNING: ${loadFailure}; bags opened now will not be remembered if the app restarts`;
    host.log('warn', `lab random: ${run.status.lastLine}`);
  }
  schedule(run, between(2_000, 6_000));
  persist();
  push();
  return { ok: true, message: 'Random trading started', status: run.status };
}

export function stop(groupId: string, reason = 'stopped by user'): { ok: boolean; message: string; status?: RandomRunStatus } {
  const run = runs.get(groupId);
  if (!run) return { ok: false, message: 'Not running' };
  if (run.nextTimer) clearTimeout(run.nextTimer);
  run.nextTimer = null;
  run.status.running = false;
  run.status.stoppedAt = Date.now();
  // The stop reason is its own field; lastLine is left alone so a "could
  // not sell X, it is still in wallet Y" hand-over survives the stop.
  run.status.stopReason = run.status.open.length ? `${reason} — ${run.status.open.length} open position(s) still sell on their timers` : reason;
  run.status.nextActionAt = null;
  host?.log('info', `lab random: ${run.status.stopReason} (group ${groupId})`);
  persist();
  push();
  return { ok: true, message: run.status.stopReason, status: run.status };
}

export function stopAll(reason: string): void {
  for (const id of runs.keys()) if (runs.get(id)?.status.running) stop(id, reason);
}

function live(run: Run): boolean {
  return runs.get(run.status.groupId) === run;
}

function schedule(run: Run, ms: number): void {
  if (!live(run) || !run.status.running) return;
  if (run.nextTimer) clearTimeout(run.nextTimer);
  run.status.nextActionAt = Date.now() + ms;
  run.nextTimer = setTimeout(() => {
    void tick(run).catch((e) => host?.log('warn', `lab random: tick threw — ${e instanceof Error ? e.message : String(e)}`));
  }, ms);
}

async function tick(run: Run): Promise<void> {
  if (!live(run) || !host || !run.status.running || run.busy) return;
  const groupId = run.status.groupId;
  const cfg = host.config(groupId);
  if (!cfg) {
    stop(groupId, 'group vanished');
    return;
  }
  const r = cfg.random;
  run.busy = true;
  try {
    if (!host.armed()) {
      stop(groupId, 'live execution disarmed');
      return;
    }
    const realized = realizedOf(run);
    run.status.realizedSol = realized.sol;
    if (realized.sol === null) {
      // The cap cannot be judged, so nothing is bought. A fill is pending for
      // a few seconds while the ledger reads it off the chain; past the grace
      // the run stops rather than keep trading blind to its own losses.
      if (blindTooLong(run)) {
        stop(groupId, `cannot price ${realized.unknown} fill(s) yet — stopped rather than trade blind to the loss cap`);
        return;
      }
      run.status.lastLine = `waiting: ${realized.unknown} fill(s) not readable on chain yet — the loss cap cannot be judged, so nothing is bought`;
      schedule(run, 15_000);
      return;
    }
    run.blindSince = null;
    if (lossCapHit(realized.sol, r.maxLossSol)) {
      stop(groupId, `loss cap reached (${realized.sol.toFixed(4)} SOL realised on closed trades)`);
      return;
    }
    const hourAgo = Date.now() - 3_600_000;
    run.tradeStamps = run.tradeStamps.filter((t) => t >= hourAgo);
    if (run.tradeStamps.length >= r.maxTradesPerHour) {
      run.status.lastLine = `hourly cap reached (${r.maxTradesPerHour}) — waiting`;
      schedule(run, 60_000);
      return;
    }
    const gapLeft = globalGapLeft();
    if (gapLeft > 0) {
      run.status.lastLine = 'another group traded a moment ago — spacing lab trades';
      schedule(run, gapLeft + between(500, 2_000));
      return;
    }
    const active = host.activePublicKey();
    const members = host
      .members(groupId)
      .filter((m) => m.publicKey !== active)
      .filter((m) => !run.walletFilter || run.walletFilter.has(m.id));
    // Across EVERY run, not just this one: two groups can share a wallet, and
    // counting only this run's bags let each of them open maxOpenPerWallet on
    // the same wallet (audit lab-10).
    const openCount = (walletId: string): number =>
      [...runs.values()].reduce((n, x) => n + x.status.open.filter((o) => o.walletId === walletId).length, 0);
    const eligible = members.filter((m) => openCount(m.id) < r.maxOpenPerWallet);
    if (!eligible.length) {
      run.status.lastLine = 'every wallet is at its open cap — waiting for sells';
      schedule(run, between(r.gapSecMin, r.gapSecMax) * 1000);
      return;
    }
    const wallet = eligible[Math.floor(Math.random() * eligible.length)];
    const bal = await host.balanceSol(wallet.publicKey);
    const sol = pickTradeSol(r, bal);
    if (sol === null) {
      run.status.lastLine = `${wallet.label}: balance too low for the minimum trade — skipping`;
      schedule(run, between(r.gapSecMin, r.gapSecMax) * 1000);
      return;
    }
    const held = new Set(run.status.open.filter((o) => o.walletId === wallet.id).map((o) => o.mint));
    const pool = (await host.candidates(r.universe, r.minLiquidityUsd)).filter((c) => !held.has(c.mint));
    if (!pool.length) {
      run.status.lastLine = `no ${r.universe} token clears ${r.minLiquidityUsd.toLocaleString()} USD liquidity right now — waiting`;
      schedule(run, 60_000);
      return;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    run.status.lastLine = `${wallet.label}: buying ${sol} SOL of ${pick.symbol || pick.mint.slice(0, 6)}`;
    push();
    lastTradeAt = Date.now();
    const res = await host.buy(wallet.id, pick.mint, sol);
    if (!live(run)) return; // a newer run replaced this one mid-buy; its bag is recorded below regardless
    run.tradeStamps.push(Date.now());
    // A broadcast-but-unconfirmed buy really did spend SOL and really does
    // hold tokens: the ledger records a fill for it, so it opens a bag and
    // its signature counts. A buy that got no further than a failure has no
    // fill behind it, so its signature must stay out of the cash set — it
    // could never be priced and would blind the loss cap forever.
    const landed = res.ok || res.stage === 'pending';
    if (res.signature && landed) run.signatures.push(res.signature);
    if (!landed) {
      run.status.failed++;
      run.status.lastLine = `${wallet.label}: buy failed — ${res.message.slice(0, 120)}`;
      host.log('warn', `lab random: ${run.status.lastLine}`);
    } else {
      run.status.buys++;
      const holdMs = between(r.holdSecMin, r.holdSecMax) * 1000;
      const open: RandomOpen = {
        walletId: wallet.id,
        mint: pick.mint,
        symbol: pick.symbol,
        boughtAt: Date.now(),
        sellAt: Date.now() + holdMs,
        // Display only: the simulated wallet delta when known, else the size
        // sent. The loss cap prices this bag from `buySig` instead.
        costSol: res.costSol ?? sol,
        buySig: res.signature,
      };
      run.status.open.push(open);
      const unconfirmed = res.ok ? '' : ' (broadcast, still confirming)';
      run.status.lastLine = `${wallet.label}: bought ${pick.symbol || pick.mint.slice(0, 6)} for ${sol} SOL${unconfirmed} — sells in ${Math.round(holdMs / 1000)} s`;
      host.log('info', `lab random: ${run.status.lastLine}`);
      armSell(groupId, open, holdMs);
    }
    schedule(run, between(r.gapSecMin, r.gapSecMax) * 1000);
  } catch (e) {
    run.status.lastLine = `error: ${e instanceof Error ? e.message : String(e)}`;
    host.log('warn', `lab random: ${run.status.lastLine}`);
    schedule(run, 30_000);
  } finally {
    run.busy = false;
    persist();
    push();
  }
}

/** Across EVERY run: a lab BUY never goes out within this of any other lab
 *  trade. Twenty groups at a 5 s gap each was 160 trades a minute — three
 *  times the keyed host's whole free budget (rate-limit swarm, 2026-09-06).
 *  Each trade is ~10 RPC calls plus a Discover assembly, so ten seconds
 *  keeps the lab under a tenth of the budget and leaves the user's own
 *  orders room. Sells are exits: they move the clock but are never held. */
const GLOBAL_TRADE_GAP_MS = 10_000;
let lastTradeAt = 0;
function globalGapLeft(): number {
  return Math.max(0, lastTradeAt + GLOBAL_TRADE_GAP_MS - Date.now());
}

function armSell(groupId: string, open: RandomOpen, ms: number): void {
  const run = runs.get(groupId);
  if (!run) return;
  const k = key(open.walletId, open.mint);
  const prev = run.sellTimers.get(k);
  if (prev) clearTimeout(prev);
  run.sellTimers.set(
    k,
    setTimeout(() => {
      void sellOpen(groupId, open).catch((e) => host?.log('warn', `lab random: sell threw — ${e instanceof Error ? e.message : String(e)}`));
    }, Math.max(0, ms)),
  );
}

async function sellOpen(groupId: string, open: RandomOpen): Promise<void> {
  const run = runs.get(groupId);
  if (!run || !host) return;
  const k = key(open.walletId, open.mint);
  run.sellTimers.delete(k);
  const label = host.members(groupId).find((m) => m.id === open.walletId)?.label ?? open.walletId.slice(0, 6);
  const name = open.symbol || open.mint.slice(0, 6);
  const tries = ((open as RandomOpen & { tries?: number }).tries ?? 0) + 1;
  const requeue = (ms: number, line: string): void => {
    run.status.open = run.status.open.filter((o) => !(o.walletId === open.walletId && o.mint === open.mint));
    const next = { ...open, sellAt: Date.now() + ms, tries } as RandomOpen & { tries?: number };
    run.status.open.push(next);
    run.status.lastLine = line;
    armSell(groupId, next, ms);
  };
  try {
    if (!host.armed()) {
      // Cannot sign while disarmed. Keep looking, never forget the bag.
      requeue(DISARMED_RETRY_MS, `${label}: cannot sell ${name} while live execution is disarmed — retrying every minute`);
      host.log('warn', `lab random: ${run.status.lastLine}`);
      return;
    }
    // A sell is an exit and is never held back; it does move the clock, so
    // the next BUY anywhere keeps its distance from it.
    lastTradeAt = Date.now();
    const res = await host.sell(open.walletId, open.mint);
    // Same rule as the buy: only a signature the ledger actually recorded a
    // fill for can ever be priced, and only those enter the cash set.
    if (res.signature && (res.ok || res.stage === 'pending')) {
      run.signatures.push(res.signature);
      // A bag whose buy was never priceable contributes nothing to this run's
      // PnL — counting its proceeds alone would show a phantom gain and make
      // the loss cap LESS likely to fire. Both legs stay out.
      if (!open.buySig) run.excluded.add(res.signature);
    }
    if (res.ok) {
      run.status.open = run.status.open.filter((o) => !(o.walletId === open.walletId && o.mint === open.mint));
      run.status.sells++;
      run.status.lastLine = `${label}: sold ${name}`;
      host.log('info', `lab random: ${run.status.lastLine}`);
    } else if (tries >= SELL_RETRY_MAX) {
      run.status.open = run.status.open.filter((o) => !(o.walletId === open.walletId && o.mint === open.mint));
      run.status.failed++;
      run.status.lastLine = `${label}: could not sell ${name} after ${tries} tries (${res.message.slice(0, 80)}) — it is still in that wallet; sell it from Copier → Sell 100 % on the group, mint ${open.mint}`;
      host.log('error', `lab random: ${run.status.lastLine}`);
    } else {
      run.status.failed++;
      const wait = SELL_RETRY_BASE_MS * 2 ** (tries - 1);
      requeue(wait, `${label}: sell of ${name} failed (${res.message.slice(0, 80)}) — retry ${tries + 1}/${SELL_RETRY_MAX} in ${Math.round(wait / 60_000)} min`);
      host.log('warn', `lab random: ${run.status.lastLine}`);
    }
  } catch (e) {
    // A throw is a failed attempt, never a lost bag.
    const msg = e instanceof Error ? e.message : String(e);
    if (tries >= SELL_RETRY_MAX) {
      run.status.open = run.status.open.filter((o) => !(o.walletId === open.walletId && o.mint === open.mint));
      run.status.failed++;
      run.status.lastLine = `${label}: could not sell ${name} after ${tries} tries (${msg.slice(0, 80)}) — still in that wallet, mint ${open.mint}`;
      host.log('error', `lab random: ${run.status.lastLine}`);
    } else {
      run.status.failed++;
      const wait = SELL_RETRY_BASE_MS * 2 ** (tries - 1);
      requeue(wait, `${label}: sell of ${name} threw (${msg.slice(0, 80)}) — retry in ${Math.round(wait / 60_000)} min`);
      host.log('warn', `lab random: ${run.status.lastLine}`);
    }
  } finally {
    const realized = realizedOf(run);
    run.status.realizedSol = realized.sol;
    if (run.status.running) {
      if (realized.sol === null) {
        // Same rule as the tick: an unpriceable fill is not a zero. The sell
        // just recorded is normally pending for a couple of seconds, so this
        // only stops the run once the blindness outlasts the grace.
        if (blindTooLong(run)) {
          stop(groupId, `cannot price ${realized.unknown} fill(s) yet — stopped rather than trade blind to the loss cap`);
        }
      } else {
        run.blindSince = null;
        if (lossCapHit(realized.sol, run.status.maxLossSol)) {
          stop(groupId, `loss cap reached (${realized.sol.toFixed(4)} SOL realised on closed trades)`);
        }
      }
    }
    persist();
    push();
  }
}

/** True once the loss cap has been unjudgeable for longer than the grace. The
 *  first call only starts the clock — unless the grace is zero, which is how
 *  the tests pin "a pending fill stops the run". */
function blindTooLong(run: Run): boolean {
  const now = Date.now();
  if (run.blindSince === null) {
    run.blindSince = now;
    return unknownGraceMs <= 0;
  }
  return now - run.blindSince >= unknownGraceMs;
}

/** Test seam. */
/** Tests drive ticks by hand; the global lab spacing is not what they measure. */
const resetTradeClock = (): void => {
  lastTradeAt = 0;
};
/** Tests pin the blind-stop deterministically instead of waiting a minute. */
const setUnknownGraceMs = (ms: number): void => {
  unknownGraceMs = ms;
};

export const __internals = { runs, tick, sellOpen, realizedOf, resetTradeClock, setUnknownGraceMs };
