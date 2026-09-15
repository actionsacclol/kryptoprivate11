// Alert evaluation + desktop notifications (term.txt §17).
//
// Shares the tick shape with `advOrders` on purpose — the same observations
// drive both — but nothing here can spend money, so the rules are looser:
// an alert may fire repeatedly (rate-limited), and it does not need the
// engine armed or live execution on.
//
// One deliberate omission: there is no Discord or Telegram webhook. A
// webhook ships your positions to a third-party server on every fire, which
// is the opposite of what this app promises. Desktop notifications stay on
// the machine.

import fs from 'node:fs';
import path from 'node:path';
import {
  describeAlert,
  isEventKind,
  isTokenScoped,
  validateAlert,
  type Alert,
  type AlertSettings,
  type NewAlertRequest,
} from '@shared/alerts';
import * as recorder from './recorder';

const FILE = 'alerts.json';
const MAX_ALERTS = 300;

let alerts: Alert[] = [];
let filePath = '';
let saveTimer: NodeJS.Timeout | null = null;

export interface AlertHost {
  /** Show a desktop notification. */
  /** `mint` is what the alert is about — the click target for the desktop
   *  notification, and the link in a webhook post. */
  notify(title: string, body: string, mint?: string): void;
  settings(): AlertSettings;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  toast(level: 'info' | 'success' | 'warn' | 'error', message: string): void;
  changed(): void;
}

let host: AlertHost | null = null;

export function attach(h: AlertHost): void {
  host = h;
}

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version: 1; alerts: Alert[] };
    alerts = Array.isArray(raw?.alerts) ? raw.alerts : [];
  } catch {
    alerts = [];
  }
  // Unlike orders, alerts DO come back armed after a restart. They cannot
  // spend anything, so the risk calculus is inverted: a silently disarmed
  // alert is a missed notification, which is the only failure mode there is.
  for (const a of alerts) {
    if (a.state === 'fired' && a.repeat) a.state = 'armed';
  }
}

function persist(): void {
  if (!filePath) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, alerts }, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch {
      /* best effort */
    }
  }, 250);
}

let seq = 0;

export function create(req: NewAlertRequest): { ok: boolean; message: string; alert?: Alert } {
  const v = validateAlert(req);
  if (!v.ok) return { ok: false, message: v.message };
  if (alerts.length >= MAX_ALERTS) return { ok: false, message: `Alert limit reached (${MAX_ALERTS})` };

  seq += 1;
  const alert: Alert = {
    id: `alr_${Date.now().toString(36)}_${seq.toString(36)}`,
    kind: req.kind,
    mint: isTokenScoped(req.kind) ? req.mint : '',
    symbol: req.symbol,
    threshold: isEventKind(req.kind) ? null : req.threshold,
    state: 'armed',
    repeat: req.repeat,
    createdAt: Date.now(),
    lastFiredAt: null,
    fireCount: 0,
    note: null,
  };
  alerts.unshift(alert);
  persist();
  host?.changed();
  return { ok: true, message: describeAlert(alert), alert: { ...alert } };
}

export function remove(id: string): { ok: boolean; message: string } {
  const before = alerts.length;
  alerts = alerts.filter((a) => a.id !== id);
  if (alerts.length === before) return { ok: false, message: 'Alert not found' };
  persist();
  host?.changed();
  return { ok: true, message: 'Alert removed' };
}

export function setMuted(id: string, muted: boolean): { ok: boolean; message: string } {
  const a = alerts.find((x) => x.id === id);
  if (!a) return { ok: false, message: 'Alert not found' };
  a.state = muted ? 'muted' : 'armed';
  persist();
  host?.changed();
  return { ok: true, message: muted ? 'Alert muted' : 'Alert armed' };
}

export function clearFired(): number {
  const before = alerts.length;
  alerts = alerts.filter((a) => a.state !== 'fired');
  persist();
  host?.changed();
  return before - alerts.length;
}

export function all(): Alert[] {
  return alerts.map((a) => ({ ...a }));
}

export function armedMints(): string[] {
  return [...new Set(alerts.filter((a) => a.state === 'armed' && a.mint).map((a) => a.mint))];
}

