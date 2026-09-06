// Thin Solana JSON-RPC HTTP client (fetch-based, no SDK). Only the calls
// the risk engine actually needs. Every method returns a typed result and
// never throws — a dead RPC must degrade the engine, not crash it.

import { base58Encode } from './base58';
import { classifyRpcFailure, credentialsMessage, safeHost } from '../../shared/rpcErrors';
import * as heliusBudget from '../system/heliusBudget';

export interface AccountInfo {
  /** Owner program id, base58. */
  owner: string;
  /** Raw account data. */
  data: Buffer;
  lamports: number;
}

export interface RpcResult<T> {
  ok: boolean;
  message: string;
  data?: T;
}

let nextId = 1;

// ── Transport resilience ──────────────────────────────────────────────
//
// 2026-09-02: a live buy died on `account read: RPC HTTP 500` from the Helius
// endpoint (Cloudflare-fronted; the same front had answered the priority
// socket with a 520 eighteen seconds earlier — a VPN exit being throttled is
// the usual cause). One transport hiccup on one endpoint should not kill an
// order when a second endpoint is configured and healthy. So every call:
//   1. retries ONCE after a short pause on a 5xx / connection error (never on
//      a JSON-RPC error — those are answers, not outages; never on a timeout —
//      the caller's budget is spent);
//   2. then, if a fallback endpoint is registered and differs, tries it once.
// Each fallback use is reported (rate-limited) so the user learns their
// primary is unhealthy instead of wondering why a trade took longer.

let fallbackHttpUrl: (() => string) | null = null;
let fallbackLog: ((line: string) => void) | null = null;
let onRejected: ((line: string) => void) | null = null;
let lastFallbackNoteAt = 0;
const RETRY_PAUSE_MS = 200;

/** The engine registers the public endpoint as the fallback for the keyed one. */
export function setRpcFallback(
  getUrl: () => string,
  log: (line: string) => void,
  /** Told once when an endpoint refuses our credentials — a log line alone
   *  is not enough for something the user has to go and fix. */
  rejectedNotice?: (line: string) => void,
): void {
  fallbackHttpUrl = getUrl;
  fallbackLog = log;
  onRejected = rejectedNotice ?? null;
}

// 429 counts too (2026-09-03: a buy died at "Simulation call failed: RPC HTTP
// 429" on the keyed endpoint — the token page's own reads plus the trade's
// burst crossed the free tier's rate for a second). A rate limit is exactly
// the case where a short pause and then the other endpoint answers.
const isTransportFailure = (r: { ok: boolean; message: string }): boolean =>
  !r.ok && (classifyRpcFailure(r.message) === 'transient' || classifyRpcFailure(r.message) === 'rate-limited');
const isRateLimited = (r: { ok: boolean; message: string }): boolean => !r.ok && classifyRpcFailure(r.message) === 'rate-limited';

// ── Rejected credentials ──────────────────────────────────────────────
//
// 2026-09-05: a user hit "RPC HTTP 401" over and over. 401 is not a
// transport failure, so it was neither retried nor failed over — every read
// simply died with that string, and the app looked broken rather than
// mis-keyed. A key the endpoint has rejected will be rejected again, so the
// endpoint is now remembered as bad and SKIPPED in favour of the public one
// until the key changes or the memory ages out. That keeps the app usable
// on a wrong key instead of dead.
//
// The host is remembered, never the URL: a keyed RPC URL carries the key in
// its query string and must not reach a log file.
const rejected = new Map<string, { at: number; code: '401' | '403' }>();
const REJECT_TTL_MS = 15 * 60_000;

/** Record a credentials rejection and tell the user once, in English. */
export function noteRpcRejection(url: string, status: number): void {
  if (status !== 401 && status !== 403) return;
  const host = safeHost(url);
  const code = String(status) as '401' | '403';
  const prev = rejected.get(host);
  rejected.set(host, { at: Date.now(), code });
  // One sentence per host per TTL, not one per failed call.
  if (!prev || Date.now() - prev.at > REJECT_TTL_MS) {
    const line = credentialsMessage(host, code);
    if (onRejected) onRejected(line);
    else fallbackLog?.(line);
  }
}

