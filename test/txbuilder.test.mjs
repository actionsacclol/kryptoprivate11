// Local transaction builder — sampling-source tests.
//
// The builder learns pump's account layout from recent successful trades, so
// WHERE it samples decides whether it can build at all. Measured 2026-08-24:
// the pump program's own signature firehose was 96% failed transactions
// (snipers losing races) and the 4% that succeeded contained no pump
// instruction, while the bonding-curve account of any actively traded mint
// returned 85-100% successful transactions. The ring below is that sampling
// source, so its ordering and bounds are worth pinning.

import assert from 'node:assert';
import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import os from 'node:os';
import path from 'node:path';
import {
  activeMintsSnapshot,
  bondingCurveV2ForTest,
  initTemplateStore,
  invalidateTemplates,
  noteActiveMint,
  resetActiveMints,
  templateInfo,
  derivedTemplate,
  fillSlots,
  parseGlobal,
  parseCurve,
  encodeTradeData,
  BUY_DISC,
  SELL_DISC,
  derivedLayoutSuspended,
  resetDerivedState,
  markLastBuildPath,
  sellAmountFor,
  sellPctOf,
} from './.txbuilder.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('a noted mint becomes the newest sampling source', () => {
  resetActiveMints();
  noteActiveMint('mintA');
  noteActiveMint('mintB');
  assert.deepEqual(activeMintsSnapshot(), ['mintB', 'mintA']);
});

test('re-noting a mint moves it to the front rather than duplicating it', () => {
  resetActiveMints();
  noteActiveMint('a');
  noteActiveMint('b');
  noteActiveMint('c');
  noteActiveMint('a');
  assert.deepEqual(activeMintsSnapshot(), ['a', 'c', 'b'], 'no duplicate, and a is newest');
});

test('re-noting the current head is a no-op', () => {
  resetActiveMints();
  noteActiveMint('x');
  noteActiveMint('x');
  assert.deepEqual(activeMintsSnapshot(), ['x']);
});

test('the ring is bounded, dropping the stalest mints', () => {
  // Unbounded, this grows with every trade the engine decodes — it is fed
  // from the live tape, which is thousands of events an hour.
  resetActiveMints();
  for (let i = 0; i < 40; i++) noteActiveMint(`m${i}`);
  const snap = activeMintsSnapshot();
  assert.equal(snap.length, 12);
  assert.equal(snap[0], 'm39', 'newest first');
  assert.ok(!snap.includes('m0'), 'the stalest mint is gone');
});

test('the snapshot is a copy, so a caller cannot corrupt the ring', () => {
  resetActiveMints();
  noteActiveMint('safe');
  const snap = activeMintsSnapshot();
  snap.push('injected');
  assert.deepEqual(activeMintsSnapshot(), ['safe']);
});

// ── Template persistence ──────────────────────────────────────────────
//
// Learning an account layout costs ~200 getTransaction calls, which a free
// public RPC will not serve on demand, so the result is written to disk and
// reused for its 6h life. The risk that buys is a STALE template surviving a
// restart, so expiry and invalidation are pinned here.

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-tpl-'));

const writeStore = (dir, learnedAt) =>
  fs.writeFileSync(
    path.join(dir, 'pump-templates.json'),
    JSON.stringify({
      version: 1,
      templates: {
        buy: {
          action: 'buy',
          disc: '66063d1201daebea',
          slots: new Array(18).fill({ kind: 'fixed', value: 'x' }),
          writable: new Array(18).fill(false),
          tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
          trailingData: '',
          learnedAt,
          sampleCount: 7,
        },
      },
    }),
    'utf8',
  );

test('a template learned by a previous run is reused', () => {
  invalidateTemplates();
  const dir = tmpDir();
  writeStore(dir, Date.now());
  initTemplateStore(dir);
  assert.match(templateInfo(), /buy: 18 slots, 7 samples/, templateInfo());
});

test('an EXPIRED template is discarded rather than trusted', () => {
  // 6h TTL. A layout older than that predates at least one pump deploy
  // window, and pump ships breaking changes roughly quarterly.
  invalidateTemplates();
  const dir = tmpDir();
  writeStore(dir, Date.now() - 7 * 60 * 60 * 1000);
  initTemplateStore(dir);
  assert.match(templateInfo(), /buy: none/, templateInfo());
});

