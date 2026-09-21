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
import { setTheme } from '../state/theme';
import { setSkin } from '../state/skin';
import { useLite } from '../state/useLite';

export function LiteModeHost(): null {
  const { settings } = useAppState();
  const reduce = settings.reduceEffects;
  // The accent rides along here rather than in its own leaf: both are
  // one-line mirrors of a Display setting onto <html>, and a second
  // subscriber to app state would be a second component re-rendering on
  // the engine's 1/s push for no reason.
  const theme = settings.theme;
  const skin = settings.skin;
  useEffect(() => {
    setLite(reduce);
  }, [reduce]);
  useEffect(() => {
    if (theme) setTheme(theme);
  }, [theme]);
  useEffect(() => {
    if (skin) setSkin(skin);
  }, [skin]);
  return null;
}

export function LiteMotion({ children }: { children: ReactNode }) {
  const lite = useLite();
  return <MotionConfig reducedMotion={lite ? 'always' : 'user'}>{children}</MotionConfig>;
}
