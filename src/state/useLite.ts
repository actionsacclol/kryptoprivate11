// The React side of Lite mode — see liteMode.ts for what it is and why it
// lives in a store of its own.

import { useSyncExternalStore } from 'react';
import { getLite, subscribe } from './liteMode';

/** True while Lite mode is on. Re-renders the caller only when it flips. */
export function useLite(): boolean {
  return useSyncExternalStore(subscribe, getLite, getLite);
}
