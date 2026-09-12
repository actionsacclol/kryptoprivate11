// Signer outflow policy — the gate that decides whether our SOL may move.
//
// Kept separate from wallet.ts deliberately: this is pure decision logic over
// transaction bytes, with no key material, no OS keystore and no `electron`
// import, so it can be unit-tested directly (test/walletpolicy.test.mjs). The
// wallet module owns the secret; this module owns the rule.
//
// WHY IT EXISTS (2026-08-16 product swarm §8): the signer previously checked
// only that WE paid the fee and that exactly one signature was required. It
// never looked at where funds went, so anything that could hand it a
// transaction could empty the wallet. The known drain chain was
// `settings:update` (unvalidated) -> `wallet:setHome` (no confirmation) ->
// autoCashout -> sweep, against a signer that only checked the fee payer.
//
// THE KEY FACT the rule rests on: SOL moving through a pump/AMM trade moves by
// CPI, which never appears as a top-level instruction. So the only legitimate
// top-level SystemProgram.transfer in any transaction we sign pays either a
// tip account or the user's own withdrawal address. Everything else is refused.

import { VersionedTransaction, type MessageCompiledInstruction } from '@solana/web3.js';
import { ALL_TIP_ACCOUNTS } from '../engine/tipAccounts';
import { ataFor, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, PUMP_PROGRAM, PUMP_FEES_PROGRAM } from '../engine/addresses';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/**
 * Wallets a relayer pays ITS fee to with a bare top-level transfer (the AMM
 * route does this; the curve route pays inside the router CPI). Bounded per
 * trade by SignPolicy.relayerFeeMaxLamports, never open-ended. Verified
 * 2026-08-29 from a decoded PumpPortal pump-amm build (0.00005 SOL fixed +
 * 0.5% inside the swap).
 */
export const RELAYER_FEE_ACCOUNTS: ReadonlySet<string> = new Set<string>([
  '7FeFBYbewCqXG7LP6gC8Fnqzk7hmQFMtntXVRqnXi4g6', // PumpPortal fee wallet
]);
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Programs a trade we sign may legitimately invoke at top level. Anything
 * else is "unknown": the policy then refuses any instruction of it that can
 * write one of OUR token accounts (see checkOutflow), and liveSigner refuses
 * the whole transaction outright. Keep this list in sync with
 * liveSigner.ts KNOWN_PROGRAMS.
 */
export const KNOWN_TRADE_PROGRAMS: ReadonlySet<string> = new Set<string>([
  PUMP_PROGRAM,
  // PumpPortal's router. Since 2026-08 every relayer-built pump trade is a
  // single instruction of this program that CPIs into pump `buy`/`sell` and
  // collects the relayer's 0.5% — verified 2026-08-29 by simulating an
  // unsigned trade-local build: its only inner calls are pump + pump-fees.
  'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // pump-amm (pumpswap)
  PUMP_FEES_PROGRAM,
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // raydium CLMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // raydium launchlab
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // meteora DLMM
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // meteora DAMM v2
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // meteora pools (DAMM v1)
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', // meteora DBC
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // jupiter v6
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // orca whirlpool (2026-09-02: Jupiter routes; the USDG case)
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // memo v2
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', // memo v1
]);

/**
 * The entries of KNOWN_TRADE_PROGRAMS that are not VENUES.
 *
 * They belong on that list — a transaction may contain them — but they are not
 * evidence that a swap is happening, so they cannot vouch for where tokens are
 * going. Kept as its own set rather than a filter so the distinction is
 * written down instead of implied.
 */
/**
 * Programs that belong in KNOWN_TRADE_PROGRAMS for ROUTING, and which a trade
 * of ours never invokes at top level.
 *
 * They are on the allowlist because Jupiter routes THROUGH them — as inner
 * instructions. Measured 2026-09-09 across 25 sampled real routes: **0 had a
 * CLMM/Whirlpool/DLMM instruction at top level.** That matters because a swap
 * through Orca and a liquidity DEPOSIT into Orca are the same program, and an
 * allowlisted program otherwise gets no inspection at all — so a top-level
 * appearance is the shape an LP deposit or a position-NFT mint would take,
 * dressed as a trade.
 *
 * Enforced on BUYS only. The measurement says a legitimate sell will not hit
 * this either, but "a limit never blocks an exit" is not a probabilistic rule:
 * on a sell this warns and signs.
 */
const CPI_ONLY_PROGRAMS: ReadonlySet<string> = new Set<string>([
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // orca whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // meteora DLMM
]);

