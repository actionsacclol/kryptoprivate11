// Send on BNB Smart Chain / Robinhood Chain — the coin (BNB / ETH) or any
// ERC-20, to an address the user typed (2026-10-03). The EVM twin of
// engine/send.ts; see shared/send.ts for why it exists.
//
// plan() reads and decides; execute() builds exactly that plan and hands it
// to the trade path's own sender (sendBuilt: per-chain ordering, the gas
// estimate as a simulation, "value + gas" checked before signing, the policy
// gate inside the signer, the receipt wait). The policy names ONE target: the
// recipient for a coin send, or the token for a token send — and then
// `tokenTransfer` pins the recipient and amount inside the calldata.

import { getAddress, type Address, type Hex } from 'viem';
import { client, feeFields } from './client';
import { CHAINS } from './chains';
import * as evmWallet from './evmWallet';
import { sendBuilt } from './trade';
import { DEFAULT_MAX_FEE_PER_GAS, DEFAULT_MAX_GAS, ERC20_TRANSFER_SELECTOR, type EvmPolicy } from './policy';
import { EVM_CHAIN_META, explorerTx, type EvmChainKind } from '@shared/evm';
import { formatUnits, parseUnits, type SendRequest, type SendResult, type SendReview } from '@shared/send';

const ERC20_READ_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface EvmSendPlan {
  chain: EvmChainKind;
  owner: Address;
  to: Address;
  token: Address | null;
  amount: bigint;
  review: SendReview;
}

type Planned = { ok: true; plan: EvmSendPlan } | { ok: false; message: string };

/** A checksummed address, or null. A mixed-case address whose checksum is
 *  wrong is a typo, not a different address — refused. */
function addressOf(s: string): Address | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  try {
    const sum = getAddress(s);
    const mixed = s.slice(2) !== s.slice(2).toLowerCase() && s.slice(2) !== s.slice(2).toUpperCase();
    if (mixed && sum !== s) return null;
    return sum as Address;
  } catch {
    return null;
  }
}

export function transferCalldata(to: Address, amount: bigint): Hex {
  return `${ERC20_TRANSFER_SELECTOR}${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` as Hex;
}