/**
 * A websocket handshake reports a rejected key as text, not a status code
 * ("Unexpected server response: 401"), and a bad key there means an endless
 * reconnect loop rather than one failed read. Same registry, same message.
 */
export function noteSocketRejection(url: string, errText: string): boolean {
  // Only a keyed socket can have its credentials refused, and the code is
  // matched with digit boundaries so a "401" inside some other number can
  // never condemn a working public endpoint.
  if (!/api-key=|[?&]token=/i.test(url)) return false;
  const m = /(?:^|[^0-9])(401|403)(?:[^0-9]|$)/.exec(errText ?? '');
  if (!m) return false;
  noteRpcRejection(url, Number(m[1]));
  return true;
}

/** True while this endpoint is known to refuse our credentials. */
export function isEndpointRejected(url: string): boolean {
  return isRejectedNow(url);
}

function isRejectedNow(url: string): boolean {
  const hit = rejected.get(safeHost(url));
  return !!hit && Date.now() - hit.at < REJECT_TTL_MS;
}

/** For the UI: the endpoint currently refusing our key, if any. */
export function rpcCredentialsRejected(): { host: string; code: '401' | '403'; message: string } | null {
  for (const [host, hit] of rejected) {
    if (Date.now() - hit.at < REJECT_TTL_MS) return { host, code: hit.code, message: credentialsMessage(host, hit.code) };
  }
  return null;
}

/** Editing the RPC settings is a new key: forget every rejection. */
export function clearRpcRejections(): void {
  rejected.clear();
}

/** Helius bills HTTP RPC as well as the websocket. A meter that counted only
 *  the socket showed a fraction of real spend, so the ceiling never bit and
 *  the number on the Settings page was not the user's usage. */
function billIfHelius(httpUrl: string): void {
  if (!/helius/i.test(httpUrl)) return;
  try {
    heliusBudget.billHttp(1);
  } catch {
    /* metering must never break a trade */
  }
}

async function callOnce<T>(httpUrl: string, method: string, params: unknown[]): Promise<RpcResult<T>> {
  billIfHelius(httpUrl);
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: `RPC HTTP ${res.status}` };
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) return { ok: false, message: body.error.message ?? 'RPC error' };
    return { ok: true, message: 'ok', data: body.result };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? 'RPC request failed' };
  }
}

async function call<T>(httpUrl: string, method: string, params: unknown[]): Promise<RpcResult<T>> {
  const otherEndpoint = (): string => {
    const alt = fallbackHttpUrl?.();
    return alt && alt !== httpUrl ? alt : '';
  };

  // A key we already know is refused: go straight to the public endpoint
  // rather than spending a round trip on a certain 401 first.
  if (isRejectedNow(httpUrl)) {
    const alt = otherEndpoint();
    if (alt) return callOnce<T>(alt, method, params);
  }

  let r = await callOnce<T>(httpUrl, method, params);

  // Bad credentials: retrying cannot help, so fail over immediately, and if
  // there is nowhere to fail over to, at least say what is wrong.
  if (classifyRpcFailure(r.message) === 'unauthorized' && !r.ok) {
    const code = r.message.endsWith('403') ? 403 : 401;
    noteRpcRejection(httpUrl, code);
    const spoken = credentialsMessage(safeHost(httpUrl), String(code) as '401' | '403');
    const alt = otherEndpoint();
    if (!alt) return { ok: false, message: spoken };
    const viaAlt = await callOnce<T>(alt, method, params);
    return viaAlt.ok ? viaAlt : { ok: false, message: `${spoken} The public endpoint also failed (${viaAlt.message}).` };
  }

  if (!isTransportFailure(r)) return r;
  // A rate limit needs a beat longer than a blip before the same host will
  // take the call again.
  await new Promise((res) => setTimeout(res, isRateLimited(r) ? RETRY_PAUSE_MS * 2 : RETRY_PAUSE_MS));
  r = await callOnce<T>(httpUrl, method, params);
  if (!isTransportFailure(r)) return r;
  const alt = fallbackHttpUrl?.();
  if (!alt || alt === httpUrl) return r;
  const viaAlt = await callOnce<T>(alt, method, params);
  if (Date.now() - lastFallbackNoteAt > 60_000) {
    lastFallbackNoteAt = Date.now();
    const host = (() => {
      try {
        return new URL(httpUrl).host;
      } catch {
        return 'primary RPC';
      }
    })();
    fallbackLog?.(`RPC ${host} failed twice (${r.message}) — ${method} answered by the fallback endpoint${viaAlt.ok ? '' : `, which also failed (${viaAlt.message})`}`);
  }
  return viaAlt.ok ? viaAlt : r;
}

