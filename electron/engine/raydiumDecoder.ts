// Raydium AMM v4 + CPMM log decoder — the post-migration rail.
//
// ─── Two programs, two ways of talking ────────────────────────────────
//
// Raydium's plain constant-product pools live in two programs, and they
// report a swap differently:
//
//   AMM v4  `675kPX9M…`  writes a `ray_log: <base64>` LOG line — a bare
//                        struct with a type byte, no Anchor discriminator,
//                        and NO pool address in it.
//   CPMM    `CPMMoo8L…`  is Anchor: `emit!` → a `Program data:` LOG line
//                        carrying a SwapEvent whose first field IS the pool.
//
// Both are logs, so both can be taped from `logsSubscribe` without a
// transaction fetch — the property that made LaunchLab cheap and DBC dear.
// Measured 2026-09-19 (see docs/raydium-rail-2026-09-19.md): 0 of 1,087
// CPMM swaps in a two-minute window came as emit_cpi only.
//
// ─── Attribution by the invoke stack ──────────────────────────────────
//
// Anchor event discriminators are sha256("event:<Name>"), so two programs
// that both call their event `SwapEvent` share a discriminator. A CPMM swap
// routed through Jupiter shares its transaction with other programs' data
// lines, and a decoder that trusts the discriminator alone would parse a
// stranger's bytes with a straight face. So every log line is first
// attributed to the program executing it — `Program X invoke [n]` pushes,
// `Program X success|failed` pops — and only lines under a Raydium program
// are decoded. Lengths are checked exactly on top of that.
//
// ─── What a log cannot give you ───────────────────────────────────────
//
// A `ray_log` swap names amounts, direction and the pool's reserves, but
// not the pool. Taping an AMM v4 pool therefore subscribes to THAT pool
// (`mentions`), and the watcher checks the logged reserves against the
// pool's own before trusting a line — a transaction can swap through two
// v4 pools. Neither program's log names the trader, so ticks carry no
// wallet, like LaunchLab's.
//
// Every layout below was verified against mainnet on 2026-09-19 by matching
// decoded amounts to the transaction's token balance changes.

import { createHash } from 'node:crypto';
import { base58Encode } from '../chain/base58';

/** Raydium AMM v4 — the OpenBook-backed constant-product pool program. */
export const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
/** Raydium CPMM — constant-product pools with no order book. */
export const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

/**
 * Where a pool creation pays its fee — the cheap way to see every creation.
 *
 * Both programs charge a creation fee into ONE fixed wrapped-SOL account,
 * so a `logsSubscribe` that mentions that account delivers pool creations
 * and nothing else, instead of a program-wide firehose filtered for the
 * rare creation. Verified 2026-09-19: the 25 newest transactions touching
 * the v4 account were all `initialize2` (InitLog in every one), and a
 * LaunchLab graduation paid 0.15 SOL into the CPMM one.
 */
export const RAYDIUM_AMM_V4_CREATE_FEE_ACCOUNT = '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5';
export const RAYDIUM_CPMM_CREATE_FEE_ACCOUNT = 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

function eventDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

const DISC_SWAP_EVENT = eventDiscriminator('SwapEvent');

const PROGRAM_DATA_PREFIX = 'Program data: ';
const RAY_LOG_PREFIX = 'Program log: ray_log: ';
const INSTRUCTION_PREFIX = 'Program log: Instruction: ';

// ── Attribution ───────────────────────────────────────────────────────

export interface AttributedLog {
  /** The program executing when this line was written; '' at top level. */
  program: string;
  line: string;
}

/**
 * Tag every log line with the program that wrote it.
 *
 * `Program X invoke [n]` pushes, `Program X success` / `failed` pops. A
 * `consumed` or `return` line is left where it is. Robust to a truncated
 * log (Solana caps log size): a pop on an empty stack is ignored.
 */
export function attributeLogs(logs: string[]): AttributedLog[] {
  const stack: string[] = [];
  const out: AttributedLog[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/^Program \S+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    out.push({ program: stack[stack.length - 1] ?? '', line });
  }
  return out;
}

// ── AMM v4 `ray_log` ──────────────────────────────────────────────────

/** InitLog — written once, by `initialize2`. 75 bytes. */
export interface RayInitLog {
  kind: 'ray_init';
  /** Pool open time, unix seconds. Equal to the pool's own poolOpenTime. */
  time: bigint;
  pcDecimals: number;
  coinDecimals: number;
  pcLotSize: bigint;
  coinLotSize: bigint;
  /** Initial deposits, raw units. */
  pcAmount: bigint;
  coinAmount: bigint;
  /** The OpenBook market the pool was created on. */
  market: string;
}

