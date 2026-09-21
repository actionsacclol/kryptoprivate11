// What the main Terminal page says about rate limits and feed loss, live
// (2026-09-20). Attaches to a RUNNING dev app, opens the Terminal workspace
// (Discover), waits, and reads off the DOM: every "Rate limited by …"
// banner, the provider counters, then on Settings the feed's estimated
// event loss and each socket's line. Hides the welcome gate for the read if
// it is up — never clicks through it. Nothing saved.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   WAIT=150 node test/ratelimit.e2e.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const WAIT_S = Number(process.env.WAIT || 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1|index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0;
const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const call = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.error) throw new Error(JSON.stringify(r.error));
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const click = (finder) => evaluate(`(() => { const b = (${finder})(); if (!b) return false; b.click(); return true; })()`);
const hideGate = () => evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /KRYPT TERMINAL/.test(e.textContent || '')); if (!el) return false; let top = el; while (top.parentElement && getComputedStyle(top).position !== 'fixed') top = top.parentElement; if (getComputedStyle(top).position !== 'fixed') return false; top.setAttribute('data-e2e-hidden', '1'); top.style.visibility = 'hidden'; return true; })()`);
const showGate = () => evaluate(`(() => { const el = document.querySelector('[data-e2e-hidden]'); if (!el) return false; el.style.visibility = ''; el.removeAttribute('data-e2e-hidden'); return true; })()`);
const toHub = () => evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
const providers = async () => JSON.parse(await evaluate(`window.krypt.market.providers().then((r) => JSON.stringify((r.data||[]).map((p) => ({ id: p.id, calls: p.calls, errors: p.errors, cool: Math.round(p.cooldownMs/1000), last: (p.lastError||'').slice(0,80), routes: p.routes || [] }))))`));
const fmt = (rows) => rows.filter((p) => p.calls).map((p) => `${p.id} ${p.calls}${p.errors ? ` (${p.errors} err)` : ''}${p.cool ? ` parked ${p.cool}s` : ''}`).join(' · ');
const banners = () => evaluate(`JSON.stringify([...document.querySelectorAll('main p')].map((p) => (p.textContent||'').trim()).filter((t) => /rate limited|no allowance|last good rows|retrying/i.test(t)))`);
const textAfter = (label) => evaluate(`(() => { const el = [...document.querySelectorAll('main span, main div')].find((e) => e.children.length === 0 && (e.textContent||'').trim() === ${JSON.stringify(label)}); if (!el) return null; const row = el.parentElement; return row ? (row.textContent||'').trim() : null; })()`);

let hid = false;
try {
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  hid = await hideGate();
  if (hid) out('(welcome gate is up on this profile — hidden for the read, not clicked)');
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  const p0 = await providers();
  out(`t=0   providers: ${fmt(p0) || 'no calls yet'}`);
  const opened = await click(`() => [...document.querySelectorAll('button')].find((b) => /Terminal/.test(b.textContent) && !/Back to the Hub/.test(b.getAttribute('title') || ''))`);
  out(`Terminal workspace opened: ${opened}`);
  await sleep(2000);
  // Make sure Discover is the page showing (the sidebar's first entry).
  await click(`() => [...document.querySelectorAll('nav button, aside button')].find((b) => /^Discover$/.test((b.textContent||'').trim()))`);
  await sleep(1500);
  out(`waiting ${WAIT_S} s on Discover…`);
  const marks = [];
  for (let t = 0; t < WAIT_S; t += 30) {
    await sleep(Math.min(30_000, (WAIT_S - t) * 1000));
    const b = JSON.parse(await banners());
    const p = await providers();
    marks.push({ t: t + 30, banners: b, providers: p });
    out(`t=${String(t + 30).padStart(3)} banners: ${b.length ? b.join(' | ') : 'none'}`);
    out(`      providers: ${fmt(p)}`);
  }
  const last = marks[marks.length - 1];
  const distinct = [...new Set(marks.flatMap((m) => m.banners))];
  out(`\nDISTINCT BANNERS SEEN ON DISCOVER: ${distinct.length ? '\n  ' + distinct.join('\n  ') : 'none'}`);
  const delta = (idp) => (last.providers.find((p) => p.id === idp)?.calls ?? 0) - (p0.find((p) => p.id === idp)?.calls ?? 0);
  out(`CALLS OVER ${WAIT_S} s: ${['pumpfun', 'geckoterminal', 'jupiter', 'dexscreener', 'pumpswap', 'rugcheck', 'birdeye', 'helius'].map((x) => `${x} +${delta(x)}`).join(' · ')}`);
  for (const p of last.providers) if (p.errors) out(`  ${p.id}: ${p.errors} error(s), last: ${p.last}`);
  out('ROUTES (this session, most-called first):');
  for (const p of last.providers) if (p.calls) out(`  ${p.id}: ${p.routes.slice(0, 8).map((r) => `${r.route} ×${r.calls}`).join(' · ')}`);

  // Settings: feed health.
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  await click(`() => [...document.querySelectorAll('button')].find((b) => /Settings & Legal/.test(b.textContent))`);
  await sleep(1500);
  const loss = await textAfter('estimated event loss (15m)');
  out(`\nFEED: ${loss ?? 'no feed section found (scanner stopped?)'}`);
  const sockets = await evaluate(`JSON.stringify([...document.querySelectorAll('main span')].map((s) => (s.textContent||'').trim()).filter((t) => /events · .* first/.test(t)))`);
  const socketRows = await evaluate(`JSON.stringify([...document.querySelectorAll('main div')].filter((d) => d.children.length >= 2 && /events · .* first/.test(d.textContent||'')).map((d) => (d.textContent||'').trim().replace(/\\s+/g,' ')).slice(0, 8))`);
  const rows = JSON.parse(socketRows);
  out(`SOCKETS (${JSON.parse(sockets).length}):`);
  for (const r of rows) out(`  ${r}`);
  const scanner = await evaluate(`(() => { const t = document.body.textContent || ''; const m = t.match(/Scanner\\s*(Running|Stopped)/); return m ? m[1] : null; })()`);
  out(`SCANNER: ${scanner ?? 'unknown from this page'}`);
} catch (err) {
  out('DRIVER ERROR:', err.message);
} finally {
  if (hid) await showGate().catch(() => undefined);
  ws.close();
}
await sleep(100);
process.exit(0);
