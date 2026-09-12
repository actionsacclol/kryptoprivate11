// Signing policy for Robinhood Chain — pure, no viem, no `electron`.
//
// The counterpart of system/signPolicy.ts. Before the key is decrypted the
// signer re-derives, from the raw transaction fields, that the money can
// only go where this trade intends. On Solana that meant walking every
// instruction; an EVM transaction has exactly one call, so the policy is a
// short allowlist: WHICH contract, WHICH function, HOW MUCH ETH, and — for
// the two approval shapes — WHO the spender is.
//
// What it refuses, by construction:
//   • any `to` the trade did not name (a swapped-out router, a stranger);
//   • a selector the target is not allowed (no `transferOwnership`, no
//     `sweep` on a curve, no arbitrary call);
//   • more ETH attached than the trade sized plus its fee;
//   • `approve()` to any spender but Permit2 / the router, and Permit2
//     approvals to any spender but the router — an approval is a standing
//     drain and is the classic phishing payload on EVM chains;
//   • the wrong chain id, a runaway gas limit, or a fee cap the user would
//     regret.
//
// Every rule is a pure function over plain values; test/evmpolicy.test.mjs
// pins each with the exact calldata the builders produce.

export type Hex = `0x${string}`;

export interface EvmTxLike {
  chainId: number;
  to: string;
  value: bigint;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
}

export interface AllowEntry {
  to: string;
  /** Allowed 4-byte selectors, or 'transfer' for a plain ETH transfer with
   *  empty calldata. */
  selectors: Hex[] | 'transfer';
  /** Ceiling on `value` for calls to this target. */
  maxValueWei: bigint;
}

export interface EvmPolicy {
  chainId: number;
  /**
   * 'launch' is the launcher's intent, and it is not a widening: it goes
   * through exactly the same allowlist, value ceiling and gas bounds as every
   * other call. It exists so a refusal message, a log line and an audit can
   * tell a create apart from a buy.
   */
  /**
   * 'bridge' is the cross-chain intent, and like 'launch' it is not a
   * widening: the allowlist, the value ceiling and the gas bounds all apply
   * unchanged. It exists so a refusal message and an audit can tell a
   * cross-chain transfer apart from a trade.
   */
  intent: 'trade' | 'approve' | 'fee' | 'launch' | 'bridge';
  allow: AllowEntry[];
  maxGas: bigint;
  maxFeePerGasWei: bigint;
  /**
   * Ceiling on what this transaction may burn on gas: `gas × maxFeePerGas`.
   *
   * The two ceilings above are independent sanity bounds, and on a SELL that
   * combination is the wrong shape: they refuse an exit outright when the
   * network gets expensive, and "a limit never blocks an exit" outranks a
   * tidy gas number. What actually matters is the total spent, so a sell sets
   * generous per-field bounds plus this product bound — a fee spike passes,
   * a drain does not. Undefined = only the per-field ceilings apply.
   */
  maxGasCostWei?: bigint;
  /** Spenders an ERC-20 `approve` may name. */
  approveSpenders: string[];
  /** Spenders a Permit2 `approve` may name. */
  permit2Spenders: string[];
  /**
   * Buy-side fee interlock (the EVM twin of SignPolicy.requireFeeTransfer).
   * When set, a Universal Router `execute` must carry a TRANSFER command that
   * pays at least `minWei` of native ETH to `treasury`, or the signer refuses.
   * Set for router BUYS only, and only when a fee was actually planned — a
   * genuine attach failure (dust, fees off, corrupt blob) clears it, so a
   * legitimate user is never blocked, and it is NEVER set on a sell. A
   * cracked build that strips the fee therefore cannot buy on a pool; it can
   * still sell everything it holds.
   */
  requireFeeLeg?: {
    treasury: string;
    minWei: bigint;
    /**
     * Where the fee leg lives. 'router-transfer' (default): a Universal
     * Router `execute` with a TRANSFER command. 'curve-router': a
     * KryptCurveRouter `buy` whose `feeWei − referrerWei` word pair pays the
     * treasury (the contract's constant), so the calldata's fee words are
     * what is checked.
     */
    via?: 'router-transfer' | 'curve-router';
  };
}

export const EXECUTE_SELECTOR: Hex = '0x3593564c';
/** KryptCurveRouter.buy(address,uint256,uint256,uint256,address,uint256). */
export const KRYPT_ROUTER_BUY_SELECTOR: Hex = '0xf26c91bb';

