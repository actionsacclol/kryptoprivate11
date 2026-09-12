// $KRYPTO — Krypt's own token, shown on the Hub.
//
// The mint is pinned HERE, in the bundle, never fetched: the Hub's buy button
// points wherever this says, and a buy target that arrived over the network
// (the update manifest is TLS-only and unsigned) would be one CDN or DNS
// swap away from sending every user to a look-alike. Pinned in code it is
// covered by the same tamper layers as the treasury address.
//
// While `mint` is null the card does not render at all, so the build can
// ship before the launch and the launch can slip without a stale link.
//
// Honesty rules for the card, because this is the one place the app shows a
// token its maker has a stake in: it says who issued it, that showing it is
// not a recommendation, and what the issuer earns from it. Its numbers come
// from the same market summary every other token gets — nothing is scored
// or ranked differently for being ours, and the Wallet Scout already keeps
// the user's own wallets (the launch wallet included) off its board.

/** Solana mint, 32–44 base58 characters. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface KryptoToken {
  /** Null until the token exists. Set once, from the launch, then shipped. */
  mint: string | null;
  symbol: string;
  name: string;
  chain: 'solana';
}

/**
 * Verified 2026-09-12 against pump.fun's coin record and the chain before it
 * was pinned: name "Krypto Bot", ticker KRYPTO, created 2026-09-12 09:38:39
 * UTC by Ff4Mw51MqPt6wgcY1TsLFdHp94Cqx9Bris9EapMyvNkm; a Token-2022 mint,
 * 6 decimals, 1,000,000,000 supply, mint authority revoked; bonding curve
 * B51N7SrnxnwX36nuLJRdyAXdohAudABXu8Q7DhTdoxC4.
 */
export const KRYPTO_TOKEN: KryptoToken = {
  mint: '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump',
  symbol: 'KRYPTO',
  name: 'Krypto Bot',
  chain: 'solana',
};

export function isValidMint(mint: string | null): mint is string {
  return typeof mint === 'string' && MINT_RE.test(mint);
}

/** The card renders only for a real, well-formed mint. */
export function kryptoTokenLive(): boolean {
  return isValidMint(KRYPTO_TOKEN.mint);
}

export function kryptoPumpUrl(mint: string): string {
  return `https://pump.fun/coin/${mint}`;
}

/**
 * Shown under the card, always. Every clause is a fact about the issuer:
 * who made it, that this is not a recommendation, and how the issuer earns
 * from it. Edit `LAUNCH_HOLDING` to the share the launch wallet actually
 * bought, once it has.
 */
/** The creator's first buy, read from the launch trades: 0.464 SOL for
 *  16,349,813.52 of 1,000,000,000 tokens (2026-09-12 09:38:39 UTC). */
export const KRYPTO_LAUNCH_HOLDING: string | null = '1.6%';

export function kryptoDisclosure(): string {
  const holding = KRYPTO_LAUNCH_HOLDING ? ` Krypt's launch wallet bought ${KRYPTO_LAUNCH_HOLDING} of the supply at launch.` : '';
  return (
    `$${KRYPTO_TOKEN.symbol} is issued by Krypt, the maker of this app. Showing it here is not a recommendation to buy, sell or hold it, ` +
    `and nothing in this app is financial advice. Krypt earns pump.fun creator fees on every trade of it.${holding} ` +
    `It is a memecoin: it can go to zero.`
  );
}
