// Order policy validator — Phase-2 Milestone C/D foundation, live NOW in
// shadow mode. Every entry intent passes through this gate before a paper
// fill; the same gate will sit in front of the signer later, so by the
// time real money flows the policy path is battle-tested.
//
// Policy is an allowlist, not a blocklist: anything not explicitly
// permitted is rejected.

import { PUMP_PROGRAM_ID } from './pumpDecoder';

export interface PolicyContext {
  programId: string;
  /** Quote mint — v1 is SOL-only ('SOL' sentinel). */
  quoteMint: 'SOL';
  quoteLamports: bigint;
  /** ms since the newest event for this token was received. */
  dataAgeMs: number;
  openPositions: number;
  maxOpenPositions: number;
  maxQuoteLamports: bigint;
}

export interface PolicyVerdict {
  ok: boolean;
  note: string;
}

const ALLOWED_PROGRAMS = new Set<string>([PUMP_PROGRAM_ID]);
const MAX_DATA_AGE_MS = 3_000;

export function validate(ctx: PolicyContext): PolicyVerdict {
  if (!ALLOWED_PROGRAMS.has(ctx.programId))
    return { ok: false, note: `program ${ctx.programId.slice(0, 8)}… not on allowlist` };
  if (ctx.quoteMint !== 'SOL') return { ok: false, note: 'only SOL-quoted entries are allowed' };
  if (ctx.quoteLamports <= 0n) return { ok: false, note: 'non-positive quote amount' };
  if (ctx.quoteLamports > ctx.maxQuoteLamports)
    return { ok: false, note: 'quote amount exceeds configured maximum' };
  if (ctx.dataAgeMs > MAX_DATA_AGE_MS)
    return { ok: false, note: `state is ${ctx.dataAgeMs}ms old (limit ${MAX_DATA_AGE_MS}ms)` };
  if (ctx.openPositions >= ctx.maxOpenPositions)
    return { ok: false, note: 'position limit reached' };
  return { ok: true, note: 'allowed' };
}