/** The fee words of a KryptCurveRouter buy: (quoteIn, feeWei, referrerWei). */
export function decodeRouterBuyFee(data: Hex): { quoteIn: bigint; feeWei: bigint; referrerWei: bigint } | null {
  if (selectorOf(data) !== KRYPT_ROUTER_BUY_SELECTOR) return null;
  const body = data.slice(10);
  const quoteIn = readWord(body, 32);
  const feeWei = readWord(body, 96);
  const referrerWei = readWord(body, 160);
  if (quoteIn === null || feeWei === null || referrerWei === null) return null;
  return { quoteIn, feeWei, referrerWei };
}

/** Does this KryptCurveRouter buy pay the treasury at least `minWei`? The
 *  contract sends `feeWei − referrerWei` to its constant treasury. */
export function carriesRouterFee(data: Hex, minWei: bigint): boolean {
  const f = decodeRouterBuyFee(data);
  if (!f || minWei <= 0n) return false;
  if (f.referrerWei > f.feeWei) return false;
  return f.feeWei - f.referrerWei >= minWei;
}
/** Universal Router command byte for TRANSFER(token, recipient, value). */
export const UR_TRANSFER_COMMAND = 0x05;
const NATIVE = '0x0000000000000000000000000000000000000000';

function readWord(body: string, byteOffset: number): bigint | null {
  const start = byteOffset * 2;
  if (start + 64 > body.length) return null;
  const w = body.slice(start, start + 64);
  return /^[0-9a-fA-F]{64}$/.test(w) ? BigInt(`0x${w}`) : null;
}

function readBytes(body: string, byteOffset: number): string | null {
  const len = readWord(body, byteOffset);
  if (len === null || len > 1_000_000n) return null;
  const n = Number(len);
  const start = (byteOffset + 32) * 2;
  if (start + n * 2 > body.length) return null;
  return body.slice(start, start + n * 2);
}

/**
 * Decode `execute(bytes commands, bytes[] inputs, uint256 deadline)` calldata
 * into its command bytes and raw input blobs, by hand — the policy is pure
 * and must not depend on an ABI library that a cracked build could swap.
 * Returns null for anything malformed.
 */
export function decodeExecute(data: Hex): { commands: number[]; inputs: string[]; deadline: bigint } | null {
  if (selectorOf(data) !== EXECUTE_SELECTOR) return null;
  const body = data.slice(10);
  const cmdOff = readWord(body, 0);
  const inOff = readWord(body, 32);
  const deadline = readWord(body, 64);
  if (cmdOff === null || inOff === null || deadline === null) return null;
  const cmdHex = readBytes(body, Number(cmdOff));
  if (cmdHex === null) return null;
  const commands: number[] = [];
  for (let i = 0; i < cmdHex.length; i += 2) commands.push(parseInt(cmdHex.slice(i, i + 2), 16));
  const base = Number(inOff);
  const count = readWord(body, base);
  if (count === null || count > 64n) return null;
  const inputs: string[] = [];
  for (let i = 0; i < Number(count); i++) {
    const rel = readWord(body, base + 32 + i * 32);
    if (rel === null) return null;
    const blob = readBytes(body, base + 32 + Number(rel));
    if (blob === null) return null;
    inputs.push(blob);
  }
  if (inputs.length !== commands.length) return null;
  return { commands, inputs, deadline };
}

/** The (token, recipient, value) of a TRANSFER input, or null. */
export function decodeTransferInput(input: string): { token: string; recipient: string; value: bigint } | null {
  if (input.length < 192) return null;
  const tok = input.slice(0, 64);
  const rec = input.slice(64, 128);
  const val = input.slice(128, 192);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(tok) || !/^0{24}[0-9a-fA-F]{40}$/.test(rec) || !/^[0-9a-fA-F]{64}$/.test(val)) return null;
  return { token: `0x${tok.slice(24)}`, recipient: `0x${rec.slice(24)}`, value: BigInt(`0x${val}`) };
}

/** Does this router call pay at least `minWei` of native ETH to `treasury`? */
export function carriesFeeLeg(data: Hex, treasury: string, minWei: bigint): boolean {
  const d = decodeExecute(data);
  if (!d) return false;
  let paid = 0n;
  d.commands.forEach((cmd, i) => {
    // The top bit of a command byte is the "allow revert" flag; mask it.
    if ((cmd & 0x3f) !== UR_TRANSFER_COMMAND) return;
    const t = decodeTransferInput(d.inputs[i]);
    if (!t) return;
    if (t.token.toLowerCase() !== NATIVE || t.recipient.toLowerCase() !== treasury.toLowerCase()) return;
    paid += t.value;
  });
  return paid >= minWei && minWei > 0n;
}

