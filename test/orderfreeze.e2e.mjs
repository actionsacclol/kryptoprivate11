// Does an armed order stall the chart? Live (2026-09-20), after a user
// report: "when I have set a buy or sell order … the graph and tickers all
// freeze and get stuck until I cancel it." Attaches to a RUNNING dev app,
// opens an active token, counts the live chart ticks the page receives for
// 40 s, arms a limit buy that can never fire (1 % of the price), counts for
// 60 s, cancels it, counts again. It also times the renderer's round trip in
// each phase and keeps every warning main logged. The one order it creates
// is cancelled before it exits.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   MINT=<active mint> node test/orderfreeze.e2e.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const MINT = process.env.MINT || 'sdyKwWzC8EnriZWBBwm8YX25nKGmtQdZAHBEGLUpump';
const PHASE_A = Number(process.env.PHASE_A || 40_000);
const PHASE_B = Number(process.env.PHASE_B || 60_000);
const PHASE_C = Number(process.env.PHASE_C || 40_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1|index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const call = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error) throw new Error(JSON.stringify(r.error));
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  return { call, evaluate, close: () => ws.close() };
}

const { call, evaluate, close } = await connect();
let orderId = null;
try {
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  const typed = await evaluate(`(() => { const i=document.querySelector('input[placeholder="Search or paste a contract address…"]'); if(!i) return false; const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, ${JSON.stringify(MINT)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return true; })()`);
  if (!typed) throw new Error('no search box');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  let heading = null;
  for (let i = 0; i < 40; i++) {
    heading = await evaluate(`(() => { const m=document.querySelector('main'); if(!m) return null; const root=[...m.children].find((c) => c.getAttribute('aria-hidden') !== 'true') ?? m; const h=root.querySelector('h1'); return h ? h.textContent.trim() : null; })()`);
    if (heading && !/Discover|Hub/i.test(heading)) break;
    await sleep(500);
  }
  out('token page:', heading);
  // The collector: chart ticks for this mint, order pushes, everything main
  // logged above info, and the last tick's time.
  await evaluate(`(() => {
    if (window.__kf) { try { window.__kfOff(); } catch {} }
    window.__kf = { ticks: 0, orders: 0, status: 0, logs: [], lastTick: 0, candles: 0 };
    window.__kfOff = window.krypt.engine.onEvent((ev) => {
      const k = window.__kf;
      if (ev.kind === 'tick' && ev.mint === ${JSON.stringify(MINT)}) { k.ticks++; k.lastTick = Date.now(); }
      else if (ev.kind === 'orders') k.orders++;
      else if (ev.kind === 'status') k.status++;
      else if (ev.kind === 'candles' && ev.mint === ${JSON.stringify(MINT)}) k.candles++;
      else if (ev.kind === 'log' && ev.level !== 'info') k.logs.push(ev.level + ': ' + ev.line);
      else if (ev.kind === 'toast') k.logs.push('toast ' + ev.level + ': ' + ev.message);
    });
    return true;
  })()`);
  const snapshot = async (label, ms) => {
    await evaluate(`(() => { const k = window.__kf; k.ticks = 0; k.orders = 0; k.status = 0; k.candles = 0; k.logs = []; return true; })()`);
    // Renderer responsiveness: how long a trivial evaluate takes, sampled.
    const rtts = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = Date.now();
      await evaluate('1');
      rtts.push(Date.now() - s);
      await sleep(2000);
    }
    const k = await evaluate('JSON.stringify(window.__kf)');
    const r = JSON.parse(k);
    rtts.sort((a, b) => a - b);
    const p95 = rtts[Math.floor(rtts.length * 0.95)] ?? rtts[rtts.length - 1];
    out(`\n[${label}] ${ms / 1000}s — ticks ${r.ticks} (${(r.ticks / (ms / 1000)).toFixed(2)}/s) · candle pushes ${r.candles} · orders pushes ${r.orders} · status pushes ${r.status} · renderer rtt median ${rtts[Math.floor(rtts.length / 2)]} ms, p95 ${p95} ms · last tick ${r.lastTick ? `${Math.round((Date.now() - r.lastTick) / 1000)}s ago` : 'never'}`);
    if (r.logs.length) out('  main said:', r.logs.slice(0, 12).join('\n             '));
    return r;
  };
  const before = await snapshot('A: no order', PHASE_A);

  // Arm a limit buy that can never fire: 1 % of the current price.
  const sum = await evaluate(`window.krypt.market.summary(${JSON.stringify(MINT)})`);
  const price = sum?.data?.priceSol ?? null;
  const symbol = sum?.data?.symbol ?? '';
  if (!price) throw new Error('no price for the mint: ' + JSON.stringify(sum).slice(0, 200));
  const req = { mint: MINT, symbol, kind: 'limit_buy', triggerValue: price / 100, triggerBasis: 'price_sol', amount: 0.01 };
  const created = await evaluate(`window.krypt.orders.create(${JSON.stringify(req)})`);
  out('\ncreate order →', JSON.stringify(created).slice(0, 300));
  const list = await evaluate(`window.krypt.orders.list()`);
  const mine = (list?.data?.orders ?? []).filter((o) => o.mint === MINT && o.kind === 'limit_buy' && (o.state === 'armed' || o.state === 'paused'));
  orderId = mine[0]?.id ?? null;
  out('armed orders on the mint:', mine.map((o) => `${o.id} ${o.state} ${o.note ?? ''}`).join(' | ') || 'none', '· executable', list?.data?.executable, '· blocked', list?.data?.blockedReason);
  const during = await snapshot('B: order armed', PHASE_B);

  if (orderId) {
    const c = await evaluate(`window.krypt.orders.cancel(${JSON.stringify(orderId)})`);
    out('\ncancel →', JSON.stringify(c).slice(0, 200));
    orderId = null;
  }
  const after = await snapshot('C: cancelled', PHASE_C);

  const rate = (r, ms) => r.ticks / (ms / 1000);
  out('\nrates: before', rate(before, PHASE_A).toFixed(2), '· during', rate(during, PHASE_B).toFixed(2), '· after', rate(after, PHASE_C).toFixed(2), 'ticks/s');
  if (rate(during, PHASE_B) < rate(before, PHASE_A) * 0.3 && rate(after, PHASE_C) > rate(during, PHASE_B) * 2) out('\nREPRODUCED: the tick stream fell away while the order was armed and came back when it was cancelled');
  else if (rate(during, PHASE_B) < rate(before, PHASE_A) * 0.3) out('\nticks fell away while armed — and did not recover after the cancel (a different cause, or the token went quiet)');
  else out('\nnot reproduced here: ticks kept flowing with the order armed');
} catch (err) {
  out('DRIVER ERROR:', err.message);
} finally {
  if (orderId) await evaluate(`window.krypt.orders.cancel(${JSON.stringify(orderId)})`).catch(() => undefined);
  await evaluate(`(() => { try { window.__kfOff(); } catch {} return true; })()`).catch(() => undefined);
  close();
}
await sleep(150);
process.exit(0);
