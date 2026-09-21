// Is Krypt's fee halved right now ($KRYPTO holder)? One answer, shared by every screen.
//
// The holder rate was visible on the Hub card and nowhere else, which made the
// Trade panel say "incl. Krypt 0.5% per side" at the exact moment a holder
// committed money and was about to be charged half that (found 2026-09-16).
// A cost shown where the decision is made has to be the cost that will be
// taken, so every place that names the fee reads this.
//
// Module-level, not a context: several panels can be open at once and they
// must not each poll. One timer, one in-flight request, every subscriber
// updated together — so the Trade panel and the Hub card can never disagree
// about what the next trade costs.
//
// It is a MIRROR of main's answer, never its own judgement. `halved` comes
// from `kryptoHolding.holderRateApplies()`, the same call the signer makes,
// so the screen cannot claim a discount the signer will not honour. Until
// the first read lands, and whenever one fails, `halved` is false — the same
// direction main errs in, so the UI never promises half and then charges full.

import { useEffect, useState } from 'react';
import type { KryptoHolding } from '@shared/krypto';

export type WaiverState = KryptoHolding & { halved: boolean; thresholdTokens: number };

const UNKNOWN: WaiverState = {
  tokens: 0,
  usd: null,
  wallets: 0,
  at: 0,
  problem: null,
  halved: false,
  thresholdTokens: 0,
};

let state: WaiverState = UNKNOWN;
const listeners = new Set<(s: WaiverState) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<string | null> | null = null;

/** How often the shared answer is refreshed while anything is watching. */
const POLL_MS = 30_000;

/**
 * One read. `fresh` asks main to re-read the chain before answering — the
 * Scan button — instead of handing back its cache.
 *
 * Resolves to why the read did not land, or null when it did. A poll
 * ignores that; a scan shows it, because a user who pressed a button and
 * saw nothing change would be left guessing — which is exactly how the
 * missing preload entry went unnoticed: every call threw, every throw was
 * swallowed, and the card said "not checked yet" for days.
 */
async function read(fresh = false): Promise<string | null> {
  if (inFlight) {
    // A poll that finds one running has nothing to add. A scan does: it
    // must produce a read that STARTED after the click, so it waits its
    // turn rather than being dropped.
    if (!fresh) return null;
    await inFlight;
  }
  const run = (async (): Promise<string | null> => {
    try {
      const r = await window.krypt.krypto.holding(fresh);
      if (!r.ok || !r.data) return r.message || 'no answer from the app';
      state = r.data;
      for (const fn of listeners) fn(state);
      return null;
    } catch (e) {
      // Leave the last answer in place. A failed poll is not evidence that
      // the holding changed, and flipping to "charged" on one dropped IPC
      // call would make the panel flicker between two different prices.
      return (e as Error)?.message || 'the read failed';
    }
  })();
  // Assigned AFTER the call is issued, and cleared by the promise rather
  // than inside it: a call that throws synchronously (the bridge missing)
  // settles before this line runs, and clearing from inside would leave
  // `inFlight` pointing at a finished promise for good, which would stop
  // every later poll at the first line of this function.
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}

/**
 * The live holder rate, for any screen that names the fee.
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

/**
 * Re-read the chain now — the Scan button, or right after a wallet is
 * added. Resolves to null when the reading was refreshed, or to the reason
 * it was not, for the caller to show. The reading itself reaches every
 * subscriber through the hook as usual.
 */
export function refreshKryptoWaiver(): Promise<string | null> {
  return read(true);
}
