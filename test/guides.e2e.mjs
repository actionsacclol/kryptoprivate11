// The Guides page and the moved reward check, live (2026-09-20). Attaches to
// a RUNNING dev app, opens Guides from the Hub and checks a guide card per
// Hub tile renders (screenshot), then opens Wallet Utilities → Robinhood
// Wallet and BNB Wallet and checks "Check my rewards" is there. It presses
// "Show reward pools" (no address leaves for that) and NEVER "Check my
// rewards" (that would send the user's own address). Read-only otherwise. A
// dev profile may have the welcome/legal gate up; its overlay is hidden for
// the screenshots only and never clicked through.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/guides.e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const OUT = process.env.OUT || 'C:/Users/Krypt/AppData/Local/Temp/krypt-appliers';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);

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
  const shot = async (name) => {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    const file = `${OUT}/${name}.png`;
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    out('screenshot', file);
  };
  return { call, evaluate, shot, close: () => ws.close() };
}

const { evaluate, shot, close } = await connect();
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const click = (finder) => evaluate(`(() => { const b = (${finder})(); if (!b) return false; b.click(); return true; })()`);
const mainText = () => evaluate(`document.querySelector('main')?.textContent ?? ''`);
const heading = () => evaluate(`(() => { const m=document.querySelector('main'); if(!m) return null; const root=[...m.children].find((c) => c.getAttribute('aria-hidden') !== 'true') ?? m; const h=root.querySelector('h1'); return h ? h.textContent.trim() : null; })()`);
const backToHub = async () => {
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
};
const tile = (text) => click(`() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}) && !/Back to the Hub/.test(b.getAttribute('title') || ''))`);
const sidebar = async (label) => {
  for (let i = 0; i < 10; i++) {
    const hit = await click(`() => [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))`);
    if (hit) return true;
    await sleep(400);
  }
  return false;
};
const waitHeading = async (want) => {
  let h = null;
  for (let i = 0; i < 30; i++) {
    h = await heading();
    if (h === want) return h;
    await sleep(400);
  }
  return h;
};
const hideGate = () => evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /KRYPT TERMINAL/.test(e.textContent || '')); if (!el) return false; let top = el; while (top.parentElement && getComputedStyle(top).position !== 'fixed') top = top.parentElement; if (getComputedStyle(top).position !== 'fixed') return false; top.setAttribute('data-e2e-hidden', '1'); top.style.visibility = 'hidden'; return true; })()`);
const showGate = () => evaluate(`(() => { const el = document.querySelector('[data-e2e-hidden]'); if (!el) return false; el.style.visibility = ''; el.removeAttribute('data-e2e-hidden'); return true; })()`);
let hid = false;
try {
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  hid = await hideGate();
  if (hid) out('(the welcome gate is up on this profile — hidden for the screenshots, not clicked)');

  // Guides from the Hub.
  await backToHub();
  const hubText = await mainText();
  check('the Hub has a Guides tile and no Rewards tile', /Guides/.test(hubText) && !/Reward Pools|Published reward rates/.test(hubText));
  check('the Guides tile opens', await tile('Guides'));
  const h = await waitHeading('Guides');
  check('the Guides page is up', h === 'Guides', h ?? 'no heading');
  await sleep(600);
  const titles = await evaluate(`[...document.querySelectorAll('main h2')].map((e) => e.textContent.trim())`);
  out('guide cards:', JSON.stringify(titles));
  for (const want of ['Start here', 'Terminal', 'Automation', 'Main Engine', 'Wallet Utilities', 'Wallet Scout', 'Launch a Token', 'Widgets', 'Settings & Legal']) {
    check(`a guide card for ${want}`, titles.includes(want));
  }
  const text = await mainText();
  check('the guides say Do this and Careful', /Do this/.test(text) && /Careful/.test(text));
  check('the detailed guides follow underneath', /Getting started, in order|What a trade actually costs/.test(text));
  await shot('guides-page');
  check('the left list jumps to a section', await click(`() => [...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Wallet Utilities')`));
  await sleep(700);
  await shot('guides-page-wallets');

  // The reward check on the EVM wallet pages.
  await backToHub();
  check('the Wallet Utilities tile opens', await tile('Wallet Utilities'));
  await sleep(800);
  for (const [label, want] of [['Robinhood Wallet', 'Robinhood Wallet'], ['BNB Wallet', 'BNB Wallet']]) {
    check(`${label} opens from the sidebar`, await sidebar(label));
    const wh = await waitHeading(want);
    check(`${want} page is up`, wh === want, wh ?? 'no heading');
    await sleep(800);
    const t = await mainText();
    check(`${label} carries Check my rewards`, /Check my rewards/.test(t) && /api\.merkl\.xyz/.test(t));
    check(`${label} says nothing is sent until the button`, /nothing is sent until you press it/.test(t));
    // The pools list needs no address: press it and wait for an answer or an honest unknown.
    const pressed = await click(`() => [...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === 'Show reward pools')`);
    check(`${label} can show the reward pools`, pressed);
    let pools = null;
    for (let i = 0; i < 30; i++) {
      pools = await mainText();
      if (/Reward pools on/.test(pools) && !/Reading Merkl/.test(pools)) break;
      await sleep(500);
    }
    check(`${label} answered about pools (live, empty, or an honest unknown)`, /live, read|No live pools|unknown — not zero/.test(pools ?? ''));
    const links = await evaluate(`[...document.querySelectorAll('main a[href]')].map((a) => a.getAttribute('href')).filter((h) => /^https?:/.test(h))`);
    check(`${label} renders no third-party link in the rewards block`, Array.isArray(links) && links.length === 0, JSON.stringify(links).slice(0, 120));
    await shot(`wallet-rewards-${label.split(' ')[0].toLowerCase()}`);
  }
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  if (hid) await showGate().catch(() => undefined);
  close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall guides checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
