// electron/evm/fourmeme.ts — the pure parts of the four.meme rail.
//
// Quotes come from the platform's own helper contract, so there is no curve
// formula here to pin; what IS pure is how a token's info becomes progress
// and the shared curve state, the quote-asset test, and the calldata the
// signer will see. The info object below is the live one read through
// TokenManagerHelper3 on 2026-09-09 (a fresh BNB-quoted launch).

import assert from 'node:assert';
import { decodeFunctionData } from 'viem';
import { progressPct, toShared, spotPrice, isNativeQuote, isFourMeme, encodeBuy, encodeSell } from './.evmfourmeme.mjs';
import { FOURMEME_MANAGER_ABI, SELECTOR_BSC, FOURMEME_CURVE_SUPPLY } from './.evmbsc.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

const NATIVE = '0x0000000000000000000000000000000000000000';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const MANAGER = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';
const TOKEN = '0xa8ec7018c07fd17ef9997246dd9b94dfdd4bffff';
const TREASURY = '0xDCBad4133961664D3F7E05f2D310A56Dc3eA483a';

/** getTokenInfo(0xA8eC7018…) as read on 2026-09-09. */
const LIVE = {
  token: TOKEN,
  version: 2n,
  tokenManager: MANAGER,
  quote: NATIVE,
  lastPrice: 5_739_795_918n,
  tradingFeeRate: 100n,
  minTradingFee: 0n,
  launchTime: 0n,
  offers: 800_000_000n * 10n ** 18n,
  maxOffers: 800_000_000n * 10n ** 18n,
  funds: 0n,
  maxFunds: 18n * 10n ** 18n,
  liquidityAdded: false,
};

// ── progress ──────────────────────────────────────────────────────────

ok('a fresh curve (0 of 18 BNB) is 0 %', () => {
  assert.equal(progressPct(LIVE), 0);
});

ok('9 of 18 BNB is 50 %, 17.99 is 99.94 %, over the line caps at 99.99 until liquidity is added', () => {
  assert.equal(progressPct({ ...LIVE, funds: 9n * 10n ** 18n }), 50);
  assert.equal(progressPct({ ...LIVE, funds: 17_990_000_000_000_000_000n }), 99.94);
  assert.equal(progressPct({ ...LIVE, funds: 19n * 10n ** 18n }), 99.99);
});

ok('liquidityAdded is 100 % whatever the funds say', () => {
  assert.equal(progressPct({ ...LIVE, liquidityAdded: true }), 100);
  assert.equal(progressPct({ ...LIVE, funds: 3n, liquidityAdded: true }), 100);
});

// ── quote asset ───────────────────────────────────────────────────────

ok('isNativeQuote: BNB launches quote in address(0); USDT and stock-token launches do not', () => {
  assert.equal(isNativeQuote(LIVE), true);
  assert.equal(isNativeQuote({ ...LIVE, quote: USDT }), false);
  assert.equal(isNativeQuote({ ...LIVE, quote: '0x205812cdbed920aff76c6580abd681a46d11efc7' }), false);
});

ok('isFourMeme: version > 0 with a manager; a token the helper does not know is not', () => {
  assert.equal(isFourMeme(LIVE), true);
  assert.equal(isFourMeme(null), false);
  assert.equal(isFourMeme({ ...LIVE, version: 0n }), false);
  assert.equal(isFourMeme({ ...LIVE, tokenManager: NATIVE }), false);
});

ok('spotPrice is lastPrice scaled by 1e18 (5.7e-9 BNB per token on the live curve); zero is null', () => {
  assert.equal(spotPrice(LIVE), 5.739795918e-9);
  assert.equal(spotPrice({ ...LIVE, lastPrice: 0n }), null);
});

// ── shared curve state ────────────────────────────────────────────────

