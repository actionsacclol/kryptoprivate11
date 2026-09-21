// Reverse copying in the editor, live (2026-09-20). Attaches to a RUNNING
// dev app, opens Automation → Copy Trading, opens a NEW config editor,
// switches it to Reverse, screenshots it, reads back that the exit fields
// and the relabelled sells switch appeared, then cancels. Nothing is saved.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/reverse.e2e.mjs
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
  // The "new config" button carries a plus icon and opens the editor.
  const opened = await click(`() => [...document.querySelectorAll('main button')].find((b) => b.querySelector('svg.lucide-plus') && !/scan/i.test(b.textContent))`);
  check('a new config editor opens', opened && (await waitFor(`/Direction/.test(document.querySelector('main')?.textContent || '')`)));
  const before = await mainText();
  check('the editor shows the Direction control with Copy and Reverse', /Direction/.test(before) && /Reverse/.test(before));
  check('on Copy the sells switch keeps its old label', /Copy their sells/.test(before));
  check('on Copy there are no reverse exit fields', !/Take profit/.test(before));
  const switched = await click(`() => [...document.querySelectorAll('main button')].find((b) => (b.textContent||'').trim() === 'Reverse')`);
  await sleep(500);
  const after = await mainText();
  check('Reverse can be chosen', switched);
  check('reverse shows its own exits', /Take profit/.test(after) && /Stop loss/.test(after) && /Max hold/.test(after));
  check('the sells switch is relabelled for reverse', /Exit when they buy back/.test(after));
  check('the editor says it is a bet and starts on paper', /bet/.test(after) && /starts on paper/.test(after));
  const defaults = await evaluate(`JSON.stringify([...document.querySelectorAll('main input[type=number]')].map((i) => i.value).filter((v) => ['25','20','30'].includes(v)))`);
  check('the exit defaults are 25 / 20 / 30', /"25"/.test(defaults) && /"20"/.test(defaults) && /"30"/.test(defaults), defaults);
  await shot('reverse-editor');
  const cancelled = await click(`() => [...document.querySelectorAll('main button')].find((b) => (b.textContent||'').trim() === 'Cancel')`);
  check('the editor is cancelled, nothing saved', cancelled);
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  if (hid) await showGate().catch(() => undefined);
  ws.close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall reverse checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
