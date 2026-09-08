// "Reduce effects" — the switch that keeps the WebGL scenes off a machine
// whose graphics driver cannot take them.
//
// The scenes are decoration that renders every frame through the GPU
// driver; that is the one thing a user-mode app does that can provoke a bad
// driver into a blue screen (a user's BSOD, 2026-09-08). The setting is read
// before a scene mounts, and a scene is never mounted while it is unknown:
// the point of the switch is that a WebGL context is never created, and a
// context that exists for the 50 ms before the answer arrives has already
// touched the driver.

import { useEffect, useState } from 'react';

/** Null until the setting has been read; true = keep the scenes off. */
export function useReduceEffects(): boolean | null {
  const [reduce, setReduce] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void window.krypt.settings
      .get()
      .then((r) => {
        if (!alive) return;
        // An unreadable settings store is not a reason to skip the scene —
        // the default is on, and the default is what the store would say.
        setReduce(r.ok && r.data ? r.data.reduceEffects : false);
      })
      .catch(() => {
        if (alive) setReduce(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return reduce;
}

/** What stands in for a scene while it is off (or not yet known). */
export function EffectsOff({ label }: { label: string }): JSX.Element {
  return (
    <div className="absolute inset-0 flex items-end justify-end p-3 pointer-events-none" aria-hidden="true">
      <span className="font-display text-[10px] uppercase tracking-[0.22em] text-krypt-muted/70">{label}</span>
    </div>
  );
}
