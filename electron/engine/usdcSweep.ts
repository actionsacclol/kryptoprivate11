// Auto-swap USDC to SOL — the runner.
//
// Reads every Solana wallet's USDC on a slow timer, and sooner when the
// active wallet's holdings change (a reward landing is exactly that), and
// hands each balance the decision in shared/usdcSweep.ts says to swap to the
// SAME swap path the Swap page and the rewards panel use — `swap.execute`
// with the wallet's id — so the platform fee, the receipt check and the
// signer policy are the ones every swap gets. Nothing here signs, prices or
// bills anything itself.
//
// Everything it touches is injected, so the runner is tested with stubs and
// the module bundles alone.

import {
  USDC_SWEEP_KICK_DEBOUNCE_MS,
  USDC_SWEEP_MIN_USDC,
  USDC_SWEEP_POLL_MS,
  sweepDecision,
  usdcFromRaw,
  type SweepWalletState,
} from '@shared/usdcSweep';

export interface UsdcSweepDeps {
  /** The setting: execution.autoSwapUsdc (absent = on). */
  enabled(): boolean;
  /** Live armed AND live mode — what a swap needs. */
  live(): boolean;
  /** Every Solana wallet this app holds a key for. */
  wallets(): Array<{ id: string; publicKey: string; label: string }>;
  /** The wallet's USDC in base units, or null when it could not be read. */
  usdcHeld(publicKey: string): Promise<bigint | null>;
  /** The swap itself: USDC (human units) → SOL, signed by that wallet. */
  swap(walletId: string, usdc: number): Promise<{ ok: boolean; message: string; signature?: string }>;
  log(level: 'info' | 'warn', line: string): void;
  /** A toast + notification for a swap that landed. Optional. */
  announce?(line: string): void;
  now?(): number;
}

let deps: UsdcSweepDeps | null = null;
const state = new Map<string, SweepWalletState>();
let timer: ReturnType<typeof setInterval> | null = null;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let passing = false;
/** Wallets whose "below minimum" / "unknown" was already logged, so a poll
 *  does not repeat the same line every five minutes. */
const quiet = new Set<string>();

export function attach(d: UsdcSweepDeps): void {
  deps = d;
}

export function start(pollMs = USDC_SWEEP_POLL_MS): void {
  if (timer) return;
  timer = setInterval(() => void runPass(), pollMs);
  timer.unref?.();
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (kickTimer) clearTimeout(kickTimer);
  kickTimer = null;
}

/** Something changed in a wallet — run a pass soon (debounced). */
export function kick(debounceMs = USDC_SWEEP_KICK_DEBOUNCE_MS): void {
  if (!deps) return;
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void runPass();
  }, debounceMs);
  kickTimer.unref?.();
}

function stateOf(id: string): SweepWalletState {
  let s = state.get(id);
  if (!s) {
    s = { lastAttemptAt: null, inFlight: false };
    state.set(id, s);
  }
  return s;
}

/**
 * One pass over every wallet. Sequential: two swaps signing at once from two
 * wallets is fine for the chain but not for the log a person reads, and a
 * reward is not a race. Never throws.
 */
export async function runPass(): Promise<{ swapped: number; skipped: number }> {
  const d = deps;
  if (!d || passing) return { swapped: 0, skipped: 0 };
  passing = true;
  let swapped = 0;
  let skipped = 0;
  try {
    const now = d.now?.() ?? Date.now();
    const enabled = d.enabled();
    const live = d.live();
    // Off or disarmed: nothing to read either — a disarmed app should not be
    // spending RPC calls on a sweep it cannot make.
    if (!enabled || !live) return { swapped: 0, skipped: d.wallets().length };
    for (const w of d.wallets()) {
      const st = stateOf(w.id);
      // The cheap gates first, before any read: probe with a balance that
      // would pass the minimum, so only in-flight / cooldown can say no here.
      const pre = sweepDecision(USDC_SWEEP_MIN_USDC, st, { enabled, live, now });
      if (!pre.swap) {
        skipped += 1;
        continue;
      }
      let raw: bigint | null = null;
      try {
        raw = await d.usdcHeld(w.publicKey);
      } catch {
        raw = null;
      }
      const usdc = raw === null ? null : usdcFromRaw(raw);
      const decision = sweepDecision(usdc, st, { enabled, live, now });
      if (!decision.swap) {
        skipped += 1;
        // Say it once per wallet, not every five minutes.
        if ((decision.why === 'below minimum' && usdc !== null && usdc > 0) || decision.why === 'unknown balance') {
          const key = `${w.id}:${decision.why}`;
          if (!quiet.has(key)) {
            quiet.add(key);
            d.log('info', `auto-swap: ${label(w)} — ${decision.why === 'unknown balance' ? 'USDC balance could not be read' : `${usdc!.toFixed(2)} USDC is under the minimum, left alone`}`);
          }
        }
        continue;
      }
      quiet.delete(`${w.id}:below minimum`);
      quiet.delete(`${w.id}:unknown balance`);
      st.inFlight = true;
      st.lastAttemptAt = now;
      try {
        const r = await d.swap(w.id, usdc!);
        if (r.ok) {
          swapped += 1;
          const line = `auto-swap: ${usdc!.toFixed(2)} USDC → SOL in ${label(w)}: ${r.message}`;
          d.log('info', line);
          d.announce?.(`Swapped ${usdc!.toFixed(2)} USDC to SOL in ${w.label || 'your wallet'}`);
        } else {
          d.log('warn', `auto-swap: ${usdc!.toFixed(2)} USDC in ${label(w)} NOT swapped — ${r.message} (next try in 10 min)`);
        }
      } catch (err) {
        d.log('warn', `auto-swap: ${label(w)} — ${(err as Error)?.message ?? 'the swap failed'} (next try in 10 min)`);
      } finally {
        st.inFlight = false;
      }
    }
    return { swapped, skipped };
  } finally {
    passing = false;
  }
}

function label(w: { label: string; publicKey: string }): string {
  return w.label ? `"${w.label}" (${w.publicKey.slice(0, 6)}…)` : `${w.publicKey.slice(0, 8)}…`;
}

/** For tests. */
export function _reset(): void {
  stop();
  deps = null;
  state.clear();
  quiet.clear();
  passing = false;
}
