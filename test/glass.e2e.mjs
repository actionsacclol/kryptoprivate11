// Liquid glass, live (2026-09-28). Attaches to a RUNNING dev app and checks
// the one thing no unit test can: that the lens actually exists on screen —
// a computed `backdrop-filter` carrying `blur()` and a `url(#…)` SVG filter
// on every glass surface — and that Lite mode takes every one of them away.
// Screenshots the onboarding card, the Hub, the shell, the search palette,
// a confirm modal, a toast, Lite mode and each look, so a person can judge
// the material. Samples frame gaps on the Hub with a dozen lenses over the
// animating backdrop, because "premium" is not worth a stutter.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/glass.e2e.mjs            (PORT=…, OUT=… to override)
//
// Read-only apart from Lite mode, which it switches on and back off through
// the Hub's own button (that writes `reduceEffects` on the profile the dev
// app is using). Looks are set as the DOM attribute only — the lens follows
// the look STORE, so the per-look screenshots show the stylesheet's side of
// each look with the lens as the current setting has it.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const OUT = process.env.OUT || 'C:/Users/Krypt/AppData/Local/Temp/krypt-glass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (...a) => console.log(...a);
fs.mkdirSync(OUT, { recursive: true });

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /localhost|127\.0\.0\.1|index\.html/.test(t.url)) ?? list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  out('target:', page.url);
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
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    out('shot:', file);
  };
  return { ws, call, evaluate, shot };
}

const { ws, call, evaluate, shot } = await connect();
await call('Page.enable');
await call('Runtime.enable');

// RELOAD=1: a fresh boot first, so the run also proves the page comes up
// clean (a hot-reloaded dev app can carry an HMR-only provider error).
if (process.env.RELOAD) {
  await call('Page.reload', { ignoreCache: false });
  await sleep(6000);
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const waitFor = async (expr, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(250); } return false; };

