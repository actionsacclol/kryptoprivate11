// FOMO copying in the editor, live (2026-09-20). Attaches to a RUNNING dev
// app, opens Automation → Copy Trading, presses "New FOMO copy", screenshots
// the editor, reads back that the crowd fields, the research warning and the
// own-exit fields appeared and the wallet address did not, then cancels.
// Nothing is saved.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/fomo.e2e.mjs
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
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
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
const click = (finder) => evaluate(`(() => { const b = (${finder})(); if (!b) return false; b.click(); return true; })()`);
const hideGate = () => evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /KRYPT TERMINAL/.test(e.textContent || '')); if (!el) return false; let top = el; while (top.parentElement && getComputedStyle(top).position !== 'fixed') top = top.parentElement; if (getComputedStyle(top).position !== 'fixed') return false; top.setAttribute('data-e2e-hidden', '1'); top.style.visibility = 'hidden'; return true; })()`);
const showGate = () => evaluate(`(() => { const el = document.querySelector('[data-e2e-hidden]'); if (!el) return false; el.style.visibility = ''; el.removeAttribute('data-e2e-hidden'); return true; })()`);
const waitFor = async (expr, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(250); } return false; };
const mainText = () => evaluate(`document.querySelector('main')?.textContent || document.body.textContent`);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

let hid = false;
try {
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  hid = await hideGate();
  if (hid) out('(welcome gate is up on this profile — hidden for the screenshots, not clicked)');
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  check('the Automation tile opens', await click(`() => [...document.querySelectorAll('main button')].find((b) => /Automation/.test(b.textContent) && !/Back to the Hub/.test(b.getAttribute('title') || ''))`));
  await sleep(1200);
  await click(`() => [...document.querySelectorAll('nav button, aside button')].find((b) => /Copy Trading/.test((b.textContent||'').trim()))`);
  await sleep(1200);
  const opened = await click(`() => [...document.querySelectorAll('main button')].find((b) => /New FOMO copy/.test(b.textContent || ''))`);
  check('"New FOMO copy" opens the editor', opened && (await waitFor(`/Direction/.test(document.querySelector('main')?.textContent || '')`)));
  const text = await mainText();
  check('the editor has three directions', /Copy/.test(text) && /Reverse/.test(text) && /FOMO/.test(text));
  check('the crowd fields are there', /The crowd/.test(text) && /Wallets to trigger/.test(text) && /Within/.test(text) && /Exit when the crowd leaves/.test(text));
  check('the research warning is on the form', /9\.3 million trades/.test(text) && /−15% to −32%/.test(text) && /starts on paper/.test(text));
  check('the own exits are shown', /Take profit/.test(text) && /Stop loss/.test(text) && /Max hold/.test(text));
  check('no wallet address field on a crowd', !/Wallet address/.test(text));
  check('the chain is pinned to Solana', await evaluate(`(() => { const s=[...document.querySelectorAll('main select')].find((s) => s.value === 'solana'); return !!s && s.disabled; })()`));
  const sources = await evaluate(`JSON.stringify([...document.querySelectorAll('main select option')].map((o) => o.textContent).filter((t) => /wallets|Top/.test(t)))`);
  check('the four crowd sources are offered', /Followed wallets/.test(sources) && /Saved Scout wallets/.test(sources) && /Tracked wallets/.test(sources) && /Top Scout wallets by Copy score/.test(sources), sources);
  const defaults = await evaluate(`JSON.stringify([...document.querySelectorAll('main input[type=number]')].map((i) => i.value))`);
  check('the crowd defaults are 3 / 180 / 50 and the exits 25 / 20 / 30', ['"3"','"180"','"50"','"25"','"20"','"30"'].every((v) => defaults.includes(v)), defaults);
  await shot('fomo-editor');
  // Top N appears only for the "top" source.
  await evaluate(`(() => { const s=[...document.querySelectorAll('main select')].find((s) => [...s.options].some((o) => /Saved Scout wallets/.test(o.textContent))); if (!s) return false; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(s, 'top'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(400);
  const withTop = await mainText();
  check('Top N appears for the top source', /Top N/.test(withTop));
  await shot('fomo-editor-top');
  const cancelled = await click(`() => [...document.querySelectorAll('main button')].find((b) => (b.textContent||'').trim() === 'Cancel')`);
  check('the editor is cancelled, nothing saved', cancelled);
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  if (hid) await showGate().catch(() => undefined);
  ws.close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall FOMO checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
