// Lite mode's two attachment points.
//
// LiteModeHost is a null leaf, like HotkeyHost: it is the one place that
// subscribes to app state for `reduceEffects`, and it mirrors the setting into
// the lite store (which puts the class on <html>). App itself never
// subscribes — the engine's 1/s push would re-render every route.
//
// LiteMotion wraps the tree in framer-motion's MotionConfig. `always` skips
// transform and layout animation (opacity and colour are kept — they are
// cheap and carry meaning), `user` is the library's default. It reads the
// store, not app state, so it re-renders only when the mode flips.

import { useEffect, type ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import { useAppState } from '../state/AppStateProvider';
import { setLite } from '../state/liteMode';
import { useLite } from '../state/useLite';

export function LiteModeHost(): null {
  const { settings } = useAppState();
  const reduce = settings.reduceEffects;
  useEffect(() => {
    setLite(reduce);
  }, [reduce]);
  return null;
}

export function LiteMotion({ children }: { children: ReactNode }) {
  const lite = useLite();
  return <MotionConfig reducedMotion={lite ? 'always' : 'user'}>{children}</MotionConfig>;
}