// Every lens on screen, with what its filter resolved to.
const LENSES = `(() => [...document.querySelectorAll('[data-liquid-glass]')].map((el) => {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { cls: (el.className || '').toString().slice(0, 60), filter: cs.backdropFilter, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' };
}))()`;
const lensReport = async (label) => {
  const rows = await evaluate(LENSES);
  const visible = rows.filter((r) => r.visible);
  const bent = visible.filter((r) => /url\(/.test(r.filter) && /blur\(/.test(r.filter));
  check(`${label}: every visible lens frosts and bends`, visible.length > 0 && bent.length === visible.length, `${bent.length}/${visible.length} lenses carry blur()+url()`);
  for (const r of visible.filter((x) => !(/url\(/.test(x.filter) && /blur\(/.test(x.filter)))) out(`     missing on: ${r.cls} → ${r.filter}`);
  return visible;
};

const hideGate = () => evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /KRYPT TERMINAL/.test(e.textContent || '')); if (!el) return false; let top = el; while (top.parentElement && getComputedStyle(top).position !== 'fixed') top = top.parentElement; if (getComputedStyle(top).position !== 'fixed') return false; top.setAttribute('data-e2e-hidden', '1'); top.style.visibility = 'hidden'; return true; })()`);
const clickText = (tag, text) => evaluate(`(() => { const b = [...document.querySelectorAll('${tag}')].find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
const clickTitle = (title) => evaluate(`(() => { const b = document.querySelector('[title=${JSON.stringify(title)}]'); if (!b) return false; b.click(); return true; })()`);

// Frame gaps over ~2 s, inside the renderer.
const FRAMES = `new Promise((res) => { const gaps = []; let last = performance.now(); const t0 = last; const tick = (now) => { gaps.push(now - last); last = now; if (now - t0 < 2000) requestAnimationFrame(tick); else { gaps.sort((a, b) => a - b); const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))]; res({ n: gaps.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +gaps[gaps.length - 1].toFixed(1), long: gaps.filter((g) => g > 33).length }); } }; requestAnimationFrame(tick); })`;

let hid = false;
let liteOn = false;
try {
  // ── The onboarding card, if the gate is up (a fresh profile). ──────
  const gated = await evaluate(`!![...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /KRYPT TERMINAL/.test(e.textContent || ''))`);
  if (gated) {
    await waitFor(`document.querySelectorAll('[data-liquid-glass]').length >= 1`, 8000);
    await sleep(600);
    await shot('01-onboarding.png');
    await lensReport('onboarding card');
    await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
    hid = await hideGate();
    check('gate hidden for the run', hid);
  } else out('info  no onboarding gate on this profile');

  // ── The Hub: a dozen lenses over the full-strength backdrop. ───────
  const onHub = await waitFor(`!!document.querySelector('[title="Watch the tutorial on YouTube — opens in your browser"]')`, 8000)
    || (await clickTitle('Back to the Hub'), await waitFor(`!!document.querySelector('[title="Watch the tutorial on YouTube — opens in your browser"]')`, 8000));
  check('on the Hub', onHub);
  await sleep(800);
  await shot('02-hub.png');
  const frost = await evaluate(`(() => [...document.querySelectorAll('.glass-frost')].map((el) => getComputedStyle(el).backdropFilter))()`);
  check('Hub tiles are frost (blur + saturate, no displacement)', frost.length >= 8 && frost.every((f) => /blur\(/.test(f) && !/url\(/.test(f)), `${frost.length} frosted, e.g. ${frost[0]}`);
  const hubLenses = await evaluate(`[...document.querySelectorAll('[data-liquid-glass]')].filter((e) => e.getBoundingClientRect().width > 0).length`);
  check('no lens on the Hub with nothing open', hubLenses === 0, `${hubLenses} lenses`);
  const f = await evaluate(FRAMES);
  out(`frames on the Hub (frost on): n=${f.n} p50=${f.p50}ms p95=${f.p95}ms max=${f.max}ms long(>33ms)=${f.long}`);
  check('Hub stays smooth with the frost on', f.p95 <= 12 && f.long === 0, `p95 ${f.p95}ms, ${f.long} long frames`);

  // ── The shell: sidebar + top bar. ──────────────────────────────────
  const terminal = await clickText('div', 'Terminal') || await evaluate(`(() => { const t = [...document.querySelectorAll('button')].find((b) => /Terminal/.test(b.textContent || '')); if (!t) return false; t.click(); return true; })()`);
  check('opened the Terminal workspace', terminal);
  await waitFor(`!!document.querySelector('aside.glass-chrome')`, 8000);
  await sleep(700);
  await shot('03-shell.png');
  // The frame carries no filter: it is on screen for the life of the app.
  const frame = await evaluate(`(() => [...document.querySelectorAll('.glass-chrome')].map((el) => getComputedStyle(el).backdropFilter))()`);
  check('the frame (top bar + sidebar) carries no filter', frame.length === 2 && frame.every((f) => f === 'none'), JSON.stringify(frame));
  const shellLenses = await evaluate(`[...document.querySelectorAll('[data-liquid-glass]')].filter((e) => e.getBoundingClientRect().width > 0).length`);
  check('no lens is on screen with nothing open', shellLenses === 0, `${shellLenses} lenses`);
  const fs2 = await evaluate(FRAMES);
  out(`frames on Discover (nothing open): n=${fs2.n} p50=${fs2.p50}ms p95=${fs2.p95}ms max=${fs2.max}ms long(>33ms)=${fs2.long}`);
  check('Discover stays smooth', fs2.p95 <= 12 && fs2.long === 0, `p95 ${fs2.p95}ms`);

  // ── The search palette: a lens inside the top bar's stacking context. ─
  const typed = await evaluate(`(() => { const i = document.querySelector('input[placeholder^="Search"]'); if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; i.focus(); set.call(i, 'pump'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  check('typed into the search', typed);
  const palette = await waitFor(`(() => { const i = document.querySelector('input[placeholder^="Search"]'); const box = i && i.closest('[class*="w-[340px]"]'); return !!(box && box.querySelector('[data-liquid-glass]')); })()`, 6000);
  check('the search palette is a lens', palette);
  await sleep(1200);
  await shot('04-search.png');
  const paletteAbove = await evaluate(`(() => { const i = document.querySelector('input[placeholder^="Search"]'); const box = i && i.closest('[class*="w-[340px]"]'); const p = box && box.querySelector('[data-liquid-glass]'); if (!p) return null; const r = p.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 24)); return !!hit && p.contains(hit); })()`);
  check('the palette paints above the page (hit-test lands inside it)', paletteAbove === true);
  await evaluate(`(() => { const i = document.querySelector('input[placeholder^="Search"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); document.body.click(); return true; })()`);
  await sleep(300);

  // ── A confirm modal: "Live" asks before it does anything. ──────────
  const live = await clickText('button', 'Live') || await clickText('button', 'LIVE');
  check('asked to go Live', live);
  const modal = await waitFor(`!!document.querySelector('[data-modal]')`, 5000);
  check('the confirm modal opened', modal);
  await sleep(500);
  await shot('05-modal.png');
  const modalLens = await evaluate(`(() => { const m = document.querySelector('[data-modal]'); const g = m && m.closest('[data-liquid-glass]'); return g ? getComputedStyle(g).backdropFilter : null; })()`);
  check('the modal card is a lens', !!modalLens && /url\(/.test(modalLens), modalLens ?? 'none');
  const cancelled = await clickText('button', 'Cancel');
  check('cancelled the confirm (nothing armed)', cancelled);
  await waitFor(`!document.querySelector('[data-modal]')`, 3000);

  // ── Lite mode, from the Hub's own button: every lens goes; a toast says so. ─
  await clickTitle('Back to the Hub');
  await waitFor(`!!document.querySelector('[title="Watch the tutorial on YouTube — opens in your browser"]')`, 8000);
  const liteBtn = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((e) => /Laggy\\? Lite mode/.test(e.textContent || '')); if (!b) return false; b.click(); return true; })()`);
  check('pressed "Laggy? Lite mode"', liteBtn);
  liteOn = liteBtn;
  const lite = await waitFor(`document.documentElement.classList.contains('lite')`, 6000);
  check('Lite mode came on', lite);
  await sleep(500);
  await shot('06-lite.png');
  const liteLenses = await evaluate(`document.querySelectorAll('[data-liquid-glass], .glass-frost').length`);
  check('Lite mode renders no lens and no frost at all', liteLenses === 0, `${liteLenses} filtered surfaces`);
  const flat = await evaluate(`document.querySelectorAll('.glass').length`);
  check('Lite mode renders the flat surface in its place', flat >= 8, `${flat} flat surfaces`);
  const fl = await evaluate(FRAMES);
  out(`frames on the Hub (Lite): n=${fl.n} p50=${fl.p50}ms p95=${fl.p95}ms max=${fl.max}ms long(>33ms)=${fl.long}`);

  // Back on: the toast that follows is itself a lens.
  const liteOff = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((e) => /Lite mode on/.test(e.textContent || '')); if (!b) return false; b.click(); return true; })()`);
  check('pressed "Lite mode on" to turn effects back', liteOff);
  liteOn = !liteOff;
  await waitFor(`!document.documentElement.classList.contains('lite')`, 6000);
  const toast = await waitFor(`!![...document.querySelectorAll('[data-liquid-glass]')].find((e) => /animate-pop-in/.test(e.className) && /Lite mode off/.test(e.textContent || ''))`, 4000);
  check('the toast is a lens', toast);
  await sleep(350);
  await shot('07-toast.png');
  await lensReport('toast');

  // ── The looks, attribute only. ─────────────────────────────────────
  const before = await evaluate(`document.documentElement.getAttribute('data-skin')`);
  for (const skin of ['classic', 'futuristic', 'minimal', 'hacker', 'retro', 'xp']) {
    await evaluate(`(document.documentElement.setAttribute('data-skin', ${JSON.stringify(skin)}), true)`);
    await sleep(700);
    await shot(`08-look-${skin}.png`);
  }
  await evaluate(before ? `(document.documentElement.setAttribute('data-skin', ${JSON.stringify(before)}), true)` : `(document.documentElement.removeAttribute('data-skin'), true)`);
  out('info  looks restored to', before ?? '(none)');
} finally {
  if (liteOn) {
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((e) => /Lite mode on/.test(e.textContent || '')); if (b) b.click(); return true; })()`).catch(() => undefined);
  }
  if (hid) await evaluate(`(() => { const el = document.querySelector('[data-e2e-hidden]'); if (!el) return false; el.style.visibility = ''; el.removeAttribute('data-e2e-hidden'); return true; })()`).catch(() => undefined);
  ws.close();
}

out(failures ? `\n${failures} check(s) FAILED` : '\nglass: all live checks passed');
process.exit(failures ? 1 : 0);