ok('toShared maps the helper’s info onto the terminal’s curve state', () => {
  const s = toShared(LIVE);
  assert.equal(s.address, MANAGER);
  assert.equal(s.realQuoteWei, '0');
  assert.equal(s.thresholdWei, (18n * 10n ** 18n).toString());
  assert.equal(s.progressPct, 0);
  assert.equal(s.graduated, false);
  assert.equal(s.readyToGraduate, false);
  assert.equal(s.feeBps, 100);
  assert.equal(s.creatorTaxBps, 0);
  assert.equal(s.pairToken, NATIVE);
  assert.equal(s.isNativeQuote, true);
  assert.equal(s.priceQuote, 5.739795918e-9);
  assert.equal(s.sellableTokens, LIVE.offers.toString());
  assert.equal(s.tokenReserve, FOURMEME_CURVE_SUPPLY.toString());
  assert.equal(s.quoteReserve, '0');
});

ok('toShared: at the line but not yet swept is readyToGraduate; swept is graduated at 100 %', () => {
  const atLine = toShared({ ...LIVE, funds: 18n * 10n ** 18n });
  assert.equal(atLine.readyToGraduate, true);
  assert.equal(atLine.graduated, false);
  assert.equal(atLine.progressPct, 99.99);
  const swept = toShared({ ...LIVE, funds: 18n * 10n ** 18n, liquidityAdded: true });
  assert.equal(swept.readyToGraduate, false);
  assert.equal(swept.graduated, true);
  assert.equal(swept.progressPct, 100);
});

// ── calldata ──────────────────────────────────────────────────────────

ok('encodeBuy is buyTokenAMAP(token, funds, minAmount) — the selector the policy allows', () => {
  const data = encodeBuy(TOKEN, 10n ** 16n, 123n);
  assert.equal(data.slice(0, 10), SELECTOR_BSC.fourMemeBuy);
  assert.equal(data.slice(0, 10), '0x87f27655');
  const d = decodeFunctionData({ abi: FOURMEME_MANAGER_ABI, data });
  assert.equal(d.functionName, 'buyTokenAMAP');
  assert.equal(d.args.length, 3);
  assert.equal(d.args[0].toLowerCase(), TOKEN);
  assert.equal(d.args[1], 10n ** 16n);
  assert.equal(d.args[2], 123n);
});

ok('encodeSell with a fee is the 6-arg sellToken(origin 0, token, amount, minFunds, feeRate, feeRecipient)', () => {
  const data = encodeSell(TOKEN, 10n ** 24n, 999n, 50n, TREASURY);
  assert.equal(data.slice(0, 10), SELECTOR_BSC.fourMemeSellWithFee);
  assert.equal(data.slice(0, 10), '0x06e7b98f');
  const d = decodeFunctionData({ abi: FOURMEME_MANAGER_ABI, data });
  assert.equal(d.functionName, 'sellToken');
  assert.equal(d.args.length, 6);
  assert.equal(d.args[0], 0n, 'origin is always 0 — no referral tracking on the platform side');
  assert.equal(d.args[1].toLowerCase(), TOKEN);
  assert.equal(d.args[2], 10n ** 24n);
  assert.equal(d.args[3], 999n);
  assert.equal(d.args[4], 50n);
  assert.equal(d.args[5].toLowerCase(), TREASURY.toLowerCase());
});

ok('encodeSell with a zero fee rate, or no recipient, falls back to the plain 3-arg sellToken', () => {
  for (const data of [encodeSell(TOKEN, 5n, 1n, 0n, TREASURY), encodeSell(TOKEN, 5n, 1n, 50n, null), encodeSell(TOKEN, 5n, 1n, 0n, null)]) {
    assert.equal(data.slice(0, 10), SELECTOR_BSC.fourMemeSell);
    assert.equal(data.slice(0, 10), '0x3e11741f');
    const d = decodeFunctionData({ abi: FOURMEME_MANAGER_ABI, data });
    assert.equal(d.functionName, 'sellToken');
    assert.equal(d.args.length, 3);
    assert.equal(d.args[0].toLowerCase(), TOKEN);
    assert.equal(d.args[1], 5n);
    assert.equal(d.args[2], 1n);
  }
});

console.log(`\n${passed} evm four.meme cases passed`);
