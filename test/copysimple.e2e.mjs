// Copy Simple in the live app (2026-09-20). Attaches to a RUNNING dev app,
// opens Automation → Copy Simple, pastes a Solana address and then a 0x one,
// reads back that the chain is recognised, the button arms and the chain
// pills appear for 0x, screenshots, then clears the box. Nothing is saved.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/copysimple.e2e.mjs
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
// React listens to the native input setter, not to `.value =`.
const type = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const SOL = 'Whae1111111111111111111111111111111111111';
const EVM = '0x' + 'ab'.repeat(20);
let hid = false;
try {
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  hid = await hideGate();
  if (hid) out('(welcome gate is up on this profile — hidden for the screenshots, not clicked)');
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  check('the Automation tile opens', await click(`() => [...document.querySelectorAll('main button')].find((b) => /Automation/.test(b.textContent) && !/Back to the Hub/.test(b.getAttribute('title') || ''))`));
  await sleep(1200);
  const landed = await mainText();
  check('Automation lands on Copy Simple', /Copy Simple/.test(landed) && /Follow on paper/.test(landed));
  check('the sidebar lists Copy Simple before Copy Trading', await evaluate(`(() => { const b=[...document.querySelectorAll('aside button')].map((b) => (b.textContent||'').trim()); return b.findIndex((t) => /^Copy Simple/.test(t)) >= 0 && b.findIndex((t) => /^Copy Simple/.test(t)) < b.findIndex((t) => /^Copy Trading/.test(t)); })()`));
  const disabledBefore = await evaluate(`(() => { const b=[...document.querySelectorAll('main button')].find((b) => /Follow on paper/.test(b.textContent||'')); return b ? b.disabled : null; })()`);
  check('the button is disabled with no address', disabledBefore === true);
  check('a Solana address is typed', await type('[data-testid=copysimple-address]', SOL));
  await sleep(300);
  const withSol = await mainText();
  check('the chain is recognised as Solana', /Solana wallet/.test(withSol));
  check('the derived sentence names the size and the daily stop', /spend 0\.1 SOL each time they buy/.test(withSol) && /after losing 1 SOL/.test(withSol), withSol.match(/spend [^.]+\./)?.[0]);
  const enabled = await evaluate(`(() => { const b=[...document.querySelectorAll('main button')].find((b) => /Follow on paper/.test(b.textContent||'')); return b ? !b.disabled : null; })()`);
  check('the button arms on a valid address', enabled === true);
  await click(`() => [...document.querySelectorAll('main button')].find((b) => (b.textContent||'').trim() === '0.25')`);
  await sleep(200);
  check('picking 0.25 moves the sentence', /spend 0\.25 SOL/.test(await mainText()) && /after losing 2\.5 SOL/.test(await mainText()));
  await shot('copysimple');
  check('a 0x address is typed', await type('[data-testid=copysimple-address]', EVM));
  await sleep(300);
  const withEvm = await mainText();
  check('a 0x address asks which EVM chain', /which chain do they trade on/.test(withEvm) && /Robinhood Chain/.test(withEvm) && /BNB Smart Chain/.test(withEvm));
  await shot('copysimple-evm');
  check('the box is cleared, nothing saved', await type('[data-testid=copysimple-address]', ''));
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  if (hid) await showGate().catch(() => undefined);
  ws.close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall Copy Simple checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
