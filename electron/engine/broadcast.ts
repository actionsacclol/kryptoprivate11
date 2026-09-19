// Multi-lane live broadcaster — the real counterpart of the shadow sender.
//
// The 2026-07-24 live session showed the failure mode plainly: buys landed,
// but 4 of 5 sells died at the confirm stage — a single sendTransaction with
// maxRetries=0 to one RPC, then a passive poll. A sell that never lands turns
// a −10% exit into a rug ride, so landing reliability IS fund protection.
//
// This module does two things:
//  1. injectTips(): appends tip-transfer instructions to the UNSIGNED tx
//     (Helius Sender swqosOnly needs ≥5000 lamports to a Helius tip account;
//     the Jito block engine only forwards txs tipping one of its 8 accounts).
//     Tips ride inside the transaction, so the existing simulate → loss-guard
//     pipeline bounds them like any other cost. One signed tx is then fanned
//     to every lane — same signature everywhere, so a double-land is
//     impossible by construction.
//  2. broadcastAndConfirm(): sends to all lanes and KEEPS resending every
//     ~2.5s while polling signature status, until confirmed / on-chain error /
//     blockhash-lifetime timeout. Leaders drop transactions; rebroadcast is
//     what actually lands them.
//
// Endpoints + tip lists verified against docs 2026-07-24 (Helius Sender docs,
// docs.jito.wtf). A wrong tip account cannot lose funds — the lane's gateway
// rejects the tx and the RPC lane still carries it; tips only spend when the
// trade itself lands.

import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  MessageV0,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAccountInfo, getBlockHeight, getSignatureStatuses, isChallengeResponse, sendRawTransaction, noteRpcRejection } from '../chain/rpcClient';
import { HELIUS_TIP_ACCOUNTS, JITO_TIP_ACCOUNTS } from '../chain/tipAccounts';
import * as confirmSocket from './confirmSocket';

/** Exported so prewarm.ts can open these connections before a trade needs them. */
export const HELIUS_SENDER_URL = 'https://sender.helius-rpc.com/fast?swqos_only=true';
export const JITO_SEND_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true';

/** swqosOnly minimum — staked-connection landing, free on all Helius plans. */
export const HELIUS_SWQOS_TIP_LAMPORTS = 5_000;
/** Floor/ceiling for the dynamic Jito tip (0.000001 / 0.005 SOL). The cap
 *  matters on sells: their loss bound is OVERHEAD_SOL only, and a p95 spike
 *  must never eat it. */
const JITO_TIP_MIN_LAMPORTS = 1_000;
const JITO_TIP_MAX_LAMPORTS = 5_000_000;

const pick = <T>(arr: readonly T[], seed: number): T => arr[Math.abs(seed) % arr.length];

export type SendLane = 'rpc' | 'helius-sender' | 'jito';

export interface TipPlan {
  /** True when this plan sends ONLY to the bundle lane — no public broadcast. */
  private: boolean;
  lanes: SendLane[];
  tips: Array<{ to: string; lamports: number }>;
  /** Total tip cost, for logging. */
  totalLamports: number;
}

export interface TipExecSettings {
  useJito: boolean;
  jitoTipPercentile: 50 | 75 | 95;
  useHeliusSender: boolean;
  /** See ExecutionSettings.mevMode. Absent on older callers = 'fast'. */
  mevMode?: import('@shared/types').MevMode;
}

export interface TipFloorLamports {
  p50Lamports: number;
  p75Lamports: number;
  p95Lamports: number;
}

/** Decide lanes + tip transfers for this trade. Sells always escalate the
 *  Jito tip to the p95 floor — exit landing protects funds; entry landing
 *  only chases them. */
