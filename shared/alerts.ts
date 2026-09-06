// ──────────────────────────────────────────────────────────────────────
// Krypto Bot — alerts (term.txt section 17).
//
// Alerts are the non-executing sibling of advanced orders: same evaluation
// machinery, same conditions, but they only ever tell you something. That
// separation is deliberate — an alert can be liberal about firing because
// the worst case is a notification, whereas an order has to be conservative
// because the worst case is a transaction.
//
// Desktop notifications only. There is no Discord/Telegram webhook here: a
// webhook posts your positions to somebody else's server, which contradicts
// the whole local-first pitch, and adding one is a decision for the user to
// make explicitly rather than a checkbox to slip in.
// ──────────────────────────────────────────────────────────────────────

export type AlertKind =
  | 'price_above'
  | 'price_below'
  | 'mcap_above'
  | 'mcap_below'
  | 'volume_above'
  | 'liquidity_below'
  | 'holders_above'
  | 'curve_above'
  | 'dev_sold'
  | 'migrated'
  | 'wallet_bought'
  | 'wallet_sold';

export const ALERT_KINDS: AlertKind[] = [
  'price_above', 'price_below', 'mcap_above', 'mcap_below',
  'volume_above', 'liquidity_below', 'holders_above', 'curve_above',
  'dev_sold', 'migrated', 'wallet_bought', 'wallet_sold',
];

export const ALERT_LABEL: Record<AlertKind, string> = {
  price_above: 'Price rises above',
  price_below: 'Price falls below',
  mcap_above: 'Market cap rises above',
  mcap_below: 'Market cap falls below',
  volume_above: '5m volume exceeds',
  liquidity_below: 'Liquidity falls below',
  holders_above: 'Holders exceed',
  curve_above: 'Bonding curve passes',
  dev_sold: 'Creator sells',
  migrated: 'Token migrates to a DEX',
  wallet_bought: 'A tracked wallet buys',
  wallet_sold: 'A tracked wallet sells',
};

/** Alerts that watch a specific token rather than the whole feed. */
export function isTokenScoped(kind: AlertKind): boolean {
  return kind !== 'wallet_bought' && kind !== 'wallet_sold';
}

/** Alerts with no numeric threshold. */
export function isEventKind(kind: AlertKind): boolean {
  return kind === 'dev_sold' || kind === 'migrated' || kind === 'wallet_bought' || kind === 'wallet_sold';
}

export type AlertState = 'armed' | 'fired' | 'muted';

export interface Alert {
  id: string;
  kind: AlertKind;
  /** Empty for wallet-scoped alerts, which watch every token. */
  mint: string;
  symbol: string;
  threshold: number | null;
  state: AlertState;
  /** Fire once then stop, or keep firing (rate-limited). */
  repeat: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  fireCount: number;
  note: string | null;
}

export interface NewAlertRequest {
  kind: AlertKind;
  mint: string;
  symbol: string;
  threshold: number | null;
  repeat: boolean;
}

export interface AlertsSnapshot {
  alerts: Alert[];
  /** Desktop notifications permitted by the OS / user setting. */
  notificationsEnabled: boolean;
}

export interface AlertSettings {
  /** Master switch for desktop notifications. */
  desktopNotifications: boolean;
  /** Play a sound with the notification. */
  sound: boolean;
  /** Minimum seconds between two firings of the same repeating alert. */
  repeatCooldownSec: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  desktopNotifications: true,
  sound: false,
  repeatCooldownSec: 60,
};

export function describeAlert(a: Alert): string {
  const label = ALERT_LABEL[a.kind];
  if (isEventKind(a.kind)) {
    return a.mint ? `${label} — ${a.symbol || a.mint.slice(0, 6)}` : label;
  }
  const v = a.threshold ?? 0;
  const formatted =
    a.kind === 'mcap_above' || a.kind === 'mcap_below' || a.kind === 'volume_above' || a.kind === 'liquidity_below'
      ? `$${v.toLocaleString()}`
      : a.kind === 'curve_above'
        ? `${v}%`
        : a.kind === 'holders_above'
          ? v.toLocaleString()
          : `${v} SOL`;
  return `${a.symbol || a.mint.slice(0, 6)}: ${label} ${formatted}`;
}

export function validateAlert(req: NewAlertRequest): { ok: boolean; message: string } {
  if (!ALERT_KINDS.includes(req.kind)) return { ok: false, message: 'Unknown alert type' };
  if (isTokenScoped(req.kind) && (!req.mint || req.mint.length < 32)) {
    return { ok: false, message: 'This alert needs a token' };
  }
  if (!isEventKind(req.kind)) {
    if (req.threshold === null || !Number.isFinite(req.threshold) || req.threshold <= 0) {
      return { ok: false, message: 'Enter a threshold greater than zero' };
    }
  }
  return { ok: true, message: 'ok' };
}
