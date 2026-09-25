// Buyer acceleration over a launch's evaluation window.
//
// Pure so it can be tested on its own: the engine feeds it the buys it
// received inside the window (never the rolling `trades` list, which is
// trimmed on busy coins). Before the window closes the split is at the middle
// of the time elapsed so far; once it closes the split is fixed and the value
// stops moving, however long the launch stays tracked (Don, 2026-09-24).

export interface EvalBuy {
  at: number;
  user: string;
}

/**
 * Distinct buyers in the second half over distinct buyers in the first.
 * A wallet buying in both halves counts once in each. 2 when only the second
 * half has buyers, 0 when neither does.
 */
export function buyerAcceleration(buys: readonly EvalBuy[], windowStart: number, evalDeadline: number, now: number): number {
  const half = windowStart + (Math.min(now, evalDeadline) - windowStart) / 2;
  const first = new Set<string>();
  const second = new Set<string>();
  for (const b of buys) {
    if (b.at > evalDeadline) continue;
    if (b.at <= half) first.add(b.user);
    else second.add(b.user);
  }
  return first.size > 0 ? second.size / first.size : second.size > 0 ? 2 : 0;
}