export function planTips(
  exec: TipExecSettings,
  action: 'buy' | 'sell',
  floor: TipFloorLamports,
  seed: number,
): TipPlan {
  // 'private' sends a BUY to the bundle lane only, so the transaction is
  // never broadcast to a public RPC and cannot be read out of a mempool
  // before it lands. It is the one honest anti-sandwich lever available
  // locally: a bundle is relayed straight to a block engine.
  //
  // A SELL is never private. Exiting is the trade you cannot afford to have
  // miss a block, and the same reasoning that already escalates a sell's tip
  // to the p95 floor says it should keep every lane it can get.
  const mode = exec.mevMode ?? 'fast';
  const wantPrivate = mode === 'private' && action === 'buy';
  const lanes: SendLane[] = wantPrivate ? [] : ['rpc'];
  const tips: Array<{ to: string; lamports: number }> = [];

  if (mode === 'off') {
    // Public lane, nothing paid for placement.
    return { lanes, tips, totalLamports: 0, private: false };
  }

  if (exec.useHeliusSender && !wantPrivate) {
    // The staked lane is a faster public path, not a private one, so it has
    // no place in a private send.
    lanes.push('helius-sender');
    tips.push({ to: pick(HELIUS_TIP_ACCOUNTS, seed), lamports: HELIUS_SWQOS_TIP_LAMPORTS });
  }
  // Private mode IS the bundle lane, so it implies Jito whatever the toggle
  // says — otherwise the mode would silently send nothing.
  if (exec.useJito || wantPrivate) {
    const pct = action === 'sell' ? 95 : exec.jitoTipPercentile;
    const raw = pct === 50 ? floor.p50Lamports : pct === 75 ? floor.p75Lamports : floor.p95Lamports;
    const lamports = Math.min(JITO_TIP_MAX_LAMPORTS, Math.max(JITO_TIP_MIN_LAMPORTS, Math.round(raw)));
    lanes.push('jito');
    tips.push({ to: pick(JITO_TIP_ACCOUNTS, seed), lamports });
  }
  // A private plan that ended up with no lane at all would silently drop the
  // trade; fall back to the public one rather than lose it.
  if (!lanes.length) lanes.push('rpc');
  return {
    lanes,
    tips,
    totalLamports: tips.reduce((a, t) => a + t.lamports, 0),
    private: wantPrivate && lanes.length === 1 && lanes[0] === 'jito',
  };
}

/** Append tip transfers to an UNSIGNED VersionedTransaction. Returns the new
 *  unsigned bytes, or null when the message can't be safely rebuilt (e.g. an
 *  address-lookup table we fail to fetch) — the caller then broadcasts the
 *  original tx on the RPC lane only. Never throws. */
export async function injectTips(
  txBytes: Uint8Array,
  owner: string,
  tips: Array<{ to: string; lamports: number }>,
  httpUrl: string,
): Promise<Uint8Array | null> {
  return injectTransfers(txBytes, owner, tips, httpUrl);
}

/**
 * Append SOL transfers to an UNSIGNED VersionedTransaction.
 *
 * This is the same operation tips have always used; it is named generically
 * because the platform fee rides the identical path. Both go in BEFORE
 * signing, so the transfers we add are inside the artifact that gets validated,
 * simulated and loss-guarded — there is no second, unchecked transaction.
 *
 * Returns null when the message cannot be safely rebuilt. Callers decide what
 * that means: for tips it drops to the RPC lane, and for fees it means the
 * trade proceeds WITHOUT a fee — never that the user's trade is blocked.
 */
export async function injectTransfers(
  txBytes: Uint8Array,
  owner: string,
  tips: Array<{ to: string; lamports: number }>,
  httpUrl: string,
): Promise<Uint8Array | null> {
  const r = await injectTransfersFit(txBytes, owner, tips.map((t) => ({ ...t, priority: 0 })), httpUrl, false);
  return r ? r.tx : null;
}

/** Solana's hard cap on a serialized transaction (packet MTU minus headers). */
export const MAX_TX_BYTES = 1232;

/**
 * Public address-lookup tables we may compile against to shrink a message.
 * Any transaction can reference any table; the only risk is the owner
 * deactivating it, which we check before use and which merely costs the
 * compression (the message then compiles without it). PumpPortal's table
 * carries the pump / pump-amm / token / system / fee accounts every relayer
 * build already contains — measured 2026-08-29: a graduated buy went from
 * 1140 to 1019 bytes, which is the headroom our tips and fee need.
 */
const KNOWN_PUBLIC_ALTS = ['84gxtAAWToZ6xep3wrWsx8TEoLB7EBS9VrKkV9CtMdJi'];
const publicAltCache = new Map<string, { at: number; alt: AddressLookupTableAccount | null }>();
const U64_MAX = (1n << 64n) - 1n;

/**
 * Lookup tables by key. A PumpPortal build references its own (stable) table
 * and it was re-read from chain on EVERY relayer trade — one full RPC round
 * trip on the critical path. Tables are append-only, so a 10-minute copy is
 * safe: existing indexes never move, and a table closed underneath us fails
 * the tx on chain, which the confirm loop reports as a revert exactly as it
 * would have anyway.
 */
const altCache = new Map<string, { at: number; alt: AddressLookupTableAccount | null }>();
const ALT_TTL_MS = 10 * 60_000;
const ALT_CACHE_CAP = 64;

