// Local pump.fun transaction builder — kills the relayer's 0.5%/side fee.
//
// The research swarm's verdict on pump's v2 interface: 27-account buy_v2,
// ~one breaking change per quarter (sometimes unannounced), fee recipients
// rotated from on-chain pools — "treat account lists as volatile config".
// So this builder does NOT hardcode the account list. It LEARNS a template
// from recent successful buy_v2/sell_v2 transactions on chain, classifies
// every account slot by comparing samples (fixed across all txs / derivable
// from mint / derivable from user / creator-vault / rotating fee account),
// then substitutes our own derivable PDAs per trade.
//
// Safety: a built tx goes through the exact validate → simulate → loss-guard
// pipeline in liveSigner that relayer txs do. A stale or misclassified
// template produces a simulation revert → fail closed, template invalidated,
// relayer fallback — never a lost lamport.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import {
  ComputeBudgetProgram,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { base58Decode, base58Encode } from './base58';
import {
  PUMP_PROGRAM,
  PUMP_FEES_PROGRAM,
  ATA_PROGRAM,
  bondingCurveV2For,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ataFor,
  bondingCurveFor,
  creatorVaultFor,
  sharingConfigFor,
  userVolumeAccumulatorFor,
  globalFor,
  eventAuthorityFor,
  globalVolumeAccumulatorFor,
  feeConfigFor,
  PUMP_FEE_RECIPIENT_FALLBACK,
  PUMP_FEE_VAULT_FALLBACK,
  isOnCurve,
} from './addresses';
import { buyQuote, sellQuote } from './curve';
import {
  getSignaturesForAddress,
  getTransaction,
  getLatestBlockhashInfo,
  getAccountInfo,
  getTokenBalanceRaw,
  type RawTransaction,
  getMultipleAccountInfo,
} from './rpcClient';
import { decodeLogsEx, decodeCpiEventData } from './pumpDecoder';

const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TEMPLATE_TTL_MS = 6 * 60 * 60_000;
const BLOCKHASH_TTL_MS = 20_000;
const SAMPLE_SIGNATURES = 140;

// Pump ships multiple concurrent trade-instruction variants (legacy 16-account
// `sell`, 26-account `sell_v2`, 27-account buy) and the on-chain discriminators
// do NOT all match the documented names. So the discriminator is LEARNED from
// chain per variant (see learn()), never hardcoded. This event discriminator
// is the only fixed one — it identifies the self-CPI log we must skip.
const EMIT_EVENT_DISC = Buffer.from(sha256(new TextEncoder().encode('event:TradeEvent')).slice(0, 8));

type SlotRole =
  | { kind: 'fixed'; pubkey: string }
  | { kind: 'fee'; pubkey: string } // rotating fee recipient — a recently observed one is valid
  | { kind: 'mint' }
  | { kind: 'user' }
  | { kind: 'bondingCurve' }
  | { kind: 'bondingCurveV2' } // ["bonding-curve-v2", mint] — required since 2026-08
  | { kind: 'curveAta' }
  | { kind: 'userAta' }
  | { kind: 'curveQuoteAta' } // ATA(bondingCurve, WSOL) — quote-mint layouts
  | { kind: 'userQuoteAta' } // ATA(user, WSOL)
  | { kind: 'creator' } // raw creator pubkey
  | { kind: 'creatorVault' } // ["creator-vault", creator] PDA
  | { kind: 'sharingConfig' }
  | { kind: 'uva' }
  // Derived-layout roles (never produced by the learner):
  | { kind: 'tokenProgram' } // the MINT's owner — Token-2022 for fresh launches, classic for old ones
  | { kind: 'feeRecipient' } // Global.fee_recipient
  | { kind: 'feeVault' }; // fee-program account referenced from Global's tail

export interface TradeTemplate {
  action: 'buy' | 'sell';
  /** Learned 8-byte instruction discriminator (varies by program epoch). */
  disc: Buffer;
  slots: SlotRole[];
  writable: boolean[];
  /** Token program the sampled mints used (fresh pump mints: Token-2022). */
  tokenProgram: string;
  /** Instruction data after discriminator + two u64 args, copied verbatim. */
  trailingData: Buffer;
  learnedAt: number;
  sampleCount: number;
}

interface Sample {
  mint: string;
  user: string;
  accounts: string[];
  writable: boolean[];
  data: Buffer;
  disc: string;
  /** The token's creator, straight from the trade event. Lets the classifier
   *  identify the creator-vault slot without resolving each sample mint's
   *  creator on-chain. Null on the older event that lacked the field. */
  creator: string | null;
}

let templates: { buy: TradeTemplate | null; sell: TradeTemplate | null } = { buy: null, sell: null };

// ── Template persistence ──────────────────────────────────────────────
//
// Learning costs ~200 `getTransaction` calls, which a free public RPC will
// not serve on demand — it rate-limits the burst and the attempt starves
// (measured 2026-08-24). Holding the result only in memory meant paying that
// cost, and usually failing it, on EVERY app start.
//
// A template is valid for TEMPLATE_TTL_MS, so persist it: learn once —
// possibly slowly, possibly on a keyed RPC — and every later start reads it
// from disk instantly. A stale template cannot cost money: it fails
// simulation, gets invalidated, and the relayer takes over (liveSigner.ts).

let templateFile = '';

interface StoredTemplate {
  action: 'buy' | 'sell';
  disc: string;
  slots: SlotRole[];
  writable: boolean[];
  tokenProgram: string;
  trailingData: string;
  learnedAt: number;
  sampleCount: number;
}

function toStored(t: TradeTemplate): StoredTemplate {
  return { ...t, disc: t.disc.toString('hex'), trailingData: t.trailingData.toString('hex') };
}

function fromStored(s: StoredTemplate): TradeTemplate | null {
  if (!s || (s.action !== 'buy' && s.action !== 'sell')) return null;
  if (!Array.isArray(s.slots) || !Array.isArray(s.writable)) return null;
  if (typeof s.learnedAt !== 'number') return null;
  try {
    return {
      action: s.action,
      disc: Buffer.from(s.disc, 'hex'),
      slots: s.slots,
      writable: s.writable,
      tokenProgram: s.tokenProgram,
      trailingData: Buffer.from(s.trailingData ?? '', 'hex'),
      learnedAt: s.learnedAt,
      sampleCount: s.sampleCount ?? 0,
    };
  } catch {
    return null;
  }
}

function saveTemplates(): void {
  if (!templateFile) return;
  try {
    const out: Record<string, StoredTemplate> = {};
    for (const action of ['buy', 'sell'] as const) {
      const t = templates[action];
      if (t) out[action] = toStored(t);
    }
    fs.writeFileSync(templateFile, JSON.stringify({ version: 1, templates: out }), 'utf8');
  } catch {
    /* a read-only profile must not break trading */
  }
}

/** Load any template learned by a previous run. Expired ones are discarded. */
export function initTemplateStore(userDataDir: string): void {
  templateFile = path.join(userDataDir, 'pump-templates.json');
  try {
    const raw = JSON.parse(fs.readFileSync(templateFile, 'utf8')) as { templates?: Record<string, StoredTemplate> };
    for (const action of ['buy', 'sell'] as const) {
      const stored = raw.templates?.[action];
      if (!stored) continue;
      const t = fromStored(stored);
      if (t && Date.now() - t.learnedAt < TEMPLATE_TTL_MS) templates[action] = t;
    }
  } catch {
    /* first run, or unreadable — learn from chain instead */
  }
}
let lastLearnFailAt = 0;
/** Why the last learn attempt failed. A rate-limited RPC is transient and
 *  must be retried within seconds; a genuine lack of usable samples means
 *  pump changed something and hammering will not help. Collapsing the two
 *  into one 60s lockout meant a single 429 burst disabled local building for
 *  a minute and every retry inside it returned in 0ms without trying —
 *  measured 2026-08-24. */
