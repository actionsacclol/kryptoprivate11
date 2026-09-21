// Telegram members and the domain record on the token page, live
// (2026-09-20). Read-only: attaches to a RUNNING dev app, opens the $KRYPTO
// coin from the top-bar search, and checks that main looked up its Telegram
// channel (t.me/kryptback) and its website's domain (krypt.cc) — the header
// buttons carry "N subscribers" and "since 2010", and the Links tab shows
// the cells. Touches no stored state.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/linkintel.e2e.mjs
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
  const typed = await evaluate(`(() => { const i=document.querySelector('input[placeholder="Search or paste a contract address…"]'); if(!i) return false; const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, ${JSON.stringify(MINT)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return true; })()`);
  check('the search box takes the mint', typed);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  let heading = null;
  for (let i = 0; i < 40; i++) {
    heading = await evaluate(`(() => { const m=document.querySelector('main'); if(!m) return null; const root=[...m.children].find((c) => c.getAttribute('aria-hidden') !== 'true') ?? m; const h=root.querySelector('h1'); return h ? h.textContent.trim() : null; })()`);
    if (heading && /KRYPTO/i.test(heading)) break;
    await sleep(500);
  }
  check('the token page opened', !!heading && /KRYPTO/i.test(heading), heading ?? 'no heading');
  // The header buttons: Telegram carries the count, Website the year, once main has answered.
  const headerButtons = () => evaluate(`(() => [...document.querySelectorAll('main button')].map((b) => b.textContent.trim()).filter((t) => /^(Telegram|Website)\\b/.test(t)))()`);
  let buttons = [];
  for (let i = 0; i < 40; i++) {
    buttons = await headerButtons();
    if (buttons.some((t) => /subscribers|members/.test(t)) && buttons.some((t) => /since \\d{4}|on /.test(t))) break;
    await sleep(500);
  }
  out('header buttons:', buttons);
  const tgBtn = buttons.find((t) => /^Telegram/.test(t)) ?? null;
  const webBtn = buttons.find((t) => /^Website/.test(t)) ?? null;
  check('the Telegram button carries the public count', !!tgBtn && /\d+ subscribers/.test(tgBtn), tgBtn ?? 'no Telegram button');
  check('the Website button carries the domain’s year', !!webBtn && /since 2010/.test(webBtn), webBtn ?? 'no Website button');
  // What main actually holds, through the bridge.
  const intel = await evaluate(`window.krypt.links.intel(${JSON.stringify(MINT)}, true)`);
  const tg = intel?.data?.telegram;
  const web = intel?.data?.website;
  check('main looked up the channel', !!tg && tg.state === 'ok' && tg.preview?.kind === 'channel' && tg.preview.members > 0, tg ? `${tg.state} · ${tg.preview?.members} ${tg.preview?.countWord}` : 'none');
  check('main looked up the domain', !!web && web.state === 'ok' && web.record?.registeredAt?.startsWith('2010') === true, web ? `${web.state} · ${web.record?.registeredAt} · ${web.record?.registrar}` : 'none');
  // The Links tab shows the cells.
  const clicked = await evaluate(`(() => { const b=[...document.querySelectorAll('main button')].find((b) => b.textContent.trim()==='Links'); if(!b) return false; b.click(); return true; })()`);
  check('the Links tab exists under the chart', clicked);
  await sleep(1200);
  const text = await evaluate(`document.querySelector('main')?.textContent ?? ''`);
  check('the tab shows the Telegram cells', /Telegram, from its public preview/.test(text) && /Subscribers/.test(text) && /channel/.test(text), 'Subscribers · channel');
  check('the tab shows the domain record', /Feb 2010/.test(text) && /NameCheap/.test(text), 'Feb 2010 · NameCheap');
  check('the tab says visitor numbers are not shown', /Visitor numbers are not shown/.test(text));
  check('the tab says what the site read needs', /Nothing read off the site yet|Names the contract/.test(text));
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall link-intel page checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