async function fetchAlt(httpUrl: string, key: string): Promise<AddressLookupTableAccount | null> {
  const hit = altCache.get(key);
  if (hit && Date.now() - hit.at < ALT_TTL_MS) return hit.alt;
  const info = await getAccountInfo(httpUrl, key);
  // A transient RPC failure: a stale copy beats no copy (and beats failing
  // the injection, which drops the tips and the fee).
  if (!info.ok) return hit?.alt ?? null;
  let alt: AddressLookupTableAccount | null = null;
  if (info.data) {
    alt = new AddressLookupTableAccount({
      key: new PublicKey(key),
      state: AddressLookupTableAccount.deserialize(info.data.data),
    });
  }
  if (altCache.size >= ALT_CACHE_CAP) {
    const oldest = altCache.keys().next().value;
    if (oldest !== undefined) altCache.delete(oldest);
  }
  altCache.set(key, { at: Date.now(), alt });
  return alt;
}

/** Prewarm: have the public tables in hand before the first trade. */
export async function prewarmAlts(httpUrl: string): Promise<void> {
  try {
    await publicAlts(httpUrl);
  } catch {
    /* the injection fetches inline if this failed */
  }
}

async function publicAlts(httpUrl: string): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = [];
  for (const key of KNOWN_PUBLIC_ALTS) {
    const hit = publicAltCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) {
      if (hit.alt) out.push(hit.alt);
      continue;
    }
    let alt: AddressLookupTableAccount | null = null;
    try {
      alt = await fetchAlt(httpUrl, key);
      // A table being deactivated stops resolving a few hundred slots later;
      // never lean on one that is on its way out.
      if (alt && alt.state.deactivationSlot !== U64_MAX) alt = null;
    } catch {
      alt = null;
    }
    publicAltCache.set(key, { at: Date.now(), alt });
    if (alt) out.push(alt);
  }
  return out;
}

/** True when every top-level SystemProgram transfer names a STATIC
 *  destination. The signer refuses a transfer whose destination sits behind
 *  a lookup table (it cannot verify where the SOL goes without a fetch), so
 *  a compression that hides one is worse than no compression. */
export function transferDestinationsStatic(msg: MessageV0): boolean {
  const keys = msg.staticAccountKeys;
  const sys = keys.findIndex((k) => k.equals(SystemProgram.programId));
  if (sys < 0) return true;
  for (const ix of msg.compiledInstructions) {
    if (ix.programIdIndex !== sys) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 4 || data.readUInt32LE(0) !== 2) continue; // 2 = Transfer
    const dest = ix.accountKeyIndexes[1];
    if (dest === undefined || dest >= keys.length) return false;
  }
  return true;
}

/**
 * Compile with the extra (public) lookup tables for size, but only if that
 * leaves every transfer destination static; otherwise compile with the
 * transaction's own tables alone. PumpPortal's table contains their fee
 * wallet, so the AMM route's fee transfer got hidden the first time this
 * shipped (2026-08-29: "Transfer destination is hidden in an address
 * lookup table — refusing to sign", on every graduated token).
 */
export function compileKeepingTransfersStatic(
  msg: TransactionMessage,
  own: AddressLookupTableAccount[],
  extra: AddressLookupTableAccount[],
): MessageV0 {
  // Every SOL transfer destination in the message must stay a static key —
  // whichever table it appears in. PumpPortal's table (the relayer's OWN
  // table on router builds) contains one of Jito's tip accounts, so a
  // seeded tip pick landing on it hid the tip behind an index and the signer
  // refused; seen live on a sell 2026-08-29. Masking those entries out of the
  // tables (same positions, so every other index still resolves) makes the
  // compiler leave them static.
  const keep = transferDestinations(msg);
  const ownMasked = own.map((a) => maskAlt(a, keep));
  const extraMasked = extra.map((a) => maskAlt(a, keep));
  if (extraMasked.length > 0) {
    const compressed = msg.compileToV0Message([...ownMasked, ...extraMasked]);
    if (transferDestinationsStatic(compressed)) return compressed;
  }
  const plain = msg.compileToV0Message(ownMasked);
  if (transferDestinationsStatic(plain)) return plain;
  // Cannot happen after masking; if it ever does, prefer a message the signer
  // will read over one it will refuse.
  return msg.compileToV0Message([]);
}

