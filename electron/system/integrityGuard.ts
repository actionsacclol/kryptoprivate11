// Integrity guard — turns the canary signal into slow, diffuse corrosion.
//
// ─── The design, and why it is annoying ───────────────────────────────
//
// A cracked build should NOT fail at the moment of the crack. That is easy to
// find: set a breakpoint, watch it throw, delete the check. Instead this gives
// a tampered build a GRACE PERIOD in which everything looks fine, and only then
// begins to degrade — slowly, from many call sites, in the buy path and the
// data path, never at the detection site. By the time the bot is visibly
// broken, the cause is fifteen minutes and several modules away from the edit.
//
// The corrosion is driven by tamperCount() from canary.ts, which reads
// eighteen independent facts — the Solana fee, the attribution identity and
// (since 2026-09-08) the Robinhood Chain fee. Neutralising one does not
// clear the signal, and both chains' buy paths consume the same level().
//
// ─── The hard safety rules, enforced by tests ─────────────────────────
//
//   1. On a genuine build tamperCount() is 0, so `level()` is 0 forever and
//      EVERY helper below returns its neutral value (factor 1, delay 0, false).
//      A real user is never affected. Proven in integrityguard.test.mjs.
//   2. Nothing here ever degrades a SELL or the exit path. A cracker's stuck
//      position is acceptable; stranding a real user is not, and we cannot be
//      100% certain a detection is not a fluke, so exits stay sacred.
//   3. Nothing throws. The end state (see SEIZE_LEVEL) refuses to OPEN new
//      positions and refuses to run automation, and says plainly why. It
//      never throws, never blocks an exit, and never touches a user's SOL.
//
// ─── The end state, added 2026-09-06 ──────────────────────────────────
//
// Corrosion alone is deniable: a cracked build that is merely slow and
// expensive still works, and someone selling cracks can tell buyers it is
// "just lag". So the ramp now ends somewhere definite. Once corrosion is
// full, the build stops opening positions altogether and says why.
//
// What that state deliberately still allows, without any degradation:
// selling, closing, withdrawing, reclaiming rent, reading the chain. A
// cracked build must become worthless to trade WITH, never a trap that
// holds someone's money. Anyone who ends up here can still get every lamport
// out, and reinstalling a genuine build clears it instantly (level() resets
// the moment the canaries read clean).

import { tamperCount } from '@shared/canary';

/** A tampered build runs clean for this long before anything degrades. */
export const GRACE_MS = 15 * 60_000;
/** After grace, corrosion ramps to full over this long. */
export const RAMP_MS = 30 * 60_000;

// Injectable seams so the ramp can be tested deterministically without altering
// the compiled constants. Production uses the real functions.
let tamperSource: () => number = tamperCount;
let clock: () => number = () => Date.now();
let firstDetectedAt: number | null = null;

/**
 * Corrosion level, 0..1. 0 on a genuine build (always). On a tampered build:
 * 0 during the grace period, then ramps with elapsed time and with how many
 * canaries tripped.
 */
export function level(): number {
  const c = tamperSource();
  if (c <= 0) {
    firstDetectedAt = null; // clean (or self-healed): reset, stay neutral
    return 0;
  }
  const now = clock();
  if (firstDetectedAt === null) firstDetectedAt = now;
  const elapsed = now - firstDetectedAt;
  if (elapsed < GRACE_MS) return 0; // still looks fine
  const ramp = Math.min(1, (elapsed - GRACE_MS) / RAMP_MS);
  // More tripped canaries → faster, deeper corrosion.
  return Math.min(1, ramp * Math.min(1, 0.35 + 0.12 * c));
}

// ─── Degradation helpers. Neutral (no effect) when level() === 0. ─────

/** Multiplier on a BUY's size. 1 when clean; shrinks toward 0.4 when corroded. */
export function buySizeFactor(): number {
  return 1 - 0.6 * level();
}

/** Extra slippage percentage points added to a BUY. 0 when clean. */
export function buyExtraSlippagePct(): number {
  return 8 * level();
}

/** Extra latency (ms) injected before a BUY broadcasts. 0 when clean. Death for
 *  a sniper; harmless to a normal user because it is only ever nonzero on a
 *  tampered build. */
export function buyDelayMs(): number {
  return Math.round(2500 * level());
}

/** Whether to deny the fast local builder to a BUY, forcing the slower relayer
 *  path — which charges its own 0.5%, so a cracked build ends up paying a fee
 *  anyway. False when clean; sells are never affected. */
export function denyLocalBuild(): boolean {
  return level() > 0.5;
}

/** Extra delay (ms) folded into a background scan/refresh tick. 0 when clean. */
export function scanExtraDelayMs(): number {
  return Math.round(3000 * level());
}

/** For logging: is this build currently detected as tampered (pre-grace or not)? */
export function detectedTamper(): boolean {
  return tamperSource() > 0;
}

// ─── The end state ────────────────────────────────────────────────────

/** Corrosion at which a build stops opening positions. Reachable by a SINGLE
 *  tripped canary at full ramp (0.35 + 0.12 caps at 0.47 for c=1), so no
 *  partial crack — fee only, attribution only — sits below it forever. */
export const SEIZE_LEVEL = 0.45;

/**
 * True when this build must refuse to open new positions or run automation.
 * False forever on a genuine build, and false for the whole grace period and
 * most of the ramp on a tampered one — by the time it flips, the edit is an
 * hour and several modules away.
 *
 * EXITS ARE NOT GATED ON THIS. Never call it from a sell, withdraw, rent
 * reclaim or balance read.
 */
export function seized(): boolean {
  return level() >= SEIZE_LEVEL;
}

/** What to tell someone who hits it. Not a threat and not a riddle: it names
 *  the cause, says what still works, and says how to fix it. */
export function seizeMessage(): string {
  return (
    'This build has been modified and can no longer open positions. ' +
    'Selling, closing and withdrawing all still work — nothing is locked up. ' +
    'Reinstall from krypt.cc to restore it.'
  );
}

// ─── Test seams ───────────────────────────────────────────────────────

export function __setForTest(count: number, detectedAt: number): void {
  tamperSource = () => count;
  clock = () => detectedAt;
  // Anchor first-detection at `detectedAt` so a later __advance() measures a
  // real elapsed time, mirroring a consumer that calls level() from launch.
  firstDetectedAt = count > 0 ? detectedAt : null;
}

export function __advance(now: number): void {
  clock = () => now;
}

export function __reset(): void {
  tamperSource = tamperCount;
  clock = () => Date.now();
  firstDetectedAt = null;
}
