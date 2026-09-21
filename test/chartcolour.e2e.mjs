// Chart colour check (2026-09-20). A user clicked Widgets and got
// "Cannot parse color: rgb(140 146 171)": the look work had replaced the
// chart's literal colours with helpers that emit the modern space-separated
// rgb() form, and lightweight-charts 4.2.3 parses only the comma form. This
// driver attaches to a RUNNING dev app, temporarily enables the Chart panel
// on Widgets (ONE localStorage key, restored on exit), opens Widgets, and
// fails on any page exception or console error mentioning a colour it
// could not parse. It also opens the last token's page, where the same
// chart lives. Nothing is accepted, saved or spent.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/chartcolour.e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const OUT = process.env.OUT || 'C:/Users/Krypt/AppData/Local/Temp/krypt-appliers';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1|index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0;
const pending = new Map();
const problems = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    const text = d.exception?.description ?? d.text ?? '';
    problems.push(`exception: ${text.split('\n')[0]}`);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (/Cannot parse color|rgb\(/.test(text)) problems.push(`console.error: ${text.split('\n')[0].slice(0, 200)}`);
  }
});
const call = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.error) throw new Error(JSON.stringify(r.error));
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const shot = async (name) => {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  const file = `${OUT}/${name}.png`;
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  out('screenshot', file);
};
const goTo = (label) => evaluate(`(() => { const L=${JSON.stringify(label)}; const all=[...document.querySelectorAll('button')]; const b=[...document.querySelectorAll('aside button')].find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.includes(L) && !/Back to the Hub/.test(b.getAttribute('title')||'')); if(!b) return false; b.click(); return true; })()`);
const hideGate = () => evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /KRYPT TERMINAL/.test(e.textContent || '')); if (!el) return false; let top = el; while (top.parentElement && getComputedStyle(top).position !== 'fixed') top = top.parentElement; if (getComputedStyle(top).position !== 'fixed') return false; top.setAttribute('data-e2e-hidden', '1'); top.style.visibility = 'hidden'; return true; })()`);
const showGate = () => evaluate(`(() => { const el = document.querySelector('[data-e2e-hidden]'); if (!el) return false; el.style.visibility = ''; el.removeAttribute('data-e2e-hidden'); return true; })()`);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ENABLED_KEY = 'krypt.panels.enabled.v1';
await call('Runtime.enable');
const saved = await evaluate(`localStorage.getItem(${JSON.stringify(ENABLED_KEY)})`);
let hid = false;
try {
  // A fresh load: the check is about what a user gets when they open the app.
  await call('Page.reload', { ignoreCache: true });
  await sleep(5000);
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  hid = await hideGate();
  if (hid) out('(welcome gate is up on this profile — hidden for the screenshots, not clicked)');
  await evaluate(`(() => { const k=${JSON.stringify(ENABLED_KEY)}; let cur=[]; try { cur = JSON.parse(localStorage.getItem(k) || '[]'); } catch {} if (!cur.includes('chart')) cur.push('chart'); localStorage.setItem(k, JSON.stringify(cur)); return cur; })()`);
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  check('Widgets opens', await goTo('Widgets'));
  await sleep(3000);
  const charts = await evaluate(`document.querySelectorAll('main canvas').length`);
  check('the Widgets page has a chart canvas', charts > 0, `${charts} canvas element(s)`);
  await shot('chartcolour-widgets');
  const widgetProblems = problems.splice(0);
  check('no colour-parse exception on Widgets', widgetProblems.length === 0, widgetProblems[0] ?? 'clean');
  // The token page carries the same chart: open the newest live launch from
  // the Widgets page's own Live launches panel (a row reads "SYMBOL  12s").
  const token = await evaluate(`(() => { const row=[...document.querySelectorAll('main button')].find((b) => /\\d+s$/.test((b.textContent||'').trim()) && /[A-Za-z$]{2,}/.test(b.textContent||'')); if(!row) return false; row.click(); return true; })()`);
  await sleep(3500);
  const onToken = await evaluate(`/Buy|Sell|Chart/.test(document.querySelector('main')?.textContent || '') && document.querySelectorAll('main canvas').length > 0`);
  const tokenProblems = problems.splice(0);
  check('a token page opens with its chart', token && onToken, token ? `${await evaluate(`document.querySelectorAll('main canvas').length`)} canvas element(s)` : 'no live launch row to open');
  check('no colour-parse exception on the token page', tokenProblems.length === 0, tokenProblems[0] ?? 'clean');
  await shot('chartcolour-terminal');
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  if (saved === null) await evaluate(`localStorage.removeItem(${JSON.stringify(ENABLED_KEY)}); true`).catch(() => undefined);
  else await evaluate(`localStorage.setItem(${JSON.stringify(ENABLED_KEY)}, ${JSON.stringify(saved)}); true`).catch(() => undefined);
  if (hid) await showGate().catch(() => undefined);
  ws.close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall chart colour checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
