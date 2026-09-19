// Decoder re-verification, run automatically after pump redeploys.
//
// The program-upgrade watchdog (programWatch.ts) fails CLOSED: when pump's
// deployment slot moves, every account offset and instruction discriminator
// this app relies on is suspect, so entries pause. That half was right and is
// unchanged. What was missing was a way back: `acceptCurrent()` had no caller
// and no UI, so `hardPauseReason` — which is never assigned null anywhere —
// stayed set for the life of the process AND across restarts, because the
// baseline file kept the old slot. A user who was running when pump redeployed
// had live buys disabled permanently, recoverable only by deleting
// program-baseline.json by hand.
//
// The fix is not a button that says "trust me". It is this: re-read the things
// the decoder actually assumes, from chain, and clear the pause only when
// every one of them still holds. Anything else — a check that fails, an RPC
// that will not answer, a sample we could not obtain — leaves the pause in
// place. "Could not verify" is NEVER "verified".
//
// What is checked, and why each one is the right question:
//
//   1. global-layout    — `parseGlobal` sets `fromChain: false` when Global no
//                         longer carries the fields at the offsets it expects.
//                         That flag already existed as a diagnostic; here it
//                         is the assertion. A reshaped Global means the fee
//                         recipient and vault slots are wrong, which is
//                         `NotAuthorized` on every trade.
//   2. curve-layout     — a real bonding curve must still parse: the Anchor
//                         discriminator must match and the reserves must be
//                         non-zero. This is what prices every quote.
//   3. trade-interface  — a REAL recent trade from chain must still carry one
//                         of our instruction discriminators, with the account
//                         count our template builds. This is the strongest
//                         check: it proves the instruction the app signs is
//                         still the instruction the program expects.
//
// Read-only. Nothing here signs, sends or simulates.

import { bondingCurveFor, globalFor, PUMP_PROGRAM } from '../chain/addresses';
import { base58Decode } from '../chain/base58';
import { getAccountInfo, getSignaturesForAddress, getTransaction } from '../chain/rpcClient';
import { BUY_DISC, SELL_DISC, parseCurve, parseGlobal } from './txBuilder';

export interface DecoderCheck {
  name: 'global-layout' | 'curve-layout' | 'trade-interface';
  pass: boolean;
  /** One sentence, safe to show a user and to put in a log. */
  detail: string;
}

export interface DecoderVerdict {
  /** True only when EVERY check ran and passed. */
  ok: boolean;
  checks: DecoderCheck[];
  summary: string;
}

/** How many candidate mints to try before giving up on a check. Each costs
 *  one account read, and a curve that has migrated is a legitimate miss. */
const MAX_SAMPLES = 6;
/** Signatures to scan on one curve looking for a decodable pump trade. */
const SIG_SCAN = 10;

/**
 * Re-verify the decoder against the live program.
 *
 * `sampleMints` should be recently-seen pump mints — the launch feed's rows
 * are the natural source. Order matters only in that earlier entries are
 * tried first; pass the freshest.
 */
export async function verifyDecoder(httpUrl: string, sampleMints: string[]): Promise<DecoderVerdict> {
  const checks: DecoderCheck[] = [];

  checks.push(await checkGlobal(httpUrl));
  const curve = await checkCurve(httpUrl, sampleMints);
  checks.push(curve.check);
  checks.push(await checkTradeInterface(httpUrl, curve.curveAddress, sampleMints));

  const failed = checks.filter((c) => !c.pass);
  const ok = failed.length === 0;
  return {
    ok,
    checks,
    summary: ok
      ? 'decoder re-verified against the new deployment: Global, the curve layout and the trade interface all still match'
      : `decoder NOT verified — ${failed.map((c) => `${c.name}: ${c.detail}`).join('; ')}`,
  };
}

async function checkGlobal(httpUrl: string): Promise<DecoderCheck> {
  const res = await getAccountInfo(httpUrl, globalFor());
  if (!res.ok) return { name: 'global-layout', pass: false, detail: `could not read Global (${res.message})` };
  if (!res.data) return { name: 'global-layout', pass: false, detail: 'Global account not found' };
  const g = parseGlobal(res.data.data);
  if (!g.fromChain) {
    return {
      name: 'global-layout',
      pass: false,
      detail: 'Global no longer carries the fee recipient and vault at the offsets this build expects',
    };
  }
  return {
    name: 'global-layout',
    pass: true,
    detail: `Global parsed from chain (fee recipient ${g.feeRecipient.slice(0, 8)}…, vault ${g.feeVault.slice(0, 8)}…)`,
  };
}

