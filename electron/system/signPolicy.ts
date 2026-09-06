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
  7, // MintTo (needs a mint authority that is not us)
  10, // FreezeAccount (authority that is not us)
  11, // ThawAccount (authority that is not us)
  14, // MintToChecked
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
export type SignIntent = 'trade' | 'sweep' | 'rent-reclaim' | 'fund';

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
  if (msg.header.numRequiredSignatures !== 1) {
    return { ok: false, message: `Transaction needs ${msg.header.numRequiredSignatures} signers — refusing (expect 1)` };
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
      const bad = checkTokenInstruction(ix, staticKeys, walletPublicKey, policy, ownAtas, ownWsolAta);
      if (bad) return { ok: false, message: bad };
      continue;
    }

    if (program !== SYSTEM_PROGRAM_ID) {
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
      if (TOK_HARMLESS.has(kind)) return null;
      return `refused: unrecognised Token instruction ${kind} — this policy only signs the token operations a trade needs`;
  }
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
