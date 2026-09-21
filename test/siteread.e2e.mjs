// The website read in the Links panel, live (2026-09-20). Attaches to a
// RUNNING dev app, points the Links panel at the $KRYPTO coin, clicks its
// Website button (krypt.cc), and waits for the panel to read the page —
// whether it names the contract, which X and Telegram it links, how big it
// is — then checks the record reached main (for the scripts). Restores the
// three localStorage keys it touches; keeps only this token's fresh read.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/siteread.e2e.mjs
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
const SITE_KEY = 'krypt.links.site.v1';
const LINKED = { mint: '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump', chain: 'solana', symbol: 'KRYPTO' };
const { evaluate, close } = await connect();
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) out(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; out(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const saved = await evaluate(`localStorage.getItem(${JSON.stringify(ENABLED_KEY)})`);
const savedToken = await evaluate(`localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`);
const savedSite = await evaluate(`localStorage.getItem(${JSON.stringify(SITE_KEY)})`);
const t0 = Date.now();
try {
  await evaluate(`(() => { [...document.querySelectorAll('[inert]')].forEach((e) => e.removeAttribute('inert')); return true; })()`);
  await evaluate(`(() => { const k=${JSON.stringify(ENABLED_KEY)}; let cur=[]; try { cur = JSON.parse(localStorage.getItem(k) || '[]'); } catch {} if (!cur.includes('links')) cur.push('links'); localStorage.setItem(k, JSON.stringify(cur)); return cur; })()`);
  await evaluate(`(() => { try { const all = JSON.parse(localStorage.getItem(${JSON.stringify(SITE_KEY)}) || '{}'); delete all[${JSON.stringify(LINKED.mint)}]; localStorage.setItem(${JSON.stringify(SITE_KEY)}, JSON.stringify(all)); } catch {} return true; })()`);
  await evaluate(`(() => { localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(JSON.stringify(LINKED))}); window.dispatchEvent(new CustomEvent('krypt:chart-token')); return true; })()`);
  const goTo = (label) => evaluate(`(() => { const L=${JSON.stringify(label)}; const all=[...document.querySelectorAll('button')]; const b=[...document.querySelectorAll('aside button')].find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.trim()===L) ?? all.find(b=>b.textContent.includes(L) && !/Back to the Hub/.test(b.getAttribute('title')||'')); if(!b) return false; b.click(); return true; })()`);
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
  const clicked = await evaluate(`(() => { const w=document.querySelector('webview'); if(!w) return false; const b=[...w.parentElement.querySelectorAll('button')].find(b=>b.textContent.trim()==='Website'); if(!b) return false; b.click(); return true; })()`);
  check('the token has a Website button', clicked);
  let fresh = null;
  let strip = null;
  for (let i = 0; i < 60; i++) {
    strip = await evaluate(`(() => { const w=document.querySelector('webview'); if(!w) return null; const el=w.nextElementSibling; return el ? el.textContent.trim() : null; })()`);
    fresh = await evaluate(`(() => { try { const all = JSON.parse(localStorage.getItem(${JSON.stringify(SITE_KEY)}) || '{}'); const e = all[${JSON.stringify(LINKED.mint)}]; return e && e.readAt > ${t0} ? e : null; } catch { return null; } })()`);
    if (fresh) break;
    await sleep(500);
  }
  check('a fresh site read landed', !!fresh, fresh ? `readAt ${fresh.readAt}` : 'none within 30 s');
  out('strip:', strip);
  if (fresh) {
    const r = fresh.read;
    out('read:', JSON.stringify({ host: r.host, title: r.title, namesContract: r.namesContract, xHandles: r.xHandles, telegramLinks: r.telegramLinks, outboundHosts: r.outboundHosts, wordCount: r.wordCount, generator: r.generator, connect: r.mentionsConnectWallet }));
    check('the read is of krypt.cc', r.host === 'krypt.cc', r.host);
    check('the page has words', r.wordCount > 0, String(r.wordCount));
    check('the strip describes the read', !!strip && /names the contract|does not name the contract/.test(strip), strip ?? 'no strip');
    check('the strip also carries the Telegram count and the domain (whichever page is open)', !!strip && /subscribers|members/.test(strip) && /Feb 2010|domain/.test(strip));
  }
  const main = await evaluate(`window.krypt.links.siteRead(${JSON.stringify(LINKED.mint)})`);
  check('main kept the record for the scripts', !!main?.ok && !!main.data && main.data.read?.host === 'krypt.cc', main?.data ? `readAt ${main.data.readAt}` : JSON.stringify(main).slice(0, 120));
} catch (err) {
  failures++;
  out('DRIVER ERROR:', err.message);
} finally {
  await evaluate(`(() => { const k=${JSON.stringify(ENABLED_KEY)}; ${saved === null ? 'localStorage.removeItem(k);' : `localStorage.setItem(k, ${JSON.stringify(saved)});`} const t=${JSON.stringify(TOKEN_KEY)}; ${savedToken === null ? 'localStorage.removeItem(t);' : `localStorage.setItem(t, ${JSON.stringify(savedToken)});`} window.dispatchEvent(new CustomEvent('krypt:chart-token')); return true; })()`).catch(() => undefined);
  if (savedSite !== null) await evaluate(`(() => { try { const old = JSON.parse(${JSON.stringify(savedSite)}); const cur = JSON.parse(localStorage.getItem(${JSON.stringify(SITE_KEY)}) || '{}'); if (cur[${JSON.stringify(LINKED.mint)}]) old[${JSON.stringify(LINKED.mint)}] = cur[${JSON.stringify(LINKED.mint)}]; localStorage.setItem(${JSON.stringify(SITE_KEY)}, JSON.stringify(old)); } catch {} return true; })()`).catch(() => undefined);
  close();
}
out(failures ? `\n${failures} check(s) FAILED` : '\nall site-read checks passed');
await sleep(150);
process.exit(failures ? 1 : 0);