let lastLearnFailKind: 'rpc' | 'samples' = 'samples';
let cachedBlockhash: { value: string; lastValidBlockHeight: number; at: number } | null = null;

export function invalidateTemplates(): void {
  templates = { buy: null, sell: null };
  // Persist the invalidation. A template that just failed simulation must not
  // come back from disk on the next start and fail again.
  saveTemplates();
  noteDerivedStrike();
}

export function templateInfo(): string {
  const t = (x: TradeTemplate | null): string => (x ? `${x.slots.length} slots, ${x.sampleCount} samples` : 'none');
  return `derived: ${derivedLayoutSuspended() ? 'suspended' : 'active'}; buy: ${t(templates.buy)}; sell: ${t(templates.sell)}`;
}

// ── Derived layout ────────────────────────────────────────────────────
//
// 2026-08-29: a live buy reverted with `ConstraintSeeds (2006)` from a
// template the learner had built THAT MINUTE. The template's slot list was
// right; what it filled two slots with was not:
//
//   • `creator_vault` was derived from the creator pump.fun's API reports,
//     but the program seeds it with `bonding_curve.creator` — and the mint in
//     question had a LEGACY 49-byte curve with no creator field at all (and
//     `complete = 1`, which the API also misreported as `false`).
//   • the last account of both buy and sell varied across samples, so the
//     learner filed it as a "rotating fee recipient" and copied it from
//     another trader's transaction. It is neither: it is a fee-program
//     account whose address lives in the Global account's data.
//
// The layout itself has been stable across every sample since the v2 curve
// landed, so it is now DERIVED from seeds + two on-chain reads (mint owner,
// bonding curve, Global) — the same inputs PumpPortal's router uses. The
// learner stays as a fallback for the day pump moves a slot again: three
// simulation failures inside ten minutes suspend the derived layout and hand
// the next builds to the learned template (see noteDerivedStrike).

/** Discriminators of the current buy/sell, verified against PumpPortal-built
 *  transactions and successful on-chain trades on 2026-08-29. */
export const BUY_DISC = Buffer.from('66063d1201daebea', 'hex');
export const SELL_DISC = Buffer.from('33e685a4017f83ad', 'hex');

/** sha256("account:Global")[0..8] — refuses to parse anything but a Global. */
const GLOBAL_DISC = Buffer.from(sha256(new TextEncoder().encode('account:Global')).slice(0, 8));
/** sha256("account:BondingCurve")[0..8]. */
const CURVE_DISC = Buffer.from(sha256(new TextEncoder().encode('account:BondingCurve')).slice(0, 8));

export interface GlobalConfig {
  feeRecipient: string;
  feeVault: string;
  /** False when a field fell back to a constant because the account did not
   *  carry it — a signal that pump reshaped Global, worth a diagnostic. */
  fromChain: boolean;
}

/** Parse the two per-trade accounts out of pump's Global account.
 *
 *  Layout (Anchor, 1045 bytes on 2026-08-29): disc 8 · initialized 1 ·
 *  authority 32 · fee_recipient 32 @41 · … · a fee-program-owned vault @965.
 *  The vault offset is the only "magic" number in this file, so it is
 *  checked rather than trusted: the 32 bytes must be non-zero and off the
 *  ed25519 curve (every fee-program account is a PDA), else the fallback is
 *  used and `fromChain` goes false. */
export function parseGlobal(data: Uint8Array): GlobalConfig {
  const d = Buffer.from(data);
  const fallback: GlobalConfig = { feeRecipient: PUMP_FEE_RECIPIENT_FALLBACK, feeVault: PUMP_FEE_VAULT_FALLBACK, fromChain: false };
  if (d.length < 73 || !d.subarray(0, 8).equals(GLOBAL_DISC)) return fallback;
  const feeRecipient = base58Encode(d.subarray(41, 73));
  if (d.length < 997) return { ...fallback, feeRecipient };
  const vault = d.subarray(965, 997);
  if (vault.every((b) => b === 0) || isOnCurve(vault)) return { ...fallback, feeRecipient };
  return { feeRecipient, feeVault: base58Encode(vault), fromChain: true };
}

export interface CurveState {
  vTok: bigint;
  vSol: bigint;
  complete: boolean;
  /** `bonding_curve.creator` — the seed of `creator_vault`. Null on a legacy
   *  curve that predates the field (49 bytes). */
  creator: string | null;
}

/** Parse a bonding-curve account: disc 8 · virtual_token 8 · virtual_sol 8 ·
 *  real_token 8 · real_sol 8 · supply 8 · complete 1 @48 · creator 32 @49. */
export function parseCurve(data: Uint8Array): CurveState | null {
  const d = Buffer.from(data);
  if (d.length < 49 || !d.subarray(0, 8).equals(CURVE_DISC)) return null;
  const creatorBytes = d.length >= 81 ? d.subarray(49, 81) : null;
  return {
    vTok: d.readBigUInt64LE(8),
    vSol: d.readBigUInt64LE(16),
    complete: d[48] !== 0,
    creator: creatorBytes && !creatorBytes.every((b) => b === 0) ? base58Encode(creatorBytes) : null,
  };
}



/** The current pump trade layouts, as slot roles. Buy = 18 accounts, sell =
 *  16 — the sell drops the two volume accumulators and swaps the order of
 *  creator_vault / token_program. Writable flags are the ones the program
 *  demands (a read-only flag on an account it mutates is a revert). */
export function derivedTemplate(action: 'buy' | 'sell'): TradeTemplate {
  const fixed = (pubkey: string): SlotRole => ({ kind: 'fixed', pubkey });
  const common = {
    global: fixed(globalFor()),
    system: fixed(SYSTEM_PROGRAM),
    eventAuthority: fixed(eventAuthorityFor()),
    program: fixed(PUMP_PROGRAM),
    feeConfig: fixed(feeConfigFor()),
    feeProgram: fixed(PUMP_FEES_PROGRAM),
  };
  const rows: Array<[SlotRole, boolean]> =
    action === 'buy'
      ? [
          [common.global, false],
          [{ kind: 'feeRecipient' }, true],
          [{ kind: 'mint' }, false],
          [{ kind: 'bondingCurve' }, true],
          [{ kind: 'curveAta' }, true],
          [{ kind: 'userAta' }, true],
          [{ kind: 'user' }, true],
          [common.system, false],
          [{ kind: 'tokenProgram' }, false],
          [{ kind: 'creatorVault' }, true],
          [common.eventAuthority, false],
          [common.program, false],
          [fixed(globalVolumeAccumulatorFor()), false],
          [{ kind: 'uva' }, true],
          [common.feeConfig, false],
          [common.feeProgram, false],
          [{ kind: 'bondingCurveV2' }, true],
          [{ kind: 'feeVault' }, true],
        ]
      : [
          [common.global, false],
          [{ kind: 'feeRecipient' }, true],
          [{ kind: 'mint' }, false],
          [{ kind: 'bondingCurve' }, true],
          [{ kind: 'curveAta' }, true],
          [{ kind: 'userAta' }, true],
          [{ kind: 'user' }, true],
          [common.system, false],
          [{ kind: 'creatorVault' }, true],
          [{ kind: 'tokenProgram' }, false],
          [common.eventAuthority, false],
          [common.program, false],
          [common.feeConfig, false],
          [common.feeProgram, false],
          [{ kind: 'bondingCurveV2' }, true],
          [{ kind: 'feeVault' }, true],
        ];
  return {
    action,
    disc: action === 'buy' ? BUY_DISC : SELL_DISC,
    slots: rows.map(([s]) => s),
    writable: rows.map(([, w]) => w),
    tokenProgram: '',
    trailingData: Buffer.alloc(0),
    learnedAt: Date.now(),
    sampleCount: 0,
  };
}

/** Inputs every slot of a derived layout is filled from. */
export interface DerivedFill {
  mint: string;
  owner: string;
  /** `bonding_curve.creator`. */
  creator: string;
  tokenProgram: string;
  feeRecipient: string;
  feeVault: string;
}

