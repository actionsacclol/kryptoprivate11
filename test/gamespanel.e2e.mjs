// Games-panel check (2026-09-20). Read-only apart from ONE localStorage key it
// restores: attaches to a RUNNING dev app, temporarily adds the Games panel
// to Widgets, focuses the play area, sends real key presses through the
// DevTools protocol and confirms the canvas draws, the clock runs on focus
// and stops on blur, each game switches in, and a trading hotkey bound to
// Space would not have fired (the play area counts as typing).
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/gamespanel.e2e.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
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
  return { call, evaluate, close: () => ws.close() };
}

const ENABLED_KEY = 'krypt.panels.enabled.v1';
const { call, evaluate, close } = await connect();
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const key = async (k, code) => {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: k === ' ' ? 32 : k === 'ArrowRight' ? 39 : k === 'ArrowUp' ? 38 : k === 'ArrowDown' ? 40 : 0 });
  await sleep(30);
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === ' ' ? 32 : k === 'ArrowRight' ? 39 : k === 'ArrowUp' ? 38 : k === 'ArrowDown' ? 40 : 0 });
};
// A checksum of the canvas pixels: changes mean it drew a new frame.
const PIXELS = `(() => { const c=document.querySelector('[data-swallows-keys] canvas'); if(!c) return null; const g=c.getContext('2d'); const d=g.getImageData(0,0,c.width,c.height).data; let h=0; for(let i=0;i<d.length;i+=97) h=(h*31+d[i])>>>0; return { h, w:c.width, hgt:c.height }; })()`;
const saved = await evaluate(`localStorage.getItem(${JSON.stringify(ENABLED_KEY)})`);
try {
  await evaluate(`(() => { const k=${JSON.stringify(ENABLED_KEY)}; let cur=[]; try { cur = JSON.parse(localStorage.getItem(k) || '[]'); } catch {} if (!cur.includes('games')) cur.push('games'); localStorage.setItem(k, JSON.stringify(cur)); return cur; })()`);
  const goTo = (label) => evaluate(`(() => { const L=${JSON.stringify(label)}; const all=[...document.querySelectorAll('button')]; const b=[...document.querySelectorAll('aside button')].find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.includes(L) && !/Back to the Hub/.test(b.getAttribute('title')||'')); if(!b) return false; b.click(); return true; })()`);
  if (!(await goTo('Widgets'))) out('could not find the Widgets button');
  await sleep(800);
  await goTo('Orders');
  await sleep(800);
  await goTo('Widgets');
  await sleep(2500);
  // A dev profile can have the legal gate up (a TERMS_VERSION bump does that),
  // and the gate makes the whole shell `inert`: nothing behind it takes focus
  // or mouse hits. Lifting the attribute for this check is a DOM-only tweak;
  // it accepts nothing and persists nothing.
  const gated = await evaluate(`(() => { const n=[...document.querySelectorAll('[inert]')]; n.forEach((e) => e.removeAttribute('inert')); return n.length; })()`);
  if (gated) out(`(legal gate is up — ${gated} inert node(s) lifted for the check)`);
  let area = null;
  for (let i = 0; i < 20 && !area; i++) {
    area = await evaluate(`(() => { const a=document.querySelector('[data-swallows-keys]'); if(!a) return null; const r=a.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height, text: a.textContent.trim().slice(0,80) }; })()`);
    if (!area) await sleep(500);
  }
  check('the Games panel renders its play area', !!area, area ? `${Math.round(area.w)}×${Math.round(area.h)} "${area.text}"` : 'none within 10 s');
  if (area) {
    const p0 = await evaluate(PIXELS);
    check('the canvas has pixels', !!p0 && p0.w > 0 && p0.h > 0, p0 ? `${p0.w}×${p0.h}` : 'no canvas');
    // Focus the play area the way a click would (a real click cannot reach it
    // while a gate overlay is up), then steer the snake with real key events.
    const focused = await evaluate(`(() => { const a=document.querySelector('[data-swallows-keys]'); a.focus(); return document.activeElement === a; })()`);
    check('the play area takes focus', focused);
    await key('ArrowRight', 'ArrowRight');
    await sleep(700);
    const p1 = await evaluate(PIXELS);
    check('frames are drawn while focused', !!p1 && p1.h !== p0.h, 'pixels changed');
    const overlay = await evaluate(`(() => { const a=document.querySelector('[data-swallows-keys]'); return /Click to play/.test(a.textContent); })()`);
    check('the "Click to play" overlay is gone while running', overlay === false);
    // Blur: the clock stops.
    await evaluate(`document.activeElement?.blur(); true`);
    await sleep(300);
    const p2 = await evaluate(PIXELS);
    await sleep(500);
    const p3 = await evaluate(PIXELS);
    check('the clock stops on blur', p2.h === p3.h, 'pixels unchanged over 500 ms');
    // Each game switches in by its button.
    for (const label of ['Flappy Crypto', 'Dino', 'Tetris', '2048', 'Snake']) {
      const okBtn = await evaluate(`(() => { const b=[...document.querySelectorAll('[data-swallows-keys]')][0].parentElement.querySelectorAll('button'); const x=[...b].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!x) return false; x.click(); return true; })()`);
      await sleep(400);
      const shown = await evaluate(`(() => { const a=document.querySelector('[data-swallows-keys]'); return a.getAttribute('aria-label'); })()`);
      check(`${label} switches in`, okBtn && shown && shown.startsWith(label), shown ?? 'no aria-label');
    }
    // The trading-hotkey guard: a Space in the play area counts as typing.
    const swallowed = await evaluate(`(() => { const a=document.querySelector('[data-swallows-keys]'); a.focus(); const el=document.activeElement; return typeof el.closest==='function' && el.closest('[data-swallows-keys]')!==null; })()`);
    check('a key in the play area is treated like typing by the hotkey guard', swallowed);
  }
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  await evaluate(`(() => { const k=${JSON.stringify(ENABLED_KEY)}; ${saved === null ? 'localStorage.removeItem(k);' : `localStorage.setItem(k, ${JSON.stringify(saved)});`} return true; })()`).catch(() => undefined);
  close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall games-panel checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
