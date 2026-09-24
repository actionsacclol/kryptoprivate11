// Reading pump.fun sign-in status on a page, names included.
//
// A username is filled in by main in the BACKGROUND when the sign-in read
// missed it (pumpAuth.refreshNamesSoon, 2026-09-23 — three of five accounts
// showed an address where pump had a name). A page that read status once on
// open would keep showing the address until it was reopened, so this reads
// again a little later — twice at most, and only while a name is missing.

import { useEffect, useState } from 'react';
import type { PumpAuthStatus } from '@shared/pumpAuth';

const RETRY_MS = [12_000, 40_000];

/** Read now; re-read while any signed-in account still has no name. Returns
 *  a cleanup for useEffect. */
export function loadPumpStatus(set: (s: PumpAuthStatus) => void): () => void {
  let alive = true;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const read = (attempt: number): void => {
    void window.krypt.pump.status().then((r) => {
      if (!alive || !r.ok || !r.data) return;
      set(r.data);
      const missing = r.data.sessions.some((s) => !s.username);
      if (missing && attempt < RETRY_MS.length) {
        timers.push(setTimeout(() => read(attempt + 1), RETRY_MS[attempt] - (attempt > 0 ? RETRY_MS[attempt - 1] : 0)));
      }
    });
  };
  read(0);
  return () => {
    alive = false;
    for (const t of timers) clearTimeout(t);
  };
}

/** The same, as a hook, for a component that only displays the status. */
export function usePumpStatus(): PumpAuthStatus | null {
  const [status, setStatus] = useState<PumpAuthStatus | null>(null);
  useEffect(() => loadPumpStatus(setStatus), []);
  return status;
}