/** Fill a template's slots. Exported so the exact account list can be pinned
 *  offline against the reference decoded from a PumpPortal-built trade. */
export function fillSlots(tpl: TradeTemplate, f: DerivedFill, observed: string[] | null = null): string[] {
  const bc = bondingCurveFor(f.mint);
  return tpl.slots.map((slot, index) => {
    switch (slot.kind) {
      case 'fee':
        // A rotating recipient from a live trade beats one baked into a
        // template hours ago — the program rejects a stale one outright.
        return observed?.[index] ?? slot.pubkey;
      case 'fixed':
        // The token program is a FIXED account in a learned layout but a
        // per-MINT fact: pump mints are a mix of Token-2022 and classic SPL.
        // Baking in whatever the sampled mints used produced
        // `ConstraintAssociatedTokenTokenProgram` on a mint of the other kind.
        return tpl.tokenProgram && slot.pubkey === tpl.tokenProgram ? f.tokenProgram : slot.pubkey;
      case 'mint':
        return f.mint;
      case 'user':
        return f.owner;
      case 'bondingCurve':
        return bc;
      case 'bondingCurveV2':
        return bondingCurveV2For(f.mint);
      case 'curveAta':
        return ataFor(bc, f.mint, f.tokenProgram);
      case 'userAta':
        return ataFor(f.owner, f.mint, f.tokenProgram);
      case 'curveQuoteAta':
        return ataFor(bc, WSOL, TOKEN_PROGRAM);
      case 'userQuoteAta':
        return ataFor(f.owner, WSOL, TOKEN_PROGRAM);
      case 'creator':
        return f.creator;
      case 'creatorVault':
        return observed?.[index] ?? creatorVaultFor(f.creator);
      case 'sharingConfig':
        return sharingConfigFor(f.mint);
      case 'uva':
        return userVolumeAccumulatorFor(f.owner);
      case 'tokenProgram':
        return f.tokenProgram;
      case 'feeRecipient':
        return f.feeRecipient;
      case 'feeVault':
        return f.feeVault;
    }
  });
}

/** Instruction data: discriminator · amount u64 · sol limit u64. Exactly 24
 *  bytes — the current instructions carry no trailing args. */
export function encodeTradeData(disc: Buffer, amount: bigint, solLimit: bigint): Buffer {
  return Buffer.concat([disc, u64le(amount), u64le(solLimit)]);
}

// Suspension: the derived layout is the primary path, but it cannot self-heal
// if pump moves a slot. Every simulation failure of a local tx counts as a
// strike (liveSigner invalidates on any pre-broadcast failure, slippage
// included, so one strike proves nothing); three inside DERIVED_STRIKE_WINDOW
// suspend it for DERIVED_SUSPEND_MS and the learner gets its turn.
const DERIVED_STRIKE_WINDOW_MS = 10 * 60_000;
const DERIVED_STRIKES_TO_SUSPEND = 3;
const DERIVED_SUSPEND_MS = 30 * 60_000;
let derivedStrikes: number[] = [];
let derivedSuspendedUntil = 0;
/** Which path built the most recent tx — a strike only counts against the
 *  derived layout if the derived layout produced the tx that failed. */
let lastBuildPath: 'derived' | 'learned' | null = null;

function noteDerivedStrike(): void {
  if (lastBuildPath !== 'derived') return;
  const now = Date.now();
  derivedStrikes = derivedStrikes.filter((t) => now - t < DERIVED_STRIKE_WINDOW_MS);
  derivedStrikes.push(now);
  if (derivedStrikes.length >= DERIVED_STRIKES_TO_SUSPEND) {
    derivedSuspendedUntil = now + DERIVED_SUSPEND_MS;
    derivedStrikes = [];
  }
}

export function derivedLayoutSuspended(): boolean {
  return Date.now() < derivedSuspendedUntil;
}

/** Test seam. */
export function resetDerivedState(): void {
  derivedStrikes = [];
  derivedSuspendedUntil = 0;
  lastBuildPath = null;
  globalCache = null;
}
/** Test seam — pretend the last build came from the given path. */
export function markLastBuildPath(p: 'derived' | 'learned' | null): void {
  lastBuildPath = p;
}

/** Global is a config account that changes on pump's schedule, not per
 *  trade; one read a minute is plenty and keeps the hot path at two reads. */
const GLOBAL_TTL_MS = 60_000;
let globalCache: { value: GlobalConfig; at: number } | null = null;

function globalFresh(): boolean {
  return !!globalCache && Date.now() - globalCache.at < GLOBAL_TTL_MS;
}

function acceptGlobal(data: Uint8Array | null): GlobalConfig {
  const value = data ? parseGlobal(data) : parseGlobal(new Uint8Array(0));
  // Cache a fallback only briefly, so a transient RPC miss does not pin the
  // constants for a full minute.
  globalCache = { value, at: value.fromChain ? Date.now() : Date.now() - GLOBAL_TTL_MS + 5_000 };
  return value;
}

async function readGlobal(httpUrl: string): Promise<GlobalConfig> {
  if (globalCache && Date.now() - globalCache.at < GLOBAL_TTL_MS) return globalCache.value;
  const acc = await getAccountInfo(httpUrl, globalFor());
  return acceptGlobal(acc.ok && acc.data ? acc.data.data : null);
}

/** Prewarm (engine/prewarm.ts): read Global now so the first trade after
 *  arming does not. No-op while the cache is fresh. */
export async function primeGlobal(httpUrl: string): Promise<void> {
  if (globalFresh()) return;
  try {
    await readGlobal(httpUrl);
  } catch {
    /* the build reads it inline if this failed */
  }
}

/** Prewarm: fetch a blockhash ahead of the trade. The prewarm heartbeat calls
 *  this every few seconds while armed, so the build below never pays the
 *  round trip inline. */
export async function primeBlockhash(httpUrl: string): Promise<void> {
  if (cachedBlockhash && Date.now() - cachedBlockhash.at < BLOCKHASH_TTL_MS / 2) return;
  try {
    const bh = await getLatestBlockhashInfo(httpUrl);
    if (bh.ok && bh.data) {
      cachedBlockhash = { value: bh.data.blockhash, lastValidBlockHeight: bh.data.lastValidBlockHeight, at: Date.now() };
    }
  } catch {
    /* the build fetches inline if this failed */
  }
}

/** A mint's owning token program never changes, so it is read once per
 *  process. Bounded: a session touches at most a few hundred mints. */
const mintOwnerCache = new Map<string, string>();
const MINT_OWNER_CAP = 2_000;

// ── Learning ──────────────────────────────────────────────────────────

/** Extract a clean single-trade sample from a fetched transaction. Scans both
 *  top-level and inner (CPI) instructions — most trades are routed, so the
 *  pump instruction is usually an inner one. The discriminator is discovered,
 *  not assumed: we take the pump instruction (≥24 data bytes = 2 u64 args,
 *  not the 1-account event emit) that references the mint+user+WSOL. */
