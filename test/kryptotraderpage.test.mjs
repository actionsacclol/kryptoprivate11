// The Krypto Trader page (stage 2, 2026-09-25), pinned from source — the
// scriptspage.test.mjs pattern. What it pins is the design's page contract
// (docs/krypto-trader-2026-09-25.md §1) and the user's 09-25 decisions:
//   - the honest strip is the shared constant, on top;
//   - Start is paper only, and the one start button; going live is a separate,
//     confirmed action on a session;
//   - no market-cap / volume / price-target goal anywhere on the page;
//   - every pacing limit is the user's, and the anti-wash amber line is the
//     shared constant;
//   - the entry notice (critic #7) sits BEFORE Start and holds it back;
//   - "Sell session bag" is on every row, whatever the state;
//   - unknown renders as an em dash.

import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const page = read('src/pages/KryptoTrader.tsx');
const sessions = read('src/components/trader/TraderSessions.tsx');
const fit = read('src/components/trader/FitCheck.tsx');
const preset = read('src/components/trader/PresetCard.tsx');
const limits = read('src/components/trader/LimitsFields.tsx');
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const all = [page, sessions, fit, preset, limits].map(code).join('\n');

{
  const strip = page.indexOf('{TRADER_HONEST_STRIP}');
  assert.ok(strip > 0, 'the honest strip renders the shared constant');
  assert.ok(strip < page.indexOf('<FitCheck'), 'above the form');
  assert.match(fit, /\{fit\.noForecastLine\}/, 'the fit card leads with the no-forecast line');
  assert.match(fit, /\{fit\.forwardLine\}/, 'and ends with the pinned forward line');
  ok('the honest strip and the fit card wording come from shared/kryptoTrader.ts');
}

{
  assert.match(page, /\{starting \? 'Starting…' : 'Start \(paper\)'\}/, 'the one start button says paper');
  assert.match(page, /window\.krypt\.kryptoTrader\.open\(options\)/, 'Start calls open');
  // No live flag goes to open; live is its own call behind a confirm.
  assert.ok(!/\blive\s*:/.test(code(page)), 'the page never sends a live flag');
  assert.ok(!/goLive/.test(code(page)), 'the form has no go-live path');
  const goLive = sessions.indexOf("if (what === 'goLive')");
  assert.ok(goLive > 0 && sessions.indexOf('modal.confirm', goLive) - goLive < 200, 'Go live asks first');
  ok('paper first: Start (paper) is the only start; going live is a confirmed action on a session');
}

{
  for (const bad of [/marketcap/i, /market_cap/i, /targetPrice/i, /volumeTarget/i, /\bgoal\b/i, /'support'/, /KRYPTO_GOAL_TEXT/, /kryptoMode\./]) {
    assert.ok(!bad.test(all), `no ${bad} in the Krypto Trader UI code`);
  }
  ok('no goal, market-cap, volume or price-target control anywhere on the page');
}

{
  assert.match(limits, /\{TRADER_ANTIWASH_LINE\}/, 'the amber line is the shared constant');
  assert.match(limits, /traderAntiWashOff\(limits\)\.length > 0 && <AntiWashLine \/>/, 'shown in the form when an anti-wash limit is off');
  assert.match(sessions, /d\.antiWashOff\.length > 0 &&/, 'and on a session row from row.derived.antiWashOff');
  assert.match(limits, /Object\.keys\(TRADER_LIMIT_TEXT\)/, 'every limit is editable, labelled from the shared text');
  assert.match(limits, /onCommit\(nullable \? null : 0\)/, 'empty = off (or per coin for the move limit), never a silent default');
  assert.match(sessions, /window\.krypt\.kryptoTrader\.setLimits\(s\.id, limits\)/, 'a running session’s limits are editable');
  ok('pacing is the user’s, 0 = off, with the shared anti-wash line');
}