export async function getAccountInfo(httpUrl: string, pubkey: string): Promise<RpcResult<AccountInfo | null>> {
  const r = await call<{ value: { owner: string; data: [string, string]; lamports: number } | null }>(
    httpUrl,
    'getAccountInfo',
    [pubkey, { encoding: 'base64', commitment: 'confirmed' }],
  );
  if (!r.ok) return { ok: false, message: r.message };
  if (!r.data?.value) return { ok: true, message: 'not found', data: null };
  const v = r.data.value;
  return {
    ok: true,
    message: 'ok',
    data: { owner: v.owner, data: Buffer.from(v.data[0], 'base64'), lamports: v.lamports },
  };
}

/**
 * Several accounts in ONE round trip, owner included. The local builder
 * needs the mint (for its token program), the bonding curve and, when its
 * cache is cold, pump's Global — three sequential reads before this existed,
 * each a full RPC round trip on the order's critical path.
 */
export async function getMultipleAccountInfo(
  httpUrl: string,
  addresses: string[],
): Promise<RpcResult<Array<AccountInfo | null>>> {
  if (addresses.length === 0) return { ok: true, message: 'ok', data: [] };
  const r = await call<{ value: Array<{ owner: string; data: [string, string]; lamports: number } | null> }>(
    httpUrl,
    'getMultipleAccounts',
    [addresses, { encoding: 'base64', commitment: 'confirmed' }],
  );
  if (!r.ok) return { ok: false, message: r.message };
  const values = r.data?.value ?? [];
  return {
    ok: true,
    message: 'ok',
    data: addresses.map((_, i) => {
      const v = values[i];
      return v ? { owner: v.owner, data: Buffer.from(v.data[0], 'base64'), lamports: v.lamports } : null;
    }),
  };
}

export async function getSlot(httpUrl: string): Promise<RpcResult<number>> {
  return call<number>(httpUrl, 'getSlot', [{ commitment: 'processed' }]);
}

/** Balance in lamports for a base58 address. */
export async function getBalance(httpUrl: string, pubkey: string): Promise<RpcResult<number>> {
  const r = await call<{ value: number }>(httpUrl, 'getBalance', [pubkey, { commitment: 'confirmed' }]);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: r.data?.value ?? 0 };
}

export interface SignatureStatus {
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
  err: unknown;
}

/** Recent-status lookup (no history search) — used for fork-awareness:
 *  a signature that stays null never made the canonical chain. */
export async function getSignatureStatuses(
  httpUrl: string,
  signatures: string[],
): Promise<RpcResult<Array<SignatureStatus | null>>> {
  const r = await call<{ value: Array<SignatureStatus | null> }>(httpUrl, 'getSignatureStatuses', [
    signatures,
    { searchTransactionHistory: false },
  ]);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: r.data?.value ?? [] };
}

export async function getHealth(httpUrl: string): Promise<RpcResult<string>> {
  return call<string>(httpUrl, 'getHealth', []);
}

export interface SimulationResult {
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
  /** Post-simulation lamports of each requested address (same order). */
  postLamports: Array<number | null>;
  /** Post-simulation base64 account data of each requested address. */
  postData: Array<string | null>;
}

/** Simulate a fully-signed, base64 transaction against current state, and
 *  return the post-simulation lamports of `watchAddrs` so the caller can
 *  bound the wallet's loss BEFORE broadcasting. */
