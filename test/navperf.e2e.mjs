// Navigation-latency driver (2026-09-08). Read-only: clicks sidebar buttons
// and one token card in a RUNNING dev app and measures, inside the renderer,
// how long each panel takes to show its heading ("shell") and to go quiet
// ("ready": 400 ms without DOM mutations and no spinner / Loading text).
//
//   KRYPT_DEBUG_PORT=9333 npm run dev      (accept the onboarding gate once)
//   npm run test:nav:e2e -- [out.json]     (PORT=… to override the port)
//
// The route on screen is the VISIBLE child of <main>: Discover stays mounted
// (aria-hidden) beside the keyed route div, so heading / fallback / node
// counts ignore the hidden wrapper. Baseline and after-numbers live in
// docs/nav-speed-2026-09-08.md.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const OUT = process.argv[2] || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1|index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  out('target:', page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

const HARNESS = `
(() => {
  if (window.__nav) return 'already';
  const longTasks = [];
  let ltSupported = false;
  try {
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration }); });
    po.observe({ type: 'longtask', buffered: true });
    ltSupported = true;
  } catch (e) {}
  try { performance.setResourceTimingBufferSize(20000); } catch (e) {}
  const mainEl = () => document.querySelector('main');
  // The route on screen: <main> holds the Discover wrapper (aria-hidden when
  // another route is up) and then the keyed route div.
  const visibleRoot = (m) => [...m.children].find((c) => c.getAttribute('aria-hidden') !== 'true') ?? m;
  const hiddenWrap = (m) => [...m.children].find((c) => c.getAttribute('aria-hidden') === 'true') ?? null;
  const heading = (m) => { const h = visibleRoot(m).querySelector('h1'); return h ? h.textContent.trim() : null; };
  const suspenseFallback = (m) => {
    const r = visibleRoot(m); if (r === m) return false;
    const fb = r.firstElementChild; if (!fb) return false;
    return !!(fb.matches && fb.matches('div.flex.h-full.items-center.justify-center') && fb.querySelector(':scope > svg.animate-spin'));
  };
  const LOADING_RE = /Loading…|Reading the chain…|Reading…|Loading/;
  const blockers = (m) => {
    const b = [];
    const r = visibleRoot(m);
    const t = r.textContent || '';
    const mm = t.match(LOADING_RE); if (mm) b.push('text:' + mm[0]);
    if (r.querySelector('svg.animate-spin')) b.push('spinner');
    return b;
  };
  const findBtn = (label) => [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === label);
  const gated = () => !!document.querySelector('div.contents[inert]');
  const pendingBar = () => !!document.querySelector('div.h-0\\\\.5.animate-pulse');

  async function measure(label, clickFn) {
    const m = mainEl();
    const prevHeading = heading(m);
    let mutations = 0; let lastMut = performance.now();
    const mo = new MutationObserver((recs) => {
      const hw = hiddenWrap(m);
      const live = hw ? recs.filter((r) => !hw.contains(r.target)) : recs;
      if (live.length) { mutations += live.length; lastMut = performance.now(); }
    });
    mo.observe(m, { subtree: true, childList: true, characterData: true, attributes: true });
    const ltIdx = longTasks.length;
    const t0 = performance.now();
    const clickInfo = clickFn();
    const deadline = t0 + 8000;
    let tShell = null, shellTimeout = false, sawFallback = false, fallbackGoneAt = null, newHeading = null, sawPending = false, pendingGoneAt = null;
    await new Promise((res) => {
      const tick = () => {
        const now = performance.now();
        const fb = suspenseFallback(m);
        if (fb) sawFallback = true; else if (sawFallback && fallbackGoneAt === null) fallbackGoneAt = now;
        const pb = pendingBar();
        if (pb) sawPending = true; else if (sawPending && pendingGoneAt === null) pendingGoneAt = now;
        const h = heading(m);
        if (h && h !== prevHeading && !fb) { tShell = now; newHeading = h; return res(); }
        if (now > deadline) { shellTimeout = true; newHeading = h; return res(); }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    let tReady = null, readyTimeout = false, lastBlockers = [];
    await new Promise((res) => {
      const tick = () => {
        const now = performance.now();
        const b = blockers(m);
        lastBlockers = b;
        if (now - lastMut >= 400 && b.length === 0) { tReady = now; return res(); }
        if (now > deadline) { readyTimeout = true; return res(); }
        setTimeout(tick, 40);
      };
      setTimeout(tick, 40);
    });
    const tEnd = performance.now();
    mo.disconnect();
    const lastMutRel = lastMut - t0;
    await new Promise((r) => setTimeout(r, 60));
    const lts = longTasks.slice(ltIdx).filter((e) => e.start >= t0 - 50 && e.start <= tEnd);
    const res = performance.getEntriesByType('resource').filter((e) => e.startTime >= t0 - 5 && e.startTime <= tEnd);
    const js = res.filter((e) => /\\.(js|mjs|ts|tsx|jsx)(\\?|$)/.test(e.name) || /\\/node_modules\\/\\.vite\\//.test(e.name)).map((e) => ({ name: e.name.replace(/^https?:\\/\\/[^/]+/, ''), dur: Math.round(e.duration * 10) / 10, start: Math.round((e.startTime - t0) * 10) / 10 }));
    const other = res.filter((e) => !js.some((j) => e.name.endsWith(j.name))).length;
    return {
      label, clickInfo, prevHeading, newHeading, gated: gated(),
      shellMs: tShell === null ? null : Math.round((tShell - t0) * 10) / 10,
      readyMs: tReady === null ? null : Math.round((tReady - t0) * 10) / 10,
      shellTimeout, readyTimeout, lastBlockers, sawFallback, sawPending,
      fallbackGoneMs: fallbackGoneAt === null ? null : Math.round((fallbackGoneAt - t0) * 10) / 10,
      pendingGoneMs: pendingGoneAt === null ? null : Math.round((pendingGoneAt - t0) * 10) / 10,
      lastMutationMs: Math.round(lastMutRel * 10) / 10, mutations,
      ltSupported, longTasks: lts.map((e) => ({ start: Math.round(e.start - t0), dur: Math.round(e.dur) })), longTasksMs: Math.round(lts.reduce((a, e) => a + e.dur, 0)),
      jsCount: js.length, jsTotalMs: Math.round(js.reduce((a, e) => a + e.dur, 0)), jsTop: js.sort((a, b) => b.dur - a.dur).slice(0, 12), otherResources: other,
      mainNodes: visibleRoot(m).querySelectorAll('*').length,
    };
  }

  window.__nav = {
    gated, ltSupported,
    labels: () => [...document.querySelectorAll('aside button')].map((b) => b.textContent.trim()),
    go: (label) => measure(label, () => { const b = findBtn(label); if (!b) throw new Error('no button ' + label); b.click(); return 'button:' + label; }),
    openToken: (preferSymbol) => measure('Token', () => {
      const m = mainEl();
      const cards = [...visibleRoot(m).querySelectorAll('[role="button"].card')];
      if (!cards.length) throw new Error('no token cards');
      let card = preferSymbol ? cards.find((c) => c.querySelector('span.font-semibold')?.textContent.trim() === preferSymbol) : null;
      if (!card) card = cards[0];
      const sym = card.querySelector('span.font-semibold')?.textContent.trim();
      card.click();
      return 'card:' + sym + ' (of ' + cards.length + ')';
    }),
    cardCount: () => visibleRoot(mainEl()).querySelectorAll('[role="button"].card').length,
    heading: () => heading(mainEl()),
    ipcProbe: async (name, fn) => { const t = performance.now(); let ok = null; try { const r = await fn(); ok = r && typeof r === 'object' && 'ok' in r ? r.ok : true; } catch (e) { ok = 'throw:' + e.message; } return { name, ms: Math.round((performance.now() - t) * 10) / 10, ok }; },
  };
  return 'installed lt=' + ltSupported;
})()
`;

