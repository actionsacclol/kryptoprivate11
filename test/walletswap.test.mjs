// The DEX-agnostic swap decoder behind copy trading (walletSwap.ts). Each
// rule in its header has a case here, on hand-built transactions shaped
// like the RPC's `getTransaction` reply.
import assert from 'node:assert';
import { decodeWalletSwap, WSOL_MINT } from './.walletswap.mjs';

const W = 'Wallet1111111111111111111111111111111111111';
const OTHER = 'Other111111111111111111111111111111111111111';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const RAY = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const MINT_A = 'MintA111111111111111111111111111111111111111';
const MINT_B = 'MintB111111111111111111111111111111111111111';
const SOL = 1_000_000_000;

/** A transaction where `keys[0]` is the fee payer and the only signer
 *  unless `signers` says otherwise. Balances are lamports; token entries are
 *  { mint, owner, amount (raw string), decimals }. */
function tx({ keys, signers = 1, pre, post, fee = 5000, preTok = [], postTok = [], err = null, programs = [] }) {
  const entry = (t, i) => ({ accountIndex: 10 + i, mint: t.mint, owner: t.owner, uiTokenAmount: { amount: t.amount, decimals: t.decimals, uiAmount: null } });
  return {
    meta: {
      err,
      fee,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: preTok.map(entry),
      postTokenBalances: postTok.map(entry),
      innerInstructions: [],
    },
    transaction: {
      message: {
        accountKeys: keys,
        header: { numRequiredSignatures: signers, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
        instructions: programs.map((p) => ({ programIdIndex: keys.indexOf(p), accounts: [], data: '' })),
      },
    },
  };
}

let passed = 0;
let ran = 0;
const test = (name, fn) => {
  ran++;
  try {
    fn();
    console.log(`ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
};

test('a one-sided LIQUIDITY ADD is not a buy — the position NFT has no market', () => {
  // From balance deltas an LP add is indistinguishable from a buy: SOL out,
  // one token in. That token is a position NFT — zero decimals, quantity one.
  // Copied live, the follower would try to buy an untradeable mint and the
  // leader's record would open a round trip that can never close. The
  // MIN_BUY_SOL floor does not catch it: a real add is far above it.
  const t = tx({
    keys: [W, RAY, MINT_A],
    pre: [10 * SOL, 0, 0],
    post: [10 * SOL - 2 * SOL - 5000, 0, 0],
    preTok: [],
    postTok: [{ mint: MINT_A, owner: W, amount: '1', decimals: 0 }],
    programs: [RAY],
  });
  assert.equal(decodeWalletSwap(t, W), null, 'two SOL into a position NFT is not a purchase');
});

test('a one-sided liquidity WITHDRAW is not a sell either', () => {
  // Position NFT out, SOL in. Sells are ungated so a real exit is never
  // missed — but a follower cannot hold the leader's position NFT, so this is
  // a phantom exit, not one worth mirroring.
  const t = tx({
    keys: [W, RAY, MINT_A],
    pre: [10 * SOL, 0, 0],
    post: [10 * SOL + 2 * SOL - 5000, 0, 0],
    preTok: [{ mint: MINT_A, owner: W, amount: '1', decimals: 0 }],
    postTok: [],
    programs: [RAY],
  });
  assert.equal(decodeWalletSwap(t, W), null, 'pulling liquidity is not a sale');
});

test('a real 0-decimal token purchase of more than one unit still decodes', () => {
  // The guard must be exactly "one indivisible unit", not "zero decimals" —
  // otherwise a legitimate 0-decimal token trade would vanish.
  const t = tx({
    keys: [W, JUP, MINT_B],
    pre: [10 * SOL, 0, 0],
    post: [10 * SOL - 0.5 * SOL - 5000, 0, 0],
    preTok: [],
    postTok: [{ mint: MINT_B, owner: W, amount: '250', decimals: 0 }],
    programs: [JUP],
  });
  const s = decodeWalletSwap(t, W);
  assert.ok(s, 'decoded');
  assert.equal(s.isBuy, true);
  assert.equal(s.tokens, 250);
});

test('a Jupiter-routed buy: SOL out, one token in, priced net of the fee', () => {
  const t = tx({
    keys: [W, JUP, RAY, MINT_A],
    pre: [10 * SOL, 0, 0, 0],
    post: [10 * SOL - 0.6 * SOL - 5000, 0, 0, 0],
    preTok: [],
    postTok: [{ mint: MINT_A, owner: W, amount: '1000000000', decimals: 6 }],
    programs: [JUP],
  });
  const s = decodeWalletSwap(t, W);
  assert.ok(s, 'decoded');
  assert.equal(s.isBuy, true);
  assert.equal(s.mint, MINT_A);
  assert.ok(Math.abs(s.sol - 0.6) < 1e-12, `0.6 SOL paid, fee excluded: ${s.sol}`);
  assert.equal(s.tokens, 1000);
  assert.ok(Math.abs(s.priceSol - 0.0006) < 1e-15);
  assert.equal(s.decimals, 6);
  assert.deepEqual(s.programs, [JUP]);
});

test('a sell: one token out, SOL in', () => {
  const t = tx({
    keys: [W, RAY, MINT_A],
    pre: [2 * SOL, 0, 0],
    post: [2 * SOL + 0.5 * SOL - 5000, 0, 0],
    preTok: [{ mint: MINT_A, owner: W, amount: '1000000000', decimals: 6 }],
    postTok: [{ mint: MINT_A, owner: W, amount: '0', decimals: 6 }],
    programs: [RAY],
  });
  const s = decodeWalletSwap(t, W);
  assert.ok(s);
  assert.equal(s.isBuy, false);
  assert.ok(Math.abs(s.sol - 0.5) < 1e-12);
  assert.equal(s.tokens, 1000);
});

test('wrapped SOL counts as SOL', () => {
  // Lamports only move by the fee; the 0.3 SOL leaves via a wSOL account.
  const t = tx({
    keys: [W, JUP, MINT_B],
    pre: [SOL, 0, 0],
    post: [SOL - 5000, 0, 0],
    preTok: [{ mint: WSOL_MINT, owner: W, amount: '300000000', decimals: 9 }],
    postTok: [
      { mint: WSOL_MINT, owner: W, amount: '0', decimals: 9 },
      { mint: MINT_B, owner: W, amount: '5000000', decimals: 4 },
    ],
  });
  const s = decodeWalletSwap(t, W);
  assert.ok(s);
  assert.equal(s.isBuy, true);
  assert.equal(s.mint, MINT_B);
  assert.ok(Math.abs(s.sol - 0.3) < 1e-12, `wSOL leg: ${s.sol}`);
  assert.equal(s.tokens, 500);
});

test('a transfer is not a swap: SOL alone, or a token alone', () => {
  const solOnly = tx({ keys: [W, OTHER], pre: [SOL, 0], post: [SOL - 0.2 * SOL - 5000, 0.2 * SOL] });
  assert.equal(decodeWalletSwap(solOnly, W), null);
  const tokenOnly = tx({
    keys: [W, OTHER, MINT_A],
    pre: [SOL, 0, 0],
    post: [SOL - 5000, 0, 0],
    preTok: [{ mint: MINT_A, owner: W, amount: '500', decimals: 0 }],
    postTok: [{ mint: MINT_A, owner: W, amount: '0', decimals: 0 }],
  });
  assert.equal(decodeWalletSwap(tokenOnly, W), null);
});

test("someone else's transaction that touches the wallet is not its trade", () => {
  // The wallet is at index 2, past the one required signer.
  const t = tx({
    keys: [OTHER, JUP, W, MINT_A],
    signers: 1,
    pre: [SOL, 0, SOL, 0],
    post: [SOL - 5000, 0, SOL - 0.5 * SOL, 0],
    postTok: [{ mint: MINT_A, owner: W, amount: '1000000', decimals: 6 }],
  });
  assert.equal(decodeWalletSwap(t, W), null);
  // The same shape with the wallet as a co-signer IS its trade.
  const signed = tx({
    keys: [OTHER, W, JUP, MINT_A],
    signers: 2,
    pre: [SOL, SOL, 0, 0],
    post: [SOL - 5000, SOL - 0.5 * SOL, 0, 0],
    postTok: [{ mint: MINT_A, owner: W, amount: '1000000', decimals: 6 }],
  });
  const s = decodeWalletSwap(signed, W);
  assert.ok(s && s.isBuy);
  assert.ok(Math.abs(s.sol - 0.5) < 1e-12, 'a co-signer did not pay the fee, so none is put back');
});

test('a failed transaction is nothing', () => {
  const t = tx({
    keys: [W, JUP, MINT_A],
    pre: [SOL, 0, 0],
    post: [SOL - 5000, 0, 0],
    postTok: [{ mint: MINT_A, owner: W, amount: '1000000', decimals: 6 }],
    err: { InstructionError: [2, { Custom: 6001 }] },
  });
  assert.equal(decodeWalletSwap(t, W), null);
});

test('token-for-token is not a SOL-priced swap', () => {
  const t = tx({
    keys: [W, JUP, MINT_A, MINT_B],
    pre: [SOL, 0, 0, 0],
    post: [SOL - 5000 - 100_000, 0, 0, 0],
    preTok: [{ mint: MINT_A, owner: W, amount: '100000000', decimals: 6 }],
    postTok: [
      { mint: MINT_A, owner: W, amount: '0', decimals: 6 },
      { mint: MINT_B, owner: W, amount: '200000000', decimals: 6 },
    ],
  });
  assert.equal(decodeWalletSwap(t, W), null);
});

test('dust is ignored', () => {
  const t = tx({
    keys: [W, JUP, MINT_A],
    pre: [SOL, 0, 0],
    post: [SOL - 5000 - 100_000, 0, 0],
    postTok: [{ mint: MINT_A, owner: W, amount: '1', decimals: 0 }],
  });
  assert.equal(decodeWalletSwap(t, W), null);
});

test("another owner's token accounts in the same transaction are not counted", () => {
  const t = tx({
    keys: [W, JUP, MINT_A],
    pre: [SOL, 0, 0],
    post: [SOL - 0.4 * SOL - 5000, 0, 0],
    postTok: [
      { mint: MINT_A, owner: W, amount: '1000000', decimals: 6 },
      { mint: MINT_A, owner: OTHER, amount: '999000000', decimals: 6 },
    ],
  });
  const s = decodeWalletSwap(t, W);
  assert.ok(s);
  assert.equal(s.tokens, 1, 'only the wallet-owned account moved for it');
});

test('a sell reports the share of the holding that went out — what a copier mirrors', () => {
  // Held 1,000 tokens across two accounts, sold 400 of them: 40 %.
  const t = tx({
    keys: [W, JUP, MINT_A],
    pre: [SOL, 0, 0],
    post: [SOL + 0.4 * SOL - 5000, 0, 0],
    preTok: [
      { mint: MINT_A, owner: W, amount: '700000000', decimals: 6 },
      { mint: MINT_A, owner: W, amount: '300000000', decimals: 6 },
    ],
    postTok: [
      { mint: MINT_A, owner: W, amount: '300000000', decimals: 6 },
      { mint: MINT_A, owner: W, amount: '300000000', decimals: 6 },
    ],
  });
  const s = decodeWalletSwap(t, W);
  assert.ok(s && !s.isBuy);
  assert.equal(s.heldBefore, 1000);
  assert.equal(s.tokens, 400);
  assert.ok(Math.abs(s.soldFraction - 0.4) < 1e-12, `sold 40 %, got ${s.soldFraction}`);
  // A buy has no fraction; a sell with no pre-balance on record has none either.
  const buy = tx({ keys: [W, JUP, MINT_A], pre: [SOL, 0, 0], post: [SOL - 0.4 * SOL - 5000, 0, 0], postTok: [{ mint: MINT_A, owner: W, amount: '1000000', decimals: 6 }] });
  assert.equal(decodeWalletSwap(buy, W).soldFraction, null);
  assert.equal(decodeWalletSwap(buy, W).heldBefore, 0);
});

test('an account-rent-sized BUY is a receipt, not a trade — but the same size SELL is real', () => {
  // Rule 6. Creating one associated token account costs 2,039,280 lamports,
  // which clears MIN_SOL. A claim, an LP or staking receipt, an NFT mint or a
  // pump.fun creation therefore decodes as "paid SOL, received a token", and
  // a copier with fixed sizing would buy its full size of a token nobody
  // traded. The wallet signs those itself, so the signer rule cannot help.
  const rent = 2_039_280;
  const receipt = tx({
    keys: [W, JUP, MINT_A],
    pre: [10 * SOL, 0, 0],
    post: [10 * SOL - rent - 5000, 0, 0],
    postTok: [{ mint: MINT_A, owner: W, amount: '1000000', decimals: 6 }],
  });
  assert.equal(decodeWalletSwap(receipt, W), null, 'a 0.00204 SOL "buy" is not a trade');

  // The floor is a CHECK, never a subtraction: a buy just over it reports its
  // full size.
  const small = tx({
    keys: [W, JUP, MINT_A],
    pre: [10 * SOL, 0, 0],
    post: [10 * SOL - 0.006 * SOL - 5000, 0, 0],
    postTok: [{ mint: MINT_A, owner: W, amount: '1000000', decimals: 6 }],
  });
  const b = decodeWalletSwap(small, W);
  assert.ok(b && b.isBuy, 'a 0.006 SOL buy is a trade');
  assert.ok(Math.abs(b.sol - 0.006) < 1e-12, `nothing is subtracted: ${b && b.sol}`);

  // SELLS are exempt. An exit must never be missed because it was small.
  const tinySell = tx({
    keys: [W, JUP, MINT_A],
    pre: [SOL, 0, 0],
    post: [SOL + rent - 5000, 0, 0],
    preTok: [{ mint: MINT_A, owner: W, amount: '1000000', decimals: 6 }],
    postTok: [{ mint: MINT_A, owner: W, amount: '0', decimals: 6 }],
  });
  const sell = decodeWalletSwap(tinySell, W);
  assert.ok(sell && !sell.isBuy, 'a sell of the same size is still a sell');
  assert.equal(sell.soldFraction, 1);
});

// Counted, not hardcoded: a hand-kept denominator silently lies the
// moment a test is added, and reads as a failure when it is not.
console.log(`walletswap: ${passed}/${ran} tests passed`);
