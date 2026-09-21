// The four looks, live (2026-09-20). Attaches to a RUNNING dev app, and for
// each look puts the attribute on <html> — DOM only, nothing saved — then
// screenshots the Hub, the Discover page and the Settings picker so a person
// can judge the character of each. Reads the fonts actually in use per look
// off the computed styles, which is the one thing no unit test can see:
// whether the bundled font files loaded. Restores the attribute it found.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/skins.e2e.mjs
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
  return { evaluate, shot, close: () => ws.close() };
}

const SKINS = ['classic', 'futuristic', 'minimal', 'hacker', 'retro', 'xp'];
const { evaluate, shot, close } = await connect();
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const click = (finder) => evaluate(`(() => { const b = (${finder})(); if (!b) return false; b.click(); return true; })()`);
const hideGate = () => evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /KRYPT TERMINAL/.test(e.textContent || '')); if (!el) return false; let top = el; while (top.parentElement && getComputedStyle(top).position !== 'fixed') top = top.parentElement; if (getComputedStyle(top).position !== 'fixed') return false; top.setAttribute('data-e2e-hidden', '1'); top.style.visibility = 'hidden'; return true; })()`);
const showGate = () => evaluate(`(() => { const el = document.querySelector('[data-e2e-hidden]'); if (!el) return false; el.style.visibility = ''; el.removeAttribute('data-e2e-hidden'); return true; })()`);
const setSkin = (s) => evaluate(`(() => { document.documentElement.setAttribute('data-skin', ${JSON.stringify(s)}); return true; })()`);
const fontsInUse = () => evaluate(`(() => { const h = document.querySelector('main h1') ?? document.querySelector('h1'); const body = document.body; const mono = document.querySelector('.font-mono'); const f = (e) => e ? getComputedStyle(e).fontFamily.split(',')[0].replace(/["']/g, '').trim() : null; return { display: f(h), body: f(body), mono: f(mono), loaded: [...document.fonts].filter((x) => x.status === 'loaded').map((x) => x.family).filter((v, i, a) => a.indexOf(v) === i) }; })()`);
const original = await evaluate(`document.documentElement.getAttribute('data-skin')`);
let hid = false;
try {
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  hid = await hideGate();
  if (hid) out('(the welcome gate is up on this profile — hidden for the screenshots, not clicked)');
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  check('the app reports its current look on the root', original === null || SKINS.includes(original), String(original));
  const WANT = { classic: ['Cinzel', 'Spline Sans', 'JetBrains Mono'], futuristic: ['Orbitron', 'Rajdhani', 'Share Tech Mono'], minimal: ['Inter', 'Inter', 'JetBrains Mono'], hacker: ['VT323', 'Share Tech Mono', 'Share Tech Mono'], retro: ['Press Start 2P', 'Share Tech Mono', 'Share Tech Mono'], xp: ['Trebuchet MS', 'Tahoma', 'Lucida Console'] };
  // XP uses the system's own fonts: nothing to find in the bundle, and on a
  // machine without Tahoma the stack falls to the OS sans, which is fine.
  const BUNDLED = { classic: true, futuristic: true, minimal: true, hacker: true, retro: true, xp: false };
  for (const s of SKINS) {
    await setSkin(s);
    await sleep(700);
    const f = await fontsInUse();
    out(`[${s}] display=${f.display} body=${f.body} mono=${f.mono}`);
    if (BUNDLED[s]) {
      check(`${s}: the display font is ${WANT[s][0]}`, f.display === WANT[s][0], f.display ?? 'none');
      check(`${s}: the body font is ${WANT[s][1]}`, f.body === WANT[s][1], f.body ?? 'none');
      check(`${s}: the mono font is ${WANT[s][2]}`, f.mono === WANT[s][2] || f.mono === null, f.mono ?? 'no .font-mono on the Hub');
      check(`${s}: its fonts actually loaded from the bundle`, WANT[s].every((name) => f.loaded.includes(name)), f.loaded.join(', '));
    } else {
      check(`${s}: the system font stack is asked for (${WANT[s][0]} / ${WANT[s][1]})`, [WANT[s][0], 'Tahoma', 'Verdana', 'Segoe UI'].includes(f.display) && [WANT[s][1], 'Verdana', 'Segoe UI'].includes(f.body), `${f.display} / ${f.body}`);
    }
    await shot(`look-${s}-hub`);
  }
  // Discover, in each look — the densest page.
  const opened = await click(`() => [...document.querySelectorAll('button')].find((b) => /Terminal/.test(b.textContent) && !/Back to the Hub/.test(b.getAttribute('title') || ''))`);
  check('the Terminal workspace opens', opened);
  await sleep(1500);
  for (const s of SKINS) {
    await setSkin(s);
    await sleep(500);
    await shot(`look-${s}-discover`);
  }
  // The picker itself, on Settings.
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  check('Settings & Legal opens', await click(`() => [...document.querySelectorAll('button')].find((b) => /Settings & Legal/.test(b.textContent))`));
  await sleep(1200);
  const themeHeading = await evaluate(`(() => { const h=[...document.querySelectorAll('main h2')].find((e) => e.textContent.trim() === 'Theme'); if (!h) return false; h.scrollIntoView({ block: 'start' }); return true; })()`);
  check('the Theme section is on Settings', themeHeading);
  await sleep(500);
  const pickerText = await evaluate(`document.querySelector('main')?.textContent ?? ''`);
  check('the picker offers the six looks', /Classic/.test(pickerText) && /Futuristic/.test(pickerText) && /Minimal/.test(pickerText) && /Hacker/.test(pickerText) && /Retro/.test(pickerText) && /XP \/ Y2K/.test(pickerText));
  await setSkin('classic');
  await sleep(400);
  await shot('look-picker');
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  if (original) await setSkin(original).catch(() => undefined);
  else await evaluate(`(() => { document.documentElement.removeAttribute('data-skin'); return true; })()`).catch(() => undefined);
  if (hid) await showGate().catch(() => undefined);
  close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall look checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