{
  const notice = page.indexOf('data-entry-notice');
  const start = page.indexOf('<PrimaryButton onClick={() => void start()}');
  assert.ok(notice > 0 && notice < start, 'the entry notice sits before Start');
  assert.match(page, /const acked = notice === null \|\| ackNotice === notice;/, 'it must be acknowledged');
  assert.match(page, /const canStart = [^;]*acked;/, 'and Start waits for that');
  assert.match(page, /fit\?\.greyed\[preset\]/, 'a greyed preset blocks Start');
  assert.match(page, /fit\.refusals/, 'and so does a refusal');
  ok('the entry notice is shown before Start and holds it back (critic #7)');
}

{
  const row = sessions.slice(sessions.indexOf('rows.map((s) =>'));
  assert.match(row, /<Btn onClick=\{\(\) => void act\(s, 'sellAll'\)\} busy=\{b\('sellAll'\)\}>Sell session bag<\/Btn>/, 'Sell session bag is unconditional');
  for (const a of ['pause', 'resume', 'goLive', 'reconcile', 'adopt', 'remove']) assert.ok(row.includes(`act(s, '${a}')`), `${a} is on the row`);
  assert.match(row, /Edit envelope/);
  assert.match(row, /Edit limits/);
  assert.match(row, /vs just holding/);
  assert.match(row, /Fees paid/);
  assert.match(row, /Gross P&L/);
  ok('the session row carries every control, and Sell session bag in every state');
}

{
  // Unknown renders as an em dash; no `?? 0` fallback on a figure.
  assert.match(sessions, /const DASH = '—';/);
  assert.match(fit, /const DASH = '—';/);
  assert.ok(!/\?\? 0\b/.test(code(sessions)) && !/\?\? 0\b/.test(code(fit)), 'no unknown silently shown as 0');
  ok('unknown is an em dash, never 0');
}

