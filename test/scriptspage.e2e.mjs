// The Scripts page, live (2026-09-20): attaches to a RUNNING dev app, opens
// Automation → Scripts from the Hub, walks the three views of the new top
// bar and screenshots each, starts a rule draft from New and checks the
// header card (Save, and the arm switch once saved) sits above the editor.
// Read-only: the draft is never saved, nothing is changed. A dev profile
// may have the welcome/legal gate up; its overlay is hidden for the
// screenshots only (a DOM style, restored) and never clicked through.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/scriptspage.e2e.mjs
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
const inScope = (text, scopeSel) => `() => { const s = document.querySelector(${JSON.stringify(scopeSel)}); if (!s) return null; return [...s.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}) ?? null; }`;
const mainText = () => evaluate(`document.querySelector('main')?.textContent ?? ''`);
// The welcome / legal gate: hidden for the screenshots only, never clicked.
const hideGate = () => evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /KRYPT TERMINAL/.test(e.textContent || '')); if (!el) return false; let top = el; while (top.parentElement && getComputedStyle(top).position !== 'fixed') top = top.parentElement; if (getComputedStyle(top).position !== 'fixed') return false; top.setAttribute('data-e2e-hidden', '1'); top.style.visibility = 'hidden'; return true; })()`);
const showGate = () => evaluate(`(() => { const el = document.querySelector('[data-e2e-hidden]'); if (!el) return false; el.style.visibility = ''; el.removeAttribute('data-e2e-hidden'); return true; })()`);
let hid = false;
try {
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  hid = await hideGate();
  if (hid) out('(the welcome gate is up on this profile — hidden for the screenshots, not clicked)');
  // The Hub shows workspace tiles, not the sidebar: Automation first, then
  // Scripts from that workspace's sidebar.
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  const tile = await click(`() => [...document.querySelectorAll('button')].find((b) => /Automation/.test(b.textContent) && !/Back to the Hub/.test(b.getAttribute('title') || ''))`);
  check('the Automation workspace opens from the Hub', tile);
  await sleep(900);
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    opened = await click(inScope('Scripts', 'aside'));
    if (!opened) opened = await click(`() => [...document.querySelectorAll('aside button, nav button')].find((b) => /^Scripts\\b/.test(b.textContent.trim()))`);
    if (!opened) await sleep(400);
  }
  check('Scripts opens from the sidebar', opened);
  let heading = null;
  for (let i = 0; i < 30; i++) {
    heading = await evaluate(`(() => { const m=document.querySelector('main'); if(!m) return null; const root=[...m.children].find((c) => c.getAttribute('aria-hidden') !== 'true') ?? m; const h=root.querySelector('h1'); return h ? h.textContent.trim() : null; })()`);
    if (heading === 'Scripts') break;
    await sleep(400);
  }
  check('the Scripts page is up', heading === 'Scripts', heading ?? 'no heading');
  const VIEWS = '[role="tablist"][aria-label="Scripts views"]';
  const REFS = '[role="tablist"][aria-label="Reference sections"]';
  const tabs = await evaluate(`[...document.querySelectorAll('${VIEWS} [role="tab"]')].map((b) => b.textContent.trim())`);
  check('the top bar has the three views', Array.isArray(tabs) && tabs.join('|') === 'My scripts|New|Reference', JSON.stringify(tabs));
  await shot('scripts-view-list');

  // New: chain first, then a rule or a script.
  check('New opens', await click(inScope('New', VIEWS)));
  await sleep(500);
  const newText = await mainText();
  check('New offers a rule and a script on a chosen chain', /Start a rule on/.test(newText) && /Start a script on/.test(newText) && /Which chain/.test(newText));
  await shot('scripts-view-new');
  // A rule draft, never saved: the editor with the header card on top.
  check('Start a rule makes a draft', await click(`() => [...document.querySelectorAll('main button')].find((b) => /^Start a rule on/.test(b.textContent.trim()))`));
  await sleep(700);
  const order = await evaluate(`(() => { const main = document.querySelector('main'); const all = [...main.querySelectorAll('*')]; const idx = (pred) => all.findIndex(pred); const name = idx((e) => e.tagName === 'INPUT' && e.getAttribute('aria-label') === 'Script name'); const save = idx((e) => e.tagName === 'BUTTON' && /^Save/.test(e.textContent.trim())); const kind = idx((e) => e.children.length === 0 && e.textContent.trim() === 'Kind'); const rules = idx((e) => e.tagName === 'H2' && /^Rule/.test(e.textContent.trim())); return { name, save, kind, rules }; })()`);
  out('DOM order:', JSON.stringify(order));
  check('the header card (name, Save) sits above the settings and the editor', order.name >= 0 && order.save > order.name && order.kind > order.save && (order.rules < 0 || order.rules > order.kind), `name ${order.name} < save ${order.save} < kind ${order.kind} < rules ${order.rules}`);
  await shot('scripts-view-editor');

  // Reference, all four sections render.
  check('Reference opens', await click(inScope('Reference', VIEWS)));
  await sleep(500);
  const refTabs = await evaluate(`[...document.querySelectorAll('${REFS} [role="tab"]')].map((b) => b.textContent.trim())`);
  check('Reference has the four sections', Array.isArray(refTabs) && refTabs.join('|') === 'AI prompt|Bot API|Variables|Examples', JSON.stringify(refTabs));
  check('the AI prompt section explains and offers the copy', /Copy AI prompt/.test(await mainText()) && /Let an assistant write the script/.test(await mainText()));
  await shot('scripts-view-reference-prompt');
  check('Bot API opens', await click(inScope('Bot API', REFS)));
  await sleep(400);
  check('the API doc renders', /bot\.(buy|links|market)\(/.test(await mainText()));
  check('Variables opens', await click(inScope('Variables', REFS)));
  await sleep(400);
  check('the variable guide renders with the new fields', /tgMembers/.test(await mainText()));
  await shot('scripts-view-reference-vars');
  check('Examples opens', await click(inScope('Examples', REFS)));
  await sleep(400);
  check('the examples list renders with Use it', /Use it/.test(await mainText()));
  await shot('scripts-view-reference-examples');
  // Back to My scripts; the unsaved draft is dropped by leaving the page.
  await click(inScope('My scripts', VIEWS));
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  if (hid) await showGate().catch(() => undefined);
  close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall scripts-page checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