function extractSample(tx: RawTransaction, wantBuy: boolean): Sample | null {
  if (!tx.meta || tx.meta.err !== null) return null;
  const msg = tx.transaction.message;
  if (msg.header.numRequiredSignatures !== 1) return null; // one signer = clean user/bot trade
  const loaded = tx.meta.loadedAddresses;
  const keys = [...msg.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const staticLen = msg.accountKeys.length;
  const h = msg.header;
  const writableAt = (i: number): boolean => {
    if (i < staticLen) {
      if (i < h.numRequiredSignatures) return i < h.numRequiredSignatures - h.numReadonlySignedAccounts;
      return i < staticLen - h.numReadonlyUnsignedAccounts;
    }
    return i - staticLen < (loaded?.writable.length ?? 0);
  };
  // Exactly one pump trade event → account/mint mapping is unambiguous.
  //
  // Pump moved TradeEvent from `Program data:` logs into emit_cpi inner
  // instructions (2026-08), so read BOTH: the logs (older tokens / other
  // events) and the inner instructions (current trades). Same layout either
  // way — decodeCpiEventData just strips the CPI wrapper first.
  const logTrades = decodeLogsEx(tx.meta.logMessages ?? []).events.filter((e) => e.kind === 'trade');
  const cpiTrades: typeof logTrades = [];
  for (const ix of (tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions)) {
    if (keys[ix.programIdIndex] !== PUMP_PROGRAM) continue;
    let raw: Buffer;
    try {
      raw = Buffer.from(base58Decode(ix.data));
    } catch {
      continue;
    }
    const ev = decodeCpiEventData(raw);
    if (ev && ev.kind === 'trade') cpiTrades.push(ev);
  }
  // A tx in the transition period carries the SAME trade in both places, so
  // prefer the emit_cpi source (the current canonical one) and only fall back
  // to the log for older tokens still using emit!. Combining them would double-
  // count one trade and wrongly read it as ambiguous.
  const events = cpiTrades.length > 0 ? cpiTrades : logTrades;
  if (events.length !== 1) return null;
  const ev = events[0];
  if (ev.kind !== 'trade' || ev.isBuy !== wantBuy) return null;

  const allIx = [
    ...msg.instructions,
    ...((tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions)),
  ];
  const candidates: Sample[] = [];
  for (const ix of allIx) {
    if (keys[ix.programIdIndex] !== PUMP_PROGRAM) continue;
    let data: Buffer;
    try {
      data = Buffer.from(base58Decode(ix.data));
    } catch {
      continue;
    }
    if (data.length < 24) continue; // skip the 1-account self-CPI event emit
    if (data.subarray(0, 8).equals(EMIT_EVENT_DISC)) continue;
    const accounts = ix.accounts.map((i) => keys[i]);
    if (accounts.some((a) => a === undefined)) continue;
    // The trade instruction must reference both the mint and the trader; WSOL
    // may or may not appear depending on the variant (native vs wrapped SOL),
    // so it is not required.
    if (!accounts.includes(ev.mint) || !accounts.includes(ev.user)) continue;
    candidates.push({
      mint: ev.mint,
      user: ev.user,
      accounts,
      writable: ix.accounts.map(writableAt),
      data,
      disc: data.subarray(0, 8).toString('hex'),
      creator: ev.creator,
    });
  }
  // One unambiguous trade instruction only — if a tx has two (e.g. router
  // wrapping), we can't tell which layout is canonical, so skip it.
  return candidates.length === 1 ? candidates[0] : null;
}

/** Role assignments derivable from a single sample's own (mint, user). */
function derivableRoles(s: Sample, tokenPrograms: string[]): Map<string, { kind: SlotRole['kind']; tokenProgram?: string }> {
  const bc = bondingCurveFor(s.mint);
  const m = new Map<string, { kind: SlotRole['kind']; tokenProgram?: string }>();
  m.set(s.mint, { kind: 'mint' });
  m.set(s.user, { kind: 'user' });
  m.set(bc, { kind: 'bondingCurve' });
  m.set(bondingCurveV2For(s.mint), { kind: 'bondingCurveV2' });
  m.set(sharingConfigFor(s.mint), { kind: 'sharingConfig' });
  m.set(userVolumeAccumulatorFor(s.user), { kind: 'uva' });
  for (const tp of tokenPrograms) {
    m.set(ataFor(bc, s.mint, tp), { kind: 'curveAta', tokenProgram: tp });
    m.set(ataFor(s.user, s.mint, tp), { kind: 'userAta', tokenProgram: tp });
  }
  // Quote-side accounts. Pump's newer layouts are quote-mint aware and carry
  // the curve's WSOL account (`associated_quote_bonding_curve`); without a
  // role for it the classifier treats it as a rotating fee account and copies
  // another mint's, which the program rejects with `ConstraintSeeds`.
  // WSOL is always a classic SPL mint, so its ATA never uses Token-2022.
  m.set(ataFor(bc, WSOL, TOKEN_PROGRAM), { kind: 'curveQuoteAta' });
  m.set(ataFor(s.user, WSOL, TOKEN_PROGRAM), { kind: 'userQuoteAta' });
  return m;
}

/** Resolve a mint's creator by scanning its bonding-curve account for an
 *  on-curve pubkey C whose creator-vault PDA appears in `knownAccounts` (the
 *  observed trade's account list). Layout-offset agnostic on purpose — the
 *  account layout moves; a hardcoded creator offset is the known trap.
 *
 *  BOTH curve accounts are scanned. On a v2 mint the creator is not
 *  necessarily in the v1 account, and when this returns null the slot
 *  classifier cannot identify the creator vault — which refuses the whole
 *  template with "creatorVault appears 0 times". Reading v2 as well is what
 *  makes the template learnable for current mints. */
const creatorCache = new Map<string, string | null>();
async function resolveCreator(httpUrl: string, mint: string, knownAccounts: Set<string>): Promise<string | null> {
  if (creatorCache.has(mint)) return creatorCache.get(mint)!;

  // A creator supplied by the engine is authoritative, but still VERIFIED
  // against the observed accounts: if its vault is not in this trade's
  // account list, the slot is not the creator vault and a wrong answer here
  // would mis-teach the template.
  const known = knownCreators.get(mint);
  if (known) {
    try {
      if (knownAccounts.has(creatorVaultFor(known))) {
        creatorCache.set(mint, known);
        return known;
      }
    } catch {
      /* unparseable — fall through to the scan */
    }
  }

  let result: string | null = null;
  let sources: string[];
  try {
    sources = [bondingCurveFor(mint), bondingCurveV2For(mint)];
  } catch {
    creatorCache.set(mint, null);
    return null;
  }
  for (const source of sources) {
    const acc = await getAccountInfo(httpUrl, source);
    if (!acc.ok || !acc.data) continue;
    const data = acc.data.data;
    const maxOff = Math.min(data.length - 32, 200);
    for (let off = 8; off <= maxOff; off++) {
      const window = data.subarray(off, off + 32);
      if (!isOnCurve(window)) continue;
      const cand = base58Encode(window);
      if (knownAccounts.has(creatorVaultFor(cand))) {
        result = cand;
        break;
      }
    }
    if (result) break;
  }
  creatorCache.set(mint, result);
  return result;
}

/**
 * Mints that are trading RIGHT NOW, newest first — the sampling source.
 *
 * Sampling the pump PROGRAM's signatures does not work: measured 2026-08-24,
 * 96 of its 100 most recent signatures were FAILED transactions (snipers
 * losing races), and the four that succeeded contained no pump instruction at
 * all. Sampling a specific mint's BONDING CURVE account instead returned
 * 85-100% successful transactions on every mint tried, because a curve
 * account only appears in trades that actually touched it.
 *
 * The engine feeds this from its live tape; a build also seeds it with the
 * mint being traded, so the ring is never empty in practice.
 */
const activeMints: string[] = [];
const ACTIVE_MINTS_MAX = 12;

/**
 * Creators for the sampled mints, supplied by the caller.
 *
 * The classifier must identify which slot is the creator vault, and it does
 * that by checking whether a slot equals `["creator-vault", creator]`. It
 * used to recover the creator by scanning the bonding-curve account — which
 * no longer works on v2 mints, where the v2 curve account is typically
 * UNINITIALISED (owner missing, 0 bytes) and the v1 account does not carry
 * it. Without a creator the vault slot is unidentifiable and the whole
 * template is refused ("creatorVault appears 0 times").
 *
 * The engine already knows every creator — it decodes the create event — so
 * it passes one in rather than making this guess from bytes.
 */
const knownCreators = new Map<string, string>();

export function noteActiveMint(mint: string, creator?: string): void {
  if (creator) {
    knownCreators.set(mint, creator);
    if (knownCreators.size > 64) knownCreators.delete(knownCreators.keys().next().value as string);
  }
  const at = activeMints.indexOf(mint);
  if (at === 0) return;
  if (at > 0) activeMints.splice(at, 1);
  activeMints.unshift(mint);
  if (activeMints.length > ACTIVE_MINTS_MAX) activeMints.length = ACTIVE_MINTS_MAX;
}

/** Diagnostics: what the sampler would draw from right now. */
export function activeMintsSnapshot(): string[] {
  return [...activeMints];
}

/** Test seam — the v2 curve derivation, which is the fix for the 2026-08-24
 *  curve-trading outage and must never silently become mint-independent. */
export function bondingCurveV2ForTest(mint: string): string {
  return bondingCurveV2For(mint);
}

/** Test seam — the ring is module state that survives between builds. */
export function resetActiveMints(): void {
  activeMints.length = 0;
}

/** Curve accounts to sample per learn attempt. Needs ≥2 distinct mints for
 *  the slot classifier to tell per-mint accounts from fixed ones. */
const SAMPLE_MINTS = 4;
/** Signatures pulled per curve account. */
const SAMPLE_PER_CURVE = 25;
/** Upper bound on transactions fetched per learn attempt. */
const MAX_CANDIDATES = 220;
/** Samples accepted from any one mint, so a single busy curve cannot supply
 *  the whole set and leave the classifier with nothing to compare. */
const MAX_SAMPLES_PER_MINT = 4;

/** Concurrent `getTransaction` fetches per batch. Small enough not to trip a
 *  free RPC's burst limit, large enough that sampling finishes in one go. */
const LEARN_BATCH = 5;
const LEARN_RETRY_MS = 350;

/** Both token programs a pump mint can use — fresh mints are Token-2022. */
const TOKEN_PROGRAMS = [
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
];

/** Set by `learn` so `getTemplate` can tell a dead RPC from a stale template. */
let learnFailure: 'rpc' | 'samples' = 'samples';

/** Why the last learn attempt ended as it did — surfaced in diagnostics and
 *  the single most useful thing to look at when local building stops. */
export interface LearnStats {
  candidates: number;
  fetched: number;
  fetchFailures: number;
  samples: number;
  variants: string[];
  chosen: string | null;
  distinctMints: number;
  rejectedAt: string | null;
}
let learnStats: LearnStats = {
  candidates: 0,
  fetched: 0,
  fetchFailures: 0,
  samples: 0,
  variants: [],
  chosen: null,
  distinctMints: 0,
  rejectedAt: null,
};
export function lastLearnStats(): LearnStats {
  return { ...learnStats, variants: [...learnStats.variants] };
}

async function learn(httpUrl: string, action: 'buy' | 'sell'): Promise<TradeTemplate | null> {
  learnFailure = 'samples';
  learnStats = { candidates: 0, fetched: 0, fetchFailures: 0, samples: 0, variants: [], chosen: null, distinctMints: 0, rejectedAt: null };
  // Only SUCCESSFUL transactions carry a usable account layout. Gather them
  // from the curve accounts of mints that are actually trading; fall back to
  // the program firehose only if that yields too little (see activeMints).
  // Gathered PER MINT and then INTERLEAVED. Taking them in order filled the
  // whole sample quota from whichever curve was read first — 10 samples, 1
  // mint — and the slot classifier needs at least two distinct mints to tell
  // a per-mint account (the v2 curve) from a fixed one. One mint means every
  // per-mint account looks constant.
  const perMint: string[][] = [];
  let rpcRefused = 0;
  for (const mint of activeMints.slice(0, SAMPLE_MINTS)) {
    let curve: string;
    try {
      curve = bondingCurveFor(mint);
    } catch {
      continue;
    }
    const r = await getSignaturesForAddress(httpUrl, curve, SAMPLE_PER_CURVE);
    if (!r.ok || !r.data) {
      rpcRefused++;
      continue;
    }
    const ok = r.data.filter((sig) => sig.err === null).map((sig) => sig.signature);
    if (ok.length) perMint.push(ok);
  }

  const candidates: string[] = [];
  for (let round = 0; ; round++) {
    let added = false;
    for (const list of perMint) {
      if (round < list.length) {
        candidates.push(list[round]);
        added = true;
      }
    }
    if (!added) break;
  }

  // ALWAYS add the program firehose as well, deduped. The two sources are
  // complementary and neither is sufficient alone: curve accounts are ~90%
  // SELLS (measured: 9 of 10 successful curve transactions), so learning a
  // BUY layout from them alone can starve, while the firehose is 96% failed
  // transactions but samples the whole program and does surface buys.
  const sigs = await getSignaturesForAddress(httpUrl, PUMP_PROGRAM, SAMPLE_SIGNATURES);
  if (!sigs.ok || !sigs.data) rpcRefused++;
  else for (const sig of sigs.data) if (sig.err === null) candidates.push(sig.signature);

  const seen = new Set<string>();
  const deduped = candidates.filter((sig) => (seen.has(sig) ? false : (seen.add(sig), true)));
  candidates.length = 0;
  candidates.push(...deduped.slice(0, MAX_CANDIDATES));

  learnStats.candidates = candidates.length;
  if (!candidates.length) {
    learnFailure = rpcRefused > 0 ? 'rpc' : 'samples';
    learnStats.rejectedAt = 'no candidate signatures';
    return null;
  }

  // Fetch in small concurrent batches rather than one at a time. Sequentially
  // this took ~1s to gather nothing on a public RPC: the burst gets 429'd,
  // every fetch returns empty, and the loop reports "chain sampling failed"
  // while the endpoint is perfectly healthy. Batching with one retry per
  // signature turns the same rate budget into usable samples.
  let samples: Sample[] = [];
  let fetched = 0;
  let fetchFailures = 0;
  for (let i = 0; i < candidates.length && samples.length < 12; i += LEARN_BATCH) {
    const batch = candidates.slice(i, i + LEARN_BATCH);
    const results = await Promise.all(
      batch.map(async (sig) => {
        let tx = await getTransaction(httpUrl, sig);
        if (!tx.ok || !tx.data) {
          // One retry, spaced past the burst that most likely caused it.
          await new Promise((r) => setTimeout(r, LEARN_RETRY_MS));
          tx = await getTransaction(httpUrl, sig);
        }
        return tx;
      }),
    );
    for (const tx of results) {
      if (!tx.ok || !tx.data) {
        fetchFailures++;
        continue;
      }
      fetched++;
      const sample = extractSample(tx.data, action === 'buy');
      if (!sample) continue;
      // Cap per mint: one busy curve must not crowd out the variety the
      // classifier depends on.
      const fromThisMint = samples.filter((x) => x.mint === sample.mint).length;
      if (fromThisMint >= MAX_SAMPLES_PER_MINT) continue;
      samples.push(sample);
    }
    // Enough samples AND enough mints — the second half is the load-bearing
    // part, since the classifier cannot separate roles without it.
    if (samples.length >= 12 && new Set(samples.map((x) => x.mint)).size >= 3) break;
  }

  learnStats.fetched = fetched;
  learnStats.fetchFailures = fetchFailures;
  learnStats.samples = samples.length;
  learnStats.distinctMints = new Set(samples.map((x) => x.mint)).size;
  if (samples.length < 2) {
    learnStats.rejectedAt = 'fewer than 2 usable samples';
    // The distinction that matters: if nothing could be READ, the RPC is the
    // problem and this is worth retrying in seconds. If transactions came
    // back fine and none of them parsed, pump changed the instruction and
    // retrying is pointless until the next TTL.
    learnFailure = fetched === 0 && fetchFailures > 0 ? 'rpc' : 'samples';
    return null;
  }

  // Prefer the CURRENT curve generation before variants are even formed.
  //
  // Pump runs legacy and v2 instructions concurrently, and which one wins the
  // sample count is luck. That matters because the legacy 27-account layout
  // carries accounts we do not model (`associated_user_volume_accumulator`),
  // so learning it produces a template that classifies cleanly and then fails
  // in simulation — observed 2026-08-24. Every mint being launched now is v2,
  // and v2 is what this app trades, so legacy samples are dropped whenever
  // enough v2 ones exist to learn from.
  const v2Samples = samples.filter((x) => x.accounts.includes(bondingCurveV2For(x.mint)));
  if (v2Samples.length >= 2 && new Set(v2Samples.map((x) => x.mint)).size >= 2) {
    samples = v2Samples;
    learnStats.samples = samples.length;
    learnStats.distinctMints = new Set(samples.map((x) => x.mint)).size;
  }

  // Group by (discriminator, account count) — that pair IS the variant. The
  // dominant variant wins (legacy + v2 instructions run concurrently).
  const byVariant = new Map<string, Sample[]>();
  for (const s of samples) {
    const kk = `${s.disc}:${s.accounts.length}`;
    const g = byVariant.get(kk) ?? [];
    g.push(s);
    byVariant.set(kk, g);
  }
  learnStats.variants = [...byVariant.entries()].map(([k, v]) => `${k}x${v.length}`);

  // Try variants LARGEST FIRST, but do not stake everything on the largest.
  //
  // Pump runs several trade instructions concurrently (measured 2026-08-24:
  // four buy variants in one sampling window). Sampling is stochastic, so a
  // legacy variant with two samples can out-count the current one, fail to
  // classify, and block a template that would otherwise have been learned —
  // observed directly: `c2ab1c46684d5b2f:27x2` won the vote and refused,
  // while `66063d1201daebea:18x9` sitting behind it classified cleanly.
  const ordered = [...byVariant.values()].sort((a, b) => b.length - a.length);
  let lastReject: string | null = null;
  for (const candidateGroup of ordered) {
    if (candidateGroup.length < 2 || new Set(candidateGroup.map((s) => s.mint)).size < 2) {
      lastReject = `variant ${candidateGroup[0].disc}:${candidateGroup[0].accounts.length} too thin (${candidateGroup.length} samples, ${new Set(candidateGroup.map((s) => s.mint)).size} mints)`;
      continue;
    }
    learnStats.chosen = `${candidateGroup[0].disc}:${candidateGroup[0].accounts.length}x${candidateGroup.length}`;
    learnStats.rejectedAt = null;
    const tpl = await classifyVariant(httpUrl, action, candidateGroup);
    if (tpl) return tpl;
    lastReject = learnStats.rejectedAt ?? 'classification failed';
  }
  learnFailure = 'samples';
  learnStats.rejectedAt = lastReject ?? 'no variant could be classified';
  return null;
}

/**
 * Turn one variant's samples into a template, or refuse.
 *
 * Refusing is the safe outcome everywhere in here: a wrong slot produces a
 * transaction that reverts in simulation, which costs a round trip, whereas a
 * confidently wrong template that happens to simulate could cost money.
 */
async function classifyVariant(
  httpUrl: string,
  action: 'buy' | 'sell',
  group0: Sample[],
): Promise<TradeTemplate | null> {
  let group = group0;
  const discHex = group[0].disc;

  // Resolve each sampled mint's true creator from chain, so non-derivable
  // slots can be classified as the raw creator vs its vault vs a fee account.
  const creators = new Map<string, string | null>();
  for (const s of group) {
    if (!creators.has(s.mint)) creators.set(s.mint, await resolveCreator(httpUrl, s.mint, new Set(s.accounts)));
  }

  // Split the group by CURVE GENERATION before classifying slots.
  //
  // Pump is mid-migration: newer mints carry a `["bonding-curve-v2", mint]`
  // account, older ones do not, and both trade through the same instruction
  // discriminator. Classified together, the v2 slot derives a role in some
  // samples and nothing in others, which reads as "the layout is in flux" and
  // refuses the whole template — so the two generations must be separated the
  // same way the discriminator separates variants. The larger generation
  // wins, exactly like the dominant-variant rule above.
  const withV2 = group.filter((s) => s.accounts.includes(bondingCurveV2For(s.mint)));
  const withoutV2 = group.filter((s) => !s.accounts.includes(bondingCurveV2For(s.mint)));
  const generation = withV2.length >= withoutV2.length ? withV2 : withoutV2;
  if (generation.length >= 2 && new Set(generation.map((s) => s.mint)).size >= 2) {
    group = generation;
    learnStats.chosen = `${group[0].disc}:${group[0].accounts.length}x${group.length}${
      generation === withV2 ? ' (v2 curves)' : ' (legacy curves)'
    }`;
  }

  // Keep only STRUCTURALLY CLEAN samples: ones where the trader's own ATA and
  // the curve's ATA are both present. Routed trades sometimes settle into an
  // account that is not the trader's ATA, and mixing those in makes a slot
  // derive `userAta` in some samples and nothing in others — which reads as
  // "the layout is in flux" and refuses a template that is actually fine.
  const isClean = (sample: Sample): boolean => {
    const roles = derivableRoles(sample, TOKEN_PROGRAMS);
    const kinds = new Set(sample.accounts.map((a) => roles.get(a)?.kind).filter(Boolean));
    return kinds.has('userAta') && kinds.has('curveAta') && kinds.has('bondingCurve');
  };
  const clean = group.filter(isClean);
  if (clean.length >= 2 && new Set(clean.map((s) => s.mint)).size >= 2) {
    group = clean;
    learnStats.chosen = `${group[0].disc}:${group[0].accounts.length}x${group.length} (clean)`;
  }

  const n = group[0].accounts.length;
  const perSample = group.map((s) => ({ s, roles: derivableRoles(s, TOKEN_PROGRAMS) }));
  const slots: (SlotRole | null)[] = new Array(n).fill(null);
  let tokenProgram: string | null = null;

  for (let j = 0; j < n; j++) {
    const assigned = perSample.map(({ s, roles }) => roles.get(s.accounts[j]) ?? null);
    const kinds = new Set(assigned.map((a) => a?.kind ?? 'none'));
    if (kinds.size === 1 && !kinds.has('none')) {
      // Every sample derives the same role for this slot.
      const a = assigned[0]!;
      slots[j] = { kind: a.kind } as SlotRole;
      if (a.tokenProgram) {
        if (tokenProgram && tokenProgram !== a.tokenProgram) return null; // mixed token programs — refuse
        tokenProgram = a.tokenProgram;
      }
      continue;
    }
    if (!kinds.has('none') || kinds.size > 1) {
      learnStats.rejectedAt = `slot ${j}: samples derive different roles (${[...kinds].join('/')})`;
      return null; // samples disagree — layout in flux, refuse
    }

    const values = group.map((s) => s.accounts[j]);
    if (new Set(values).size === 1) {
      slots[j] = { kind: 'fixed', pubkey: values[0] };
      continue;
    }
    // Non-derivable and varying across mints. Classify against each mint's
    // resolved creator: the raw creator, its vault PDA, or (else) a rotating
    // fee recipient. EVERY sample must agree, or we refuse the slot.
    // Only samples whose creator resolved on-chain can vote — an unresolved
    // creator would otherwise masquerade as a 'fee' and break consensus.
    const votes = group
      .map((s, k) => {
        // Prefer the on-chain-resolved creator, but fall back to the one the
        // trade event itself carries — self-contained, no lookup needed.
        const c = creators.get(s.mint) ?? s.creator;
        if (!c) return null;
        if (values[k] === c) return 'creator';
        if (values[k] === creatorVaultFor(c)) return 'creatorVault';
        return 'fee';
      })
      .filter((v): v is 'creator' | 'creatorVault' | 'fee' => v !== null);
    const roleSet = new Set(votes);
    if (votes.length === 0) {
      // Nobody resolved — assume a rotating fee account (safe: sim will catch
      // a mistake, and fee accounts genuinely vary here).
      slots[j] = { kind: 'fee', pubkey: values[0] };
    } else if (roleSet.size === 1) {
      const r = votes[0];
      slots[j] = r === 'fee' ? { kind: 'fee', pubkey: values[0] } : { kind: r };
    } else {
      learnStats.rejectedAt = `slot ${j}: samples disagree on its role`;
      return null; // samples disagree on this slot's creator role — refuse
    }
  }

  if (slots.some((s) => s === null)) {
    learnStats.rejectedAt = 'a slot could not be classified';
    return null;
  }
  const finalSlots = slots as SlotRole[];
  const count = (k: SlotRole['kind']): number => finalSlots.filter((s) => s.kind === k).length;
  if (count('mint') < 1 || count('user') < 1 || count('bondingCurve') < 1 || count('userAta') < 1) {
    learnStats.rejectedAt = `missing a required role (mint=${count('mint')} user=${count('user')} curve=${count('bondingCurve')} userAta=${count('userAta')})`;
    return null;
  }
  if (count('creatorVault') !== 1) {
    learnStats.rejectedAt = `creatorVault appears ${count('creatorVault')} times, expected exactly 1`;
    return null;
  }
  if (!tokenProgram) {
    learnStats.rejectedAt = 'no token program resolved';
    return null;
  }

  return {
    action,
    disc: Buffer.from(discHex, 'hex'),
    slots: finalSlots,
    writable: group[0].writable,
    tokenProgram,
    trailingData: Buffer.from(group[0].data.subarray(24)),
    learnedAt: Date.now(),
    sampleCount: group.length,
  };
}


/** Lockout after a failed learn. A rate-limited RPC recovers in seconds; a
 *  changed instruction does not. */
const LEARN_LOCKOUT_MS: Record<'rpc' | 'samples', number> = { rpc: 5_000, samples: 60_000 };

async function getTemplate(httpUrl: string, action: 'buy' | 'sell'): Promise<TradeTemplate | null> {
  const cached = templates[action];
  if (cached && Date.now() - cached.learnedAt < TEMPLATE_TTL_MS) return cached;
  if (Date.now() - lastLearnFailAt < LEARN_LOCKOUT_MS[lastLearnFailKind]) return null;
  const learned = await learn(httpUrl, action);
  if (!learned) {
    lastLearnFailAt = Date.now();
    lastLearnFailKind = learnFailure;
    return null;
  }
  templates[action] = learned;
  saveTemplates();
  return learned;
}

/** Why local building is currently unavailable, for the diagnostics panel. */
export function lastLearnFailure(): { kind: 'rpc' | 'samples'; at: number } | null {
  return lastLearnFailAt === 0 ? null : { kind: lastLearnFailKind, at: lastLearnFailAt };
}

// ── Building ──────────────────────────────────────────────────────────

export interface LocalBuildParams {
  action: 'buy' | 'sell';
  mint: string;
  creator: string;
  owner: string;
  /** Buy: lamports to spend. Sell: ignored (sells are always 100%). */
  solLamports: bigint;
  slippagePct: number;
  priorityFeeSol: number;
  computeUnitLimit: number;
  /** Latest known virtual reserves (engine's live view of the curve). */
  vSol: bigint;
  vTok: bigint;
  httpUrl: string;
}

export interface LocalBuildResult {
  ok: boolean;
  message: string;
  /** Serialized unsigned VersionedTransaction. */
  tx?: Uint8Array;
  /**
   * The trade's SOL value in lamports — what the platform fee is charged on.
   *
   * A buy knows this exactly (it is the SOL being spent). A sell does not, so
   * this is the curve's PRE-slippage estimate of the proceeds: the same number
   * the min-out limit is derived from. Charging on the estimate rather than the
   * realised amount means a sell into unusual slippage is billed slightly under
   * the true proceeds, which is the right direction to be wrong in.
   */
  solValueLamports?: number;
  /** Expiry height of the blockhash the tx was compiled with. The broadcaster
   *  treats the tx as dead only once the chain passes this — not on a clock. */
  lastValidBlockHeight?: number;
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v < 0n ? 0n : v);
  return b;
}

