// The React side of the look — see skin.ts for what it is and why it lives
// in a store of its own.

import { useSyncExternalStore } from 'react';
import { getSkin, subscribe, type SkinId } from './skin';

/** The look on screen right now. Re-renders the caller only when it changes. */
export function useSkin(): SkinId {
  return useSyncExternalStore(subscribe, getSkin, getSkin);
}
