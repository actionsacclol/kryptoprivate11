// Is Krypt's fee waived right now? One answer, shared by every screen.
//
// The waiver was visible on the Hub card and nowhere else, which made the
// Trade panel say "incl. Krypt 0.5% per side" at the exact moment a holder
// committed money and was about to be charged nothing (found 2026-09-16).
// A cost shown where the decision is made has to be the cost that will be
// taken, so every place that names the fee reads this.
//
// Module-level, not a context: several panels can be open at once and they
// must not each poll. One timer, one in-flight request, every subscriber
// updated together — so the Trade panel and the Hub card can never disagree
// about whether the next trade is free.
//
// It is a MIRROR of main's answer, never its own judgement. `waived` comes
// from `kryptoHolding.feeWaived()`, the same call the signer makes, so the
// screen cannot claim a waiver the signer will not honour. Until the first
// read lands, and whenever one fails, `waived` is false — the same direction
// main errs in, so the UI never promises free and then charges.

import { useEffect, useState } from 'react';
import type { KryptoHolding } from '@shared/krypto';

export type WaiverState = KryptoHolding & { waived: boolean; thresholdTokens: number };

const UNKNOWN: WaiverState = {
  tokens: 0,
  usd: null,
  wallets: 0,
  at: 0,
  problem: null,
  waived: false,
  thresholdTokens: 0,
};

let state: WaiverState = UNKNOWN;
const listeners = new Set<(s: WaiverState) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** How often the shared answer is refreshed while anything is watching. */
const POLL_MS = 30_000;

async function read(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const r = await window.krypt.krypto.holding();
    if (r.ok && r.data) {
      state = r.data;
      for (const fn of listeners) fn(state);
    }
  } catch {
    // Leave the last answer in place. A failed poll is not evidence that the
    // holding changed, and flipping to "charged" on one dropped IPC call
    // would make the panel flicker between two different prices.
  } finally {
    inFlight = false;
  }
}

/**
 * The live waiver, for any screen that names the fee.
 *
 * Polling starts with the first subscriber and stops with the last, so a
 * user who never opens a screen that mentions fees never pays for the check.
 */
export function useKryptoWaiver(): WaiverState {
  const [local, setLocal] = useState<WaiverState>(state);
  useEffect(() => {
    listeners.add(setLocal);
    if (listeners.size === 1) {
      void read();
      timer = setInterval(() => void read(), POLL_MS);
    } else {
      // A later subscriber gets the answer already in hand rather than
      // rendering "charged" for a poll interval.
      setLocal(state);
    }
    return () => {
      listeners.delete(setLocal);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return local;
}

/** Ask for a fresh read now — after a trade, or when a wallet changes. */
export function refreshKryptoWaiver(): void {
  void read();
}