/** Destinations of every SystemProgram transfer in an uncompiled message. */
function transferDestinations(msg: TransactionMessage): Set<string> {
  const out = new Set<string>();
  for (const ix of msg.instructions) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 4 || data.readUInt32LE(0) !== 2) continue;
    const dest = ix.keys[1]?.pubkey;
    if (dest) out.add(dest.toBase58());
  }
  return out;
}

/** A copy of a lookup table with the given keys replaced IN PLACE by a key
 *  no message references, so the compiler cannot resolve them through the
 *  table while every other entry keeps its on-chain index. */
function maskAlt(alt: AddressLookupTableAccount, exclude: Set<string>): AddressLookupTableAccount {
  if (exclude.size === 0) return alt;
  let touched = false;
  const addresses = alt.state.addresses.map((k) => {
    if (!exclude.has(k.toBase58())) return k;
    touched = true;
    return PublicKey.default;
  });
  if (!touched) return alt;
  return new AddressLookupTableAccount({ key: alt.key, state: { ...alt.state, addresses } });
}

export interface PlannedTransfer {
  to: string;
  lamports: number;
  /** Higher = dropped first when the transaction would not fit. */
  priority: number;
}

/**
 * Append transfers, compressing with lookup tables, and if the result still
 * exceeds MAX_TX_BYTES drop the least important transfers until it fits.
 *
 * A graduated-token relayer build is ~1140 bytes with 28 static accounts —
 * three appended transfers overflow it (1287 bytes; seen live 2026-08-29).
 * The trade must never fail for that: a tip or the referral cut is worth
 * less than the trade, so they go first; `allowDrop=false` keeps the old
 * all-or-nothing contract for callers that want it.
 */
export async function injectTransfersFit(
  txBytes: Uint8Array,
  owner: string,
  transfers: PlannedTransfer[],
  httpUrl: string,
  allowDrop = true,
): Promise<{ tx: Uint8Array; kept: PlannedTransfer[]; dropped: PlannedTransfer[] } | null> {
  if (transfers.length === 0) return { tx: txBytes, kept: [], dropped: [] };
  try {
    const tx = VersionedTransaction.deserialize(txBytes);
    const own: AddressLookupTableAccount[] = [];
    for (const l of tx.message.addressTableLookups ?? []) {
      const alt = await fetchAlt(httpUrl, l.accountKey.toBase58());
      if (!alt) return null;
      own.push(alt);
    }
    const extra = await publicAlts(httpUrl);
    const from = new PublicKey(owner);
    const attempt = (set: PlannedTransfer[]): Uint8Array | null => {
      const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: own });
      for (const t of set) {
        msg.instructions.push(
          SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(t.to), lamports: t.lamports }),
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = new VersionedTransaction(compileKeepingTransfersStatic(msg, own, extra)).serialize();
      } catch {
        return null; // web3.js throws "encoding overruns" past the packet limit
      }
      return bytes.length <= MAX_TX_BYTES ? bytes : null;
    };
    let kept = [...transfers];
    const dropped: PlannedTransfer[] = [];
    for (;;) {
      const bytes = attempt(kept);
      if (bytes) return { tx: bytes, kept, dropped };
      if (!allowDrop || kept.length === 0) return null;
      // Drop the highest-priority-number transfer (least important) and retry.
      const idx = kept.reduce((best, t, i) => (t.priority > kept[best].priority ? i : best), 0);
      dropped.push(kept[idx]);
      kept = kept.filter((_, i) => i !== idx);
    }
  } catch {
    return null;
  }
}

async function postJsonRpc(url: string, base64Tx: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [base64Tx, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
      }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      // A send lane refusing our key is the same problem the read path
      // reports; telling the registry here means one rejected key produces
      // one message and one failover, not two independent mysteries. Keyed
      // lanes only — a tip relay answering 401 is not the user's RPC key,
      // and must not send them off to fix a setting that is already right.
      // ...and a Cloudflare challenge is not a rejected key either. A 403
      // carrying an interstitial means the EDGE said no, not the provider:
      // banning the endpoint for 15 minutes and telling the user to replace a
      // key that works is the wrong answer twice over.
      if ((res.status === 401 || res.status === 403) && /api-key=/i.test(url) && !(await isChallengeResponse(res))) {
        noteRpcRejection(url, res.status);
      }
      return { ok: false, message: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error) return { ok: false, message: body.error.message ?? 'error' };
    return { ok: true, message: 'ok' };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? 'request failed' };
  }
}

