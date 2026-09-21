// Wallet Scout with the Copy score, live (2026-09-20). Attaches to a RUNNING
// dev app, opens the Scout from the Hub, screenshots the board, opens the
// drawer on the first row and screenshots that, and reads back what the page
// says: the score column and its explanation, the drawer's checks. Hides the
// welcome gate for the screenshots if it is up — never clicks through it.
// Nothing saved, nothing followed.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/scout.e2e.mjs
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
  check('the Wallet Scout tile opens', await click(`() => [...document.querySelectorAll('main button')].find((b) => /Wallet Scout/.test(b.textContent) && !/Back to the Hub/.test(b.getAttribute('title') || ''))`));
  check('the board renders', await waitFor(`!!document.querySelector('table thead')`));
  await sleep(1500);
  const head = await evaluate(`[...document.querySelectorAll('table thead th')].map((t) => t.textContent.trim())`);
  check('the Copy score column is first after the wallet', head[1] === 'Copy score', head.join(' | '));
  check('the follower columns are there', head.includes('Copy / trip') && head.includes('Reachable'), head.join(' | '));
  const sortLabels = await evaluate(`[...document.querySelectorAll('main button')].map((b) => b.textContent.trim()).filter((t) => ['Copy score','Follower return','Their profit'].includes(t))`);
  check('the sort pills lead with the copy figures', sortLabels.includes('Copy score') && sortLabels.includes('Follower return'), sortLabels.join(', '));
  const scanBtn = await evaluate(`(() => { const b = [...document.querySelectorAll('aside button')].find((b) => /Scan last|Cancel scan/.test(b.textContent)); return b ? { text: b.textContent.trim(), h: b.getBoundingClientRect().height } : null; })()`);
  check('the scan button is a real button now', !!scanBtn && scanBtn.h >= 32, scanBtn ? `${scanBtn.text} · ${Math.round(scanBtn.h)} px tall` : 'not found');
  const footer = await evaluate(`document.querySelector('main')?.textContent || document.body.textContent`);
  check('the page says what the score is and is not', /not how the wallet did/.test(footer) && /It is not an edge/.test(footer));
  const rows = await evaluate(`document.querySelectorAll('[data-testid="scout-row"]').length`);
  out(`rows on the board: ${rows}`);
  await shot('scout-board');
  if (rows > 0) {
    const firstScore = await evaluate(`document.querySelector('[data-testid="scout-row"] td:nth-child(2)')?.textContent.trim()`);
    out(`first row's copy score chip: ${firstScore}`);
    check('a row opens the drawer', await click(`() => document.querySelector('[data-testid="scout-row"]')`));
    check('the drawer appears', await waitFor(`!!document.querySelector('[data-testid="wallet-drawer"]')`));
    await sleep(1200);
    const drawer = await evaluate(`document.querySelector('[data-testid="wallet-drawer"]')?.textContent || ''`);
    check('the drawer explains the score', /How a copier would have done/.test(drawer));
    check('the drawer lists the checks', /Follower return/.test(drawer) && /Reachable trips/.test(drawer) && /Coins per trip/.test(drawer));
    check('the drawer shows both sides', /If you had copied them/.test(drawer) && /What they did/.test(drawer));
    check('the drawer states the model\'s assumptions', /2 s after theirs/.test(drawer) && /1\.5% a side/.test(drawer));
    await shot('scout-drawer');
    await evaluate(`(() => { const b = document.querySelector('[data-testid="wallet-drawer"] button[aria-label="Close"]'); if (b) b.click(); return !!b; })()`);
  } else {
    out('(no wallets on record for this chain — drawer not exercised; run a Scan first)');
  }
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  if (hid) await showGate().catch(() => undefined);
  ws.close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall Scout checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