export interface PolicyVerdict {
  ok: boolean;
  message: string;
}

export const APPROVE_SELECTOR: Hex = '0x095ea7b3';
export const PERMIT2_APPROVE_SELECTOR: Hex = '0x87517c45';

/** Sensible ceilings. A curve buy is ~105k gas, a router swap ~165k; a
 *  million leaves room for a pathological pool and still cannot burn a
 *  meaningful amount at this chain's fee level. */
export const DEFAULT_MAX_GAS = 1_500_000n;
/** 50 gwei — 200× the base fee measured during the 90-day subsidy; a cap,
 *  not an expectation. */
export const DEFAULT_MAX_FEE_PER_GAS = 50_000_000_000n;

/**
 * Exit ceilings. Deliberately loose per field, because an exit must survive a
 * gas spike — Robinhood's subsidy ends 2026-09-29, and a 50 gwei cap is only
 * 200x a subsidised base fee. The binding limit on a sell is
 * SELL_MAX_GAS_COST_WEI instead: 0.02 native is far above any real swap
 * (a curve sell is ~105k gas) and far below an amount worth stealing.
 */
export const SELL_MAX_GAS = 3_000_000n;
export const SELL_MAX_FEE_PER_GAS = 2_000_000_000_000n; // 2,000 gwei
export const SELL_MAX_GAS_COST_WEI = 20_000_000_000_000_000n; // 0.02 native

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function selectorOf(data: Hex): Hex | null {
  if (typeof data !== 'string' || !data.startsWith('0x')) return null;
  if (data.length < 10) return null;
  return data.slice(0, 10).toLowerCase() as Hex;
}

/** The address in ABI word `index` of the calldata, or null. */
export function wordAddress(data: Hex, index: number): string | null {
  const start = 10 + index * 64;
  if (data.length < start + 64) return null;
  const word = data.slice(start, start + 64);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) return null;
  return `0x${word.slice(24)}`;
}

/** Spender named by `approve(address spender, uint256 amount)`. */
export function decodeApproveSpender(data: Hex): string | null {
  return selectorOf(data) === APPROVE_SELECTOR ? wordAddress(data, 0) : null;
}

/** Spender named by Permit2 `approve(address token, address spender, uint160, uint48)`. */
export function decodePermit2Spender(data: Hex): string | null {
  return selectorOf(data) === PERMIT2_APPROVE_SELECTOR ? wordAddress(data, 1) : null;
}

/** A 32-byte word as a bigint, or null when the call data is too short. */
export function wordUint(data: Hex, index: number): bigint | null {
  const start = 10 + index * 64;
  if (data.length < start + 64) return null;
  const word = data.slice(start, start + 64);
  if (!/^[0-9a-fA-F]{64}$/.test(word)) return null;
  return BigInt(`0x${word}`);
}

/**
 * True when this call SURRENDERS an approval rather than granting one.
 *
 * An allowance of zero conveys no authority to anyone, so the spender does not
 * matter — which is what makes this a safe exception to the spender allowlist
 * rather than a hole in it. It exists so the app can revoke approvals it did
 * not itself create: a user accumulates standing allowances from every site
 * they have ever used, LI.FI lost $11.6M in 2024 to wallets holding infinite
 * ones (some granted 28 months earlier), and the obvious workaround — sending
 * people to a revocation website — is what drainers impersonate within hours
 * of any incident. So revocation has to be possible in here.
 *
 * Deliberately narrow: ONLY an amount of exactly zero, only on the two approve
 * selectors, and it still cannot carry ETH. `approve(spender, 1)` is a grant
 * and stays refused.
 */
export function isApprovalSurrender(data: Hex): boolean {
  const sel = selectorOf(data);
  if (sel === APPROVE_SELECTOR) return wordUint(data, 1) === 0n;
  // Permit2 approve(token, spender, uint160 amount, uint48 expiration)
  if (sel === PERMIT2_APPROVE_SELECTOR) return wordUint(data, 2) === 0n;
  return false;
}