{
  // Stage 4: the chain picker is live for all three chains; the wallet list,
  // the fit check and every money label follow it.
  assert.ok(!/Solana only for now/.test(page), 'no "Solana only" label any more');
  assert.match(page, /data-chain-picker/);
  for (const c of ["id: 'solana'", "id: 'robinhood'", "id: 'bnb'"]) assert.ok(page.includes(c), `the picker offers ${c}`);
  assert.match(page, /walletsFor\(chain\)/, 'the wallet list follows the chain');
  assert.match(page, /walletVisibleOn\(w, chain\)/, 'EVM: only that chain’s wallets (evm-wallet-home-chain)');
  assert.match(page, /\.fit\(options\.mint, \{ chain,/, 'the fit check is asked on the chosen chain');
  assert.match(page, /label=\{`Budget \(\$\{money\.symbol\}\)`\}/, 'the budget is labelled in the chain’s coin');
  assert.match(page, /min=\{money\.minBudget\} max=\{money\.maxBudget\} suffix=\{money\.symbol\}/, 'and bounded per chain');
  assert.ok(!/'SOL'|" SOL|SOL\)/.test(code(page).replace(/Money in SOL/g, '')), 'no hard-coded SOL money label on the page');
  assert.match(sessions, /const u = traderMoney\(s\.options\.chain\)\.symbol;/, 'each session row labels money in its chain’s coin');
  assert.match(fit, /const sol = money\(fit\.native\);/, 'the fit card too');
  assert.match(preset, /traderNativeText\(t\.rule, chain\)/, 'and the preset rules');
  assert.ok(!/DRIVER_NEXT_STAGE|next stage/.test(page), 'stage 3: the AI and MCP drivers are live, no "next stage" note');
  assert.match(page, /DRIVER_NOTE\[driver\]/, 'each non-preset driver says what it does before Start');
  assert.match(page, /useState\(\(\) => peekTraderPrefill\(\)\)/, 'the page reads the coin handed from Token/Runners on its first render…');
  assert.match(page, /useEffect\(\(\) => \{\s*clearTraderPrefill\(prefill\);\s*\}, \[prefill\]\);/, '…and clears it only once mounted');
  ok('three chains in the picker, drivers labelled honestly, prefill taken once');
}

{
  // Stage 3: the AI driver's model, cost and spend cap are on the form; the
  // session row shows the model, spend today, the estimate and the last answer.
  assert.match(page, /TRADER_AI_MODELS\.filter\(\(m\) => keys\[m\.provider\]\)/, 'the model picker offers only models whose provider has a key');
  assert.match(page, /traderAiCostEstimate\(aiPick\.model, limits\)/, 'the estimate follows the model and the AI pacing');
  assert.match(page, /\/hour/);
  assert.match(page, /\/day/);
  assert.match(page, /AI spend cap per day \(USD\)/);
  assert.match(page, /The AI driver needs an OpenAI or Anthropic key/, 'no key → Start is held with the reason');
  assert.match(sessions, /data-ai-strip/);
  assert.match(sessions, /spent today/);
  assert.match(sessions, /a\.pausedReason/, 'the spend-cap pause is shown');
  assert.match(sessions, /Last answer/);
  assert.match(sessions, /t\.reason/, 'every trade line carries its reason — for the AI, the model’s own');
  assert.match(sessions, /data-mcp-strip/);
  assert.match(limits, /AI_ONLY/, 'the AI pacing limits show for the AI driver');
  ok('AI driver on the page: model from configured keys, $/hour and $/day, daily cap; the row shows spend, estimate and the last AI answer');
}

// ── review #20: the handed-over coin survives a discarded transition render ─
{
  const P = await import('./.traderprefill.mjs');
  P.setTraderPrefill('0xabc', 'bnb');
  const first = P.peekTraderPrefill();
  // React throws the half-rendered page away and renders it again: the
  // second render's initializer must still see the coin.
  const second = P.peekTraderPrefill();
  assert.deepEqual(second, { mint: '0xabc', chain: 'bnb' }, 'reading in render does not use it up');
  P.clearTraderPrefill(second);
  assert.equal(P.peekTraderPrefill(), null, 'cleared once the page has mounted');
  P.setTraderPrefill('0xdef', 'robinhood');
  P.clearTraderPrefill(first);
  assert.deepEqual(P.peekTraderPrefill(), { mint: '0xdef', chain: 'robinhood' }, 'a stale clear never drops a newer click');
  assert.ok(!/takeTraderPrefill|pending = null;\s*return m/.test(read('src/state/traderPrefill.ts')), 'no read-and-clear left');
  ok('review #20: the prefill is peeked in render and cleared after mount');
}

// ── review #21–#24 and #3 on the page ─────────────────────────────────────
{
  const guard = page.slice(page.indexOf('if (!mintOk) {'), page.indexOf('const my = ++seq.current;'));
  assert.ok(/\+\+seq\.current;[\s\S]*return;/.test(guard), '#21: an invalid/empty coin drops any fit answer still in flight');
  assert.match(page, /no buy-back within \{secsOrMins\(limits\.noRebuySec\)\} of a sell/, '#23: the summary never rounds 20 s to "0 min"');
  assert.match(page, /const secsOrMins = \(sec: number\): string => \(sec < 60 \|\| sec % 60 !== 0 \? `\$\{sec\} s` : `\$\{sec \/ 60\} min`\);/);
  assert.match(page, /\{!showLimits && traderAntiWashOff\(limits\)\.length > 0 && \(/, '#23: the amber line shows with the limits collapsed');
  assert.match(sessions, /\{d\.priceStale && \(s\.status === 'running' \|\| heldRaw\) && \(/, '#22: a paused/stopped row with a bag shows its price is stale');
  assert.match(sessions, /const isToday = s\.aiSpend\.day === today;/);
  assert.match(sessions, /\{isToday && a && a\.asksToday > 0 \?/, '#24: yesterday’s ask count is not shown as today’s');
  assert.match(sessions, /\{isToday && a\?\.pausedReason && /, '#24: nor yesterday’s cap pause');
  assert.match(sessions, /\{!stuck && s\.mode === 'live' && heldRaw && s\.status !== 'running' && \(/, '#3: Fit to wallet is on a live row holding a bag');
  assert.match(sessions, /Fit to wallet…/);
  ok('review #21–#24 + #3: stale fit answers dropped, honest pacing summary + amber line, stale price and AI day on paused rows, Fit to wallet');
}

console.log(`\nkryptotraderpage: ${passed}/${passed} passed`);