export async function simulateTransaction(
  httpUrl: string,
  base64Tx: string,
  watchAddrs: string[],
): Promise<RpcResult<SimulationResult>> {
  const r = await call<{
    value: {
      err: unknown;
      logs: string[] | null;
      unitsConsumed?: number;
      accounts?: Array<{ lamports: number; data: [string, string] } | null>;
    };
  }>(httpUrl, 'simulateTransaction', [
    base64Tx,
    {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
      encoding: 'base64',
      accounts: { addresses: watchAddrs, encoding: 'base64' },
    },
  ]);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  const v = r.data.value;
  return {
    ok: true,
    message: 'ok',
    data: {
      err: v.err,
      logs: v.logs ?? [],
      unitsConsumed: v.unitsConsumed ?? null,
      postLamports: (v.accounts ?? []).map((a) => (a ? a.lamports : null)),
      postData: (v.accounts ?? []).map((a) => (a ? a.data[0] : null)),
    },
  };
}

/** Broadcast a base64 signed transaction. Preflight already done via
 *  simulate, so we skip it and run our own confirmation loop. */
export async function sendRawTransaction(httpUrl: string, base64Tx: string): Promise<RpcResult<string>> {
  return call<string>(httpUrl, 'sendTransaction', [
    base64Tx,
    { skipPreflight: true, maxRetries: 0, encoding: 'base64', preflightCommitment: 'processed' },
  ]);
}

// ── Local tx-builder support (template learning + assembly) ───────────

export interface ConfirmedSignatureInfo {
  signature: string;
  err: unknown;
  slot: number;
  /** Unix SECONDS, or null for a block the node has pruned the time for.
   *  Used to age a wallet (holder-graph "fresh" tagging). */
  blockTime?: number | null;
}

export async function getSignaturesForAddress(
  httpUrl: string,
  address: string,
  limit: number,
): Promise<RpcResult<ConfirmedSignatureInfo[]>> {
  return call<ConfirmedSignatureInfo[]>(httpUrl, 'getSignaturesForAddress', [
    address,
    { limit, commitment: 'confirmed' },
  ]);
}

export interface RawIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

export interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

export interface RawTransaction {
  meta: {
    err: unknown;
    logMessages?: string[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: Array<{ index: number; instructions: RawIx[] }>;
    /** Lamport balances by account index, before and after. The DIFFERENCE
     *  for our own wallet is the only honest way to know what a trade
     *  actually cost — it includes fees, rent, tips and slippage, none of
     *  which appear in the amount we requested. */
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
  } | null;
  transaction: {
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      instructions: RawIx[];
    };
  };
}

/**
 * The COMPLETE account list for a transaction, in the order instruction
 * indexes refer to: static keys, then ALT-loaded writable, then ALT-loaded
 * readonly.
 *
 * This is not optional bookkeeping. `instruction.programIdIndex` and the
 * `preBalances`/`postBalances` arrays index into this combined list, not into
 * `message.accountKeys`. Verified on mainnet 2026-08-24: a Meteora DBC
 * transaction had 12 static keys and 5 ALT-loaded ones, with its own program
 * referenced at index 15 — reading only the static array silently yields
 * `undefined` and the instruction gets skipped. Any decoder that ignores this
 * appears to work (no error, no crash) while quietly missing every
 * transaction that uses a lookup table.
 */