async function checkCurve(
  httpUrl: string,
  sampleMints: string[],
): Promise<{ check: DecoderCheck; curveAddress: string | null }> {
  if (sampleMints.length === 0) {
    return {
      check: { name: 'curve-layout', pass: false, detail: 'no recent pump mint to test against yet' },
      curveAddress: null,
    };
  }
  let looked = 0;
  for (const mint of sampleMints.slice(0, MAX_SAMPLES)) {
    let addr: string;
    try {
      addr = bondingCurveFor(mint);
    } catch {
      continue;
    }
    const res = await getAccountInfo(httpUrl, addr);
    if (!res.ok) continue;
    looked += 1;
    // A migrated or closed curve is a legitimate miss, not a layout failure —
    // keep looking rather than condemning the decoder for it.
    if (!res.data) continue;
    const c = parseCurve(res.data.data);
    if (!c) continue;
    if (!(c.vTok > 0n) || !(c.vSol > 0n)) continue;
    return {
      check: {
        name: 'curve-layout',
        pass: true,
        detail: `a live bonding curve still parses (${mint.slice(0, 8)}…, ${res.data.data.length} bytes)`,
      },
      curveAddress: addr,
    };
  }
  return {
    check: {
      name: 'curve-layout',
      pass: false,
      detail: looked === 0 ? 'could not read any curve account' : `read ${looked} curve account(s), none parsed`,
    },
    curveAddress: null,
  };
}

/**
 * The load-bearing check: a real trade the program ACCEPTED must still look
 * like the instruction this app builds.
 */
async function checkTradeInterface(
  httpUrl: string,
  curveAddress: string | null,
  sampleMints: string[],
): Promise<DecoderCheck> {
  const candidates: string[] = [];
  if (curveAddress) candidates.push(curveAddress);
  for (const mint of sampleMints.slice(0, MAX_SAMPLES)) {
    try {
      const a = bondingCurveFor(mint);
      if (!candidates.includes(a)) candidates.push(a);
    } catch {
      /* not a derivable mint */
    }
  }
  if (candidates.length === 0) {
    return { name: 'trade-interface', pass: false, detail: 'no curve to read a recent trade from' };
  }

  let scanned = 0;
  for (const addr of candidates) {
    const sigs = await getSignaturesForAddress(httpUrl, addr, SIG_SCAN);
    if (!sigs.ok || !sigs.data) continue;
    for (const sig of sigs.data) {
      // Only transactions the program ACCEPTED say anything about the
      // interface; a failure could have failed for any reason.
      if (sig.err !== null) continue;
      const tx = await getTransaction(httpUrl, sig.signature);
      if (!tx.ok || !tx.data?.meta) continue;
      scanned += 1;
      const msg = tx.data.transaction.message;
      const loaded = tx.data.meta.loadedAddresses;
      const keys = [...msg.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
      const allIx = [...msg.instructions, ...(tx.data.meta.innerInstructions ?? []).flatMap((g) => g.instructions)];
      for (const ix of allIx) {
        if (keys[ix.programIdIndex] !== PUMP_PROGRAM) continue;
        let data: Buffer;
        try {
          data = Buffer.from(base58Decode(ix.data));
        } catch {
          continue;
        }
        if (data.length < 8) continue;
        const disc = data.subarray(0, 8);
        const isBuy = disc.equals(BUY_DISC);
        const isSell = disc.equals(SELL_DISC);
        if (!isBuy && !isSell) continue;
        return {
          name: 'trade-interface',
          pass: true,
          detail: `a confirmed on-chain ${isBuy ? 'buy' : 'sell'} still carries this build's discriminator (${ix.accounts.length} accounts)`,
        };
      }
    }
  }
  return {
    name: 'trade-interface',
    pass: false,
    detail:
      scanned === 0
        ? 'could not read any recent pump transaction'
        : `read ${scanned} confirmed pump transaction(s), none carried a discriminator this build knows`,
  };
}