export interface BroadcastResult {
  /** True when the signature reached confirmed/finalized commitment. */
  landed: boolean;
  /** True when the chain executed the tx but it errored (definitive). */
  chainErr: boolean;
  /**
   * True only when the chain's block height passed the tx's
   * lastValidBlockHeight without a confirmation — the tx can NEVER land.
   * False with landed=false means we stopped waiting (absolute cap, or no
   * expiry height known) while the tx might still land: treat as PENDING,
   * never as failed, and never rebuild-and-resend a buy or partial sell on it.
   */
  expired: boolean;
  /** Per-lane accept/reject notes from the FIRST send round, for the log. */
  laneNotes: string;
  /** Wall time of the first fan-out send (all lanes, parallel). */
  sendMs: number;
  /** From the first send to the moment we KNEW it landed (or failed/expired). */
  confirmMs: number;
  /** From the first send to the first `processed` sighting, when observed. */
  processedMs?: number;
}

/** Fan one signed tx to every lane and rebroadcast until it confirms, errors
 *  on-chain, or the blockhash lifetime is spent. The signature is identical
 *  on every lane, so at most one execution can ever land. */
export async function broadcastAndConfirm(opts: {
  httpUrl: string;
  base64: string;
  signature: string;
  lanes: SendLane[];
  /** Absolute backstop. With an expiry height this is generous; the height
   *  is what actually decides. Without one, the old 55s clock applies. */
  timeoutMs?: number;
  /** From getLatestBlockhash. When known, "expired" means the chain passed
   *  it — a clock alone declared 2026-08 buys dead 20s+ before the blockhash
   *  was, and they landed after we had given up on them. */
  lastValidBlockHeight?: number;
  /** Test seam: how often to ask the chain for its height. */
  heightPollMs?: number;
  /**
   * WebSocket for `signatureSubscribe` (confirmSocket.ts). The push usually
   * beats the status poll by a poll interval; the poll stays as the backstop,
   * so a socket that is down changes nothing.
   */
  wssUrl?: string;
  /**
   * Fired ONCE, the first time the signature is seen at `processed` — the
   * earliest honest "it is on chain" signal, a slot or so before `confirmed`.
   * The renderer refreshes the position on it; the result below still waits
   * for `confirmed`, so nothing that books money moves earlier.
   */
  onProcessed?: () => void;
}): Promise<BroadcastResult> {
  const hasHeight = typeof opts.lastValidBlockHeight === 'number' && Number.isFinite(opts.lastValidBlockHeight);
  const deadline = Date.now() + (opts.timeoutMs ?? (hasHeight ? 120_000 : 55_000));
  const HEIGHT_POLL_MS = opts.heightPollMs ?? 2_000;
  let lastHeightPoll = 0;
  const RESEND_EVERY_MS = 2_500;
  // Confirmation cadence. A Solana slot is ~400ms, so nothing confirms sooner
  // than that — but polling every 1.2s (the old fixed interval) meant a trade
  // that landed in one or two slots still wasn't SEEN as landed for 1.2–2.4s
  // of pure dead time, and that dead time was most of a "4-second" fill. Poll
  // aggressively for the first few seconds to catch the common fast confirm,
  // then back off so a slow, still-unconfirmed trade doesn't hammer the RPC's
  // rate limit while it waits out the blockhash.
  // With the confirmation socket open the push is what usually wins; the
  // poll can afford to be gentler on the RPC's rate limit (the same limit
  // the trade's own simulate/send calls share).
  // With the socket open the push wins by ~130 ms and the poll is a safety
  // net, so it runs at 1 s; without it the poll IS the confirmation and
  // stays at 300 ms. Five wallets fanning out at 500 ms each was 165
  // getSignatureStatuses per ten seconds — four times the public window
  // (rate-limit swarm, 2026-09-06). A 429 on a poll doubles the wait.
  const socketOpen = !!opts.wssUrl && confirmSocket.isOpen();
  const FAST_POLL_MS = socketOpen ? 1_000 : 300;
  const SLOW_POLL_MS = socketOpen ? 1_500 : 1_000;
  const fastUntil = Date.now() + 4_000;
  let pollPenaltyMs = 0;
  let lastSend = 0;
  let laneNotes = '';
  let sendMs = 0;
  let sentAt = 0;
  let processedMs: number | undefined;
  let processedNoted = false;
  const noteProcessed = (): void => {
    if (processedNoted) return;
    processedNoted = true;
    processedMs = Date.now() - sentAt;
    try {
      opts.onProcessed?.();
    } catch {
      /* a UI hook must never affect the trade */
    }
  };
  const done = (r: Omit<BroadcastResult, 'sendMs' | 'confirmMs' | 'processedMs'>): BroadcastResult => ({
    ...r,
    sendMs,
    confirmMs: Date.now() - sentAt,
    processedMs,
  });

  const sendAll = async (first: boolean): Promise<void> => {
    lastSend = Date.now();
    const jobs: Array<Promise<{ lane: SendLane; ok: boolean; message: string }>> = [];
    for (const lane of opts.lanes) {
      if (lane === 'rpc') {
        jobs.push(sendRawTransaction(opts.httpUrl, opts.base64).then((r) => ({ lane, ok: r.ok, message: r.message })));
      } else if (lane === 'helius-sender') {
        jobs.push(postJsonRpc(HELIUS_SENDER_URL, opts.base64).then((r) => ({ lane, ...r })));
      } else {
        jobs.push(postJsonRpc(JITO_SEND_URL, opts.base64).then((r) => ({ lane, ...r })));
      }
    }
    const results = await Promise.all(jobs);
    if (first) {
      laneNotes = results.map((r) => `${r.lane}:${r.ok ? 'ok' : r.message.slice(0, 60)}`).join(' ');
    }
  };

  // Subscribe BEFORE the send so a one-slot landing cannot slip between the
  // send and the subscription. Both resolve null when the socket cannot say.
  const wsConfirmed = opts.wssUrl
    ? confirmSocket.waitFor(opts.signature, 'confirmed', Math.max(1_000, deadline - Date.now()))
    : null;
  if (opts.wssUrl) {
    void confirmSocket.waitFor(opts.signature, 'processed', 20_000).then((r) => {
      if (r && !r.err) noteProcessed();
    });
  }
  let wsOutcome: confirmSocket.SignatureOutcome | null | undefined;
  let wsPending: Promise<unknown> | null = wsConfirmed;
  if (wsConfirmed) {
    void wsConfirmed.then((r) => {
      wsOutcome = r;
      wsPending = null;
    });
  }

  const t0 = Date.now();
  await sendAll(true);
  sendMs = Date.now() - t0;
  sentAt = Date.now();
  while (Date.now() < deadline) {
    const pollMs = (Date.now() < fastUntil ? FAST_POLL_MS : SLOW_POLL_MS) + pollPenaltyMs;
    await Promise.race([
      new Promise((r) => setTimeout(r, pollMs)),
      ...(wsPending ? [wsPending] : []),
    ]);
    if (wsOutcome) {
      // The socket answered: definitive either way.
      if (wsOutcome.err) return done({ landed: false, chainErr: true, laneNotes, expired: false });
      noteProcessed();
      return done({ landed: true, chainErr: false, laneNotes, expired: false });
    }
    const st = await getSignatureStatuses(opts.httpUrl, [opts.signature]);
    // A rate-limited poll backs off (1 s, 2 s, capped at 3 s extra) instead
    // of asking again at the same cadence; a good answer lifts the penalty.
    pollPenaltyMs = !st.ok && /429/.test(st.message) ? Math.min(3_000, pollPenaltyMs ? pollPenaltyMs * 2 : 1_000) : 0;
    if (st.ok && st.data) {
      const s = st.data[0];
      if (s?.err) return done({ landed: false, chainErr: true, laneNotes, expired: false });
      if (s?.confirmationStatus) noteProcessed();
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
        return done({ landed: true, chainErr: false, laneNotes, expired: false });
      }
    }
    if (hasHeight && Date.now() - lastHeightPoll >= HEIGHT_POLL_MS) {
      lastHeightPoll = Date.now();
      const h = await getBlockHeight(opts.httpUrl);
      if (h.ok && typeof h.data === 'number' && h.data > (opts.lastValidBlockHeight as number)) {
        // One last status read: the tx may have confirmed in the slot that
        // crossed the expiry height.
        const fin = await getSignatureStatuses(opts.httpUrl, [opts.signature]);
        const s = fin.ok && fin.data ? fin.data[0] : null;
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
          noteProcessed();
          return done({ landed: true, chainErr: false, laneNotes, expired: false });
        }
        if (s?.err) return done({ landed: false, chainErr: true, laneNotes, expired: false });
        return done({ landed: false, chainErr: false, laneNotes, expired: true });
      }
    }
    if (Date.now() - lastSend >= RESEND_EVERY_MS) await sendAll(false);
  }
  return done({ landed: false, chainErr: false, laneNotes, expired: false });
}
