// Paper-position book — persistence around shared/paper.ts.
//
// Stored in userData/paper-positions.json (tmp + rename, like the ledger).
// Not per wallet: a paper position is a simulated fill, it belongs to the
// install, and switching wallets should not hide it.
//
// This book is the ONLY place a Paper trade leaves a mark. The ledger, the
// real portfolio, the live breakers and fee accounting never see it.

import fs from 'node:fs';
import path from 'node:path';
import {
  emptyPaperBook,
  openPaper,
  paperRealizedSol,
  parsePaperBook,
  sellPaper,
  type PaperBook,
  type PaperPosition,
  type PaperSellResult,
} from '@shared/paper';
import type { ClosedTrade } from '@shared/portfolio';

const FILE = 'paper-positions.json';
let filePath: string | null = null;
let book: PaperBook = emptyPaperBook();

export function init(userDataDir: string): void {
  filePath = path.join(userDataDir, FILE);
  try {
    if (fs.existsSync(filePath)) book = parsePaperBook(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    book = emptyPaperBook();
  }
}

function save(): void {
  if (!filePath) return;
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(book, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch {
    /* a failed save loses at most one paper fill; never blocks the trade path */
  }
}

export function open(p: { mint: string; symbol: string; tokens: number; costSol: number; decimalsKnown: boolean }): { ok: boolean; message: string; position: PaperPosition | null } {
  const r = openPaper(book, p);
  if (r.ok) {
    book = r.book;
    save();
  }
  return { ok: r.ok, message: r.message, position: r.position };
}

export function sell(mint: string, pct: number, priceSol: number | null): PaperSellResult {
  const r = sellPaper(book, mint, pct, priceSol);
  if (r.ok) {
    book = r.book;
    save();
  }
  return r;
}

export function list(): PaperPosition[] {
  return book.open;
}

export function get(mint: string): PaperPosition | undefined {
  return book.open.find((p) => p.mint === mint);
}

export function closed(): ClosedTrade[] {
  return book.closed;
}

export function realized(): number {
  return paperRealizedSol(book);
}

/** Test hook. */
export function _load(b: PaperBook): void {
  book = b;
}