export function resolveAccountKeys(tx: RawTransaction): string[] {
  const stat = tx.transaction?.message?.accountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return stat;
  return [...stat, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

/**
 * Static account keys + first signature straight off the wire bytes of a
 * transaction (what `encoding: 'base64'` hands back on blockSubscribe /
 * getBlock). Only the prefix is parsed — signatures, the version byte,
 * the header and the static key table — which is all a decoder needs to
 * turn `programIdIndex` into a program id once `loadedAddresses` is appended
 * (see resolveAccountKeys). Returns null on any malformed input; a bad tx in
 * a block must skip, never throw on the feed thread.
 */
export function parseWireTransaction(txBase64: string): { signature: string; accountKeys: string[] } | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(txBase64, 'base64');
  } catch {
    return null;
  }
  let off = 0;
  const compactU16 = (): number => {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 3; i++) {
      if (off >= buf.length) throw new Error('eof');
      const b = buf[off++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
    }
    throw new Error('bad compact-u16');
  };
  try {
    const nSig = compactU16();
    if (nSig < 1 || off + nSig * 64 > buf.length) return null;
    const signature = base58Encode(buf.subarray(off, off + 64));
    off += nSig * 64;
    if (off >= buf.length) return null;
    if ((buf[off] & 0x80) !== 0) off += 1; // versioned message prefix (v0 = 0x80)
    off += 3; // header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
    const nKeys = compactU16();
    if (off + nKeys * 32 > buf.length) return null;
    const accountKeys: string[] = [];
    for (let i = 0; i < nKeys; i++) {
      accountKeys.push(base58Encode(buf.subarray(off, off + 32)));
      off += 32;
    }
    return { signature, accountKeys };
  } catch {
    return null;
  }
}

export async function getTransaction(httpUrl: string, signature: string): Promise<RpcResult<RawTransaction | null>> {
  return call<RawTransaction | null>(httpUrl, 'getTransaction', [
    signature,
    { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]);
}

/**
 * Several transactions in ONE JSON-RPC batch request. Helius counts each
 * element against the 10 rps cap, so callers keep batches small (≤10) and
 * spaced (≥100 ms) — this only saves round trips, not credits. Results are
 * returned in request order; an element that errored is null.
 */
export async function getTransactions(httpUrl: string, signatures: string[]): Promise<RpcResult<Array<RawTransaction | null>>> {
  if (signatures.length === 0) return { ok: true, message: 'ok', data: [] };
  const firstId = nextId;
  nextId += signatures.length;
  const body = signatures.map((sig, i) => ({
    jsonrpc: '2.0',
    id: firstId + i,
    method: 'getTransaction',
    params: [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
  }));
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: `RPC HTTP ${res.status}` };
    const replies = (await res.json()) as Array<{ id?: number; result?: RawTransaction | null; error?: unknown }>;
    if (!Array.isArray(replies)) return { ok: false, message: 'batch reply is not an array' };
    const out: Array<RawTransaction | null> = signatures.map(() => null);
    for (const r of replies) {
      const idx = typeof r?.id === 'number' ? r.id - firstId : -1;
      if (idx < 0 || idx >= out.length || r.error) continue;
      out[idx] = r.result ?? null;
    }
    return { ok: true, message: 'ok', data: out };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? 'RPC request failed' };
  }
}

export interface BlockhashInfo {
  blockhash: string;
  /** Last block height at which a tx using this blockhash can still land.
   *  Past it the tx is DEFINITIVELY dead — the only honest "expired". */
  lastValidBlockHeight: number;
}

export async function getLatestBlockhashInfo(httpUrl: string): Promise<RpcResult<BlockhashInfo>> {
  const r = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>(httpUrl, 'getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: { blockhash: r.data.value.blockhash, lastValidBlockHeight: Number(r.data.value.lastValidBlockHeight) } };
}

export async function getLatestBlockhash(httpUrl: string): Promise<RpcResult<string>> {
  const r = await getLatestBlockhashInfo(httpUrl);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: r.data.blockhash };
}

/** Current block height (confirmed) — compared against lastValidBlockHeight
 *  to decide whether an unconfirmed tx can still land. */
export async function getBlockHeight(httpUrl: string): Promise<RpcResult<number>> {
  const r = await call<number>(httpUrl, 'getBlockHeight', [{ commitment: 'confirmed' }]);
  if (!r.ok || typeof r.data !== 'number') return { ok: false, message: r.message };
  return { ok: true, message: 'ok', data: r.data };
}

export interface TokenAccountHolding {
  mint: string;
  tokenAccount: string;
  amountRaw: string;
  uiAmount: number;
  decimals: number;
  /** Token program that owns the account (classic SPL or Token-2022). */
  programId: string;
}