const INFRASTRUCTURE_PROGRAMS: ReadonlySet<string> = new Set<string>([
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

/** SPL Token / Token-2022 instruction discriminators (shared 1-byte layout). */
const TOK_TRANSFER = 3;
const TOK_APPROVE = 4;
const TOK_REVOKE = 5;
const TOK_SET_AUTHORITY = 6;
const TOK_BURN = 8;
const TOK_CLOSE_ACCOUNT = 9;
const TOK_TRANSFER_CHECKED = 12;
const TOK_APPROVE_CHECKED = 13;
const TOK_BURN_CHECKED = 15;
/** Token-2022 only: moves lamports out of a token account. */
const TOK_WITHDRAW_EXCESS_LAMPORTS = 38;
const TOK_MINT_TO = 7;
const TOK_FREEZE_ACCOUNT = 10;
const TOK_MINT_TO_CHECKED = 14;
/**
 * Token / Token-2022 discriminators a trade legitimately contains and that
 * move nothing of ours by themselves. Anything NOT here is refused, because
 * the alternative is enumerating every extension Token-2022 has added (and
 * will add) — including TransferFeeExtension (26) and
 * ConfidentialTransferExtension (27), whose sub-instructions DO move
 * tokens. Fail closed: a new extension is refused until it is understood.
 */
const TOK_HARMLESS = new Set([
  1, // InitializeAccount
  2, // InitializeMultisig
  5, // Revoke — gives an approval up, never takes anything
  // MintTo (7/14) and FreezeAccount (10) used to sit here, excused as
  // "needs an authority that is not us". That parenthetical was an assumption,
  // and it is backwards: a TOP-LEVEL Token instruction's authority must SIGN,
  // and a signer who is not us makes the transaction two-signer, which the
  // signer already refuses. So the only version of these we could ever sign is
  // the one where WE are the authority — minting supply or freezing an
  // account, neither of which is part of any trade. Refused explicitly below.
  //
  // ThawAccount (11) stays: on a default-frozen Token-2022 mint whose freeze
  // authority is ours, thawing is what makes a SELL possible, and a limit
  // never blocks an exit.
  11, // ThawAccount
  16, // InitializeAccount2
  17, // SyncNative
  18, // InitializeAccount3
  19, // InitializeMultisig2
  20, // InitializeMint2
  21, // GetAccountDataSize
  22, // InitializeImmutableOwner
  23, // AmountToUiAmount
  24, // UiAmountToAmount
]);

/** SystemInstruction discriminants. Transfer is the only one we parse; the
 *  other three move lamports by paths this rule cannot verify. */
const SYS_IX_CREATE_ACCOUNT = 0;
const SYS_IX_TRANSFER = 2;
const SYS_IX_CREATE_ACCOUNT_WITH_SEED = 3;
const SYS_IX_TRANSFER_WITH_SEED = 11;

/** What the caller says the transaction is for. The policy enforces a
 *  different rule per intent — it does not take the caller's word for the
 *  contents. */
export type SignIntent = 'trade' | 'sweep' | 'rent-reclaim' | 'fund' | 'launch' | 'collect-fees' | 'bridge';

/**
 * Programs whose CREATE instructions a launch may contain.
 *
 * Deliberately NOT KNOWN_TRADE_PROGRAMS. That list exists so a swap can route,
 * and every program on it is waved through without instruction inspection — a
 * launch must not inherit that. This list is short, separate, and only
 * reachable under `intent: 'launch'`.
 */
export const LAUNCHPAD_PROGRAMS: ReadonlySet<string> = new Set<string>([
  PUMP_PROGRAM,
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // raydium launchlab
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', // meteora DBC
]);

/**
 * pump's two creator-fee collect instructions, by discriminator.
 *
 * Both read out of pump's own on-chain IDL 2026-09-11. v1 collects the SOL
 * creator vault; v2 collects a quote-token one. The app only builds v1, but
 * the signer recognises both so that adding v2 later is a builder change and
 * not a policy change.
 */
export const COLLECT_FEE_DISCRIMINATORS: ReadonlySet<string> = new Set<string>([
  '1416567bc61cdb84', // collect_creator_fee
  'cf118af204221338', // collect_creator_fee_v2
]);

/**
 * A fee claim is held to a TIGHTER rule than a trade, not a looser one.
 *
 * `intent: 'collect-fees'` exists so this transaction cannot borrow the trade
 * path's permissiveness. A trade may call any known trade program with any
 * data; a claim may do exactly one thing:
 *
 *  · every top-level program is pump or plain infrastructure;
 *  · exactly ONE pump instruction appears;
 *  · its discriminator is one of pump's two collect instructions — so a claim
 *    can never be a buy, a sell, or a create wearing a claim's name;
 *  · its first account, which the IDL calls `creator`, IS this wallet. That
 *    is the account the lamports are paid to, and it is the whole reason this
 *    is safe to sign: pump lets anyone crank a collection, so the only thing
 *    that matters is who gets paid.
 */
function checkCollectFees(
  msg: VersionedTransaction['message'],
  staticKeys: string[],
  walletPublicKey: string,
): string | null {
  let seen = 0;
  for (const ix of msg.compiledInstructions) {
    const program = staticKeys[ix.programIdIndex];
    if (program === undefined) return 'A fee claim hides its program in an address lookup table — refusing to sign';
    if (INFRASTRUCTURE_PROGRAMS.has(program)) continue;
    if (program !== PUMP_PROGRAM) {
      return `A fee claim may only call pump — ${short(program)} is not it, refusing to sign`;
    }
    seen += 1;
    if (ix.data.length < 8) return 'A fee claim instruction carries no discriminator — refusing to sign';
    const disc = Buffer.from(ix.data.subarray(0, 8)).toString('hex');
    if (!COLLECT_FEE_DISCRIMINATORS.has(disc)) {
      return `That pump instruction (${disc}) is not a creator-fee collection — refusing to sign`;
    }
    const paidTo = staticKeys[ix.accountKeyIndexes[0] ?? -1];
    if (paidTo !== walletPublicKey) {
      return `The claim pays ${short(paidTo)}, not this wallet — refusing to sign`;
    }
  }
  if (seen !== 1) return `A fee claim is exactly one pump instruction — found ${seen}, refusing to sign`;
  return null;
}

/**
 * Top-level programs in this transaction that are NOT on the allowlist.
 *
 * ─── Why this exists as its own function ────────────────────────────────
 *
 * `checkOutflow` inspects TOP-LEVEL instructions only, and its unknown-program
 * branch guards only our TOKEN accounts. It does not check whether the
 * wallet's own system account — index 0, always writable, always a signer —
 * was handed to a program nobody recognises. Such a program can CPI a transfer
 * out, and no rule in this file sees it, because a CPI is not a top-level
 * instruction.
 *
 * The defence against that has always been a hard program allowlist applied by
 * the CALLER before signing, and until 2026-09-11 it existed in exactly one
 * place — liveSigner's relayer path. Every other module that signs
 * third-party-built bytes lacked it, which the bridge swarm found while
 * auditing something else entirely.
 *
 * A program id hidden in a lookup table reads as `undefined` here and is
 * reported as unknown, because an account we cannot name is one we cannot
 * judge.
 */
export function unknownTopLevelPrograms(tx: VersionedTransaction, allowed: ReadonlySet<string>): string[] {
  const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const seen = new Set(tx.message.compiledInstructions.map((ix) => staticKeys[ix.programIdIndex]));
  return [...seen].filter((pid) => !pid || !allowed.has(pid)).map((pid) => pid ?? 'hidden-in-lookup-table');
}

/**
 * Programs a BRIDGE transaction may call, pinned as build constants.
 *
 * Deliberately NOT taken from the quote. A program id the quote supplies is
 * attacker data: the quote and the transaction arrive over the same channel
 * from the same host, so validating one against the other proves nothing.
 * These were decoded from a real LI.FI route on 2026-09-11 and every one is
 * recorded in docs/bridge-research-2026-09-11.md.
 *
 * Deliberately NOT added to KNOWN_TRADE_PROGRAMS either. That set feeds
 * `tradeProgramAccounts` below, which the sell-side destination rule consults
 * — adding a bridge program there would silently widen every TRADE in the app
 * to allow a sell's proceeds into any account a bridge names. Separate set,
 * the LAUNCHPAD_PROGRAMS shape, reachable only under `intent: 'bridge'`.
 *
 * A route whose programs are not in here REFUSES. That is the point: an
 * unmeasured route is not a route this app signs for.
 */
export const BRIDGE_PROGRAMS: ReadonlySet<string> = new Set<string>([
  // Relay depository — the account the bridged lamports actually go to.
  // Measured on solana->robinhood, 2026-09-11.
  '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
  // LI.FI's own instruction, carrying the 8-byte transactionId.
  '3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br',
]);

/**
 * The ONE shape a Solana bridge is allowed to take.
 *
 * ─── What this can and cannot prove ────────────────────────────────────
 *
 * It proves how much leaves and that it leaves to a program pinned above. It
 * CANNOT prove where the money ends up, because — measured on a real route —
 * the destination address, the destination chain id, the expected amount and
 * the minimum are NONE of them present in the transaction. The far side is
 * carried by an opaque id that changes between two identical quotes.
 *
 * So this is a bound on the ORIGIN, and the UI is required to say that the
 * destination is trusted rather than verified. A checkmark here would be a
 * lie by omission, which is worse than no checkmark.
 *
 * Every clause is load-bearing:
 *
 *  · no address lookup tables at all. LI.FI's Solana routes use them, and the
 *    tempting fix — relaxing the existing ALT refusals — would be the actual
 *    loss event, because an account we cannot name is an account we cannot
 *    judge;
 *  · every top-level program is infrastructure or a PINNED bridge program;
 *  · the integrator fee goes through `feeAllowance`, which sums per address,
 *    so a second transfer to the same fee collector cannot slip under an
 *    individual ceiling;
 *  · nothing else may leave by a bare transfer;
 *  · no `trade` context is set, so every Token instruction that would move a
 *    holding hits the ordinary refusal in checkTokenInstruction.
 */
function checkBridge(
  msg: VersionedTransaction['message'],
  staticKeys: string[],
  policy: SignPolicy,
): string | null {
  // An account hidden in a lookup table is an account this signer cannot
  // name, and a bridge is the one shape where the accounts ARE the security.
  // So every looked-up account is NAMED — resolved by the caller from the
  // chain and handed over — and each one must be on the route's pinned list.
  const lookups = msg.addressTableLookups ?? [];
  if (lookups.length > 0) {
    const tables = policy.resolvedTables ?? [];
    if (tables.length !== lookups.length) {
      return 'A bridge may not use an address lookup table this signer has not resolved — refusing to sign';
    }
    const pinned = new Set(policy.bridgeAccounts ?? []);
    if (pinned.size === 0) return 'A bridge with lookup tables needs a pinned account list for its route — refusing to sign';
    for (let i = 0; i < lookups.length; i += 1) {
      const lookup = lookups[i]!;
      const table = tables[i]!;
      if (table.key !== lookup.accountKey.toBase58()) {
        return `Lookup table ${i} resolved as ${short(table.key)} but the transaction names ${short(lookup.accountKey.toBase58())} — refusing to sign`;
      }
      for (const idx of [...lookup.writableIndexes, ...lookup.readonlyIndexes]) {
        const account = table.addresses[idx];
        if (account === undefined) return `Lookup table ${short(table.key)} has no entry ${idx} — refusing to sign`;
        if (!pinned.has(account)) {
          return `A bridge instruction is handed ${short(account)} from a lookup table, which is not an account this route was measured with — refusing to sign`;
        }
      }
    }
  }
  let bridgeIxs = 0;
  for (const ix of msg.compiledInstructions) {
    const program = staticKeys[ix.programIdIndex];
    if (program === undefined) {
      return 'A bridge instruction hides its program in an address lookup table — refusing to sign';
    }
    if (INFRASTRUCTURE_PROGRAMS.has(program)) continue;
    if (!BRIDGE_PROGRAMS.has(program)) {
      return `A bridge may only call a bridge this build has measured — ${short(program)} is not one, refusing to sign`;
    }
    bridgeIxs += 1;
  }
  if (bridgeIxs === 0) return 'That transaction calls no bridge at all — refusing to sign';
  return null;
}

/**
 * What the trade is, so the policy can tell an expected token movement (the
 * traded mint leaving on a sell, WSOL wrap/unwrap, an ATA closed back to us)
 * from a drain of something else we hold. Optional so older callers keep
 * working; without it the policy assumes NO token of ours may move at all,
 * which is the safe default for a buy.
 */
export interface TradeContext {
  side: 'buy' | 'sell';
  mint: string;
}

export interface SignPolicy {
  intent: SignIntent;
  /**
   * Intent 'launch' ONLY: the mint keypair this app generated for this launch.
   *
   * A launchpad create needs a second signature, and this names exactly whose.
   * Without it a launch cannot be signed at all — see checkLaunch. The value is
   * a public key held in memory for the seconds a launch takes; the secret is
   * never persisted and never leaves the main process.
   */
  launchMint?: string;
  /** Hard ceiling on total lamports leaving via bare top-level SystemProgram
   *  transfers. Trades pay tips; sweeps pay the user's own address. */
  maxTransferLamports: number;
  /**
   * Addresses permitted to receive the platform fee on THIS transaction, each
   * with its own exact ceiling.
   *
   * Kept separate from `maxTransferLamports` on purpose. That cap exists to
   * bound tips, and folding the fee into it would quietly raise the amount a
   * malicious relayer could route to a tip account. Here each fee recipient is
   * named and bounded individually, the sum per address is checked, and
   * everything else still falls under the old rule — so this widens the policy
   * by exactly the two transfers we ourselves injected and nothing more.
   *
   * Absent or empty means no fee transfer may appear at all.
   */
  feeAllowance?: Array<{ address: string; maxLamports: number }>;
  /**
   * Intent 'bridge' ONLY: the address lookup tables the transaction
   * references, RESOLVED by the caller from the chain, in the order the
   * message lists them, each with that table's full address list.
   *
   * A table entry is append-only — an index, once written, never points
   * anywhere else — so a copy read moments before signing names exactly the
   * accounts the runtime will load. Without this a transaction with lookups
   * is refused (as every bridge was until 2026-09-11, when the audit found
   * the only enabled Solana route ships one and could never be signed).
   */
  resolvedTables?: Array<{ key: string; addresses: string[] }>;
  /**
   * Intent 'bridge' ONLY: every account a lookup table is allowed to hand
   * the bridge program. Pinned per route by the caller from a measured
   * transaction; anything else looked up is refused by name.
   */
  bridgeAccounts?: string[];
  /**
   * Ceiling on lamports a trade may send, top-level, to a KNOWN relayer fee
   * wallet (RELAYER_FEE_ACCOUNTS). Absent or 0 = none allowed. Set by
   * liveSigner from the trade size, so a relayer can only ever take its
   * published cut, never route the trade's SOL to itself.
   */
  relayerFeeMaxLamports?: number;
  /**
   * A fee transfer that MUST be present, or the signature is refused.
   *
   * This is the anti-tamper interlock, and it is deliberately applied by the
   * caller ONLY to buys — never sells. A cracked build that strips the fee
   * injection then cannot open a position (the signer refuses the buy), which
   * makes the crack useless as a sniper; but a legitimate user is never blocked
   * from EXITING one, because sells carry no such requirement. Stranding a
   * position to protect a fee would be a worse outcome than a cracked build.
   *
   * The required transfer must also be within `feeAllowance` — this only adds a
   * floor, it does not widen what may leave the wallet.
   */
  requireFeeTransfer?: { address: string; minLamports: number };
  /**
   * Intent 'fund' (Wallet Lab, 2026-09-03): the ONLY destinations a transfer
   * may name — the public keys of wallets this install holds, resolved from
   * the store by the caller. Anything else in the transaction is refused.
   */
  fundTargets?: string[];
  /**
   * The trade this signature is for. Drives the SPL Token rule (2026-08-28
   * audit, HIGH): a relayer-built tx could carry a Token `Approve`,
   * `SetAuthority`, `Transfer` of another held token or `CloseAccount` to a
   * stranger, and the SOL-only rule let it through. See checkTokenInstruction.
   */
  trade?: TradeContext;
}

export interface OutflowCheck {
  ok: boolean;
  message: string;
}

/**
 * Decode every top-level instruction and decide whether this transaction may
 * move our SOL. Fails closed on anything it cannot fully account for.
 */

/**
 * The launch exception, stated in one place so it can be read in one sitting.
 *
 * Returns a refusal string, or null when the transaction is a launch this app
 * itself set up. Every clause is load-bearing:
 *
 *  · `launchMint` must be present — a caller that did not generate a mint is
 *    not launching, whatever its intent field says;
 *  · exactly TWO signatures, never "at least two";
 *  · slot 0 is the fee payer, already checked to be our wallet;
 *  · slot 1 is the ephemeral mint EXACTLY — not merely "some other key";
 *  · every top-level program must be a launchpad or plain infrastructure, so a
 *    second signer cannot be smuggled in beside an unrelated program.
 */
function checkLaunchSigners(
  msg: VersionedTransaction['message'],
  staticKeys: string[],
  policy: SignPolicy,
): string | null {
  const mint = policy.launchMint;
  if (typeof mint !== 'string' || mint.length < 32) {
    return 'A launch must name the mint keypair it generated — refusing to sign';
  }
  const n = msg.header.numRequiredSignatures;
  if (n !== 2) {
    return `A launch is signed by your wallet and the new mint, exactly 2 signers — this needs ${n}, refusing to sign`;
  }
  const second = staticKeys[1];
  if (second !== mint) {
    return `The second signer is ${short(second)}, not the mint this launch created — refusing to sign`;
  }
  for (const ix of msg.compiledInstructions) {
    const program = staticKeys[ix.programIdIndex];
    if (program === undefined) {
      return 'A launch instruction hides its program in an address lookup table — refusing to sign';
    }
    if (!LAUNCHPAD_PROGRAMS.has(program) && !INFRASTRUCTURE_PROGRAMS.has(program)) {
      return `A launch may only call a launchpad — ${short(program)} is not one, refusing to sign`;
    }
  }
  return null;
}

const short = (k: string | undefined): string => `${(k ?? '?').slice(0, 8)}…`;

export function checkOutflow(
  tx: VersionedTransaction,
  walletPublicKey: string,
  homeAddress: string | null,
  policy: SignPolicy,
): OutflowCheck {
  const msg = tx.message;
  const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
  const ixs = msg.compiledInstructions;

  const feePayer = staticKeys[0];
  if (feePayer !== walletPublicKey) {
    return { ok: false, message: 'Transaction fee payer is not this wallet — refusing to sign' };
  }
  // ── The one-signer rule, and its single exception ──────────────────
  //
  // "Exactly one required signature" is this app's strongest invariant: it is
  // what makes it impossible to talk the signer into co-signing somebody
  // else's transaction. A launchpad create is the one legitimate thing that
  // cannot satisfy it, because the new mint must sign for itself.
  //
  // So the exception is not "allow two signers". It is: allow exactly two,
  // where the second is a keypair THIS APP generated for THIS launch and named
  // in the policy. Every other caller — every trade, sweep, fund and rent
  // reclaim — still gets the original rule, unchanged, and a launch is only
  // reachable when the user has turned the launcher on.
  if (policy.intent === 'launch') {
    const bad = checkLaunchSigners(msg, staticKeys, policy);
    if (bad) return { ok: false, message: bad };
  } else if (msg.header.numRequiredSignatures !== 1) {
    return { ok: false, message: `Transaction needs ${msg.header.numRequiredSignatures} signers — refusing (expect 1)` };
  }

  if (policy.intent === 'collect-fees') {
    const bad = checkCollectFees(msg, staticKeys, walletPublicKey);
    if (bad) return { ok: false, message: bad };
  }

  if (policy.intent === 'bridge') {
    const bad = checkBridge(msg, staticKeys, policy);
    if (bad) return { ok: false, message: bad };
  }

  if (policy.intent === 'sweep') {
    // Our own builder emits exactly one instruction. Anything else is not a
    // sweep, whatever the caller claims.
    if (ixs.length !== 1) {
      return { ok: false, message: `Sweep must be a single instruction — got ${ixs.length}, refusing to sign` };
    }
    if (!homeAddress) {
      return { ok: false, message: 'No withdrawal address set — refusing to sign a sweep' };
    }
  }
  const fundSet = new Set(policy.intent === 'fund' ? policy.fundTargets ?? [] : []);
  if (policy.intent === 'fund') {
    if (fundSet.size === 0) return { ok: false, message: 'A fund transaction needs an explicit list of own-wallet destinations — refusing to sign' };
    if (ixs.length === 0 || ixs.length > 16) return { ok: false, message: `A fund transaction carries 1–16 transfers — got ${ixs.length}, refusing to sign` };
  }

  let totalOut = 0n;
  /** Fee lamports per recipient, so repeated transfers to the same address
   *  cannot each slip under the ceiling individually. */
  const feeOut = new Map<string, bigint>();
  let relayerOut = 0n;

  // Token accounts of OURS this trade may legitimately touch: the traded mint's
  // ATA under both token programs, and the WSOL ATA (AMM quote side).
  const ownAtas = ownTokenAccounts(walletPublicKey, policy.trade?.mint);
  const ownWsolAta = ataFor(walletPublicKey, WSOL_MINT, TOKEN_PROGRAM);

  // Every account a KNOWN trade program touches in this transaction.
  //
  // On a sell, the traded mint legitimately leaves our ATA — but it leaves it
  // INTO a pool vault, which is by definition an account the swap instruction
  // itself also names. A destination that appears nowhere near a trade program
  // is not a venue, it is a stranger. Precomputed once, before the loop, so
  // the Transfer rule below can name what it is comparing against.
  //
  // KNOWN_TRADE_PROGRAMS is not the right list to ask: it also contains the
  // Token, ATA, System, ComputeBudget and Memo programs, so a Transfer's own
  // destination would be added by the Transfer itself and the check could
  // never fire. Only an actual VENUE counts as evidence of an exit.
  /** Routing-only programs seen at top level on a SELL: reported, never blocking. */
  const topLevelVenueWarnings: string[] = [];
  const tradeProgramAccounts = new Set<string>();
  for (const ix of ixs) {
    if (ix.programIdIndex >= staticKeys.length) continue;
    const pid = staticKeys[ix.programIdIndex];
    if (!KNOWN_TRADE_PROGRAMS.has(pid) || INFRASTRUCTURE_PROGRAMS.has(pid)) continue;
    for (const idx of ix.accountKeyIndexes) {
      const key = staticKeys[idx];
      if (key !== undefined) tradeProgramAccounts.add(key);
    }
  }

  for (const ix of ixs) {
    if (ix.programIdIndex >= staticKeys.length) {
      // The runtime forbids this too, but never rely on it: an instruction
      // whose PROGRAM we cannot name is one we cannot judge.
      return { ok: false, message: 'Instruction program is hidden in an address lookup table — refusing to sign' };
    }
    const program = staticKeys[ix.programIdIndex];

    // A fund transaction is SystemProgram transfers (plus a compute-budget
    // priority fee) and nothing else — decided before any program-specific
    // branch can wave an instruction through.
    if (policy.intent === 'fund' && program !== SYSTEM_PROGRAM_ID && program !== COMPUTE_BUDGET_PROGRAM) {
      return { ok: false, message: `A fund transaction may only contain SystemProgram transfers — found ${program.slice(0, 8)}…, refusing to sign` };
    }

    if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
      const bad = checkTokenInstruction(ix, staticKeys, walletPublicKey, policy, ownAtas, ownWsolAta, tradeProgramAccounts);
      if (bad) return { ok: false, message: bad };
      continue;
    }

    if (program !== SYSTEM_PROGRAM_ID) {
      // A routing-only program at top level is not a route. See
      // CPI_ONLY_PROGRAMS — buys refuse, sells warn and sign.
      if (CPI_ONLY_PROGRAMS.has(program)) {
        if (policy.trade?.side === 'buy') {
          return {
            ok: false,
            message: `refused: ${program.slice(0, 8)}… is a routing venue this app only ever calls through a router — a direct call is not a trade`,
          };
        }
        topLevelVenueWarnings.push(program);
      }
      // A program we do not know may run, but it may NOT be handed one of our
      // token accounts writable: that is how a foreign program drains a
      // holding without any Token instruction appearing at top level.
      if (!KNOWN_TRADE_PROGRAMS.has(program)) {
        for (const idx of ix.accountKeyIndexes) {
          const key = staticKeys[idx];
          if (key === undefined) continue; // lookup-table entry: cannot be one of our static ATAs
          if (ownAtas.has(key) && msg.isAccountWritable(idx)) {
            return {
              ok: false,
              message: `refused: unknown program ${program.slice(0, 8)}… is given your token account ${key.slice(0, 8)}… writable`,
            };
          }
        }
      }
      continue;
    }

    const data = ix.data;
    if (data.length < 4) {
      return { ok: false, message: 'Malformed SystemProgram instruction — refusing to sign' };
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const kind = view.getUint32(0, true);

    if (kind === SYS_IX_CREATE_ACCOUNT || kind === SYS_IX_CREATE_ACCOUNT_WITH_SEED || kind === SYS_IX_TRANSFER_WITH_SEED) {
      return { ok: false, message: `SystemProgram instruction ${kind} moves lamports by a path this signer cannot verify — refusing to sign` };
    }
    if (kind !== SYS_IX_TRANSFER) {
      // Assign/Allocate/nonce ops move no lamports directly, but our builders
      // never emit them. Fail closed (PHASE2 invariant 3).
      return { ok: false, message: `Unexpected SystemProgram instruction ${kind} — refusing to sign` };
    }
    if (data.length < 12) {
      return { ok: false, message: 'Malformed SystemProgram transfer — refusing to sign' };
    }

    const lamports = view.getBigUint64(4, true);
    const destIdx = ix.accountKeyIndexes[1];
    if (destIdx === undefined) {
      return { ok: false, message: 'Transfer with no destination account — refusing to sign' };
    }
    // An address-lookup-table entry cannot be resolved from the message alone,
    // so the destination is unverifiable. Refuse rather than assume.
    if (destIdx >= staticKeys.length) {
      return { ok: false, message: 'Transfer destination is hidden in an address lookup table — refusing to sign' };
    }
    const dest = staticKeys[destIdx];

    // WSOL wrap: an AMM buy funds our OWN wrapped-SOL account (a PDA only we
    // can spend from) before the swap. Not an outflow, so not counted against
    // the tip cap; the simulation loss guard bounds the SOL either way.
    if (policy.intent === 'trade' && dest === ownWsolAta) continue;

    // A named fee recipient is accounted separately, against its own ceiling,
    // so the tip cap below keeps meaning exactly what it used to.
    const feeSlot = policy.intent !== 'sweep' ? (policy.feeAllowance ?? []).find((f) => f.address === dest) : undefined;
    if (feeSlot) {
      const soFar = (feeOut.get(dest) ?? 0n) + lamports;
      if (soFar > BigInt(feeSlot.maxLamports)) {
        return {
          ok: false,
          message: `Transaction sends ${Number(soFar) / LAMPORTS_PER_SOL} SOL to fee address ${dest.slice(0, 8)}…, over the ${feeSlot.maxLamports / LAMPORTS_PER_SOL} SOL allowed for this trade — refusing to sign`,
        };
      }
      feeOut.set(dest, soFar);
      continue;
    }

    // The relayer's own fee: a known wallet, bounded by the trade size.
    if (policy.intent === 'trade' && RELAYER_FEE_ACCOUNTS.has(dest)) {
      relayerOut += lamports;
      const cap = BigInt(policy.relayerFeeMaxLamports ?? 0);
      if (relayerOut > cap) {
        return {
          ok: false,
          message: `Transaction sends ${Number(relayerOut) / LAMPORTS_PER_SOL} SOL to relayer fee wallet ${dest.slice(0, 8)}…, over the ${Number(cap) / LAMPORTS_PER_SOL} SOL a relayer may take on this trade — refusing to sign`,
        };
      }
      continue;
    }

    const allowed =
      policy.intent === 'sweep'
        ? dest === homeAddress
        : policy.intent === 'fund'
          ? fundSet.has(dest)
          : dest === homeAddress || ALL_TIP_ACCOUNTS.has(dest);

    if (!allowed) {
      return {
        ok: false,
        message: `Transaction sends SOL to ${dest.slice(0, 8)}…, which is neither your withdrawal address nor a known tip account — refusing to sign`,
      };
    }
    totalOut += lamports;
  }

  if (totalOut > BigInt(policy.maxTransferLamports)) {
    return {
      ok: false,
      message: `Transaction moves ${Number(totalOut) / LAMPORTS_PER_SOL} SOL, over the ${policy.maxTransferLamports / LAMPORTS_PER_SOL} SOL cap for a ${policy.intent} — refusing to sign`,
    };
  }

  // Anti-tamper: a required fee must actually be present. Only ever set for
  // buys (see SignPolicy.requireFeeTransfer), so a stripped-fee build cannot
  // open a position while a legit user can always close one.
  if (policy.requireFeeTransfer) {
    const paid = feeOut.get(policy.requireFeeTransfer.address) ?? 0n;
    if (paid < BigInt(policy.requireFeeTransfer.minLamports)) {
      return {
        ok: false,
        message:
          'This build appears to have been modified: the platform fee is missing from a paid trade. Refusing to sign. Reinstall an official build from krypt.cc.',
      };
    }
  }

  // Signed, but say so: a routing venue called directly on a sell is unusual
  // enough to name in the log, and the exit still happens.
  if (topLevelVenueWarnings.length) {
    return {
      ok: true,
      message: `ok — WARNING: sell calls ${topLevelVenueWarnings.map((x) => `${x.slice(0, 8)}…`).join(', ')} directly rather than through a router`,
    };
  }
  return { ok: true, message: 'ok' };
}

/** Our ATAs for the traded mint (both token programs) plus WSOL. */
function ownTokenAccounts(wallet: string, mint: string | undefined): Set<string> {
  const out = new Set<string>([ataFor(wallet, WSOL_MINT, TOKEN_PROGRAM)]);
  if (mint) {
    out.add(ataFor(wallet, mint, TOKEN_PROGRAM));
    out.add(ataFor(wallet, mint, TOKEN_2022_PROGRAM));
  }
  return out;
}

/**
 * The SPL Token rule. Every top-level Token / Token-2022 instruction is
 * decoded by its discriminator; the ones that can hand our holdings to
 * someone else are refused unless they are exactly what this trade needs:
 *
 *   Approve / ApproveChecked / SetAuthority   never (a delegate drains later)
 *   CloseAccount                              only with the rent back to us
 *   Transfer / TransferChecked by us          sell only, and only the traded
 *                                             mint (a buy moves no token out)
 *   Burn / BurnChecked by us                  sell only, traded mint only
 *   WithdrawExcessLamports (2022)             never
 *
 * A sell that also moves ANOTHER token is refused too: that is not "blocking
 * an exit", it is refusing a drain riding on one. Returns the refusal, or
 * null when the instruction is fine.
 */
function checkTokenInstruction(
  ix: MessageCompiledInstruction,
  staticKeys: string[],
  wallet: string,
  policy: SignPolicy,
  ownAtas: Set<string>,
  ownWsolAta: string,
  tradeProgramAccounts: Set<string>,
): string | null {
  const data = ix.data;
  if (data.length < 1) return 'Malformed Token instruction — refusing to sign';
  const kind = data[0];
  const short = (k: string | undefined) => `${(k ?? '?').slice(0, 8)}…`;

  // Every account of a Token instruction must be nameable. One hidden in a
  // lookup table could be our ATA, or a stranger as destination.
  for (const idx of ix.accountKeyIndexes) {
    if (idx >= staticKeys.length) {
      return `refused: Token instruction ${kind} touches an account hidden in an address lookup table`;
    }
  }
  const acct = (i: number): string | undefined => {
    const idx = ix.accountKeyIndexes[i];
    return idx === undefined ? undefined : staticKeys[idx];
  };
  const trade = policy.trade;
  const isTradedMintAta = (k: string | undefined) => k !== undefined && trade !== undefined && k !== ownWsolAta && ownAtas.has(k);

  switch (kind) {
    case TOK_APPROVE:
    case TOK_APPROVE_CHECKED: {
      const delegate = kind === TOK_APPROVE ? acct(1) : acct(2);
      return `refused: Approve delegates token account ${short(acct(0))} to ${short(delegate)} — nothing we sign grants a delegate`;
    }
    case TOK_SET_AUTHORITY: {
      return `refused: SetAuthority would hand token account ${short(acct(0))} to a new owner`;
    }
    case TOK_WITHDRAW_EXCESS_LAMPORTS: {
      return `refused: WithdrawExcessLamports moves SOL out of ${short(acct(0))}`;
    }
    case TOK_CLOSE_ACCOUNT: {
      const dest = acct(1);
      if (dest !== wallet) {
        return `refused: CloseAccount sends the rent of ${short(acct(0))} to ${short(dest)}, not to this wallet`;
      }
      return null;
    }
    case TOK_TRANSFER:
    case TOK_TRANSFER_CHECKED: {
      const source = acct(0);
      const mintAcct = kind === TOK_TRANSFER_CHECKED ? acct(1) : undefined;
      const dest = kind === TOK_TRANSFER_CHECKED ? acct(2) : acct(1);
      const authority = kind === TOK_TRANSFER_CHECKED ? acct(3) : acct(2);
      // Only an instruction we AUTHORISE can move our tokens (we are the sole
      // signer; any other authority fails on chain). The source address is
      // checked as well, so a spoofed authority slot hides nothing.
      const ours = authority === wallet || (source !== undefined && ownAtas.has(source));
      if (!ours) return null;
      if (!trade || trade.side !== 'sell') {
        return `refused: Transfer moves tokens out of your account ${short(source)} to ${short(dest)} — a ${trade?.side ?? 'trade'} moves no token out`;
      }
      if (!isTradedMintAta(source)) {
        return `refused: Transfer moves a token other than the one being sold out of ${short(source)} to ${short(dest)}`;
      }
      if (mintAcct !== undefined && mintAcct !== trade.mint) {
        return `refused: TransferChecked names mint ${short(mintAcct)}, not the mint being sold`;
      }
      // WHERE the tokens go was decoded and then never checked — `dest` was
      // used only to word the refusals above. So a top-level Transfer of the
      // whole bag to any address at all passed, as long as it was a sell of
      // the traded mint.
      //
      // A real exit sends the tokens into the venue's vault, and that vault is
      // an account the swap instruction itself names. Requiring that cannot
      // block an exit: if no known trade program is involved, there is no exit
      // happening. Our own accounts are allowed too, so a consolidating
      // transfer between our ATAs still signs.
      if (dest === undefined) {
        return 'refused: Transfer with no destination account';
      }
      if (!tradeProgramAccounts.has(dest) && !ownAtas.has(dest) && dest !== ownWsolAta) {
        return `refused: Transfer sends ${short(source)} to ${short(dest)}, which no trade program in this transaction touches`;
      }
      return null;
    }
    case TOK_BURN:
    case TOK_BURN_CHECKED: {
      const account = acct(0);
      const mintAcct = acct(1);
      const authority = acct(2);
      const ours = authority === wallet || (account !== undefined && ownAtas.has(account));
      if (!ours) return null;
      if (!trade || trade.side !== 'sell' || mintAcct !== trade.mint || !isTradedMintAta(account)) {
        return `refused: Burn destroys tokens of mint ${short(mintAcct)} in your account ${short(account)}`;
      }
      return null;
    }
    default:
      // Fail closed. The kinds that can move our tokens are handled above;
      // the rest are only allowed when they are on the explicit harmless
      // list. A Token-2022 extension instruction (26 TransferFee, 27
      // ConfidentialTransfer, and whatever ships next) reaches here and is
      // refused rather than waved through on the assumption that an
      // unrecognised byte is inert.
      // See TOK_HARMLESS: reachable only when the authority is us.
      if (kind === TOK_MINT_TO || kind === TOK_MINT_TO_CHECKED) {
        return `refused: MintTo creates supply — no trade mints tokens`;
      }
      if (kind === TOK_FREEZE_ACCOUNT) {
        return `refused: FreezeAccount would make ${short(acct(0))} unsellable — no trade freezes an account`;
      }
      if (TOK_HARMLESS.has(kind)) return null;
      return `refused: unrecognised Token instruction ${kind} — this policy only signs the token operations a trade needs`;
  }
}

/**
 * The programs a bridge transaction calls at top level that this build has
 * not measured — empty when every one is either infrastructure or a pinned
 * bridge. Needs no RPC read, so the Bridge page can refuse a quote before a
 * single token is spent on checking it.
 */
export function unknownBridgePrograms(tx: VersionedTransaction): string[] {
  const staticKeys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const out: string[] = [];
  for (const ix of tx.message.compiledInstructions) {
    const program = staticKeys[ix.programIdIndex];
    if (program === undefined) {
      out.push('(a program hidden in a lookup table)');
      continue;
    }
    if (INFRASTRUCTURE_PROGRAMS.has(program) || BRIDGE_PROGRAMS.has(program)) continue;
    out.push(program);
  }
  return out;
}

/** Test entry point: same rule, from serialized bytes. */
export function checkOutflowForTest(
  txBytes: Uint8Array,
  walletPublicKey: string,
  homeAddress: string | null,
  policy: SignPolicy,
): OutflowCheck {
  return checkOutflow(VersionedTransaction.deserialize(txBytes), walletPublicKey, homeAddress, policy);
}