export function checkEvmTx(tx: EvmTxLike, policy: EvmPolicy): PolicyVerdict {
  if (tx.chainId !== policy.chainId) {
    return { ok: false, message: `Transaction is for chain ${tx.chainId}, not ${policy.chainId} — refusing to sign` };
  }
  if (typeof tx.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
    return { ok: false, message: 'Transaction has no valid recipient — refusing to sign' };
  }
  if (tx.gas <= 0n || tx.gas > policy.maxGas) {
    return { ok: false, message: `Gas limit ${tx.gas} is outside the allowed range (max ${policy.maxGas})` };
  }
  if (tx.maxFeePerGas <= 0n || tx.maxFeePerGas > policy.maxFeePerGasWei) {
    return { ok: false, message: `Fee cap ${tx.maxFeePerGas} wei/gas exceeds the policy ceiling` };
  }
  if (policy.maxGasCostWei !== undefined && tx.gas * tx.maxFeePerGas > policy.maxGasCostWei) {
    return {
      ok: false,
      message: `Worst-case gas cost ${tx.gas * tx.maxFeePerGas} wei exceeds the ${policy.maxGasCostWei} wei this trade allows`,
    };
  }
  if (tx.value < 0n) return { ok: false, message: 'Negative value' };

  const entry = policy.allow.find((a) => eq(a.to, tx.to));
  if (!entry) return { ok: false, message: `Transaction targets ${tx.to}, which this trade did not name — refusing to sign` };
  if (tx.value > entry.maxValueWei) {
    return { ok: false, message: `Transaction attaches ${tx.value} wei; this trade allows at most ${entry.maxValueWei}` };
  }

  const data = (tx.data ?? '0x') as Hex;
  if (entry.selectors === 'transfer') {
    // An allowlist says exactly what it accepts: a plain value transfer is
    // `0x`, nothing else (not even one zero byte).
    if (data !== '0x') {
      return { ok: false, message: 'A fee transfer must carry no calldata' };
    }
    return { ok: true, message: 'ok' };
  }

  const sel = selectorOf(data);
  if (!sel) return { ok: false, message: 'Call has no function selector' };
  if (!entry.selectors.some((s) => eq(s, sel))) {
    return { ok: false, message: `Function ${sel} is not allowed on ${tx.to} for this trade` };
  }

  // Setting an allowance to ZERO is a surrender, not a grant: it names a
  // spender but conveys nothing to them, so the spender allowlist does not
  // apply. Without this the app could never revoke an approval a user picked
  // up somewhere else, and the only alternative is advice that sends them to a
  // revocation site — which is precisely what drainers impersonate.
  const surrender = isApprovalSurrender(data);
  if (sel === APPROVE_SELECTOR && !surrender) {
    const spender = decodeApproveSpender(data);
    if (!spender || !policy.approveSpenders.some((s) => eq(s, spender))) {
      return { ok: false, message: `Token approval names spender ${spender ?? '?'}, which is not Permit2 or the router — refusing` };
    }
  }
  if (sel === PERMIT2_APPROVE_SELECTOR && !surrender) {
    const spender = decodePermit2Spender(data);
    if (!spender || !policy.permit2Spenders.some((s) => eq(s, spender))) {
      return { ok: false, message: `Permit2 approval names spender ${spender ?? '?'}, which is not the router — refusing` };
    }
  }
  // A revocation carries no value either — that rule holds for both shapes.
  if ((sel === APPROVE_SELECTOR || sel === PERMIT2_APPROVE_SELECTOR) && tx.value !== 0n) {
    return { ok: false, message: 'An approval must not carry ETH' };
  }
  if (policy.requireFeeLeg) {
    // The interlock: a buy was planned WITH a fee, so the bytes must carry it.
    // A router call with the fee stripped, pointed elsewhere or shaved is a
    // cracked build's buy, and it does not get signed.
    const leg = policy.requireFeeLeg;
    const refused = { ok: false, message: 'Buy is missing its platform fee leg — refusing to sign' };
    if (leg.via === 'curve-router') {
      if (sel !== KRYPT_ROUTER_BUY_SELECTOR) return refused;
      if (!carriesRouterFee(data, leg.minWei)) return refused;
      // The contract insists on msg.value == quoteIn + feeWei; a mismatch
      // reverts on chain, but refusing here keeps a shaved value from even
      // being signed.
      const f = decodeRouterBuyFee(data)!;
      if (tx.value !== f.quoteIn + f.feeWei) return { ok: false, message: 'Buy value does not cover the amount plus its fee — refusing to sign' };
    } else {
      if (sel !== EXECUTE_SELECTOR) return refused;
      if (!carriesFeeLeg(data, leg.treasury, leg.minWei)) return refused;
    }
  }
  return { ok: true, message: 'ok' };
}