const ROUTES = ['Watchlist', 'Runners', 'Trades', 'Orders', 'Portfolio', 'Wallet', 'Observatory', 'Copy Trading', 'Scripts', 'Launches'];

const { evaluate, close } = await connect();
const result = { startedAt: new Date().toISOString(), cold: [], warm: [], probes: {}, notes: [] };
try {
  out(await evaluate(HARNESS));
  out('gated:', await evaluate('window.__nav.gated()'));
  out('labels:', JSON.stringify(await evaluate('window.__nav.labels()')));
  out('heading now:', await evaluate('window.__nav.heading()'));

  const probe = async (tag) => {
    const list = await evaluate(`(async () => {
      const P = window.__nav.ipcProbe;
      const r = [];
      for (let i = 0; i < 3; i++) r.push(await P('settings.get', () => window.krypt.settings.get()));
      r.push(await P('engine.snapshot', () => window.krypt.engine.snapshot()));
      r.push(await P('portfolio.summary(stale)', () => window.krypt.portfolio.summary({ stale: true })));
      r.push(await P('portfolio.summary', () => window.krypt.portfolio.summary()));
      r.push(await P('portfolio.history', () => window.krypt.portfolio.history()));
      r.push(await P('orders.list', () => window.krypt.orders.list()));
      r.push(await P('wallet.info', () => window.krypt.wallet.info()));
      r.push(await P('wallet.holdings', () => window.krypt.wallet.holdings()));
      r.push(await P('wallet.list', () => window.krypt.wallet.list()));
      r.push(await P('live.state', () => window.krypt.live.state()));
      r.push(await P('copy.list', () => window.krypt.copy.list()));
      r.push(await P('watchlist.get', () => window.krypt.watchlist.get()));
      r.push(await P('automation.list', () => window.krypt.automation.list()));
      r.push(await P('recorder.stats', () => window.krypt.recorder.stats()));
      r.push(await P('market.providers', () => window.krypt.market.providers()));
      r.push(await P('wallet.refreshBalance', () => window.krypt.wallet.refreshBalance()));
      return r;
    })()`);
    result.probes[tag] = list;
    out(`probe ${tag}:`, list.map((p) => `${p.name}=${p.ms}ms(${p.ok})`).join(' '));
  };

  const runPass = async (tag, preferSymbol) => {
    const rows = [];
    for (const label of ROUTES) {
      const r = await evaluate(`window.__nav.go(${JSON.stringify(label)})`);
      rows.push(r);
      out(`[${tag}] ${label.padEnd(13)} shell=${String(r.shellMs).padStart(7)} ready=${String(r.readyMs).padStart(7)} ${r.shellTimeout ? 'SHELL-TIMEOUT ' : ''}${r.readyTimeout ? 'READY-TIMEOUT(' + r.lastBlockers + ') ' : ''}js=${r.jsCount}/${r.jsTotalMs}ms lt=${r.longTasksMs}ms mut=${r.mutations} lastMut=${r.lastMutationMs} pend=${r.sawPending ? r.pendingGoneMs : '-'} h="${r.newHeading}" nodes=${r.mainNodes}`);
      await sleep(600);
    }
    const d = await evaluate(`window.__nav.go('Discover')`);
    rows.push(d);
    out(`[${tag}] Discover      shell=${d.shellMs} ready=${d.readyMs} ${d.readyTimeout ? 'READY-TIMEOUT(' + d.lastBlockers + ') ' : ''}js=${d.jsCount}/${d.jsTotalMs}ms lt=${d.longTasksMs}ms mut=${d.mutations} lastMut=${d.lastMutationMs} nodes=${d.mainNodes}`);
    let cards = 0;
    for (let i = 0; i < 20 && !cards; i++) { cards = await evaluate('window.__nav.cardCount()'); if (!cards) await sleep(500); }
    if (!cards) { rows.push({ label: 'Token', skipped: 'no token cards within 10 s' }); out(`[${tag}] Token skipped: no cards`); }
    else {
      const t = await evaluate(`window.__nav.openToken(${JSON.stringify(preferSymbol ?? null)})`);
      rows.push(t);
      out(`[${tag}] Token         shell=${t.shellMs} ready=${t.readyMs} ${t.shellTimeout ? 'SHELL-TIMEOUT ' : ''}${t.readyTimeout ? 'READY-TIMEOUT(' + t.lastBlockers + ') ' : ''}js=${t.jsCount}/${t.jsTotalMs}ms lt=${t.longTasksMs}ms mut=${t.mutations} lastMut=${t.lastMutationMs} ${t.clickInfo} h="${t.newHeading}"`);
    }
    return rows;
  };

  await probe('before');
  result.cold = await runPass('cold');
  await sleep(1500);
  const sym = result.cold.find((r) => r.label === 'Token' && r.clickInfo)?.clickInfo?.match(/^card:(\S+)/)?.[1] ?? null;
  result.warm = await runPass('warm', sym);
  await probe('after');
  const back = await evaluate(`window.__nav.go('Discover')`);
  out('back to Discover:', back.shellMs, back.readyMs);
  result.notes.push(`token symbol cold=${sym}`);
} catch (err) {
  out('DRIVER ERROR:', err.message);
  result.error = err.message;
} finally {
  close();
}
if (OUT) {
  writeFileSync(OUT, JSON.stringify(result, null, 1));
  out('wrote', OUT);
}
