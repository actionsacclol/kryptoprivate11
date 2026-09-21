// Links-panel check (2026-09-20). Read-only apart from ONE localStorage key it
// restores: attaches to a RUNNING dev app, temporarily adds the Links panel
// to Widgets, opens a token, and confirms the embedded browser view (a
// separate DevTools target of type "webview") actually loaded the token's
// page and switches when another link button is clicked — the one thing a
// unit test cannot see, because the guest lives in its own process and the
// app's CSP could silently block the element.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/linkspanel.e2e.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
}
async function connect() {
  const list = await targets();
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
  return { evaluate, close: () => ws.close() };
}

const ENABLED_KEY = 'krypt.panels.enabled.v1';
const { evaluate, close } = await connect();
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const saved = await evaluate(`localStorage.getItem(${JSON.stringify(ENABLED_KEY)})`);
const TOKEN_KEY = 'krypt.panels.chartToken.v1';
const savedToken = await evaluate(`localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`);
// A coin that certainly has a launchpad page: the app's own $KRYPTO (pump.fun).
const LINKED = { mint: '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump', chain: 'solana', symbol: 'KRYPTO' };
try {
  // Enable the panel for the duration of the check.
  await evaluate(`(() => { const k=${JSON.stringify(ENABLED_KEY)}; let cur=[]; try { cur = JSON.parse(localStorage.getItem(k) || '[]'); } catch {} if (!cur.includes('links')) cur.push('links'); localStorage.setItem(k, JSON.stringify(cur)); return cur; })()`);
  // Point the panel at a coin with links (restored at the end), the way an
  // open does: write the store and fire the same-window event.
  await evaluate(`(() => { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(JSON.stringify(LINKED))}); window.dispatchEvent(new CustomEvent('krypt:chart-token')); return true; })()`);
  // Go to Widgets — and REMOUNT it, because the page reads the enabled set
  // once at mount: leave for another page first, then come back.
  // The sidebar exists inside a workspace; on the Hub the workspaces are tiles.
  const goTo = (label) => evaluate(`(() => { const L=${JSON.stringify(label)}; const all=[...document.querySelectorAll('button')]; const b=[...document.querySelectorAll('aside button')].find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.includes(L) && !/Back to the Hub/.test(b.getAttribute('title')||'')); if(!b) return false; b.click(); return true; })()`);
  if (!(await goTo('Widgets'))) out('could not find the Widgets button');
  await sleep(800);
  await goTo('Orders');
  await sleep(800);
  await goTo('Widgets');
  await sleep(2500);
  let info = null;
  for (let i = 0; i < 20 && !info; i++) {
    info = await evaluate(`(() => { const w=document.querySelector('webview'); if(!w) return null; const r=w.getBoundingClientRect(); return { src: w.getAttribute('src'), w: r.width, h: r.height, buttons: [...w.parentElement.querySelectorAll('button')].map(b=>b.textContent.trim()) }; })()`);
    if (!info) await sleep(500);
  }
  check('the Links panel renders a <webview>', !!info, info ? `src ${info.src} · ${Math.round(info.w)}×${Math.round(info.h)} · buttons ${info.buttons.join(', ')}` : 'no webview element within 10 s');
  if (info) {
    check('the view has a size', info.w > 50 && info.h > 50, `${Math.round(info.w)}×${Math.round(info.h)}`);
    // The guest is its own target; its URL says whether the page loaded.
    await sleep(4000);
    let guest = (await targets()).filter((t) => t.type === 'webview');
    check('a webview target exists (the guest loaded in its own process)', guest.length > 0, guest.map((g) => `${g.url.slice(0, 80)} "${(g.title || '').slice(0, 40)}"`).join(' | ') || 'none');
    const first = guest[0]?.url ?? null;
    // Click a DIFFERENT link button, if there is one, and see the guest move.
    const others = info.buttons.filter((b) => b !== 'Browser');
    if (others.length > 1) {
      const clicked = await evaluate(`(() => { const w=document.querySelector('webview'); const bs=[...w.parentElement.querySelectorAll('button')].filter(b=>b.textContent.trim()!=='Browser'); const cur=w.getAttribute('src'); const other=bs.find(b=>b.title && b.title!==cur); if(!other) return null; other.click(); return other.title; })()`);
      await sleep(4000);
      const src2 = await evaluate(`document.querySelector('webview')?.getAttribute('src')`);
      guest = (await targets()).filter((t) => t.type === 'webview');
      check('clicking another link replaces the page in the same box', clicked !== null && src2 === clicked, `now ${src2}`);
      check('the guest followed', guest.some((g) => g.url && clicked && g.url.startsWith(new URL(clicked).origin)), guest.map((g) => g.url.slice(0, 80)).join(' | ') || 'no guest', );
    } else {
      out(`(only one link for this token — switch not exercised; first guest ${first})`);
    }
  }
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  // Put the user's panel set and last-opened token back exactly as they were.
  await evaluate(`(() => { const k=${JSON.stringify(ENABLED_KEY)}; ${saved === null ? 'localStorage.removeItem(k);' : `localStorage.setItem(k, ${JSON.stringify(saved)});`} const t=${JSON.stringify(TOKEN_KEY)}; ${savedToken === null ? 'localStorage.removeItem(t);' : `localStorage.setItem(t, ${JSON.stringify(savedToken)});`} window.dispatchEvent(new CustomEvent('krypt:chart-token')); return true; })()`).catch(() => undefined);
  close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall links-panel checks passed');
// Let the socket finish closing before the process goes: exiting mid-close
// trips a libuv assertion on Windows.
await sleep(150);
process.exit(failures ? 1 : 0);
