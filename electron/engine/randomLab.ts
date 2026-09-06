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
  buy(walletId: string, mint: string, sol: number): Promise<{ ok: boolean; message: string; signature: string | null; costSol: number | null }>;
  sell(walletId: string, mint: string): Promise<{ ok: boolean; message: string; signature: string | null }>;
  /** Realised SOL (cash delta) across the given signatures, from reconciled fills. */
  realizedFor(signatures: string[]): number;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  emit(runs: RandomRunStatus[]): void;
}

interface Run {
  /** Bumped on every start(); a callback from an older generation bails. */
  gen: number;
  status: RandomRunStatus;
  walletFilter: Set<string> | null;
  signatures: string[];
  /** Realised cash at start(), so a restarted run is judged from zero. */
  capBaseline: number;
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

let host: RandomHost | null = null;
let file = '';
const runs = new Map<string, Run>();

function persist(): void {
  if (!file) return;
  try {
    const rows = [...runs.values()].map((r) => ({ groupId: r.status.groupId, open: r.status.open, signatures: r.signatures.slice(-400) }));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs: rows }), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort; the in-memory state is what trades */
  }
}

/** Load persisted open bags so a restart never forgets what a wallet holds. */
export function init(userDataDir: string): number {
  file = path.join(userDataDir, 'lab-runs.json');
  let restored = 0;
  try {
    if (!fs.existsSync(file)) return 0;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { runs?: Array<{ groupId: string; open: RandomOpen[]; signatures: string[] }> };
    for (const row of raw.runs ?? []) {
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
          realizedSol: 0,
          maxLossSol: 0,
          open,
          nextActionAt: null,
          lastLine: open.length ? `${open.length} open position(s) restored from the last session` : null,
        },
        walletFilter: null,
        signatures: Array.isArray(row.signatures) ? row.signatures.filter((s) => typeof s === 'string') : [],
        capBaseline: 0,
        tradeStamps: [],
        nextTimer: null,
        sellTimers: new Map(),
        busy: false,
      };
      runs.set(row.groupId, run);
      for (const o of open) armSell(row.groupId, o, Math.max(5_000, o.sellAt - Date.now()));
      restored += open.length;
    }
  } catch {
    /* a corrupt file must not stop the app; it is rewritten on the next change */
  }
  return restored;
}

export function attach(h: RandomHost): void {
  host = h;
}

function realizedOf(run: Run): number {
  if (!host) return run.status.realizedSol;
  // Cash delta of every fill of this run, PLUS the cost of bags still held
  // (a buy is not a loss until its sell lands), MINUS what the run had
  // already realised before this start.
  const held = run.status.open.reduce((a, o) => a + (o.costSol ?? 0), 0);
  return host.realizedFor(run.signatures) + held - run.capBaseline;
}

export function status(): RandomRunStatus[] {
  for (const r of runs.values()) r.status.realizedSol = realizedOf(r);
  return [...runs.values()].map((r) => ({ ...r.status, open: [...r.status.open] }));
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
  const heldCost = inheritedOpen.reduce((a, o) => a + (o.costSol ?? 0), 0);
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
    // Judge this run from zero: whatever the inherited fills realised is the
    // baseline, and inherited bags are carried at cost.
    capBaseline: (host.realizedFor(inheritedSigs) + heldCost),
    tradeStamps: [],
    nextTimer: null,
    sellTimers: existing?.sellTimers ?? new Map(),
    busy: false,
  };
  runs.set(groupId, run);
  host.log('info', `lab random: started on group ${groupId} (${members.length} wallet(s), loss cap ${cfg.random.maxLossSol} SOL)`);
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
    run.status.realizedSol = realizedOf(run);
    if (lossCapHit(run.status.realizedSol, r.maxLossSol)) {
      stop(groupId, `loss cap reached (${run.status.realizedSol.toFixed(4)} SOL realised on closed trades)`);
      return;
    }
    const hourAgo = Date.now() - 3_600_000;
    run.tradeStamps = run.tradeStamps.filter((t) => t >= hourAgo);
    if (run.tradeStamps.length >= r.maxTradesPerHour) {
      run.status.lastLine = `hourly cap reached (${r.maxTradesPerHour}) — waiting`;
      schedule(run, 60_000);
      return;
    }
    const active = host.activePublicKey();
    const members = host
      .members(groupId)
      .filter((m) => m.publicKey !== active)
      .filter((m) => !run.walletFilter || run.walletFilter.has(m.id));
    const openCount = (walletId: string): number => run.status.open.filter((o) => o.walletId === walletId).length;
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
    const res = await host.buy(wallet.id, pick.mint, sol);
    if (!live(run)) return; // a newer run replaced this one mid-buy; its bag is recorded below regardless
    run.tradeStamps.push(Date.now());
    if (res.signature) run.signatures.push(res.signature);
    if (!res.ok) {
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
        // Carried at cost until sold; the simulated wallet delta when known,
        // else the size sent.
        costSol: res.costSol ?? sol,
      };
      run.status.open.push(open);
      run.status.lastLine = `${wallet.label}: bought ${pick.symbol || pick.mint.slice(0, 6)} for ${sol} SOL — sells in ${Math.round(holdMs / 1000)} s`;
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
    const res = await host.sell(open.walletId, open.mint);
    if (res.signature) run.signatures.push(res.signature);
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
    run.status.realizedSol = realizedOf(run);
    if (run.status.running && lossCapHit(run.status.realizedSol, run.status.maxLossSol)) {
      stop(groupId, `loss cap reached (${run.status.realizedSol.toFixed(4)} SOL realised on closed trades)`);
    }
    persist();
    push();
  }
}

/** Test seam. */
export const __internals = { runs, tick, sellOpen, realizedOf };