/**
 * A swap, either shape. 57 bytes each.
 *
 * `direction` is Raydium's own word: 1 = pc in / coin out, 2 = coin in /
 * pc out. Verified on seven swaps across two pools (one with SOL as coin,
 * one with SOL as pc) against the vaults' balance changes. Which of those
 * is a BUY depends on which side of the pool is SOL — see `ammV4Side`.
 *
 * `poolCoin` / `poolPc` are the reserves BEFORE the swap: on consecutive
 * swaps of one pool the next line's reserve equals this line's plus this
 * line's input, exactly.
 */
export interface RaySwapLog {
  kind: 'ray_swap';
  /** 3 = SwapBaseIn (exact in), 4 = SwapBaseOut (exact out). */
  logType: 3 | 4;
  direction: number;
  /** What went in and came out, raw units — the same two numbers whichever
   *  shape wrote them. */
  amountIn: bigint;
  amountOut: bigint;
  poolCoin: bigint;
  poolPc: bigint;
}

export type RayLog = RayInitLog | RaySwapLog;

const RAY_INIT_LEN = 75;
const RAY_SWAP_LEN = 57;

/** Decode one `ray_log` payload. Null for any other type or a wrong size. */
export function decodeRayLog(b64: string): RayLog | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (buf.length === 0) return null;
  try {
    const type = buf[0];
    if (type === 0 && buf.length === RAY_INIT_LEN) {
      return {
        kind: 'ray_init',
        time: buf.readBigUInt64LE(1),
        pcDecimals: buf[9],
        coinDecimals: buf[10],
        pcLotSize: buf.readBigUInt64LE(11),
        coinLotSize: buf.readBigUInt64LE(19),
        pcAmount: buf.readBigUInt64LE(27),
        coinAmount: buf.readBigUInt64LE(35),
        market: base58Encode(buf.subarray(43, 75)),
      };
    }
    if ((type === 3 || type === 4) && buf.length === RAY_SWAP_LEN) {
      const u = (o: number): bigint => buf.readBigUInt64LE(o);
      // SwapBaseIn:  amount_in, minimum_out, direction, user_source, pool_coin, pool_pc, out_amount
      // SwapBaseOut: max_in,    amount_out,  direction, user_source, pool_coin, pool_pc, deduct_in
      return {
        kind: 'ray_swap',
        logType: type,
        direction: Number(u(17)),
        amountIn: type === 3 ? u(1) : u(49),
        amountOut: type === 3 ? u(49) : u(9),
        poolCoin: u(33),
        poolPc: u(41),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Every AMM v4 `ray_log` in a transaction's logs, attributed to the program. */
export function rayLogsOf(logs: string[]): RayLog[] {
  const out: RayLog[] = [];
  for (const { program, line } of attributeLogs(logs)) {
    if (program !== RAYDIUM_AMM_V4_PROGRAM || !line.startsWith(RAY_LOG_PREFIX)) continue;
    const ev = decodeRayLog(line.slice(RAY_LOG_PREFIX.length));
    if (ev) out.push(ev);
  }
  return out;
}

/** The InitLog of a pool creation, if these logs are one. */
export function ammV4CreationInLogs(logs: string[]): RayInitLog | null {
  for (const ev of rayLogsOf(logs)) if (ev.kind === 'ray_init') return ev;
  return null;
}

// ── CPMM Anchor events ────────────────────────────────────────────────

/**
 * CPMM SwapEvent. Body 162 bytes after the discriminator:
 *   0    poolId              pubkey
 *   32   inputVaultBefore    u64
 *   40   outputVaultBefore   u64
 *   48   inputAmount         u64   the vault gained exactly this (4/4)
 *   56   outputAmount        u64   the vault lost exactly this (4/4)
 *   64   inputTransferFee    u64   Token-2022 transfer fee, if any
 *   72   outputTransferFee   u64
 *   80   baseInput           u8
 *   81   inputMint           pubkey   both mints were in the tx's keys (4/4)
 *   113  outputMint          pubkey
 *   145  tradeFee            u64
 *   153  creatorFee          u64
 *   161  creatorFeeOnInput   u8
 * An older 81-byte body (no mints, no fees) exists in the program's history
 * and is refused here: without the mints a swap cannot be sided.
 */
export interface CpmmSwapEvent {
  kind: 'cpmm_swap';
  pool: string;
  inputMint: string;
  outputMint: string;
  inputAmount: bigint;
  outputAmount: bigint;
  inputVaultBefore: bigint;
  outputVaultBefore: bigint;
  inputTransferFee: bigint;
  outputTransferFee: bigint;
  baseInput: boolean;
  tradeFee: bigint;
  creatorFee: bigint;
}

const CPMM_SWAP_BODY_LEN = 162;

export interface CpmmDecodeOutcome {
  event: CpmmSwapEvent | null;
  /** A SwapEvent under the CPMM program whose body is not the size this
   *  decoder knows — layout drift, to be counted, never parsed. */
  layoutError: boolean;
}

/** Decode one `Program data:` payload known to come from the CPMM program. */
export function decodeCpmmEventEx(b64: string): CpmmDecodeOutcome {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return { event: null, layoutError: false };
  }
  if (buf.length < 8 || !buf.subarray(0, 8).equals(DISC_SWAP_EVENT)) return { event: null, layoutError: false };
  const body = buf.subarray(8);
  if (body.length !== CPMM_SWAP_BODY_LEN) return { event: null, layoutError: true };
  try {
    const u = (o: number): bigint => body.readBigUInt64LE(o);
    return {
      event: {
        kind: 'cpmm_swap',
        pool: base58Encode(body.subarray(0, 32)),
        inputVaultBefore: u(32),
        outputVaultBefore: u(40),
        inputAmount: u(48),
        outputAmount: u(56),
        inputTransferFee: u(64),
        outputTransferFee: u(72),
        baseInput: body[80] !== 0,
        inputMint: base58Encode(body.subarray(81, 113)),
        outputMint: base58Encode(body.subarray(113, 145)),
        tradeFee: u(145),
        creatorFee: u(153),
      },
      layoutError: false,
    };
  } catch {
    return { event: null, layoutError: true };
  }
}

export interface DecodedCpmmLogs {
  events: CpmmSwapEvent[];
  layoutErrors: number;
}

/** Every CPMM swap in a transaction's logs — CPMM-attributed lines only. */
export function cpmmEventsOf(logs: string[]): DecodedCpmmLogs {
  const events: CpmmSwapEvent[] = [];
  let layoutErrors = 0;
  for (const { program, line } of attributeLogs(logs)) {
    if (program !== RAYDIUM_CPMM_PROGRAM || !line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const r = decodeCpmmEventEx(line.slice(PROGRAM_DATA_PREFIX.length));
    if (r.event) events.push(r.event);
    else if (r.layoutError) layoutErrors++;
  }
  return { events, layoutErrors };
}

/**
 * Did these logs create a CPMM pool?
 *
 * CPMM emits no event on creation (verified: a graduation's transaction
 * carried no `Program data:` line from it at all), and creation comes as
 * more than one instruction — `initialize` from a creator, and
 * `initialize_with_permission` when LaunchLab migrates a curve — so the
 * test is the instruction name Anchor logs, under the CPMM program.
 */
export function cpmmCreationInLogs(logs: string[]): boolean {
  for (const { program, line } of attributeLogs(logs)) {
    if (program === RAYDIUM_CPMM_PROGRAM && line.startsWith(`${INSTRUCTION_PREFIX}Initialize`)) return true;
  }
  return false;
}

// ── Siding a swap ─────────────────────────────────────────────────────

/** A swap reduced to what the tape needs, in raw units. */
export interface SidedSwap {
  /** True when SOL went in and the token came out. */
  isBuy: boolean;
  lamports: bigint;
  baseUnits: bigint;
}

/**
 * Side an AMM v4 swap given which side of the pool is SOL.
 *
 * direction 1 = pc in, coin out; 2 = coin in, pc out. So with SOL as pc a
 * buy is direction 1, and with SOL as coin a buy is direction 2 — the
 * memecoin pools sampled had it both ways round.
 */
export function sideAmmV4Swap(ev: RaySwapLog, solSide: 'A' | 'B' | null): SidedSwap | null {
  if (solSide === null) return null;
  // 'A' is coin, 'B' is pc (raydiumAccounts keeps the pool's own order).
  const coinIn = ev.direction === 2;
  const pcIn = ev.direction === 1;
  if (!coinIn && !pcIn) return null;
  const solIn = solSide === 'A' ? coinIn : pcIn;
  return {
    isBuy: solIn,
    lamports: solIn ? ev.amountIn : ev.amountOut,
    baseUnits: solIn ? ev.amountOut : ev.amountIn,
  };
}

/** Side a CPMM swap by its own mints. Null when neither side is SOL. */
export function sideCpmmSwap(ev: CpmmSwapEvent): SidedSwap | null {
  const solIn = ev.inputMint === WSOL_MINT;
  const solOut = ev.outputMint === WSOL_MINT;
  if (solIn === solOut) return null;
  return {
    isBuy: solIn,
    lamports: solIn ? ev.inputAmount : ev.outputAmount,
    baseUnits: solIn ? ev.outputAmount : ev.inputAmount,
  };
}

/**
 * Price a swap cleared at, in SOL per whole token — the amounts that
 * actually moved, never a reserve ratio. Null when either side is zero.
 */
export function executedPriceSol(s: SidedSwap, baseDecimals: number): number | null {
  if (s.lamports <= 0n || s.baseUnits <= 0n) return null;
  const price = Number(s.lamports) / 1e9 / (Number(s.baseUnits) / 10 ** baseDecimals);
  return Number.isFinite(price) && price > 0 ? price : null;
}
