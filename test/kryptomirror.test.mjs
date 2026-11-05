// Copy trading left this app on 2026-11-04 for its own, Krypto Mirror. Two
// things are pinned here: the Copy Trading row now leads to the advert with a
// working link, and nothing can quietly bring a follower back to life.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`ok  ${name}`);
};

// ── The page ─────────────────────────────────────────────────────────
{
  const links = src('../src/kryptoMirror.ts');
  assert.ok(links.includes("KRYPTO_MIRROR_URL = 'https://krypt.cc/mirror'"), 'the download link');

  const page = src('../src/pages/KryptoMirror.tsx');
  assert.ok(/openExternal\(KRYPTO_MIRROR_URL\)/.test(page), 'the button goes through main, which only opens https://');
  assert.ok(fs.existsSync(path.join(here, '../public/krypto-mirror.png')), 'the logo the page shows ships with the app');

  // An advert for a tool whose own research says copying loses on average.
  assert.ok(page.includes('0.5%'), 'the fee is on the page');
  assert.ok(page.includes('holder waiver'), 'and that the $KRYPTO waiver stays behind');
  assert.ok(page.includes('Not') && page.includes('financial advice'), 'not financial advice');
  assert.ok(/lost money on average/.test(page), 'the honest number');
  for (const claim of [/guarantee/i, /\bprofitable wallets\b/i, /winning wallets/i, /smart money/i, /fastest/i, /risk[- ]free/i]) {
    assert.ok(!claim.test(page), `no over-claim: ${claim}`);
  }

  // Someone updating with open copies has to be told their exits stopped.
  assert.ok(/nothing will sell it for you now/.test(page), 'a follower is told nothing sells for them now');
  assert.ok(/onOpenPortfolio/.test(page), 'and is given the way to the coins');
  ok('the page links out through main, states the fee and the risk, and tells a former follower what stopped');
}

// ── The route ────────────────────────────────────────────────────────
{
  const sidebar = src('../src/components/Sidebar.tsx');
  assert.ok(/\{ id: 'mirror', label: 'Copy Trading'/.test(sidebar), 'the row keeps the name people look for');
  assert.ok(!/'copysimple'/.test(sidebar), 'Copy Simple is gone from the sidebar');
  assert.ok(/mirror: \(\) => import\('\.\/pages\/KryptoMirror'\)/.test(src('../src/routeLoaders.ts')), 'the loader');
  const app = src('../src/App.tsx');
  assert.ok(/route === 'mirror' && <KryptoMirrorPage/.test(app), 'App renders it');
  assert.ok(!/WalletsPage|CopySimplePage/.test(app), 'the old pages are not rendered');

  const ws = src('../src/workspaces.ts');
  const routes = /routes: \['trader', 'scripts', 'mirror', [^\]]*\]/.exec(ws);
  assert.ok(routes, 'Automation lands on a tool, with the advert beside it');
  ok('Automation lists the Copy Trading row and lands on a tool');
}

// ── Nothing left that can trade off another wallet ───────────────────
{
  for (const gone of ['electron/engine/copyTrade.ts', 'electron/engine/walletWatcher.ts', 'electron/engine/leaderFeedFrames.ts', 'shared/copytrade.ts', 'src/pages/Wallets.tsx', 'src/pages/CopySimple.tsx']) {
    assert.ok(!fs.existsSync(path.join(here, '..', gone)), `${gone} is gone`);
  }
  const engine = src('../electron/engine/engine.ts');
  assert.ok(!/copyTrade\.|walletWatcher\./.test(engine), 'the engine calls neither');
  assert.ok(!/copyTrade\.|'copy:/.test(src('../electron/ipc.ts')), 'no copy channel in main');
  assert.ok(!/'copy:/.test(src('../electron/preload.ts')), 'no copy channel in the bridge');
  assert.ok(!/copyTrade\./.test(src('../electron/evm/scanner.ts')), 'the EVM scanner hands nothing to a copier');
  assert.ok(!/copyTrade\./.test(src('../electron/main.ts')), 'and main starts none');
  // The bridge outlived the feature: it is how scripts and orders reach the EVM rails.
  assert.ok(src('../electron/ipc.ts').includes('getEngine().setEvmCopy({'), 'the EVM bridge stays wired');
  ok('no copier, no leader watcher, no copy channel; the EVM bridge stays');
}

console.log(`\nkryptomirror: ${passed}/${passed} passed`);
