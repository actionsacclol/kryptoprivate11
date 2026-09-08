// Scripts, end to end, in the RUNNING app.
//
// Start the app with the DevTools port open (KRYPT_DEBUG_PORT=9333 npm run dev),
// then `npm run test:scripts:e2e`. This drives window.krypt.automation over the
// Chrome DevTools Protocol exactly as the Scripts page does: saves a paper code
// script and a paper rule, enables them, starts the scanner, and watches them
// run against the LIVE launch feed — sandbox up, launches and updates delivered,
// the rule firing, paper buys booked through the simulated-fill path, a paper
// sell through the script API, a self-disable, cleanup.
//
// Side effects on the dev profile: up to two 0.005 SOL PAPER positions and one
// 50 % paper sell (no real SOL moves; paper buys need a wallet to exist). The
// scripts it creates are removed at the end. First green: 2026-09-08.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1|index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error(`no page target: ${JSON.stringify(list.map((t) => [t.type, t.url]))}`);
  out('target:', page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const call = (method, params) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

const { evaluate, close } = await connect();
const checks = {};
const note = (k, v, extra = '') => {
  checks[k] = !!v;
  out(`${v ? 'ok  ' : 'FAIL'} ${k}${extra ? ' — ' + extra : ''}`);
};

try {
  const snap0 = await evaluate('window.krypt.automation.list()');
  note('automation IPC answers', snap0.ok, `${snap0.data?.scripts.length ?? '?'} scripts, kill switch ${snap0.data?.killSwitch}`);

  // 1. A paper CODE script: logs launches, runs a timer, reads the wallet, subscribes and prices.
  const code = `
    bot.on('launch', (t) => bot.log('LAUNCH ' + t.symbol + ' score=' + t.score + ' buyers=' + t.uniqueBuyers));
    bot.on('launchUpdate', (t) => { if (t.uniqueBuyers !== null && t.uniqueBuyers >= 3) bot.log('UPDATE ' + t.symbol + ' buyers=' + t.uniqueBuyers + ' held=' + t.held); });
    bot.every(5, async () => {
      const w = await bot.wallet();
      const ps = await bot.positions();
      bot.log('TIMER wallet=' + (w.sol === null ? 'null' : w.sol.toFixed(3)) + ' positions=' + ps.length);
    });
    bot.log('loaded');
  `;
  const saveCode = await evaluate(`window.krypt.automation.save(${JSON.stringify({
    name: 'E2E code',
    kind: 'code',
    mode: 'paper',
    code,
    rules: { trigger: 'launch', conditions: [], actions: [{ type: 'log', message: 'x' }], oncePerMint: true, cooldownSec: 0 },
    budget: { maxSolPerTrade: 0.01, maxBuysPerDay: 2, maxLossSolPerDay: 0.1, maxOpenPositions: 2, maxActionsPerMinute: 30 },
  })})`);
  note('code script saved (paper, off)', saveCode.ok, saveCode.message);
  const codeId = saveCode.data?.scripts.find((s) => s.name === 'E2E code')?.id;

  // 2. A paper RULE: on a launch update with a few buyers, paper-buy 0.005 SOL once per token, twice a day at most.
  const saveRule = await evaluate(`window.krypt.automation.save(${JSON.stringify({
    name: 'E2E rule',
    kind: 'rules',
    mode: 'paper',
    code: '',
    rules: { trigger: 'launch_update', conditions: [{ field: 'uniqueBuyers', op: 'gte', value: 3 }, { field: 'hardRisk', op: 'is_false', value: '' }], actions: [{ type: 'buy', sol: 0.005 }, { type: 'log', message: '{symbol} bought at {priceSol} with {uniqueBuyers} buyers' }], oncePerMint: true, cooldownSec: 0 },
    budget: { maxSolPerTrade: 0.01, maxBuysPerDay: 2, maxLossSolPerDay: 0.1, maxOpenPositions: 2, maxActionsPerMinute: 30 },
  })})`);
  note('rule saved (paper, off)', saveRule.ok, saveRule.message);
  const ruleId = saveRule.data?.scripts.find((s) => s.name === 'E2E rule')?.id;

  const on1 = await evaluate(`window.krypt.automation.setEnabled(${JSON.stringify(codeId)}, true)`);
  const on2 = await evaluate(`window.krypt.automation.setEnabled(${JSON.stringify(ruleId)}, true)`);
  note('both enabled', on1.ok && on2.ok, `${on1.message} / ${on2.message}`);
  await sleep(2500);
  let snap = await evaluate('window.krypt.automation.list()');
  note('code sandbox running in the real app', snap.data.stats[codeId]?.running, JSON.stringify(snap.data.logs[codeId]?.map((l) => l.line)));

  // 3. Start the scanner so the feed produces launches, then watch.
  const started = await evaluate('window.krypt.engine.start()');
  out('engine.start:', JSON.stringify(started));
  const deadline = Date.now() + 90_000;
  let sawLaunch = false, sawTimer = false, sawFire = false, sawPaperBuy = false, sawUpdate = false;
  while (Date.now() < deadline) {
    await sleep(5000);
    snap = await evaluate('window.krypt.automation.list()');
    const cl = (snap.data.logs[codeId] ?? []).map((l) => l.line);
    const rl = (snap.data.logs[ruleId] ?? []).map((l) => l.line);
    sawLaunch ||= cl.some((l) => l.startsWith('LAUNCH '));
    sawUpdate ||= cl.some((l) => l.startsWith('UPDATE '));
    sawTimer ||= cl.some((l) => l.startsWith('TIMER '));
    sawFire ||= rl.some((l) => /^fired on/.test(l));
    sawPaperBuy ||= rl.some((l) => /^PAPER buy .*Paper position opened|^PAPER buy/.test(l));
    out(`  t+${Math.round((90_000 - (deadline - Date.now())) / 1000)}s code=${cl.length} rule=${rl.length} launch=${sawLaunch} update=${sawUpdate} timer=${sawTimer} fired=${sawFire} paperBuy=${sawPaperBuy}`);
    if (sawLaunch && sawTimer && sawFire && sawPaperBuy && sawUpdate) break;
  }
  note('code script saw launches', sawLaunch);
  note('code script saw launch updates', sawUpdate);
  note('code script timer + wallet + positions reads', sawTimer);
  note('rule fired on a launch update', sawFire);
  note('rule PAPER buy went through the simulated-fill path', sawPaperBuy);
  const rl = (snap.data.logs[ruleId] ?? []).map((l) => l.line);
  out('rule log tail:', JSON.stringify(rl.slice(-6), null, 1));
  const cl = (snap.data.logs[codeId] ?? []).map((l) => l.line);
  out('code log tail:', JSON.stringify(cl.slice(-6), null, 1));
  out('stats:', JSON.stringify({ code: snap.data.stats[codeId], rule: snap.data.stats[ruleId] }));

  const port = await evaluate('window.krypt.portfolio.summary()');
  const paperPos = port.data?.paper?.positions ?? [];
  note('paper positions exist for what the rule bought', paperPos.length >= 1, `${paperPos.length} paper position(s): ${paperPos.map((p) => p.symbol || p.mint.slice(0, 6)).join(', ')}`);
  note('no script errors', (snap.data.stats[codeId]?.errorsInARow ?? 0) === 0 && (snap.data.stats[ruleId]?.errorsInARow ?? 0) === 0, `last errors: ${snap.data.stats[codeId]?.lastError} / ${snap.data.stats[ruleId]?.lastError}`);

  // 4. A paper sell through the script API on what the rule bought (sell 50 %), then cleanup.
  if (paperPos.length) {
    const mint = paperPos[0].mint;
    await evaluate(`window.krypt.automation.save(${JSON.stringify({ id: undefined, name: 'E2E seller', kind: 'code', mode: 'paper', code: `bot.every(5, async () => { const r = await bot.sell(${JSON.stringify(mint)}, 50); bot.log('SELL ' + JSON.stringify(r)); await bot.disable('done'); });`, rules: { trigger: 'launch', conditions: [], actions: [{ type: 'log', message: 'x' }], oncePerMint: true, cooldownSec: 0 }, budget: { maxSolPerTrade: 0.01, maxBuysPerDay: 2, maxLossSolPerDay: 0.1, maxOpenPositions: 2, maxActionsPerMinute: 30 } })})`);
    const s3 = await evaluate('window.krypt.automation.list()');
    const sellerId = s3.data.scripts.find((s) => s.name === 'E2E seller')?.id;
    await evaluate(`window.krypt.automation.setEnabled(${JSON.stringify(sellerId)}, true)`);
    await sleep(9000);
    const s4 = await evaluate('window.krypt.automation.list()');
    const sl = (s4.data.logs[sellerId] ?? []).map((l) => l.line);
    note('paper SELL 50% through the script API', sl.some((l) => /^SELL .*"ok":true/.test(l)), JSON.stringify(sl.slice(-3)));
    note('script disabled itself', s4.data.scripts.find((s) => s.id === sellerId)?.enabled === false);
    await evaluate(`window.krypt.automation.remove(${JSON.stringify(sellerId)})`);
  }

  await evaluate(`window.krypt.automation.setEnabled(${JSON.stringify(codeId)}, false)`);
  await evaluate(`window.krypt.automation.setEnabled(${JSON.stringify(ruleId)}, false)`);
  const rm1 = await evaluate(`window.krypt.automation.remove(${JSON.stringify(codeId)})`);
  const rm2 = await evaluate(`window.krypt.automation.remove(${JSON.stringify(ruleId)})`);
  note('cleanup: scripts removed', rm1.ok && rm2.ok);
  const stopped = await evaluate('window.krypt.engine.stop()');
  out('engine.stop:', JSON.stringify(stopped));
} catch (err) {
  out('E2E ERROR:', err.message);
  checks.error = false;
} finally {
  close();
}
const all = Object.values(checks).every(Boolean);
out(all ? 'E2E: PASS' : 'E2E: FAIL');
process.exit(all ? 0 : 1);