export async function plan(chain: EvmChainKind, req: SendRequest): Promise<Planned> {
  const sym = EVM_CHAIN_META[chain].nativeSymbol;
  const name = EVM_CHAIN_META[chain].name;
  const owner = evmWallet.address(chain);
  if (!owner) return { ok: false, message: `No ${name} wallet.` };
  const to = addressOf(req.to);
  if (!to) return { ok: false, message: `That is not a valid ${name} address (check for a typo — the capital letters are a checksum).` };
  if (to.toLowerCase() === owner.toLowerCase()) return { ok: false, message: 'That is this wallet’s own address.' };
  const c = client(chain);
  const warnings: string[] = [];

  let code: Hex | undefined;
  let bal: bigint;
  let fees: Awaited<ReturnType<typeof feeFields>>;
  try {
    [code, bal, fees] = await Promise.all([c.getCode({ address: to }), c.getBalance({ address: owner }), feeFields(chain)]);
  } catch (e) {
    return { ok: false, message: `Could not reach ${name}: ${(e as Error).message.slice(0, 160)}` };
  }
  const isContract = !!code && code !== '0x';
  if (isContract) warnings.push('This address is a smart contract, not a plain wallet. Send only if you know it accepts this (a smart wallet or an exchange’s contract).');
  const gasText = (gas: bigint): string => `up to ${formatUnits(gas * fees.maxFeePerGas, 18, 6)} ${sym}`;

  // ── The chain's coin ────────────────────────────────────────────────
  if (req.token === null) {
    // Checked first: the probe below fails on an empty wallet too, and that
    // must not read as "the address refused it".
    if (bal <= 0n) return { ok: false, message: `This wallet has no ${sym} to send.` };
    let est: bigint;
    try {
      est = await c.estimateGas({ account: owner, to, value: 1n });
    } catch {
      return { ok: false, message: `That address does not accept ${sym} — its contract refused a test transfer.` };
    }
    // The same padding the sender applies, plus 20 % on the fee for a base fee
    // that rises between this read and the send.
    const gas = (est * 125n) / 100n + 10_000n;
    const reserve = (gas * fees.maxFeePerGas * 12n) / 10n;
    const max = bal > reserve ? bal - reserve : 0n;
    const amount = req.amount === 'max' ? max : parseUnits(req.amount, 18);
    if (amount === null || amount <= 0n) return { ok: false, message: max <= 0n ? `This wallet has no ${sym} to send beyond the gas.` : 'Enter an amount.' };
    if (amount > max) return { ok: false, message: `That is more than this wallet can send — at most ${formatUnits(max, 18, 6)} ${sym} once gas is paid.` };
    return {
      ok: true,
      plan: {
        chain,
        owner,
        to,
        token: null,
        amount,
        review: {
          chain, from: owner, to, token: null, symbol: sym, decimals: 18,
          amountRaw: amount.toString(), amountText: `${formatUnits(amount, 18)} ${sym}`,
          networkFeeText: gasText(gas), extraCostText: null, warnings,
        },
      },
    };
  }

  // ── A token ─────────────────────────────────────────────────────────
  const token = addressOf(req.token);
  if (!token) return { ok: false, message: 'That is not a token address.' };
  if (token.toLowerCase() === to.toLowerCase()) return { ok: false, message: 'That is the token’s own contract — tokens sent there are lost for good.' };
  let decimals: number;
  let symbol: string;
  let held: bigint;
  try {
    const [d, s, h] = await Promise.all([
      c.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'decimals' }),
      c.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'symbol' }).catch(() => ''),
      c.readContract({ address: token, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [owner] }),
    ]);
    decimals = Number(d);
    symbol = String(s).trim().slice(0, 16) || `${token.slice(0, 6)}…`;
    held = h as bigint;
  } catch {
    // Decimals unknown = the amount is unknowable (×10^12 apart): refuse, never guess 18.
    return { ok: false, message: 'Could not read this token’s details — nothing to send.' };
  }
  if (!(decimals >= 0 && decimals <= 36)) return { ok: false, message: 'This token reports nonsense decimals — refusing to send it.' };
  if (held <= 0n) return { ok: false, message: `This wallet holds no ${symbol}.` };
  const amount = req.amount === 'max' ? held : parseUnits(req.amount, decimals);
  if (amount === null || amount <= 0n) return { ok: false, message: 'Enter an amount.' };
  if (amount > held) return { ok: false, message: `That is more than the ${formatUnits(held, decimals)} ${symbol} this wallet holds.` };
  let est: bigint;
  try {
    est = await c.estimateGas({ account: owner, to: token, data: transferCalldata(to, amount), value: 0n });
  } catch (e) {
    return { ok: false, message: `The token refused this transfer: ${(e as Error).message.split('\n')[0]?.slice(0, 160)}` };
  }
  const gas = (est * 125n) / 100n + 10_000n;
  if (gas * fees.maxFeePerGas > bal) {
    return { ok: false, message: `Not enough ${sym} for gas: it needs ${gasText(gas).replace('up to ', '')} and the wallet has ${formatUnits(bal, 18, 6)}.` };
  }
  return {
    ok: true,
    plan: {
      chain,
      owner,
      to,
      token,
      amount,
      review: {
        chain, from: owner, to, token, symbol, decimals,
        amountRaw: amount.toString(), amountText: `${formatUnits(amount, decimals)} ${symbol}`,
        networkFeeText: gasText(gas), extraCostText: null, warnings,
      },
    },
  };
}

/** Send a plan. Call only after the user confirmed it in the native dialog. */
export async function execute(p: EvmSendPlan): Promise<SendResult> {
  const { chain, owner, to, token, amount } = p;
  if (evmWallet.address(chain)?.toLowerCase() !== owner.toLowerCase()) {
    return { ok: false, message: 'The active wallet changed — nothing was sent.', txid: null, explorerUrl: null };
  }
  const policy: EvmPolicy = {
    chainId: CHAINS[chain].viem.id,
    intent: 'send',
    allow: token
      ? [{ to: token, selectors: [ERC20_TRANSFER_SELECTOR], maxValueWei: 0n }]
      : [{ to, selectors: 'transfer', maxValueWei: amount }],
    maxGas: DEFAULT_MAX_GAS,
    maxFeePerGasWei: DEFAULT_MAX_FEE_PER_GAS,
    approveSpenders: [],
    permit2Spenders: [],
    ...(token ? { tokenTransfer: { token, to, maxAmount: amount } } : {}),
  };
  const call = token ? { to: token, data: transferCalldata(to, amount), value: 0n } : { to, data: '0x' as Hex, value: amount };
  const out = await sendBuilt(chain, owner, call, policy, { simulateOnly: false, wait: true });
  const url = out.hash ? explorerTx(chain, out.hash) : null;
  if (!out.ok) return { ok: false, message: out.message, txid: out.hash, explorerUrl: url };
  return { ok: true, message: `Sent ${p.review.amountText}`, txid: out.hash, explorerUrl: url };
}
