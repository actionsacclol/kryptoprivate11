// The wallet panel: click the top bar's balance, a square opens with the balance,
// a manual refresh, the deposit address and withdrawing (2026-11-04).
//
// Source pins, for what a wrong edit would cost money or lock up the window. The
// panel itself, and the QR read back from its pixels, were driven in the real app.

import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const panel = read('src/components/terminal/WalletPanel.tsx');
const bar = read('src/components/TopBar.tsx');
const card = read('src/components/terminal/WithdrawPanel.tsx');
const page = read('src/pages/Wallet.tsx');
const code = panel.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
let n = 0;
const ok = (name, fn) => {
  fn();
  n += 1;
  console.log(`  ok  ${name}`);
};

ok('every balance in the top bar opens the panel', () => {
  for (const chain of ['chain="all"', 'chain={evmChain}', 'chain="solana"']) {
    assert.ok(bar.includes(`<WalletButton ${chain}`), chain);
  }
  // Loaded on the first click: the bar is on screen for the life of the app.
  assert.match(bar, /const WalletPanel = lazy\(\(\) => import\('\.\/terminal\/WalletPanel'\)/);
  assert.doesNotMatch(bar, /^import \{ WalletPanel/m);
  assert.match(bar, /^import type \{ WalletPageRoute, WalletPanelChain \}/m);
});

ok('the panel moves money only through the cards the wallet pages use', () => {
  assert.doesNotMatch(code, /krypt\.wallet\.withdraw|krypt\.send|\.execute\(|krypt\.bridge|exportKey|\.reveal\(/);
  assert.match(code, /<WithdrawPanel\b/);
  assert.match(code, /<SendCard\b/);
  // One withdrawal card, not a copy of it.
  assert.match(page, /import \{ WithdrawPanel \} from '\.\.\/components\/terminal\/WithdrawPanel'/);
  assert.doesNotMatch(page, /function WithdrawPanel/);
  assert.match(card, /window\.krypt\.wallet\.withdraw\(\{ lamports \}\)/);
});

ok('an unsaved withdrawal address blocks the withdrawal here too', () => {
  // User report 2026-10-03: the field showed the new address, nothing was saved,
  // and 0.1 SOL went to the old one.
  assert.match(code, /const homeUnsaved = showEditor && homeInput\.trim\(\) !== saved;/);
  assert.match(code, /unsavedHome=\{homeUnsaved\}/);
  // Opening the editor starts from the saved address, so it is not an edit yet.
  assert.match(code, /setHomeInput\(saved\);\s*\n\s*setEditingHome\(true\);/);
});

ok('the deposit address is the wallet the balance belongs to', () => {
  assert.match(code, /<Deposit address=\{info\.publicKey\}/);
  assert.match(code, /<Deposit address=\{w\.address\}/);
  assert.match(code, /const address = chain === 'solana' \? info\.solanaAddress : info\.evmAddress;/);
  // Every deposit names its network: coins sent on the wrong one do not arrive.
  for (const m of code.matchAll(/<Deposit address=\{[^}]+\} note=\{?[`"]([^`"]+)/g)) {
    assert.match(m[1], /only/, m[1]);
  }
});

ok('a chain switched off in Settings is not offered', () => {
  assert.match(code, /AIO_CHAINS\.filter\(\(c\) => c === 'solana' \|\| settings\.evm\[c\]\.enabled\)/);
});

ok('a failed read says so and an unknown balance is a dash', () => {
  assert.match(code, /Could not read the balance: \{error\}/);
  assert.match(code, /info\.balanceSol != null \? `\$\{info\.balanceSol\.toFixed\(4\)\} SOL` : '—'/);
  // An unreadable wallet file is not "no wallet".
  assert.match(code, /if \(w\.failure\) return <NoWallet text=\{w\.failure\}/);
});

ok('it sits under the confirm dialogs and over everything else', () => {
  const z = /fixed inset-0 z-\[(\d+)\]/.exec(code);
  const modal = /fixed inset-0 z-\[(\d+)\]/.exec(read('src/state/ModalProvider.tsx'));
  assert.ok(Number(z[1]) < Number(modal[1]), 'a withdrawal confirm must open on top of the panel');
  assert.ok(Number(z[1]) > 50, 'and the panel over the drawers');
});

ok('trade hotkeys stay quiet, and Escape answers only the top dialog', () => {
  assert.match(code, /data-swallows-keys/);
  assert.ok(read('src/state/useHotkeys.ts').includes("closest('[data-swallows-keys]')"));
  assert.match(code, /onKeyDown=\{\(e\) => \{\s*\n\s*if \(e\.key === 'Escape'\) onClose\(\);/);
  assert.doesNotMatch(code, /document\.addEventListener|window\.addEventListener/);
});

ok('the copy tick means the address really is on the clipboard', () => {
  const common = read('src/components/common.tsx');
  const at = common.indexOf('export function Copyable');
  const body = common.slice(at, common.indexOf('</button>', at));
  assert.match(body, /writeText\(value\)\.then\(\s*\(\) => \{\s*setDone\(true\)/);
});

ok('the balance stays on screen when the bar is crowded', () => {
  assert.match(bar, /<div className="flex min-w-0 items-center gap-2\.5">/, 'the left side can give way');
  assert.match(bar, /<div className="flex flex-shrink-0 items-center gap-4">/, 'the money side never does');
  assert.match(read('src/components/terminal/TokenSearch.tsx'), /relative w-\[340px\] min-w-\[120px\]/);
  // Only the search box gives way: squeezed evenly, the chain switch clipped "All" to "A".
  assert.match(bar, /glass-btn inline-flex flex-shrink-0 rounded-lg/, 'the chain switch keeps its width');
  assert.match(bar, /flex flex-shrink-0 items-center gap-1\.5 rounded-md border border-white\/10/, 'and so does the Hub button');
});

ok('it asks for nothing secret and shows nothing secret', () => {
  assert.doesNotMatch(code, /secretEnc|privateKey|\.phrase\b|\.reveal\(|type="password"/i);
});

console.log(`walletpanel: ${n} passed`);