/** Every SPL token account the owner holds, across both token programs.
 *  This is the chain's ground truth — positions left behind by a crashed
 *  or previous run show up here even when no session remembers them. */
export async function getTokenAccountsByOwner(
  httpUrl: string,
  owner: string,
): Promise<RpcResult<TokenAccountHolding[]>> {
  const TOKEN_PROGRAMS = [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ];
  interface ParsedTokenAccount {
    pubkey: string;
    account: {
      data: {
        parsed: {
          info: {
            mint: string;
            tokenAmount: { amount: string; uiAmount: number | null; decimals: number };
          };
        };
      };
    };
  }
  const out: TokenAccountHolding[] = [];
  for (const programId of TOKEN_PROGRAMS) {
    const r = await call<{ value: ParsedTokenAccount[] }>(httpUrl, 'getTokenAccountsByOwner', [
      owner,
      { programId },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    if (!r.ok) return { ok: false, message: r.message };
    for (const acc of r.data?.value ?? []) {
      const info = acc.account?.data?.parsed?.info;
      if (!info?.mint || !info.tokenAmount) continue;
      out.push({
        mint: info.mint,
        tokenAccount: acc.pubkey,
        amountRaw: info.tokenAmount.amount,
        uiAmount: info.tokenAmount.uiAmount ?? 0,
        decimals: info.tokenAmount.decimals,
        programId,
      });
    }
  }
  return { ok: true, message: 'ok', data: out };
}

/** Raw token amount held in a token account (0n if the account is missing). */
/** UI-unit balance of `owner` in `mint`, across both token programs, in ONE
 *  call (the RPC accepts a mint filter). Null = could not read (honest-null),
 *  0 only when the chain really says zero. */
export async function getTokenBalanceForMint(
  httpUrl: string,
  owner: string,
  mint: string,
): Promise<RpcResult<number>> {
  interface Row {
    account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null; uiAmountString?: string } } } } };
  }
  const r = await call<{ value: Row[] }>(httpUrl, 'getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  let total = 0;
  for (const row of r.data.value) {
    const ta = row.account?.data?.parsed?.info?.tokenAmount;
    const v = ta?.uiAmount ?? (ta?.uiAmountString ? Number(ta.uiAmountString) : null);
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  return { ok: true, message: 'ok', data: total };
}

/** RAW base units held for a mint across the owner's token accounts, plus
 *  decimals — what a Jupiter sell must be sized in. */
export async function getTokenBalanceRawForMint(
  httpUrl: string,
  owner: string,
  mint: string,
): Promise<RpcResult<{ raw: bigint; decimals: number | null }>> {
  interface Row {
    account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals?: number } } } } };
  }
  const r = await call<{ value: Row[] }>(httpUrl, 'getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  if (!r.ok || !r.data) return { ok: false, message: r.message };
  let raw = 0n;
  let decimals: number | null = null;
  for (const row of r.data.value) {
    const ta = row.account?.data?.parsed?.info?.tokenAmount;
    if (!ta?.amount) continue;
    try {
      raw += BigInt(ta.amount);
    } catch {
      /* unparseable amount — skip rather than corrupt the total */
    }
    if (decimals === null && typeof ta.decimals === 'number') decimals = ta.decimals;
  }
  return { ok: true, message: 'ok', data: { raw, decimals } };
}

export async function getTokenBalanceRaw(httpUrl: string, tokenAccount: string): Promise<RpcResult<bigint>> {
  const r = await call<{ value: { amount: string } | null }>(httpUrl, 'getTokenAccountBalance', [
    tokenAccount,
    { commitment: 'processed' },
  ]);
  if (!r.ok) {
    // A missing account is "0 balance", not an error worth failing a sell for.
    if (/could not find|invalid param/i.test(r.message)) return { ok: true, message: 'no account', data: 0n };
    return { ok: false, message: r.message };
  }
  try {
    return { ok: true, message: 'ok', data: BigInt(r.data?.value?.amount ?? '0') };
  } catch {
    return { ok: false, message: 'unparseable token amount' };
  }
}

