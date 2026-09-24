// pump.fun callout rewards (2026-09-23): reading what pump paid, its reward
// terms, and moving the USDC that lands in each wallet.
//
// The signer rule itself (USDC may leave ONLY to the stored withdrawal
// address) is pinned with real transactions in walletpolicy.test.mjs. This
// pins the parsing and the wiring around it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CALLOUT_REWARD_TERMS_URL, payoutFrom, payoutsFrom, payoutStatusLabel, termsFrom } from './.pumprewards.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

{
  // pump's documented shapes.
  const body = {
    payouts: [
      { walletAddress: 'W1', amountUsdc: 3.5, status: 'confirmed', txSignature: 'SIG', createdAt: '2026-09-23T10:00:00Z', kind: 'reward' },
      { walletAddress: 'W1', amountUsdc: 1.25, status: 'awaiting_approval', txSignature: null, createdAt: null, kind: 'reward' },
    ],
    totalPaidUsdc: 3.5,
  };
  const r = payoutsFrom(body);
  assert.equal(r.totalPaidUsdc, 3.5, 'the confirmed-only total is pump’s, as given');
  assert.equal(r.payouts.length, 2);
  assert.equal(payoutStatusLabel(r.payouts[0].status), 'paid');
  assert.equal(payoutStatusLabel(r.payouts[1].status), 'awaiting approval');
  assert.deepEqual(termsFrom({ accepted: false, acceptedAt: null }), { accepted: false, acceptedAt: null });
  assert.equal(termsFrom({ accepted: true, acceptedAt: '2026-09-23' }).accepted, true);
  assert.equal(CALLOUT_REWARD_TERMS_URL, 'https://pump.fun/docs/callout-reward-terms');
  ok('pump’s payout and terms answers are read as documented');
}

{
  // Honest null: nothing unreadable becomes a zero or a "not accepted".
  assert.equal(payoutsFrom({ totalsOnly: true }), null, 'not that shape → null, not an empty history');
  assert.equal(payoutsFrom({ payouts: [] }).totalPaidUsdc, null, 'a missing total is unknown, never $0');
  assert.equal(payoutFrom({ status: 'something_new' }).status, 'unknown');
  assert.equal(payoutFrom({ status: 'confirmed' }).amountUsdc, null, 'a missing amount is null, never 0');
  assert.equal(termsFrom({}), null, 'terms pump did not state are unknown, never read as "not accepted"');
  assert.equal(termsFrom(null), null);
  ok('what pump did not say stays unknown');
}

{
  const ipc = src('../electron/ipc.ts');
  const wd = ipc.slice(ipc.indexOf("ipcMain.handle('calloutRewards:withdrawUsdc'"), ipc.indexOf("ipcMain.handle('swap:execute'"));
  assert.match(wd, /await withdrawUsdc\(.*, \{ walletId, amountRaw \}\);/, 'the renderer names a wallet and an amount — never a destination');
  assert.ok(!/homeAddress/.test(wd.slice(0, wd.indexOf('logger.warn'))), 'no destination is read or passed on this side');
  const tw = src('../electron/engine/tokenWithdraw.ts');
  assert.match(tw, /homeAddress \?\? null/, 'the builder reads the STORED withdrawal address');
  assert.match(tw, /intent: 'withdraw-token' as const, maxTransferLamports: 0, withdrawMint: mint/, 'and signs under the narrow token-withdraw rule, no SOL allowed');
  assert.match(tw, /arrived < amount/, 'nothing is sent unless the simulation delivers the full amount');
  const sw = src('../electron/engine/swap.ts');
  assert.match(sw, /walletId \? wallet\.signVersionedTransactionForWallet\(walletId, tx, policy\) : wallet\.signVersionedTransaction\(tx, policy\)/, 'a swap from another wallet is signed BY that wallet');
  const swapIpc = ipc.slice(ipc.indexOf("ipcMain.handle('calloutRewards:swapUsdc'"), ipc.indexOf("ipcMain.handle('calloutRewards:withdrawUsdc'"));
  assert.match(swapIpc, /if \(!deps\.live\) return fail/, 'a rewards swap needs live armed, like any swap');
  const pre = src('../electron/preload.ts');
  assert.match(pre, /calloutRewards: \{/, 'its own bridge name — window.krypt.rewards is the Merkl check');
  assert.match(pre, /^ {2}rewards: \{/m, 'which is still there');
  const panel = src('../src/components/terminal/CalloutRewards.tsx');
  assert.match(panel, /modal\.confirm\(\{\n\s+title: `Accept pump\.fun's reward terms/, 'accepting terms is a confirmed click, with the terms linked');
  ok('the USDC can only be swapped in place or sent to the confirmed address, and terms are accepted only by a person');
}

console.log(`\ncalloutrewards: ${passed}/${passed} passed`);
