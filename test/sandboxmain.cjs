// Runs INSIDE Electron (see scriptsandbox.live.mjs): proves the script
// sandbox with the real thing — a hidden sandboxed renderer, the preload
// bridge, the locked-down session.
//
// What it checks:
//   1. a script loads, receives an event, logs, and gets an answer to a call;
//   2. it cannot reach the network (fetch rejects), Node (no require, no
//      process), and a refused call rejects with the refusal;
//   3. a handler that never returns is killed by the watchdog and the
//      sandbox is reported gone;
//   4. a script that throws while loading fails to start, promptly.
const { app } = require('electron');
const sb = require('./.sandbox/scriptsandbox.cjs');

const out = (...a) => process.stdout.write(`${a.join(' ')}\n`);

app.whenReady().then(async () => {
  const messages = [];
  let gone = null;
  sb.install({
    onMessage: (id, m) => {
      messages.push({ id, m });
      if (m.t === 'call') {
        if (m.method === 'price') sb.reply(id, m.id, true, 0.0042);
        else sb.reply(id, m.id, false, undefined, 'refused by the host');
      }
    },
    onGone: (id, reason) => {
      gone = { id, reason };
    },
    log: (level, line) => out('[sandbox]', level, line),
  });

  // 1 + 2: a well-behaved script that also probes the walls.
  const probe = `
    bot.on('launch', async (t) => {
      bot.log('got launch ' + t.symbol);
      bot.log('price ' + (await bot.price(t.mint)));
      let net = 'unknown';
      try { await fetch('https://example.com/'); net = 'FETCH-WORKED'; } catch (e) { net = 'fetch-blocked'; }
      bot.log('net ' + net);
      let ws = 'unknown';
      try { const s = new WebSocket('wss://example.com/'); await new Promise((res, rej) => { s.onopen = () => res(); s.onerror = () => rej(new Error('err')); setTimeout(() => rej(new Error('timeout')), 1500); }); ws = 'WS-WORKED'; } catch (e) { ws = 'ws-blocked'; }
      bot.log('ws ' + ws);
      bot.log('require ' + typeof require + ' process ' + typeof process + ' bridge ' + typeof window.__krypt_sandbox);
      try { await bot.buy(t.mint, 0.1); bot.log('buy WORKED'); } catch (e) { bot.log('buy refused: ' + e.message); }
    });`;
  const s1 = await sb.start('one', probe);
  out('start one:', JSON.stringify(s1));
  const t1 = Date.now();
  const d1 = await sb.dispatch('one', 'launch', { mint: 'Mint111111111111111111111111111111111111111', symbol: 'TST' });
  out('dispatch one:', JSON.stringify(d1), `${Date.now() - t1} ms`);
  const lines = messages.filter((x) => x.id === 'one' && x.m.t === 'log').map((x) => x.m.line);
  for (const l of lines) out('  one>', l);

  // 3: a runaway handler.
  const s2 = await sb.start('two', `bot.on('launch', () => { for (;;) {} });`);
  const t2 = Date.now();
  const d2 = await sb.dispatch('two', 'launch', {});
  out('runaway:', JSON.stringify(d2), `${Date.now() - t2} ms`);
  await new Promise((r) => setTimeout(r, 800));
  out('gone:', JSON.stringify(gone));

  // 4: a script that throws at load.
  const t3 = Date.now();
  const s3 = await sb.start('three', `throw new Error('bad script');`);
  out('bad load:', JSON.stringify(s3), `${Date.now() - t3} ms`);

  await sb.stopAll();
  const checks = {
    loads: s1.ok && s2.ok,
    eventHandled: d1.ok,
    logged: lines.includes('got launch TST'),
    callAnswered: lines.includes('price 0.0042'),
    fetchBlocked: lines.includes('net fetch-blocked'),
    wsBlocked: lines.includes('ws ws-blocked'),
    noNode: lines.some((l) => /^require undefined process undefined/.test(l)),
    refusalRejects: lines.some((l) => /buy refused: refused by the host/.test(l)),
    watchdogKilled: !d2.ok && /killed/.test(d2.error ?? ''),
    goneReported: !!gone && gone.id === 'two',
    badLoadFails: !s3.ok && Date.now() - t3 < 5_000,
  };
  for (const [k, v] of Object.entries(checks)) out(`${v ? 'ok  ' : 'FAIL'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  out(ok ? 'SANDBOX LIVE: PASS' : 'SANDBOX LIVE: FAIL');
  app.exit(ok ? 0 : 1);
});