// ── Terminal additions (Krypto Bot, 2026-08-24) ───────────────────
//
// The terminal must answer "who holds this token" and "what is the supply"
// for mints this install never watched launch. Both are plain RPC reads, so
// they belong here rather than in a provider — they are authoritative and
// need no third party.

export interface TokenSupply {
  /** Raw base units as a decimal string (u64-safe). */
  amountRaw: string;
  uiAmount: number;
  decimals: number;
}

export async function getTokenSupply(httpUrl: string, mint: string): Promise<RpcResult<TokenSupply | null>> {
  const r = await call<{ value: { amount: string; uiAmount: number | null; decimals: number } | null }>(
    httpUrl,
    'getTokenSupply',
    [mint, { commitment: 'confirmed' }],
  );
  if (!r.ok) return { ok: false, message: r.message };
  const v = r.data?.value;
  if (!v) return { ok: true, message: 'not found', data: null };
  return {
    ok: true,
    message: 'ok',
    data: { amountRaw: v.amount, uiAmount: v.uiAmount ?? 0, decimals: v.decimals },
  };
}

export interface LargestAccount {
  /** TOKEN ACCOUNT address — not the owner wallet. */
  address: string;
  amountRaw: string;
  uiAmount: number;
  decimals: number;
}

/** The 20 largest token accounts. This is a hard RPC cap, not our choice —
 *  a full holder list needs an indexer (Birdeye / Helius DAS). 20 rows is
 *  still enough to compute top-10 concentration honestly. */
export async function getTokenLargestAccounts(
  httpUrl: string,
  mint: string,
): Promise<RpcResult<LargestAccount[]>> {
  const r = await call<{ value: Array<{ address: string; amount: string; uiAmount: number | null; decimals: number }> }>(
    httpUrl,
    'getTokenLargestAccounts',
    [mint, { commitment: 'confirmed' }],
  );
  if (!r.ok) return { ok: false, message: r.message };
  const rows = (r.data?.value ?? []).map((v) => ({
    address: v.address,
    amountRaw: v.amount,
    uiAmount: v.uiAmount ?? 0,
    decimals: v.decimals,
  }));
  return { ok: true, message: 'ok', data: rows };
}

/** Owner wallets for a batch of token accounts, via getMultipleAccounts. */
export async function getTokenAccountOwners(
  httpUrl: string,
  tokenAccounts: string[],
): Promise<RpcResult<Map<string, string>>> {
  const out = new Map<string, string>();
  interface Parsed {
    data?: { parsed?: { info?: { owner?: string } } };
  }
  for (let i = 0; i < tokenAccounts.length; i += 100) {
    const batch = tokenAccounts.slice(i, i + 100);
    const r = await call<{ value: Array<Parsed | null> }>(httpUrl, 'getMultipleAccounts', [
      batch,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    if (!r.ok) return { ok: false, message: r.message };
    const values = r.data?.value ?? [];
    for (let k = 0; k < batch.length; k++) {
      const owner = values[k]?.data?.parsed?.info?.owner;
      if (typeof owner === 'string') out.set(batch[k], owner);
    }
  }
  return { ok: true, message: 'ok', data: out };
}

/** Raw account data for many addresses at once, base64. Batches of 100 —
 *  the RPC's hard limit for getMultipleAccounts. */
export async function getMultipleAccountsRaw(
  httpUrl: string,
  addresses: string[],
): Promise<RpcResult<Map<string, Buffer>>> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    const r = await call<{ value: Array<{ data: [string, string]; owner: string } | null> }>(
      httpUrl,
      'getMultipleAccounts',
      [batch, { encoding: 'base64', commitment: 'confirmed' }],
    );
    if (!r.ok) return { ok: false, message: r.message };
    const values = r.data?.value ?? [];
    for (let k = 0; k < batch.length; k++) {
      const v = values[k];
      if (!v?.data?.[0]) continue;
      out.set(batch[k], Buffer.from(v.data[0], 'base64'));
    }
  }
  return { ok: true, message: 'ok', data: out };
}
