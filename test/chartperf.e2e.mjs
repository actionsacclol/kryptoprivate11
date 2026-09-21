// Chart-interaction profiler (2026-09-20). Read-only: attaches to a RUNNING
// dev app, opens a token if none is open, then DRAGS and WHEEL-ZOOMS the chart
// with real input events through the DevTools protocol while sampling frame
// gaps, long tasks, IPC round trips and a CPU profile inside the renderer.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev        (accept the onboarding gate once)
//   npm run test:chart:e2e -- [out.json]     (PORT=… to override the port)
//     SCENARIO=trending (default) | new       which Discover column's first card
//     INTERVAL=1m (default) | 1s | 5s | …     candle interval to click first
//
// What it answers: when a drag feels seconds late, is the renderer's main
// thread busy (long tasks, frame gaps, WHOSE code in the profile), is the main
// process stalling (IPC pings and input acks take long), or is everything on
// time and the delay is in painting/compositing?
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const SCENARIO = process.env.SCENARIO || 'trending';
const INTERVAL = process.env.INTERVAL || '1m';
const OUT = process.argv[2] || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1|index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  out('target:', page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
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

const HARNESS = `
(() => {
  // Re-installable: a previous run's loops stop when the generation moves.
  const gen = (window.__cpGen = (window.__cpGen ?? 0) + 1);
  const frames = [];
  const longTasks = [];
  const pings = [];
  let ltSupported = false;
  try {
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration }); });
    po.observe({ type: 'longtask', buffered: true });
    ltSupported = true;
  } catch (e) {}
  const loop = (t) => { if (window.__cpGen !== gen) return; frames.push(t); if (frames.length > 20000) frames.splice(0, 10000); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  // IPC round trips to the main process every 50 ms: a stalled main process
  // (the engine runs there, and so does input routing) shows up as long pings.
  let pinging = false;
  const ping = async () => {
    if (window.__cpGen !== gen) return;
    if (!pinging && window.krypt?.settings?.get) {
      pinging = true;
      const t = performance.now();
      try { await window.krypt.settings.get(); } catch (e) {}
      pings.push({ at: t, ms: performance.now() - t });
      if (pings.length > 5000) pings.splice(0, 2500);
      pinging = false;
    }
    setTimeout(ping, 50);
  };
  setTimeout(ping, 50);
  const chartEl = () => document.querySelector('.tv-lightweight-charts');
  const chartRect = () => {
    const el = chartEl(); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const mainEl = () => document.querySelector('main');
  const visibleRoot = (m) => [...m.children].find((c) => c.getAttribute('aria-hidden') !== 'true') ?? m;
  const q = (arr, p) => arr.length ? Math.round(arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] * 10) / 10 : null;
  window.__cp = {
    ltSupported,
    now: () => performance.now(),
    chartRect,
    heading: () => { const h = visibleRoot(mainEl()).querySelector('h1'); return h ? h.textContent.trim() : null; },
    lite: () => document.documentElement.classList.contains('lite'),
    findBtn: (label) => { const b = [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === label); if (!b) return false; b.click(); return true; },
    clickText: (label) => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label); if (!b) return false; b.click(); return true; },
    // Document-wide: on the Hub the columns are not under the route root.
    // The card's own click opens the token; its nested quick-buy button is
    // never touched. 'new' = a card whose age reads in seconds or minutes.
    openCard: (which) => {
      const cards = [...document.querySelectorAll('[role="button"].card')].filter((c) => c.getBoundingClientRect().width > 0);
      let card = null;
      if (which === 'new') card = cards.find((c) => /[A-Za-z0-9](\\d{1,2})[sm](?=[—\\-+])/.test(c.textContent)) ?? null;
      if (!card) card = cards[0] ?? null;
      if (!card) return null;
      const sym = card.querySelector('span.font-semibold')?.textContent.trim() ?? '?';
      card.click();
      return sym;
    },
    window: (t0, t1) => {
      const f = frames.filter((t) => t >= t0 && t <= t1);
      const gaps = [];
      for (let i = 1; i < f.length; i++) gaps.push(f[i] - f[i - 1]);
      gaps.sort((a, b) => a - b);
      const lts = longTasks.filter((e) => e.start >= t0 - 50 && e.start <= t1);
      const ps = pings.filter((p) => p.at >= t0 && p.at <= t1).map((p) => p.ms).sort((a, b) => a - b);
      return {
        frames: f.length, span: Math.round(t1 - t0),
        gapP50: q(gaps, 0.5), gapP90: q(gaps, 0.9), gapP99: q(gaps, 0.99), gapMax: gaps.length ? Math.round(gaps[gaps.length - 1]) : null,
        gapsOver50: gaps.filter((g) => g > 50).length, gapsOver200: gaps.filter((g) => g > 200).length,
        longTasks: lts.map((e) => ({ start: Math.round(e.start - t0), dur: Math.round(e.dur) })),
        longTasksMs: Math.round(lts.reduce((a, e) => a + e.dur, 0)),
        pings: ps.length, pingP50: q(ps, 0.5), pingP90: q(ps, 0.9), pingMax: ps.length ? Math.round(ps[ps.length - 1]) : null,
      };
    },
    nodes: () => document.querySelectorAll('*').length,
    canvases: () => [...document.querySelectorAll('canvas')].map((c) => ({ w: c.width, h: c.height, inChart: !!c.closest('.tv-lightweight-charts') })),
  };
  return 'installed lt=' + ltSupported + ' gen=' + gen;
})()
`;

/** Self time per function from a CDP profile, aggregated by name@file. */
function summarize(profile, top = 18) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const byUrl = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    if (!n) continue;
    total += dt;
    const cf = n.callFrame;
    const file = cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') : '';
    const key = `${cf.functionName || '(anonymous)'} @ ${file || '(native)'}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    const u = file || (cf.functionName === '(idle)' ? '(idle)' : cf.functionName === '(garbage collector)' ? '(gc)' : cf.functionName === '(program)' ? '(program)' : '(native)');
    byUrl.set(u, (byUrl.get(u) ?? 0) + dt);
  }
  const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => ({ what: k, ms: Math.round(v), pct: Math.round((v / total) * 1000) / 10 }));
  return { totalMs: Math.round(total), topFunctions: fmt(self), byFile: fmt(byUrl) };
}

const { call, evaluate, close } = await connect();
const result = { startedAt: new Date().toISOString(), scenario: SCENARIO, interval: INTERVAL, phases: {}, notes: [] };
try {
  out(await evaluate(HARNESS));
  out('heading:', await evaluate('window.__cp.heading()'), 'lite:', await evaluate('window.__cp.lite()'), 'nodes:', await evaluate('window.__cp.nodes()'));

  // A chart on screen, or open one.
  let rect = await evaluate('window.__cp.chartRect()');
  if (!rect || SCENARIO !== 'trending') {
    out(`opening the first ${SCENARIO} card`);
    await evaluate(`window.__cp.findBtn('Discover')`);
    let sym = null;
    for (let i = 0; i < 40 && !sym; i++) { sym = await evaluate(`window.__cp.openCard(${JSON.stringify(SCENARIO)})`); if (!sym) await sleep(500); }
    if (!sym) throw new Error('no token cards within 20 s');
    out('opened card:', sym);
    result.notes.push(`card=${sym}`);
    rect = null;
    for (let i = 0; i < 60 && !rect; i++) { rect = await evaluate('window.__cp.chartRect()'); if (!rect) await sleep(500); }
    if (!rect) throw new Error('no chart within 30 s of opening the token');
    await sleep(2000);
  }
  if (INTERVAL !== '1m') {
    const ok = await evaluate(`window.__cp.clickText(${JSON.stringify(INTERVAL)})`);
    out(`interval ${INTERVAL}: ${ok ? 'clicked' : 'NO BUTTON'}`);
    await sleep(4000); // let the series reload
    rect = await evaluate('window.__cp.chartRect()');
  }
  out('chart rect:', JSON.stringify(rect), 'canvases:', JSON.stringify(await evaluate('window.__cp.canvases()')));
  const cx = Math.round(rect.x + rect.w * 0.6);
  const cy = Math.round(rect.y + rect.h * 0.45);

  const phase = async (name, fn, settleMs = 1500) => {
    await call('Profiler.enable');
    await call('Profiler.setSamplingInterval', { interval: 500 });
    await call('Profiler.start');
    const t0 = await evaluate('window.__cp.now()');
    const acks = [];
    const inputs = await fn(acks);
    const tInputDone = await evaluate('window.__cp.now()');
    await sleep(settleMs);
    const t1 = await evaluate('window.__cp.now()');
    const prof = await call('Profiler.stop');
    const win = await evaluate(`window.__cp.window(${t0}, ${t1})`);
    const active = await evaluate(`window.__cp.window(${t0}, ${tInputDone})`);
    const summary = prof.result?.profile ? summarize(prof.result.profile) : null;
    acks.sort((a, b) => a - b);
    const ackP50 = acks.length ? acks[Math.floor(acks.length / 2)] : null;
    const ackMax = acks.length ? acks[acks.length - 1] : null;
    result.phases[name] = { inputs, win, active, summary, ackP50, ackMax };
    out(`\n## ${name}: ${inputs} input events over ${Math.round(tInputDone - t0)} ms (window ${win.span} ms)`);
    if (acks.length) out(`  input ack (browser→renderer round trip): p50 ${ackP50} ms · max ${ackMax} ms`);
    out(`  frames during input: ${active.frames} · gap p50 ${active.gapP50} p90 ${active.gapP90} p99 ${active.gapP99} max ${active.gapMax} ms · gaps>50 ${active.gapsOver50} · gaps>200 ${active.gapsOver200}`);
    out(`  ipc pings during input: ${active.pings} · p50 ${active.pingP50} p90 ${active.pingP90} max ${active.pingMax} ms`);
    out(`  whole window: ${win.frames} frames · gap max ${win.gapMax} ms · long tasks ${win.longTasks.length} = ${win.longTasksMs} ms${win.longTasks.length ? ' ' + JSON.stringify(win.longTasks.slice(0, 8)) : ''} · ping max ${win.pingMax} ms`);
    if (summary) {
      out(`  cpu ${summary.totalMs} ms sampled; by file:`);
      for (const f of summary.byFile.slice(0, 8)) out(`    ${String(f.pct).padStart(5)}%  ${f.ms} ms  ${f.what}`);
      out('  top functions:');
      for (const f of summary.topFunctions.slice(0, 10)) out(`    ${String(f.pct).padStart(5)}%  ${f.ms} ms  ${f.what}`);
    }
  };

  const mouse = async (acks, type, x, y, extra = {}) => {
    const t = performance.now();
    await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
    acks.push(Math.round((performance.now() - t) * 10) / 10);
  };

  // Baseline: nothing touched.
  await phase('idle', async () => { await sleep(2000); return 0; }, 0);

  // Drag right→left across the chart, ~60 moves in ~1 s (a real hand).
  await phase('drag', async (acks) => {
    let n = 0;
    await mouse(acks, 'mouseMoved', cx, cy); n++;
    await mouse(acks, 'mousePressed', cx, cy, { buttons: 1, clickCount: 1 }); n++;
    for (let i = 1; i <= 60; i++) { await mouse(acks, 'mouseMoved', cx - i * 4, cy, { buttons: 1 }); n++; await sleep(12); }
    await mouse(acks, 'mouseReleased', cx - 240, cy, { buttons: 0, clickCount: 1 }); n++;
    return n;
  });

  // Wheel: zoom in 20 notches, then out 20, 40 ms apart.
  await phase('wheel', async (acks) => {
    let n = 0;
    await mouse(acks, 'mouseMoved', cx, cy); n++;
    for (let i = 0; i < 20; i++) { await mouse(acks, 'mouseWheel', cx, cy, { deltaX: 0, deltaY: -100 }); n++; await sleep(40); }
    for (let i = 0; i < 20; i++) { await mouse(acks, 'mouseWheel', cx, cy, { deltaX: 0, deltaY: 100 }); n++; await sleep(40); }
    return n;
  });

  // A fast drag the other way right after — "after interacting".
  await phase('drag2', async (acks) => {
    let n = 0;
    await mouse(acks, 'mousePressed', cx - 200, cy, { buttons: 1, clickCount: 1 }); n++;
    for (let i = 1; i <= 60; i++) { await mouse(acks, 'mouseMoved', cx - 200 + i * 4, cy, { buttons: 1 }); n++; await sleep(4); }
    await mouse(acks, 'mouseReleased', cx + 40, cy, { buttons: 0, clickCount: 1 }); n++;
    return n;
  });

  result.notes.push(`heading=${await evaluate('window.__cp.heading()')} lite=${await evaluate('window.__cp.lite()')} nodes=${await evaluate('window.__cp.nodes()')}`);
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
