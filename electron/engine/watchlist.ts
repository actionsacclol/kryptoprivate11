// Smart-wallet watchlist — a curated set of consistently-profitable wallets
// whose real-time participation we record as an entry SIGNAL (research §4 /
// smart-wallet follow). We do NOT copy-trade them (their holds are seconds;
// see docs/smart-wallet-analysis) — we record when they buy a launch so we
// can correlate "smart money present" against our own outcomes offline, and
// eventually use it as a scorer feature.

import fs from 'node:fs';
import path from 'node:path';
import type { WatchedWallet } from '@shared/types';

// Seeded from the deep-dive analysis. A 58-SOL, 11-day-consistent Pump.fun
// scalper — the first entry in our smart-money database.
const SEED: WatchedWallet[] = [
  { address: '696969Y6orZEjp4gZtwcCZS7TNVuhMVE6G5mFvdJ4mYq', label: 'seed-696969 (pump scalper)', addedAt: 0 },
];

let filePath = '';
let wallets: WatchedWallet[] = [];
let index = new Set<string>();

function reindex(): void {
  index = new Set(wallets.map((w) => w.address));
}

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, 'watchlist.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WatchedWallet[];
    wallets = Array.isArray(raw) ? raw : [];
  } catch {
    wallets = [...SEED];
    save();
  }
  // Ensure the seed is always present unless the user explicitly removed it.
  reindex();
}

function save(): void {
  if (!filePath) return;
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(wallets, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* best-effort */
  }
}

export function has(address: string): boolean {
  return index.has(address);
}

export function labelFor(address: string): string | null {
  return wallets.find((w) => w.address === address)?.label ?? null;
}

export function all(): WatchedWallet[] {
  return [...wallets];
}

export function add(address: string, label: string): { ok: boolean; message: string } {
  const a = address.trim();
  if (a.length < 32) return { ok: false, message: 'Invalid wallet address' };
  if (index.has(a)) return { ok: false, message: 'Already watched' };
  wallets.push({ address: a, label: label.trim() || a.slice(0, 8), addedAt: Date.now() });
  reindex();
  save();
  return { ok: true, message: `Watching ${a.slice(0, 8)}…` };
}

export function remove(address: string): { ok: boolean; message: string } {
  wallets = wallets.filter((w) => w.address !== address);
  reindex();
  save();
  return { ok: true, message: 'Removed from watchlist' };
}

export function size(): number {
  return wallets.length;
}