test('invalidation is persisted, so a bad template cannot return on restart', () => {
  const dir = tmpDir();
  writeStore(dir, Date.now());
  initTemplateStore(dir);
  assert.match(templateInfo(), /18 slots/);
  invalidateTemplates(); // what liveSigner does when a local tx fails simulation
  initTemplateStore(dir);
  assert.match(templateInfo(), /buy: none/, 'the invalidated template must stay gone');
});

test('a corrupt store degrades to learning from chain, not a crash', () => {
  invalidateTemplates();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'pump-templates.json'), '{not json', 'utf8');
  initTemplateStore(dir);
  assert.match(templateInfo(), /buy: none/);
});

test('a missing store is simply a first run', () => {
  invalidateTemplates();
  initTemplateStore(tmpDir());
  assert.match(templateInfo(), /buy: none/);
});

// ── The v2 bonding curve ──────────────────────────────────────────────
//
// Pump added `["bonding-curve-v2", mint]` as a required account. Because it
// was not derivable, the slot classifier fell through to "rotating fee
// account" and copied ANOTHER MINT's value — which the program rejected with
// InvalidBondingCurveV2 (6074), and which is why curve trading broke.

test('the v2 curve PDA is derived per mint, not shared', () => {
  const a = bondingCurveV2ForTest('9UraUj77CSF5YPJ5bDpH9jCEqy62xBv7RSd1JTCQpump');
  const b = bondingCurveV2ForTest('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  assert.notEqual(a, b, 'two mints must never share a v2 curve — that was the bug');
  assert.equal(a.length >= 32 && a.length <= 44, true);
});

test('the v2 curve PDA is deterministic', () => {
  const m = '9UraUj77CSF5YPJ5bDpH9jCEqy62xBv7RSd1JTCQpump';
  assert.equal(bondingCurveV2ForTest(m), bondingCurveV2ForTest(m));
});

test('the v2 curve PDA matches the address observed ON CHAIN', () => {
  // GOLDEN FIXTURE. Captured 2026-08-24 from slot 16 of a real, successful
  // 18-account buy (disc 66063d1201daebea) on this mint. If this ever fails,
  // the derivation has drifted from what the program actually expects — which
  // is precisely the failure that took curve trading down.
  assert.equal(
    bondingCurveV2ForTest('6tMM6beJxNdoHTWvsWQfaocXpJm9gDyw9AJKB8KPpump'),
    '5S4diBPpRfPj4hU7RCKpRpoEPNQeoWdraTRW2g5v5xr1',
  );
});

// ── The derived layout (2026-08-29) ───────────────────────────────────
//
// GROUND TRUTH: the inner pump `Buy` / `Sell` decoded from PumpPortal-built
// transactions for mint HoZRwYVHbehn9F6dujm61qTkaY8j6evnKUowwjx5pump and
// buyer 2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce, both of which
// simulated clean (buy: err null; sell: 6022 SellZeroAmount, i.e. every
// account constraint passed on a zero balance). Our own build of the same
// trade produced an IDENTICAL list and also simulated err null. If any slot
// here drifts, the program rejects the tx with ConstraintSeeds (2006) — the
// live failure this pins.

const REF_MINT = 'HoZRwYVHbehn9F6dujm61qTkaY8j6evnKUowwjx5pump';
const REF_USER = '2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce';
const REF_CREATOR = '5TzdhmUZEaqDzpu7CH7d13MPbVjfbT1XroREe8gHjajC';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const REF_FEE_RECIPIENT = '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV';
const REF_FEE_VAULT = 'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW';

const REF_BUY = [
  '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', // global
  REF_FEE_RECIPIENT, // fee recipient (Global.fee_recipient)
  REF_MINT,
  'BdU5z8KvnuEiK4x2VzJpc3S4Ma87kYJcr7oD68mxUMap', // bonding curve
  'CMMJJtyLbK1BzBk9yWR1qjPL17hEJa7A1H5jkP6K3MjV', // curve ATA (Token-2022)
  '4SPo6YkB93ydJxgs4JYJ3gZ9jNpBZLHS83Sz4zM1ZD6N', // user ATA (Token-2022)
  REF_USER,
  '11111111111111111111111111111111',
  T22,
  '2gHwpoGVmVceRrQ6qVAa71kwmTGHbMvrYDGJRZLWGj7P', // creator vault
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', // event authority
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y', // global volume accumulator
  '9jvXGXWp5PvpjDVrWxWZDQr9kP3L8S1EGQFjLcKMk4q7', // user volume accumulator
  '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt', // fee config
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  'CA2oEWbxJQEtPfXRicn9JG9RRdNohE5geAAxBcmb2mpx', // bonding curve v2
  REF_FEE_VAULT, // fee vault (from Global's tail)
];
const REF_BUY_WRITABLE = [false, true, false, true, true, true, true, false, false, true, false, false, false, true, false, false, true, true];
const REF_SELL = [
  REF_BUY[0], REF_BUY[1], REF_MINT, REF_BUY[3], REF_BUY[4], REF_BUY[5], REF_USER, REF_BUY[7],
  REF_BUY[9], // creator vault comes BEFORE the token program on the sell
  T22,
  REF_BUY[10], REF_BUY[11], REF_BUY[14], REF_BUY[15], REF_BUY[16], REF_FEE_VAULT,
];

const refFill = { mint: REF_MINT, owner: REF_USER, creator: REF_CREATOR, tokenProgram: T22, feeRecipient: REF_FEE_RECIPIENT, feeVault: REF_FEE_VAULT };

test('the derived BUY layout reproduces the reference account list exactly', () => {
  const tpl = derivedTemplate('buy');
  assert.deepEqual(fillSlots(tpl, refFill), REF_BUY);
  assert.deepEqual(tpl.writable, REF_BUY_WRITABLE);
  assert.equal(tpl.disc.toString('hex'), '66063d1201daebea');
});

test('the derived SELL layout reproduces the reference account list exactly', () => {
  const tpl = derivedTemplate('sell');
  assert.deepEqual(fillSlots(tpl, refFill), REF_SELL);
  assert.equal(tpl.slots.length, 16);
  assert.equal(tpl.disc.toString('hex'), '33e685a4017f83ad');
});

test('the last slot is the fee vault, never a "rotating fee" copied from another trade', () => {
  // The learner filed this slot as `fee` (it varies across samples) and
  // filled it from someone else's transaction. It is Global config.
  const buy = derivedTemplate('buy');
  assert.equal(buy.slots[17].kind, 'feeVault');
  assert.equal(buy.slots[1].kind, 'feeRecipient');
  assert.equal(buy.slots[8].kind, 'tokenProgram', 'the token program is a per-mint fact');
  assert.equal(derivedTemplate('sell').slots[15].kind, 'feeVault');
});

// ── Golden fixture: real landed trades ──────────────────────────────
//
// REF_BUY above was decoded from a PumpPortal BUILD. This pins the derived
// layout against transactions that actually LANDED on chain, with the raw
// bonding-curve, mint and Global accounts captured alongside, so every
// slot — creator from the curve, token program from the mint's owner, fee
// recipient and vault from Global — is re-derived here from bytes, offline.
// Refresh with `npm run fixture:pump-layout` when pump changes a layout;
// a diff in this test is the signal that the local builder is stale.
const FIXTURE = JSON.parse(
  fs.readFileSync(new URL('./fixtures/pump-derived-layout.json', import.meta.url), 'utf8'),
);
const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

/** True when `key` is stored somewhere inside Global's bytes. */
const inGlobal = (globalBytes, key) => {
  const needle = Buffer.from(new PublicKey(key).toBytes());
  for (let i = 0; i + 32 <= globalBytes.length; i++) if (globalBytes.subarray(i, i + 32).equals(needle)) return true;
  return false;
};

for (const action of ['buy', 'sell']) {
  test(`golden: the derived ${action.toUpperCase()} layout reproduces a landed trade's accounts`, () => {
    const fx = FIXTURE[action];
    const globalBytes = Buffer.from(FIXTURE.global.dataB64, 'base64');
    const global = parseGlobal(new Uint8Array(globalBytes));
    assert.equal(global.fromChain, true, 'Global parsed from the captured account bytes');
    const curve = parseCurve(b64(fx.curve.dataB64));
    assert.ok(curve && !curve.complete, 'captured curve is open');
    assert.ok(curve.creator, 'captured curve names its creator');
    const tokenProgram = fx.mintAccount.owner;
    const tpl = derivedTemplate(action);
    const filled = fillSlots(tpl, {
      mint: fx.mint,
      owner: fx.user,
      creator: curve.creator,
      tokenProgram,
      feeRecipient: global.feeRecipient,
      feeVault: global.feeVault,
    });
    assert.equal(filled.length, action === 'buy' ? 18 : 16);
    for (let i = 0; i < filled.length; i++) {
      const kind = tpl.slots[i].kind;
      if (kind === 'feeRecipient' || kind === 'feeVault') {
        // Pump's Global lists EIGHT fee recipients and several fee vaults (all
        // owned by the fee program), and the program accepts any of them —
        // clients rotate to spread write-locks. We always use the primary pair
        // (offsets 41 / 965), which our own landed trades used; a landed trade
        // from another client may name a sibling. The pin here is that both
        // come from Global's bytes, never from a template or another trade.
        assert.ok(inGlobal(globalBytes, fx.accounts[i]), `slot ${i} (${kind}) ${fx.accounts[i]} is listed in Global`);
        assert.ok(inGlobal(globalBytes, filled[i]), `our ${kind} ${filled[i]} is listed in Global`);
        continue;
      }
      assert.equal(filled[i], fx.accounts[i], `slot ${i} (${kind}) of ${action} ${fx.signature.slice(0, 16)}… — every non-fee slot derives exactly`);
    }
  });
}

test('golden: landed instruction data starts with our discriminators (a trailing track_volume byte is optional)', () => {
  // Our encoder emits exactly 24 bytes; landed buys from other clients may
  // carry a 25th (Anchor OptionBool) — both are accepted by the program, the
  // 24-byte form being what our own landed trades used on 2026-08-29.
  assert.equal(encodeTradeData(BUY_DISC, 1n, 1n).length, 24);
  assert.ok([24, 25].includes(FIXTURE.buy.dataLen), 'buy data is 24 or 25 bytes on chain');
  assert.ok([24, 25].includes(FIXTURE.sell.dataLen), 'sell data is 24 or 25 bytes on chain');
});

test('a classic-Token mint derives its ATAs and token-program slot for Tokenkeg', () => {
  const TOK = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const filled = fillSlots(derivedTemplate('buy'), { ...refFill, tokenProgram: TOK });
  assert.equal(filled[8], TOK);
  assert.notEqual(filled[4], REF_BUY[4], 'curve ATA differs by token program');
  assert.notEqual(filled[5], REF_BUY[5], 'user ATA differs by token program');
  assert.equal(filled[17], REF_FEE_VAULT, 'the fee vault does not depend on the mint');
});

// Real account bytes captured 2026-08-29.
const GLOBAL_B64 = 'p+joschscn8B07uMqzQc4FKEV/LDgX0yeEQZY9zVX+1YuiTJmd2sAqpKwvjQ3Vy8l+MonBl8tQYqVPPZVrnOblEV+WVnqlyz5gAQ2EfjzwMAAKwj/AYAAAAAeMX7UdECAACAxqR+jQMAXwAAAAAAAAAf6nQ58860xO9Lucx77kChpiYXG2hBX+3tQLeolW+E5wHB4eQAAAAAAAUAAAAAAAAAYIzMHfzpYbQ7d5wZFQWm4tO/RdWk20YYrXbILWF1RTVjg3MADqIssmTTSv9koEte+r+7dN3NBImXsZgVR9fREIOEdCkuZ1qUtDbssKmYiUIyioPdxiM4ApYSZ8XNYRfLjRgaDISfqTem80re0wge+VcAqssMm7PZCaS5FHUnpOutEeak/ClEpPqCUb74FUJuG/soxrZkZndgfGrZ9WamRteqj7Bg2CkbTE1HXa/3Yslr3A2s6zbAEurRLtOpSEFh4ATIfOuY+lzkf4A4Bv0seUXSlSSVmuwA3tl4FPOPeEYf6nQ58860xO9Lucx77kChpiYXG2hBX+3tQLeolW+E5wchXZlAeTaU4RYGbORZuBj9+bugx7QbeD+joSDKQZUyAaKLX9JqtHmmqcxsv2sLI+thiFo3HgEgrKkTvu89E4p46JMUH7GOnxV02BDheOGeMGBOMXWqLkoy38hgByfRBwkBNYRTYlYJT5EoGRJ++k5Ea0MzcheT0Th2+arb89x9C19udQGCIPlCZ3ADI3tNa0U3WbSlxpC1nDXZuxh6CQy9KjOYep67E2eZq1mSWxPl3Iswgd8AXbQnwUePpG/4w0egdOlUPz43otBGInrdy06cd0xEJYxD7fJKqKrh8AIUZlvaTDjNbbdDj1m0CLuew7TKnorR8fJGU8SZtXlsINv5sy3dnuo/ObNyEVxxhHwYRc+lNsaFB04DDkTQId4++eNcTLeA8I7i/uhL7ERqV3gl2mjUOfqKXaOwxc/1D2P0VGsBQ55lEMA9ZfrZMeidBL4Ltw1Rlx9RxBX7NEwH20GfISICI1UWqRcTTGdYjEk4IK4VXulmZVd6wbcY2kfdzyoFDuan4iBou4hkCqV/kJMIxh/vcRoBY/WnVcBwvIYNH2NnIHzs2lvMbLHq8PFtaEBFZrGNVtJIGssxcDJlbpBVHHhElkH4SVjcc6dqhdh1b1XALNrKiboZMnkMNoqxV+ktc8VLlrXJMZQeRupL4uDjESd0T8a3TPtFXv6vi9VxeSztRPwfePlKM9CQnF5rX7AhVwrY262N6P2z0g7RzZnrjk6HcBV+6+tnimVduZs39rEybHZX25DPuKh6vvjHtvLIaYgTAAAAAAAAALnS/wAAAADG+nrzvtutOj1l82qryXQxsbvkwtL24OR8pgIDRS9dYQ==';
const CURVE_HOZR_B64 = 'F7f4N2DYrGDtRMXQpM8DAC8olvwGAAAA7ayyhBPRAgAvfHIAAAAAAACAxqR+jQMAAEJZA61yoNCDpFTrwT7UxrbGogLh7BB27NB5UtP3749jAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
// The curve of the mint that failed LIVE on 2026-08-29: 49 bytes (no creator
// field), every reserve zero, complete = 1 — while the API said complete=false.
const CURVE_LEGACY_B64 = 'F7f4N2DYrGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAxqR+jQMAAQ==';

test('parseGlobal reads the fee recipient and fee vault from a real Global account', () => {
  const g = parseGlobal(Buffer.from(GLOBAL_B64, 'base64'));
  assert.equal(g.feeRecipient, REF_FEE_RECIPIENT);
  assert.equal(g.feeVault, REF_FEE_VAULT);
  assert.equal(g.fromChain, true);
});

test('parseGlobal refuses a non-Global and falls back to the verified constants', () => {
  const g = parseGlobal(Buffer.alloc(1045));
  assert.equal(g.fromChain, false);
  assert.equal(g.feeRecipient, REF_FEE_RECIPIENT);
  assert.equal(g.feeVault, REF_FEE_VAULT);
  // A Global whose tail no longer carries a PDA there keeps the recipient
  // but does not read garbage as the vault.
  const zeroed = Buffer.from(GLOBAL_B64, 'base64');
  zeroed.fill(0, 965, 997);
  const z = parseGlobal(zeroed);
  assert.equal(z.feeRecipient, REF_FEE_RECIPIENT);
  assert.equal(z.feeVault, REF_FEE_VAULT);
  assert.equal(z.fromChain, false);
});

test('parseCurve reads reserves, completion and the creator the program seeds the vault with', () => {
  const c = parseCurve(Buffer.from(CURVE_HOZR_B64, 'base64'));
  assert.equal(c.creator, REF_CREATOR);
  assert.equal(c.complete, false);
  assert.equal(c.vSol, 30007502895n);
  assert.equal(c.vTok, 1072731714307309n);
});

test('a legacy 49-byte curve parses as complete with NO creator — the 2026-08-29 live failure', () => {
  const c = parseCurve(Buffer.from(CURVE_LEGACY_B64, 'base64'));
  assert.equal(c.complete, true, 'the builder must refuse this before deriving anything');
  assert.equal(c.creator, null, 'the API creator must not be trusted for the vault seed here');
  assert.equal(parseCurve(Buffer.alloc(151)), null, 'wrong discriminator is not a curve');
});

test('trade data is disc · amount · sol limit, 24 bytes, little-endian', () => {
  const d = encodeTradeData(BUY_DISC, 0x292ff30543n, 0x989680n);
  assert.equal(d.toString('hex'), '66063d1201daebea4305f32f290000008096980000000000');
  assert.equal(encodeTradeData(SELL_DISC, 0n, 0n).toString('hex'), '33e685a4017f83ad00000000000000000000000000000000');
});

test('three derived-layout simulation failures inside ten minutes suspend it; learned failures do not', () => {
  resetDerivedState();
  initTemplateStore(tmpDir());
  markLastBuildPath('learned');
  for (let i = 0; i < 5; i++) invalidateTemplates();
  assert.equal(derivedLayoutSuspended(), false, 'a learned template failing says nothing about the derived layout');
  markLastBuildPath('derived');
  invalidateTemplates();
  invalidateTemplates();
  assert.equal(derivedLayoutSuspended(), false, 'one slippage revert must not hand trading to the learner');
  invalidateTemplates();
  assert.equal(derivedLayoutSuspended(), true);
  assert.match(templateInfo(), /derived: suspended/);
  resetDerivedState();
  assert.equal(derivedLayoutSuspended(), false);
});

// ── Coin classes: mayhem-mode and cashback (2026-09-07) ─────────────
//
// Pump's curves now come in three classes and the program checks the trade
// against the class. GROUND TRUTH, measured by simulating real holders'
// trades on 2026-09-07:
//   • mayhem (curve byte 81): buy AND sell revert `NotAuthorized (6000)`
//     with the normal fee recipient; a RESERVED one (Global @483) passes.
//     Jupiter has no route for these, and the relayer's build reverted
//     `Overflow (6024)` — the user-visible failure that started this.
//   • cashback (curve byte 82): the sell must pass the user's volume
//     accumulator BEFORE bonding_curve_v2 or it reverts
//     `InvalidCashbackAccumulator (6073)`; the same slot on a non-cashback
//     coin reverts `InvalidBondingCurveV2 (6074)`; dropping the last
//     (buyback) slot reverts `BuybackFeeRecipientMissing (6062)`.
// The fixture holds the three real curve accounts and Global at capture.
const CLASSES = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-curve-classes.json', import.meta.url), 'utf8'));
const RESERVED_FEE_RECIPIENT_0 = 'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS';

test('parseCurve reads the mayhem and cashback flags off real curves, and SOL as a null quote mint', () => {
  const mayhem = parseCurve(b64(CLASSES.mayhem.dataB64));
  const cashback = parseCurve(b64(CLASSES.cashback.dataB64));
  const normal = parseCurve(b64(CLASSES.normal.dataB64));
  assert.deepEqual([mayhem.mayhem, mayhem.cashback], [true, false]);
  assert.deepEqual([cashback.mayhem, cashback.cashback], [false, true]);
  assert.deepEqual([normal.mayhem, normal.cashback], [false, false]);
  for (const c of [mayhem, cashback, normal]) {
    assert.equal(c.complete, false);
    assert.equal(c.quoteMint, null, 'SOL-paired: the quote_mint field is zero');
    assert.ok(c.creator, 'creator still parses');
  }
  assert.ok(mayhem.vSol > 100_000_000_000n, 'a mayhem curve trades against inflated virtual SOL');
});

test('parseCurve: a legacy short curve has the flags OFF, and a non-SOL quote mint is surfaced', () => {
  const full = Buffer.from(b64(CLASSES.normal.dataB64));
  const legacy = parseCurve(full.subarray(0, 81));
  assert.deepEqual([legacy.mayhem, legacy.cashback, legacy.quoteMint], [false, false, null]);
  const usdc = Buffer.from(full);
  Buffer.from(new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').toBytes()).copy(usdc, 83);
  assert.equal(parseCurve(usdc).quoteMint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
});

test('parseGlobal reads the reserved (mayhem) fee recipient at offset 483 — pump\'s published #0', () => {
  const g = parseGlobal(b64(CLASSES.global.dataB64));
  assert.equal(g.reservedFeeRecipient, RESERVED_FEE_RECIPIENT_0);
  assert.notEqual(g.reservedFeeRecipient, g.feeRecipient, 'a different account from the normal recipient');
  assert.equal(g.fromChain, true);
  // Too short for the field: the documented #0 stands in, never the normal one.
  const short = parseGlobal(b64(CLASSES.global.dataB64).subarray(0, 200));
  assert.equal(short.reservedFeeRecipient, RESERVED_FEE_RECIPIENT_0);
});

test('a cashback SELL carries the user volume accumulator right before bonding_curve_v2, buyback last', () => {
  const tpl = derivedTemplate('sell', { cashback: true });
  assert.equal(tpl.slots.length, 17);
  assert.equal(tpl.slots[14].kind, 'uva');
  assert.equal(tpl.writable[14], true, 'the accumulator is mutated (creator fee lands in it)');
  assert.equal(tpl.slots[15].kind, 'bondingCurveV2');
  assert.equal(tpl.slots[16].kind, 'feeVault');
  const filled = fillSlots(tpl, refFill);
  assert.equal(filled[14], REF_BUY[13], 'the same accumulator PDA the buy already carries');
  assert.deepEqual([...filled.slice(0, 14), ...filled.slice(15)], REF_SELL, 'every other slot is the plain sell');
});

test('a non-cashback SELL and every BUY are byte-for-byte what they were', () => {
  assert.deepEqual(fillSlots(derivedTemplate('sell', { cashback: false }), refFill), REF_SELL);
  assert.deepEqual(fillSlots(derivedTemplate('sell'), refFill), REF_SELL);
  assert.deepEqual(fillSlots(derivedTemplate('buy', { cashback: true }), refFill), REF_BUY, 'buys already carry the accumulator');
});

test('a mayhem coin fills slot 1 with the reserved recipient and nothing else moves', () => {
  const g = parseGlobal(b64(CLASSES.global.dataB64));
  for (const action of ['buy', 'sell']) {
    const filled = fillSlots(derivedTemplate(action), { ...refFill, feeRecipient: g.reservedFeeRecipient });
    const plain = fillSlots(derivedTemplate(action), refFill);
    assert.equal(filled[1], RESERVED_FEE_RECIPIENT_0);
    assert.deepEqual(filled.slice(2), plain.slice(2));
    assert.equal(filled[0], plain[0]);
  }
});

test('a partial sell moves exactly floor(balance × pct / 100) to two decimals; 100% and "absent" move everything', () => {
  // Before 2026-09-07 the local builder hardcoded the full balance, so a
  // partial request had to be withheld from it or it would have emptied the
  // bag under a "sold 25%" toast. Now it sizes like the Jupiter route does.
  const bal = 34_199_203_154_141n;
  assert.equal(sellAmountFor(bal, undefined), bal);
  assert.equal(sellAmountFor(bal, 100), bal);
  assert.equal(sellAmountFor(bal, 150), bal, 'clamped to 100');
  assert.equal(sellAmountFor(bal, 50), bal / 2n);
  assert.equal(sellAmountFor(bal, 25), (bal * 25n) / 100n);
  assert.equal(sellAmountFor(bal, 1), bal / 100n);
  // Two decimals since 2026-09-15: a mirrored copy sell is sized from the
  // base units the copy holds, converted to the share of the balance that
  // really is. Rounding that back to a whole percent left up to 1 % of the
  // position in the wallet under a "sold 100 %" record — the reported bug.
  assert.equal(sellAmountFor(bal, 52.37), (bal * 5237n) / 10_000n, 'a fractional share survives');
  assert.equal(sellAmountFor(bal, 0.01), bal / 10_000n);
  assert.equal(sellAmountFor(bal, 0), bal / 10_000n, 'never zero: the floor is one basis point');
  assert.equal(sellAmountFor(bal, 33.4), (bal * 3340n) / 10_000n, 'kept to two decimals, not rounded to a whole percent');
  assert.equal(sellAmountFor(bal, 33.456), (bal * 3346n) / 10_000n, 'past two decimals it rounds');
  assert.equal(sellAmountFor(3n, 50), 1n, 'floors, never rounds up past what is held');
  assert.equal(sellPctOf(NaN), 100);
});

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`ok  ${c.name}`);
      passed++;
    } catch (err) {
      console.log(`FAIL ${c.name}\n     ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`txbuilder: ${passed}/${cases.length} tests passed`);
}

await run();
