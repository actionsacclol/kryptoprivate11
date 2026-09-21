// The token page's Links tab, live (2026-09-20). Read-only: attaches to a
// RUNNING dev app, opens the $KRYPTO coin from the top-bar search, clicks
// the Links tab under the chart, and checks the three sections render — the
// published links, the X numbers (or the honest "nothing read yet"), and
// the X-link classification. Touches no stored state.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/linkstab.e2e.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);
const MINT = '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump';

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
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
try {
  // The legal gate may be up in a dev profile; lift `inert` for the check only.
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  // Paste the mint into the search and press Enter (a React input: set through
  // the native setter so React sees the change).
  const typed = await evaluate(`(() => { const i=document.querySelector('input[placeholder="Search or paste a contract address…"]'); if(!i) return false; const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, ${JSON.stringify(MINT)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return true; })()`);
  check('the search box takes the mint', typed);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  let heading = null;
  for (let i = 0; i < 40; i++) {
    // The route on screen: Discover stays mounted (aria-hidden) beside the
    // keyed route, so the visible root's heading is the one that counts.
    heading = await evaluate(`(() => { const m=document.querySelector('main'); if(!m) return null; const root=[...m.children].find((c) => c.getAttribute('aria-hidden') !== 'true') ?? m; const h=root.querySelector('h1'); return h ? h.textContent.trim() : null; })()`);
    if (heading && /KRYPTO/i.test(heading)) break;
    await sleep(500);
  }
  check('the token page opened', !!heading && /KRYPTO/i.test(heading), heading ?? 'no heading');
  await sleep(1500);
  const clicked = await evaluate(`(() => { const b=[...document.querySelectorAll('main button')].find((b) => b.textContent.trim()==='Links'); if(!b) return false; b.click(); return true; })()`);
  check('the Links tab exists under the chart', clicked);
  await sleep(1200);
  const text = await evaluate(`(() => { const h=[...document.querySelectorAll('main *')].find((e) => /Links the creator published/.test(e.textContent||'') && e.children.length < 40); return document.querySelector('main')?.textContent ?? ''; })()`);
  check('the tab lists the published links', /Links the creator published/.test(text) && /pump\.fun/.test(text), 'has pump.fun');
  check('the tab shows the X numbers or says nothing was read', /followers|Nothing read yet|sign-in wall/.test(text));
  check('the tab carries the X-link classification', /X link|account|post/i.test(text));
  const headerX = await evaluate(`(() => { const b=[...document.querySelectorAll('main button')].find((b) => /^X\\b/.test(b.textContent.trim())); return b ? b.textContent.trim() : null; })()`);
  out('header X button:', headerX);
  check('the header X button exists', !!headerX);
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall links-tab checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
