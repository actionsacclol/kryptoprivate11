// The chain-first summary, live in a RUNNING dev app (2026-09-20).
//
// Attaches over CDP and does what a token page does — asks for the summary
// of a pump coin every five seconds for a minute — while diffing the
// provider counters the app keeps for its own Settings › Providers panel.
// Before this change that minute cost ~10 pump.fun `/coins/{mint}` calls
// and, with the host parked, a page with no price. Now it must cost at most
// ONE (the ten-minute identity record), and the price must be the chain's.
// Also asks for a fresh curve coin from the New column, when there is one,
// so the pre-graduation path is seen live too.
//
// Nothing is clicked, nothing saved, no key printed.
//
//   KRYPT_DEBUG_PORT=9333 npm run dev
//   node test/pumpchain.e2e.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const PORT = process.env.PORT || '9333';
const KRYPTO = '2qEubd7GwtZbCqDu1uQwNC4kNaJLBdRUcWKpckTypump';
const ROUNDS = Number(process.env.ROUNDS || 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const providers = async () => {
  const rows = await evaluate(`window.krypt.market.providers().then((r) => JSON.stringify((r.data||[]).map((p) => ({ id: p.id, calls: p.calls, errors: p.errors, cool: Math.round(p.cooldownMs/1000) }))))`);
  return new Map(JSON.parse(rows).map((p) => [p.id, p]));
};
const summary = async (mint) => JSON.parse(await evaluate(`window.krypt.market.summary(${JSON.stringify(mint)}).then((r) => JSON.stringify(r.ok ? { ok: true, s: { name: r.data.name, symbol: r.data.symbol, priceSol: r.data.priceSol, priceUsd: r.data.priceUsd, marketCapUsd: r.data.marketCapUsd, liquidityUsd: r.data.liquidityUsd, bondingCurvePct: r.data.bondingCurvePct, dexId: r.data.dexId, poolAddress: r.data.poolAddress, imageUrl: r.data.imageUrl, createdAt: r.data.createdAt, creator: r.data.creator, sources: r.data.sources, fetchedAt: r.data.fetchedAt } } : { ok: false, message: r.message }))`));

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const fmt = (m) => [...m.values()].filter((p) => p.calls).map((p) => `${p.id} ${p.calls}${p.errors ? ` (${p.errors} err)` : ''}${p.cool ? ` parked ${p.cool}s` : ''}`).join(' · ');

try {
  // A fresh curve coin, if the New column has one.
  let curveMint = null;
  try {
    curveMint = await evaluate(`window.krypt.market.discover('new', 20, '5m').then((r) => { const rows = (r.data && (r.data.rows || r.data)) || []; const hit = rows.find((x) => x.mint && x.mint.endsWith('pump') && x.dexId !== 'pumpswap'); return hit ? hit.mint : null; }).catch(() => null)`);
  } catch { curveMint = null; }

  const before = await providers();
  console.log(`before: ${fmt(before) || 'no calls yet'}`);
  const t0 = Date.now();
  let first = null;
  let firstCurve = null;
  for (let i = 0; i < ROUNDS; i++) {
    const s = await summary(KRYPTO);
    if (i === 0) first = s;
    if (curveMint) {
      const c = await summary(curveMint);
      if (i === 0) firstCurve = c;
    }
    if (i < ROUNDS - 1) await sleep(5_000);
  }
  const after = await providers();
  console.log(`after ${Math.round((Date.now() - t0) / 1000)} s: ${fmt(after) || 'no calls'}`);
  const delta = (idp) => (after.get(idp)?.calls ?? 0) - (before.get(idp)?.calls ?? 0);
  console.log(`delta: pumpfun +${delta('pumpfun')} · jupiter +${delta('jupiter')} · dexscreener +${delta('dexscreener')} · geckoterminal +${delta('geckoterminal')}`);

  check('the summary came back', first?.ok === true, first?.ok ? '' : first?.message);
  if (first?.ok) {
    const s = first.s;
    console.log(`  $KRYPTO: ${s.name} (${s.symbol}) price ${s.priceSol} SOL · mcap ${s.marketCapUsd === null ? '—' : `$${Math.round(s.marketCapUsd).toLocaleString()}`} · liq ${s.liquidityUsd === null ? '—' : `$${Math.round(s.liquidityUsd).toLocaleString()}`} · ${s.dexId} · pool ${s.poolAddress} · image ${s.imageUrl ? 'yes' : 'none'} · created ${s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : '—'}`);
    console.log(`  sources: ${JSON.stringify(s.sources)}`);
    check('its price is the chain\'s', s.sources.price === 'onchain' && s.priceSol > 0, `price source ${s.sources.price}`);
    check('it is on PumpSwap with the canonical pool', s.dexId === 'pumpswap' && s.poolAddress === '5KA82pef8tpzZ29rRf3oJCdwjJ5NUTciLHpZQLdfPJga', `${s.dexId} ${s.poolAddress}`);
    check('the name comes off the chain too', s.name === 'Krypto Bot' && s.symbol === 'KRYPTO');
  }
  const perMinuteBefore = ROUNDS * (curveMint ? 2 : 1);
  check(`a minute of summaries cost pump.fun at most one call per coin (was ~${perMinuteBefore})`, delta('pumpfun') <= (curveMint ? 2 : 1), `+${delta('pumpfun')}`);
  if (curveMint) {
    check('a fresh curve coin summarised', firstCurve?.ok === true, curveMint);
    if (firstCurve?.ok) {
      const c = firstCurve.s;
      console.log(`  curve coin ${curveMint.slice(0, 8)}…: ${c.name || '—'} (${c.symbol || '—'}) price ${c.priceSol} SOL · ${c.bondingCurvePct === null ? '—' : c.bondingCurvePct.toFixed(1)} % · ${c.dexId} · creator ${c.creator ? c.creator.slice(0, 8) + '…' : '—'} · sources ${JSON.stringify(c.sources)}`);
      check('its price is the chain\'s (or the engine\'s own tape)', (c.sources.price === 'onchain' || c.sources.price === 'engine') && c.priceSol > 0, `price source ${c.sources.price}`);
    }
  } else console.log('(no fresh curve coin in the New column right now — pre-graduation path covered by the live unit read instead)');
} catch (err) {
  failures++;
  console.log('DRIVER ERROR:', err.message);
} finally {
  ws.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall chain-first checks passed');
await sleep(100);
process.exit(failures ? 1 : 0);