/**
 * One recent, successful trade of this mint in OUR template's variant —
 * used as a live source for the slots we cannot derive.
 *
 * Two slot kinds go stale in a cached template, and both were observed
 * failing in simulation on 2026-08-24:
 *
 *   • `creatorVault` — `["creator-vault", creator]` is only correct if the
 *     creator is, and pump.fun's API `creator` is NOT always the account the
 *     program expects (`ConstraintSeeds` on `creator_vault`).
 *   • `fee` — the fee recipients rotate and the program validates membership,
 *     so a recipient copied into a 6h-old template eventually stops being one
 *     (`NotAFeeRecipient`).
 *
 * Reading both from a trade that actually landed fixes them together, and it
 * is the same principle the rest of this file already follows: observe the
 * chain rather than hardcode what it is doing this week.
 */
interface Observation {
  accounts: string[];
  at: number;
}
const observedTrades = new Map<string, Observation>();
/**
 * Fee recipients rotate FAST — a recipient observed 90s ago was rejected with
 * `NotAFeeRecipient` (measured 2026-08-24), so this window is deliberately
 * tiny. It exists only to stop a burst of builds for the same mint from
 * repeating the same two reads.
 */
const OBSERVATION_TTL_MS = 8_000;

async function observeRecentTrade(httpUrl: string, mint: string, tpl: TradeTemplate): Promise<string[] | null> {
  const hit = observedTrades.get(mint);
  if (hit && Date.now() - hit.at < OBSERVATION_TTL_MS) return hit.accounts;

  let curve: string;
  try {
    curve = bondingCurveFor(mint);
  } catch {
    return null;
  }
  const sigs = await getSignaturesForAddress(httpUrl, curve, 10);
  if (!sigs.ok || !sigs.data) return null;

  // A same-shape trade is what we want, but a same-SIZE one is enough: the
  // slot indexes line up either way, and that is all this is used for. Being
  // strict about the discriminator meant a mint whose recent trades happened
  // to be sells (or the other buy variant) got no observation at all, fell
  // back to the derived creator vault, and reverted with `ConstraintSeeds`.
  let sameSize: string[] | null = null;

  for (const sig of sigs.data) {
    if (sig.err !== null) continue;
    const tx = await getTransaction(httpUrl, sig.signature);
    if (!tx.ok || !tx.data?.meta) continue;
    const msg = tx.data.transaction.message;
    const loaded = tx.data.meta.loadedAddresses;
    const keys = [...msg.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
    const allIx = [...msg.instructions, ...(tx.data.meta.innerInstructions ?? []).flatMap((g) => g.instructions)];
    for (const ix of allIx) {
      if (keys[ix.programIdIndex] !== PUMP_PROGRAM) continue;
      if (ix.accounts.length !== tpl.slots.length) continue;
      let data: Buffer;
      try {
        data = Buffer.from(base58Decode(ix.data));
      } catch {
        continue;
      }
      if (data.length < 24) continue;
      const accounts = ix.accounts.map((i) => keys[i]);
      if (accounts.some((a) => a === undefined)) continue;
      if (data.subarray(0, 8).equals(tpl.disc)) {
        observedTrades.set(mint, { accounts, at: Date.now() });
        return accounts;
      }
      sameSize ??= accounts;
    }
  }

  if (sameSize) {
    observedTrades.set(mint, { accounts: sameSize, at: Date.now() });
    return sameSize;
  }
  return null;
}

export async function buildLocalTrade(p: LocalBuildParams): Promise<LocalBuildResult> {
  // The mint we are about to trade is, by definition, one that trades — so it
  // is a good sampling source even if the engine never fed the ring.
  noteActiveMint(p.mint, p.creator);

  // ONE round trip for everything the build reads from chain:
  //  - the mint's owner — the token program is per-MINT (fresh pump mints are
  //    Token-2022, older ones classic SPL) and the ATAs must be derived for
  //    the right one, a mismatch being a silent buy failure. Immutable, so it
  //    is cached per process after the first read;
  //  - the bonding curve — the source of truth for whether the curve is
  //    COMPLETE (the 2026-08-29 failure was a buy on a curve the API still
  //    called open), the CREATOR `creator_vault` is seeded with, and the live
  //    reserves the quote uses;
  //  - pump's Global, only when its 60 s cache is cold.
  // These were three sequential reads (plus a blind 400 ms retry sleep) on
  // the order's critical path; a transient failure now retries immediately.
  const bc = bondingCurveFor(p.mint);
  const knownOwner = mintOwnerCache.get(p.mint);
  const wantGlobal = !globalFresh();
  const addrs = [bc];
  if (!knownOwner) addrs.push(p.mint);
  if (wantGlobal) addrs.push(globalFor());
  let multi = await getMultipleAccountInfo(p.httpUrl, addrs);
  if (!multi.ok || !multi.data) return { ok: false, message: `account read: ${multi.message}` };
  const byAddr = new Map(addrs.map((a, i) => [a, multi.data?.[i] ?? null]));

  let tokenProgram = knownOwner;
  if (!tokenProgram) {
    const mintAcc = byAddr.get(p.mint);
    if (!mintAcc) return { ok: false, message: 'mint account: not found' };
    tokenProgram = mintAcc.owner;
    if (tokenProgram === TOKEN_PROGRAM || tokenProgram === TOKEN_2022_PROGRAM) {
      if (mintOwnerCache.size >= MINT_OWNER_CAP) {
        const oldest = mintOwnerCache.keys().next().value;
        if (oldest !== undefined) mintOwnerCache.delete(oldest);
      }
      mintOwnerCache.set(p.mint, tokenProgram);
    }
  }
  if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) {
    return { ok: false, message: `mint owner ${tokenProgram.slice(0, 8)} is not a token program` };
  }
  if (wantGlobal) acceptGlobal(byAddr.get(globalFor())?.data ?? null);

  const curveInfo = byAddr.get(bc) ?? null;
  const curve = curveInfo ? parseCurve(curveInfo.data) : null;
  if (!curve) return { ok: false, message: 'bonding curve account is missing or unrecognised — not an open pump curve' };
  if (curve.complete) return { ok: false, message: 'bonding curve is complete (graduated) — not a curve trade' };
  // A legacy curve without a creator field seeds the vault with the default
  // pubkey. Trusting the API creator there is exactly the ConstraintSeeds
  // revert; the caller's creator is only used when the chain has none.
  // With no caller creator (chain-first callers pass none) a zero creator on
  // chain means the program seeds the vault with the default pubkey.
  const creator = curve.creator ?? (curveInfo && curveInfo.data.length < 81 ? SYSTEM_PROGRAM : p.creator || SYSTEM_PROGRAM);
  const vSol = curve.vSol > 0n ? curve.vSol : p.vSol;
  const vTok = curve.vTok > 0n ? curve.vTok : p.vTok;

  // Amounts from the live curve state; slippage margin also absorbs the gap
  // between our modeled 1% curve fee and pump's current tiered ~1.25%.
  let amount: bigint;
  let limit: bigint;
  /** SOL value of this trade, for the platform fee. See LocalBuildResult. */
  let solValueLamports = 0;
  const userAta = ataFor(p.owner, p.mint, tokenProgram);
  if (p.action === 'buy') {
    const q = buyQuote(p.solLamports, vSol, vTok);
    amount = (q.tokensOut * BigInt(Math.round((1 - p.slippagePct / 100) * 10_000))) / 10_000n;
    limit = p.solLamports;
    solValueLamports = Number(p.solLamports);
    if (amount <= 0n) return { ok: false, message: 'buy quote is zero tokens' };
  } else {
    const bal = await getTokenBalanceRaw(p.httpUrl, userAta);
    if (!bal.ok || bal.data === undefined) return { ok: false, message: `token balance: ${bal.message}` };
    if (bal.data <= 0n) return { ok: false, message: 'nothing to sell (zero token balance)' };
    amount = bal.data;
    const q = sellQuote(amount, vSol, vTok);
    limit = (q.solOutLamports * BigInt(Math.round((1 - p.slippagePct / 100) * 10_000))) / 10_000n;
    solValueLamports = Number(q.solOutLamports);
  }

  // Derived layout first; the learner only once the derived layout has been
  // struck out (see noteDerivedStrike).
  let tpl: TradeTemplate;
  let observed: string[] | null = null;
  if (!derivedLayoutSuspended()) {
    tpl = derivedTemplate(p.action);
    lastBuildPath = 'derived';
  } else {
    const learned = await getTemplate(p.httpUrl, p.action);
    if (!learned) {
      return {
        ok: false,
        message:
          lastLearnFailKind === 'rpc'
            ? 'no learned template — the RPC would not serve enough recent transactions (a Helius key fixes this)'
            : 'no learned template — no recent pump trades matched a known instruction shape',
      };
    }
    tpl = learned;
    lastBuildPath = 'learned';
    // Volatile slots (rotating fee recipients) of a LEARNED template come
    // from a real recent trade where one exists.
    observed = await observeRecentTrade(p.httpUrl, p.mint, tpl);
  }
  const global = await readGlobal(p.httpUrl);

  let keys;
  try {
    const filled = fillSlots(
      tpl,
      { mint: p.mint, owner: p.owner, creator, tokenProgram, feeRecipient: global.feeRecipient, feeVault: global.feeVault },
      observed,
    );
    keys = filled.map((pubkey, j) => ({
      pubkey: new PublicKey(pubkey),
      isSigner: tpl.slots[j].kind === 'user',
      isWritable: tpl.slots[j].kind === 'user' ? true : tpl.writable[j],
    }));
  } catch (err) {
    return { ok: false, message: `account derivation failed: ${(err as Error).message}` };
  }

  const data = Buffer.concat([encodeTradeData(tpl.disc, amount, limit), tpl.trailingData]);
  const tradeIx = new TransactionInstruction({ programId: new PublicKey(PUMP_PROGRAM), keys, data });

  const microLamports = Math.max(
    1,
    Math.floor((p.priorityFeeSol * 1e9 * 1e6) / Math.max(p.computeUnitLimit, 1)),
  );
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
  if (p.action === 'buy') {
    // Idempotent ATA create — a no-op when the account already exists.
    instructions.push(
      new TransactionInstruction({
        programId: new PublicKey(ATA_PROGRAM),
        keys: [
          { pubkey: new PublicKey(p.owner), isSigner: true, isWritable: true },
          { pubkey: new PublicKey(userAta), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(p.owner), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(p.mint), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(tokenProgram), isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
    );
  }
  instructions.push(tradeIx);
  if (p.action === 'sell') {
    // Sells are always 100%, so the ATA is empty afterwards — close it in the
    // same tx and reclaim the ~0.00203 SOL rent (2026-07-24 swarm: the leak
    // exceeds pump fees at live sizes). If anything would leave dust, the
    // close fails simulation and liveSigner falls back to the relayer path.
    instructions.push(
      new TransactionInstruction({
        programId: new PublicKey(tokenProgram),
        keys: [
          { pubkey: new PublicKey(userAta), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(p.owner), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(p.owner), isSigner: true, isWritable: false },
        ],
        data: Buffer.from([9]), // CloseAccount
      }),
    );
  }

  if (!cachedBlockhash || Date.now() - cachedBlockhash.at > BLOCKHASH_TTL_MS) {
    const bh = await getLatestBlockhashInfo(p.httpUrl);
    if (!bh.ok || !bh.data) return { ok: false, message: `blockhash: ${bh.message}` };
    cachedBlockhash = { value: bh.data.blockhash, lastValidBlockHeight: bh.data.lastValidBlockHeight, at: Date.now() };
  }

  try {
    const message = MessageV0.compile({
      payerKey: new PublicKey(p.owner),
      instructions,
      recentBlockhash: cachedBlockhash.value,
    });
    return {
      ok: true,
      message: `local ${p.action} built (${tpl.slots.length}-slot ${lastBuildPath} layout)`,
      tx: new VersionedTransaction(message).serialize(),
      solValueLamports,
      lastValidBlockHeight: cachedBlockhash.lastValidBlockHeight,
    };
  } catch (err) {
    return { ok: false, message: `tx compile failed: ${(err as Error).message}` };
  }
}