// ── Evaluation ────────────────────────────────────────────────────────

export interface AlertTick {
  mint: string;
  symbol?: string;
  priceSol?: number | null;
  mcapUsd?: number | null;
  volume5mUsd?: number | null;
  liquidityUsd?: number | null;
  holders?: number | null;
  curvePct?: number | null;
  devSold?: boolean;
  migrated?: boolean;
}

export interface WalletTick {
  wallet: string;
  label: string | null;
  mint: string;
  symbol: string;
  isBuy: boolean;
  sol: number;
  mcapUsd: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function matches(a: Alert, t: AlertTick): boolean {
  const th = a.threshold;
  switch (a.kind) {
    case 'price_above': {
      const v = num(t.priceSol);
      return th !== null && v !== null && v >= th;
    }
    case 'price_below': {
      const v = num(t.priceSol);
      return th !== null && v !== null && v <= th;
    }
    case 'mcap_above': {
      const v = num(t.mcapUsd);
      return th !== null && v !== null && v >= th;
    }
    case 'mcap_below': {
      const v = num(t.mcapUsd);
      return th !== null && v !== null && v <= th;
    }
    case 'volume_above': {
      const v = num(t.volume5mUsd);
      return th !== null && v !== null && v >= th;
    }
    case 'liquidity_below': {
      const v = num(t.liquidityUsd);
      return th !== null && v !== null && v <= th;
    }
    case 'holders_above': {
      const v = num(t.holders);
      return th !== null && v !== null && v >= th;
    }
    case 'curve_above': {
      const v = num(t.curvePct);
      return th !== null && v !== null && v >= th;
    }
    case 'dev_sold':
      return t.devSold === true;
    case 'migrated':
      return t.migrated === true;
    default:
      return false;
  }
}

function fire(a: Alert, title: string, body: string): void {
  const now = Date.now();
  a.lastFiredAt = now;
  a.fireCount += 1;
  a.state = a.repeat ? 'armed' : 'fired';
  a.note = body;
  persist();
  recorder.record('alert_fire', { id: a.id, kind: a.kind, mint: a.mint, threshold: a.threshold });
  host?.notify(title, body, a.mint);
  host?.toast('info', `${title} — ${body}`);
  host?.log('info', `alert: ${title} — ${body}`);
  host?.changed();
}

function cooling(a: Alert): boolean {
  if (a.lastFiredAt === null) return false;
  const cooldown = (host?.settings().repeatCooldownSec ?? 60) * 1000;
  return Date.now() - a.lastFiredAt < cooldown;
}

export function onTick(t: AlertTick): void {
  let dirty = false;
  for (const a of alerts) {
    if (a.state !== 'armed') continue;
    if (a.mint !== t.mint) continue;
    if (cooling(a)) continue;
    if (!matches(a, t)) continue;
    fire(a, a.symbol || t.symbol || t.mint.slice(0, 8), describeAlert(a));
    dirty = true;
  }
  if (dirty) persist();
}

/** Tracked-wallet activity — the "whale entered" popup from term.txt §9. */
export function onWalletActivity(t: WalletTick): void {
  for (const a of alerts) {
    if (a.state !== 'armed') continue;
    if (a.kind !== 'wallet_bought' && a.kind !== 'wallet_sold') continue;
    if (a.kind === 'wallet_bought' && !t.isBuy) continue;
    if (a.kind === 'wallet_sold' && t.isBuy) continue;
    if (cooling(a)) continue;
    const who = t.label ?? `${t.wallet.slice(0, 6)}…`;
    const mc = t.mcapUsd !== null ? ` at $${Math.round(t.mcapUsd).toLocaleString()} MC` : '';
    fire(
      a,
      `${who} ${t.isBuy ? 'bought' : 'sold'} ${t.symbol || t.mint.slice(0, 6)}`,
      `${t.sol.toFixed(2)} SOL${mc}`,
    );
  }
}

/** Test seam. */
export function _reset(): void {
  alerts = [];
  filePath = '';
}

export function _load(list: Alert[]): void {
  alerts = list;
}
