// Creating a token on Robinhood Chain, through Pons.
//
// `pons.buildLaunch` encodes the call and `test/ponslaunch.test.mjs` pins it
// against a real launch byte for byte. This is the send half: the policy that
// bounds it, the wallet it signs from, and reading the new token's address
// back out of the receipt.
//
// ─── One call does both halves here ──────────────────────────────────────
//
// Pons's router exposes `launchAndBuy`, so on this chain the create and the
// creator's first buy are ONE transaction and nobody can buy in between. That
// is not true on Solana (see launchSolana.ts), and the Launch page says which
// is which rather than implying they behave alike.
//
// ─── What the policy allows ──────────────────────────────────────────────
//
// Exactly one target (Pons's launch router), exactly one selector
// (`launchAndBuy`), and a value ceiling of precisely what this launch costs:
// the first buy plus the router's flat fee. A launch cannot become a transfer,
// cannot become an approval, and cannot spend a wei more than the number the
// user saw.

import type { Address, Hex } from 'viem';
import { ADDR, PONS_LAUNCH_FEE_WEI, TOPIC } from './chain';
import { CHAINS } from './chains';
import * as pons from './pons';
import * as evmWallet from './evmWallet';
import { chargeLaunchFee, sendBuilt } from './trade';
import { logger } from '../system/logger';
import type { EvmPolicy } from './policy';

/** `launchAndBuy(( … ),uint256,address,uint256,uint256,address,address[])`. */
const LAUNCH_SELECTOR: Hex = '0xf85f8e41';

/**
 * Gas bounds for a launch.
 *
 * A create deploys a token and a curve, so it is an order of magnitude more
 * gas than a buy — 3.66 M estimated against the live chain and 3.73 M used
 * by the real launch the fixture is built from (2026-09-11). The product
 * bound is what actually protects the wallet; the per-field ceilings are
 * sanity bounds, generous enough that a busy block does not refuse a launch
 * the user already paid to prepare.
 */
const LAUNCH_MAX_GAS = 6_000_000n;
const LAUNCH_MAX_FEE_PER_GAS = 100_000_000_000n; // 100 gwei
/** 0.01 native, worst case, on gas alone. */
const LAUNCH_MAX_GAS_COST_WEI = 10_000_000_000_000_000n;

export interface LaunchEvmRequest {
  /** The EVM wallet the Launch page named. Never the active trading wallet. */
  walletId: string;
  name: string;
  symbol: string;
  /** Pinned image URL. Pons stores this on the token itself. */
  image: string;
  website: string;
  twitter: string;
  telegram: string;
  /** Wei for the creator's own first buy, in the same transaction. */
  quoteInWei: bigint;
  /** Creator fee, basis points, paid to the launch wallet. */
  creatorTaxBps: number;
  /** Referrer address from onboarding; paid their share of the platform fee. */
  referrer: string;
}

export interface LaunchEvmResult {
  ok: boolean;
  message: string;
  /** The new token's address, read from the receipt. */
  token?: string;
  hash?: string;
  /** The platform fee transfer on the creator's own buy, when one was due. */
  feeHash?: string;
}

/**
 * 32 bytes of randomness feeding the token's CREATE2 address.
 *
 * From the OS CSPRNG rather than Math.random: the salt decides the deployed
 * address, and a predictable one lets somebody else deploy to it first and
 * make the user's launch revert.
 */
function salt(): Hex {
  return `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as Hex;
}

function policyFor(valueWei: bigint): EvmPolicy {
  return {
    chainId: CHAINS.robinhood.viem.id,
    intent: 'launch',
    allow: [{ to: ADDR.ponsLaunchRouter, selectors: [LAUNCH_SELECTOR], maxValueWei: valueWei }],
    maxGas: LAUNCH_MAX_GAS,
    maxFeePerGasWei: LAUNCH_MAX_FEE_PER_GAS,
    maxGasCostWei: LAUNCH_MAX_GAS_COST_WEI,
    approveSpenders: [],
    permit2Spenders: [],
  };
}

/** The token Pons just created, from the factory's own event. */
function tokenFromReceipt(logs: ReadonlyArray<{ address: string; topics: readonly string[] }>): string | null {
  for (const l of logs) {
    if (l.topics[0] !== TOPIC.tokenLaunched) continue;
    // TokenLaunched(address indexed token, address indexed curve, …)
    const t = l.topics[1];
    if (typeof t === 'string' && t.length === 66) return `0x${t.slice(26)}`.toLowerCase();
  }
  return null;
}

/**
 * Build, simulate, sign and send a Pons launch.
 *
 * `simulateOnly` stops before the broadcast: the gas estimate IS the
 * simulation on an EVM chain, so a successful dry run means the chain executed
 * this launch against current state and it worked.
 */
export async function launchEvm(req: LaunchEvmRequest, simulateOnly: boolean): Promise<LaunchEvmResult> {
  const creator = evmWallet.addressOfWallet(req.walletId);
  if (!creator) return { ok: false, message: 'The launch wallet no longer exists. Pick one on the Launch page.' };

  const build: pons.PonsLaunchRequest = {
    name: req.name,
    symbol: req.symbol,
    image: req.image,
    website: req.website,
    twitter: req.twitter,
    telegram: req.telegram,
    quoteIn: req.quoteInWei,
    // The curve's price at launch is fixed and the transaction is the first
    // one against it, so there is nothing to slip against. Pons's own
    // interface sends 0 here.
    minTokensOut: 0n,
    creatorTaxBps: req.creatorTaxBps,
    creator: creator as Address,
    salt: salt(),
  };
  const call = pons.buildLaunch(build);
  const policy = policyFor(req.quoteInWei + PONS_LAUNCH_FEE_WEI);

  const out = await sendBuilt('robinhood', creator as Address, call, policy, {
    simulateOnly,
    wait: !simulateOnly,
    walletId: req.walletId,
  });
  if (!out.ok) {
    logger.warn(`pons launch failed: ${out.message}`);
    return { ok: false, message: out.message, hash: out.hash ?? undefined };
  }
  if (simulateOnly) return { ok: true, message: 'The chain accepts this launch.' };

  const token = out.receipt ? tokenFromReceipt(out.receipt.logs) : null;
  if (out.hash) logger.info(`launch: pons launch ${token ?? 'unknown token'} in ${out.hash}`);

  // The creator's own buy is billed like any other buy. The basis is what was
  // sent rather than a receipt reading: this is the FIRST trade against a
  // brand-new curve, so there is nothing for it to be clamped against.
  const feeHash = await chargeLaunchFee('robinhood', req.walletId, creator as Address, req.quoteInWei, req.referrer);
  // The transaction confirmed; a missing event is a decoding problem, not a
  // failed launch, and saying "it failed" here would send someone to launch a
  // second token they already own.
  return {
    ok: true,
    message: token
      ? 'Launched.'
      : 'Launched, but the new token could not be read from the receipt — find it by the transaction hash.',
    token: token ?? undefined,
    hash: out.hash ?? undefined,
    feeHash: feeHash ?? undefined,
  };
}
