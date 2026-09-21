// X-page stats, live (2026-09-20). Read-only apart from two localStorage keys
// it restores: attaches to a RUNNING dev app, points the Links panel at the
// $KRYPTO coin, clicks its X button, and waits for the panel to read the
// profile off the rendered page — followers, following, joined — then
// checks the record reached main (for the scripts) and the token store (for
// the token page). The one thing no unit test can see: X's real markup today.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/xstats.e2e.mjs
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
  return { evaluate, close: () => ws.close() };
}

const ENABLED_KEY = 'krypt.panels.enabled.v1';
const TOKEN_KEY = 'krypt.panels.chartToken.v1';
const LINKED = { mint: '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump', chain: 'solana', symbol: 'KRYPTO' };
const { evaluate, close } = await connect();
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const saved = await evaluate(`localStorage.getItem(${JSON.stringify(ENABLED_KEY)})`);
const savedToken = await evaluate(`localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`);
const STATS_KEY = 'krypt.links.xstats.v1';
const savedStats = await evaluate(`localStorage.getItem(${JSON.stringify(STATS_KEY)})`);
const t0 = Date.now();
try {
  await evaluate(`(() => { const k=${JSON.stringify(ENABLED_KEY)}; let cur=[]; try { cur = JSON.parse(localStorage.getItem(k) || '[]'); } catch {} if (!cur.includes('links')) cur.push('links'); localStorage.setItem(k, JSON.stringify(cur)); return cur; })()`);
  // Forget this token's earlier read so the check sees a FRESH one.
  await evaluate(`(() => { try { const all = JSON.parse(localStorage.getItem(${JSON.stringify(STATS_KEY)}) || '{}'); delete all[${JSON.stringify(LINKED.mint)}]; localStorage.setItem(${JSON.stringify(STATS_KEY)}, JSON.stringify(all)); } catch {} return true; })()`);
  await evaluate(`(() => { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(JSON.stringify(LINKED))}); window.dispatchEvent(new CustomEvent('krypt:chart-token')); return true; })()`);
  const goTo = (label) => evaluate(`(() => { const L=${JSON.stringify(label)}; const all=[...document.querySelectorAll('button')]; const b=[...document.querySelectorAll('aside button')].find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.includes(L) && !/Back to the Hub/.test(b.getAttribute('title')||'')); if(!b) return false; b.click(); return true; })()`);
  // From inside a workspace the tiles are on the Hub: go back there first.
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title')||'') === 'Back to the Hub'); if (b) b.click(); return !!b; })()`);
  await sleep(800);
  if (!(await goTo('Widgets'))) out('could not find the Widgets button');
  await sleep(800);
  await goTo('Orders');
  await sleep(800);
  await goTo('Widgets');
  await sleep(2500);
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    ok = await evaluate(`!!document.querySelector('webview')`);
    if (!ok) await sleep(500);
  }
  check('the Links panel is up', ok);
  // Click X.
  const clicked = await evaluate(`(() => { const w=document.querySelector('webview'); if(!w) return false; const b=[...w.parentElement.querySelectorAll('button')].find(b=>b.textContent.trim()==='X'); if(!b) return false; b.click(); return true; })()`);
  check('the token has an X button', clicked);
  // Wait for the strip to say something other than "nothing read yet".
  let strip = null;
  let fresh = null;
  for (let i = 0; i < 60; i++) {
    // The numbers sit UNDER the view since 2026-09-20. Wait for a read made NOW.
    strip = await evaluate(`(() => { const w=document.querySelector('webview'); if(!w) return null; const el=w.nextElementSibling; return el ? el.textContent.trim() : null; })()`);
    fresh = await evaluate(`(() => { try { const all = JSON.parse(localStorage.getItem(${JSON.stringify(STATS_KEY)}) || '{}'); const e = all[${JSON.stringify(LINKED.mint)}]; return e && e.readAt > ${t0} ? e : null; } catch { return null; } })()`);
    if (fresh) break;
    await sleep(500);
  }
  check('a fresh read landed', !!fresh, fresh ? `readAt ${fresh.readAt}` : 'none within 30 s');
  out('strip:', strip);
  check('the panel read the X page', !!strip && /followers|sign-in wall|likes/.test(strip), strip ?? 'no strip');
  const entry = await evaluate(`(() => { try { const all = JSON.parse(localStorage.getItem('krypt.links.xstats.v1') || '{}'); return all[${JSON.stringify(LINKED.mint)}] ?? null; } catch { return null; } })()`);
  check('the read is kept for the token page', !!entry && typeof entry.readAt === 'number', entry ? `page ${entry.stats.page} · followers ${entry.stats.followers} · following ${entry.stats.following} · joined ${entry.stats.joined} · verified ${entry.stats.verified} · wall ${entry.stats.loginWall}` : 'none');
  if (entry?.stats.loginWall) out('(X showed its sign-in wall to the logged-out view — expected on a fresh profile; sign in inside the box and it reads again)');
  else check('followers were read as a number', typeof entry?.stats.followers === 'number' && entry.stats.followers > 0, String(entry?.stats.followers));
  const main = await evaluate(`window.krypt.links.xStats(${JSON.stringify(LINKED.mint)})`);
  check('main kept the record for the scripts', !!main?.ok && !!main.data && main.data.stats.page === entry?.stats.page, main?.data ? `readAt ${main.data.readAt}` : JSON.stringify(main).slice(0, 120));
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  await evaluate(`(() => { const k=${JSON.stringify(ENABLED_KEY)}; ${saved === null ? 'localStorage.removeItem(k);' : `localStorage.setItem(k, ${JSON.stringify(saved)});`} const t=${JSON.stringify(TOKEN_KEY)}; ${savedToken === null ? 'localStorage.removeItem(t);' : `localStorage.setItem(t, ${JSON.stringify(savedToken)});`} window.dispatchEvent(new CustomEvent('krypt:chart-token')); return true; })()`).catch(() => undefined);
  // The stored reads go back too — except this token's, which now holds the fresh one.
  if (savedStats !== null) await evaluate(`(() => { try { const old = JSON.parse(${JSON.stringify(savedStats)}); const cur = JSON.parse(localStorage.getItem(${JSON.stringify(STATS_KEY)}) || '{}'); if (cur[${JSON.stringify(LINKED.mint)}]) old[${JSON.stringify(LINKED.mint)}] = cur[${JSON.stringify(LINKED.mint)}]; localStorage.setItem(${JSON.stringify(STATS_KEY)}, JSON.stringify(old)); } catch {} return true; })()`).catch(() => undefined);
  close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall x-stats checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
