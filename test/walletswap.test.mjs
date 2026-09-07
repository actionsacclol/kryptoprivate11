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
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
};

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

console.log(`walletswap: ${passed}/9 tests passed`);
