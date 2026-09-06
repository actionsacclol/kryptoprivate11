// Auto-sell templates: the exit you decided on once, armed on every buy.
//
// Every primitive this needs already exists — stop loss, take profit,
// trailing stop, sell-on-dev-sell, partial sells from 1 to 100 % — but each
// had to be typed by hand, per token, after each buy. In a twenty-launch
// session that is sixty form fills, and the stop that only exists in your
// head is the one that does not save you.
//
// A template is a plan, not an automation: it places the same advanced
// orders you would have written yourself, they appear on the Orders page
// like any other, and you can cancel them. Nothing here decides to trade —
// it decides what protection to arm the moment you decide to.
//
// Pure: the engine and the page share this file, and a test pins the
// expansion, because an exit ladder that silently sells more than 100 % of a
// position is the worst possible bug in it.

import { validateOrder, type NewOrderRequest } from './orders';

export interface TakeProfitStep {
  /** Gain that triggers it, percent above the entry. */
  gainPct: number;
  /** How much of the REMAINING position to sell, percent. */
  sellPct: number;
}

export interface OrderTemplate {
  id: string;
  name: string;
  /** Percent below entry that closes the whole position. Null = no stop. */
  stopLossPct: number | null;
  /** Ladder, in the order given. At most MAX_TAKE_PROFITS. */
  takeProfits: TakeProfitStep[];
  /** Trailing stop, percent off the high. Null = none. */
  trailingPct: number | null;
  /** Exit if the creator sells — the one signal with a measured edge. */
  sellOnDevSell: boolean;
}

export const MAX_TAKE_PROFITS = 3;
export const MAX_TEMPLATES = 8;

/** What ships, so the feature is usable before anyone writes a template. */
export const BUILT_IN_TEMPLATES: OrderTemplate[] = [
  {
    id: 'builtin-runner',
    name: 'Runner',
    stopLossPct: 35,
    takeProfits: [
      { gainPct: 100, sellPct: 40 },
      { gainPct: 300, sellPct: 50 },
    ],
    trailingPct: 30,
    sellOnDevSell: true,
  },
  {
    id: 'builtin-scalp',
    name: 'Scalp',
    stopLossPct: 20,
    takeProfits: [{ gainPct: 40, sellPct: 100 }],
    trailingPct: null,
    sellOnDevSell: true,
  },
  {
    id: 'builtin-stop-only',
    name: 'Stop only',
    stopLossPct: 30,
    takeProfits: [],
    trailingPct: null,
    sellOnDevSell: false,
  },
];

export function emptyTemplate(id: string): OrderTemplate {
  return { id, name: 'New template', stopLossPct: 30, takeProfits: [{ gainPct: 100, sellPct: 50 }], trailingPct: null, sellOnDevSell: true };
}

export function validateTemplate(t: OrderTemplate): { ok: boolean; message: string } {
  if (!t.name.trim()) return { ok: false, message: 'Give the template a name' };
  if (t.name.length > 40) return { ok: false, message: 'Name is too long' };
  if (t.stopLossPct !== null && !(t.stopLossPct > 0 && t.stopLossPct < 100)) {
    return { ok: false, message: 'Stop loss must be between 0 and 100 %' };
  }
  if (t.trailingPct !== null && !(t.trailingPct > 0 && t.trailingPct < 100)) {
    return { ok: false, message: 'Trailing stop must be between 0 and 100 %' };
  }
  if (t.takeProfits.length > MAX_TAKE_PROFITS) {
    return { ok: false, message: `At most ${MAX_TAKE_PROFITS} take profits` };
  }
  for (const [i, tp] of t.takeProfits.entries()) {
    if (!(tp.gainPct > 0)) return { ok: false, message: `Take profit ${i + 1}: gain must be above 0 %` };
    if (!(tp.sellPct > 0 && tp.sellPct <= 100)) return { ok: false, message: `Take profit ${i + 1}: sell must be 1-100 %` };
    if (i > 0 && tp.gainPct <= t.takeProfits[i - 1].gainPct) {
      return { ok: false, message: 'Take profits must be in increasing order of gain' };
    }
  }
  if (t.stopLossPct === null && !t.takeProfits.length && t.trailingPct === null && !t.sellOnDevSell) {
    return { ok: false, message: 'A template that arms nothing is not a template' };
  }
  return { ok: true, message: 'ok' };
}

/**
 * The orders a template arms for one position.
 *
 * Each take profit sells a share of what is LEFT at that moment, which is
 * how the order engine resolves a percentage — so a 40 % step followed by a
 * 50 % step sells 40 % of the bag and then half of the remainder, never more
 * than the position. The last step may be 100 %, which closes it.
 */
export function ordersForTemplate(t: OrderTemplate, mint: string, symbol: string): NewOrderRequest[] {
  const out: NewOrderRequest[] = [];
  if (t.stopLossPct !== null) {
    out.push({ mint, symbol, kind: 'stop_loss', triggerValue: t.stopLossPct, triggerBasis: 'pct', amount: 100 });
  }
  for (const tp of t.takeProfits) {
    out.push({ mint, symbol, kind: 'take_profit', triggerValue: tp.gainPct, triggerBasis: 'pct', amount: tp.sellPct });
  }
  if (t.trailingPct !== null) {
    out.push({ mint, symbol, kind: 'trailing_stop', triggerValue: t.trailingPct, triggerBasis: 'pct', amount: 100 });
  }
  if (t.sellOnDevSell) {
    out.push({ mint, symbol, kind: 'sell_on_dev_sell', triggerValue: null, triggerBasis: 'pct', amount: 100 });
  }
  // Never hand the engine something it would refuse: a template that cannot
  // produce a valid order produces none, rather than a half-armed ladder.
  return out.filter((o) => validateOrder(o).ok);
}

/** One line saying exactly what will be armed, for the button that arms it. */
export function describeTemplate(t: OrderTemplate): string {
  const parts: string[] = [];
  if (t.stopLossPct !== null) parts.push(`stop -${t.stopLossPct}%`);
  for (const tp of t.takeProfits) parts.push(`+${tp.gainPct}% sell ${tp.sellPct}%`);
  if (t.trailingPct !== null) parts.push(`trailing ${t.trailingPct}%`);
  if (t.sellOnDevSell) parts.push('exit if dev sells');
  return parts.length ? parts.join(' · ') : 'nothing';
}
