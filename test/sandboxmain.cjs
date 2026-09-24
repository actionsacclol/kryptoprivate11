// Runs INSIDE Electron (see scriptsandbox.live.mjs): proves the script
// sandbox with the real thing — a hidden sandboxed renderer, the preload
// bridge, the locked-down session.
//
// What it checks:
//   1. a script loads, receives an event, logs, and gets an answer to a call;
//   2. it cannot reach the network (fetch rejects, WebSocket rejects, WebRTC
//      is blocked by CSP so no ICE candidate and no STUN lookup ever leaves),
//      Node (no require, no process), and a refused call rejects with the
//      refusal;
//   3. a handler that never returns is killed by the watchdog and the
//      sandbox is reported gone;
//   4. a script that throws while loading fails to start, promptly;
//   5. a page that FORGES the `done` message and then wedges is still killed
//      on time — the watchdog is armed by the renderer's own liveness, not
//      by anything the page says;
//   6. a page that calls window.close() is reported gone, with nothing
//      thrown into the main process;
//   7. a page that floods the channel is rate-limited and told so;
//   8. top-level `await` works, and a SLOW one is waited for rather than
//      disarmed — the ready budget belongs to the user's code;
//   9. a preload that cannot load is named as a broken install, promptly,
//      instead of surfacing as a bare eight-second timeout (the failure
//      users actually hit).
const { app } = require('electron');
const sb = require('./.sandbox/scriptsandbox.cjs');

const out = (...a) => process.stdout.write(`${a.join(' ')}\n`);
const uncaught = [];
process.on('uncaughtException', (e) => {
  uncaught.push(String((e && e.message) || e));
  out('UNCAUGHT:', String((e && e.stack) || e));
});
process.on('unhandledRejection', (e) => {
  uncaught.push(`rejection: ${String((e && e.message) || e)}`);
  out('UNHANDLED REJECTION:', String((e && e.stack) || e));
});

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
    });
    // WebRTC needs no permission and is no "request": only the CSP can stop
    // it. A data channel plus a stun: server would be DNS + UDP straight out
    // of a sandbox promised no network. Own event, own 3 s budget.
    bot.on('tick', async () => {
      let rtc = 'unknown';
      try {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc.createDataChannel('probe');
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((res) => {
          const t = setTimeout(res, 800);
          pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
        });
        const sdp = (pc.localDescription && pc.localDescription.sdp) || '';
        const cands = sdp.split('\\n').filter((l) => l.indexOf('a=candidate') === 0).length;
        rtc = cands > 0 ? 'RTC-WORKED' : 'rtc-no-candidates';
        pc.close();
      } catch (e) {
        rtc = 'rtc-blocked';
      }
      bot.log('rtc ' + rtc + ' (typeof RTCPeerConnection ' + typeof RTCPeerConnection + ')');
    });`;
  const s1 = await sb.start('one', probe);
  out('start one:', JSON.stringify(s1));
  const t1 = Date.now();
  const d1 = await sb.dispatch('one', 'launch', { mint: 'Mint111111111111111111111111111111111111111', symbol: 'TST' });
  out('dispatch one:', JSON.stringify(d1), `${Date.now() - t1} ms`);
  const tRtc = Date.now();
  const dRtc = await sb.dispatch('one', 'tick', {});
  out('dispatch one (rtc):', JSON.stringify(dRtc), `${Date.now() - tRtc} ms`);
  const lines = messages.filter((x) => x.id === 'one' && x.m.t === 'log').map((x) => x.m.line);
  for (const l of lines) out('  one>', l);

  // 3: a runaway handler.
  const s2 = await sb.start('two', `bot.on('launch', () => { for (;;) {} });`);
  const t2 = Date.now();
  const d2 = await sb.dispatch('two', 'launch', {});
  out('runaway:', JSON.stringify(d2), `${Date.now() - t2} ms`);
  await new Promise((r) => setTimeout(r, 800));
  out('gone:', JSON.stringify(gone));
  const goneTwo = !!gone && gone.id === 'two';

  // 4: a script that throws at load.
  const t3 = Date.now();
  const s3 = await sb.start('three', `throw new Error('bad script');`);
  // Measured HERE, not in the checks block: the elapsed time has to be the
  // one this start took, not the age of the whole run.
  const badLoadMs = Date.now() - t3;
  out('bad load:', JSON.stringify(s3), `${badLoadMs} ms`);

  // 5: the watchdog cannot be talked out of it. The bridge's `on` is
  // additive and the dispatch id rides in the message body, so page code can
  // answer `done` for an event it never finished. This one does exactly that
  // and then wedges the renderer in the same turn.
  gone = null;
  const forge = `
    window.__krypt_sandbox.on((m) => {
      if (m && m.t === 'event') { window.__krypt_sandbox.send({ t: 'done', id: m.id, ok: true }); for (;;) {} }
    });
    bot.on('launch', async () => { await new Promise((r) => setTimeout(r, 50)); });`;
  const s4 = await sb.start('four', forge);
  const t4 = Date.now();
  const d4 = await sb.dispatch('four', 'launch', {});
  const forgedFast = Date.now() - t4;
  out('forged done:', JSON.stringify(d4), `${forgedFast} ms`);
  // 6 s, not 4: the deadline now ASKS the renderer whether it is wedged
  // before killing it, and a wedged one answers by never answering — so the
  // kill lands one probe timeout later than it used to. That second is the
  // price of not crashing well-behaved scripts.
  await new Promise((r) => setTimeout(r, 6_000));
  out('after forge — gone:', JSON.stringify(gone), 'isRunning:', sb.isRunning('four'));
  const forgeKilled = !!gone && gone.id === 'four' && !sb.isRunning('four');

  // 6: a page that closes its own window. Teardown must not read anything
  // off the destroyed window, or the throw escapes into the crash guard and
  // automation never learns the script died.
  gone = null;
  const s5 = await sb.start('five', `bot.on('launch', () => { setTimeout(() => window.close(), 10); });`);
  await sb.dispatch('five', 'launch', {});
  await new Promise((r) => setTimeout(r, 500));
  out('after close — gone:', JSON.stringify(gone), 'isRunning:', sb.isRunning('five'));
  const closeReported = !!gone && gone.id === 'five';
  await sb.stop('five', 'after close'); // must not throw on a destroyed window
  await sb.dispatch('five', 'launch', {}); // nor must this

  // 7: a flood. Main is where breakers, orders and sells are evaluated, so
  // unbounded sandbox chatter delays a stop-loss.
  const s6 = await sb.start('six', `bot.on('launch', () => { for (let i = 0; i < 2000; i++) bot.log('flood ' + i); });`);
  const t6 = Date.now();
  const d6 = await sb.dispatch('six', 'launch', {});
  const floodLogs = messages.filter((x) => x.id === 'six' && x.m.t === 'log').length;
  const floodErr = messages.filter((x) => x.id === 'six' && x.m.t === 'error').map((x) => x.m.line);
  out('flood:', JSON.stringify(d6), `${Date.now() - t6} ms`, `${floodLogs}/2000 logs delivered`, JSON.stringify(floodErr));

  // 8: top-level `await` — the guide and the generated AI prompt promise it,
  // and a plain `new Function` body cannot run it.
  const s7 = await sb.start('seven', `
    const p = await bot.price('Mint111111111111111111111111111111111111111');
    bot.log('top-level await got ' + p);
    bot.on('launch', () => {});`);
  const sevenLines = messages.filter((x) => x.id === 'seven' && x.m.t === 'log').map((x) => x.m.line);
  out('top-level await:', JSON.stringify(s7), JSON.stringify(sevenLines));

  // 9: a SLOW top-level await. Top-level await is promised, so this budget is
  // the user's code, not the sandbox coming up: a single `bot.market(...)`
  // behind a parked provider outlasts the 8 s ready timeout. A renderer that
  // is merely waiting must be given more time, not disarmed.
  const t8 = Date.now();
  const s8 = await sb.start('eight', `
    await new Promise((r) => setTimeout(r, 11000));
    bot.log('slow start finished');
    bot.on('launch', () => {});`);
  const slowMs = Date.now() - t8;
  const eightLines = messages.filter((x) => x.id === 'eight' && x.m.t === 'log').map((x) => x.m.line);
  out('slow top-level await:', JSON.stringify(s8), `${slowMs} ms`, JSON.stringify(eightLines));

  // 10: THE bug users reported — "DISABLED: could not start: no ready within
  // 8000 ms". Every preload failure was silent and identical: the harness
  // finds no bridge and returns, so the only symptom was the timeout. It must
  // now name the preload, say it is a broken install rather than the script,
  // and come back promptly instead of burning the full budget.
  const t9 = Date.now();
  sb._setPreloadPath(require('path').join(__dirname, '.sandbox', 'no-such-preload.js'));
  const s9 = await sb.start('nine', `bot.on('launch', () => {});`);
  const badPreloadMs = Date.now() - t9;
  sb._setPreloadPath(null);
  out('broken preload:', JSON.stringify(s9), `${badPreloadMs} ms`);

  // and the sandbox still works once the install is sound again
  const s10 = await sb.start('ten', `bot.on('launch', () => {});`);
  out('recovered after a broken preload:', JSON.stringify(s10));

  // 11: a SLOW BUT RESPONSIVE handler must finish, not be crashed.
  //
  // The event deadline is 3 s and `bot.market()` alone is documented as "a
  // second or more", so two of them in one handler used to blow it — and the
  // sandbox was crashed for OUR latency, taking every byte of the script's
  // in-memory state with it. A user lost seven hours to that
  // (docs/script-never-bought-2026-09-21.md).
  //
  // The two cases are distinguishable: a renderer in a loop cannot answer an
  // injected expression, one that is merely awaiting can. This handler awaits
  // for twice the deadline and must come back normally, with the script still
  // running afterwards. Case 3 above proves the wedged one still dies.
  gone = null;
  const s11 = await sb.start('eleven', `bot.on('launch', async () => { await new Promise((r) => setTimeout(r, 6500)); bot.log('slow handler finished'); });`);
  const t11 = Date.now();
  const d11 = await sb.dispatch('eleven', 'launch', {});
  const slowHandlerMs = Date.now() - t11;
  const elevenLines = messages.filter((x) => x.id === 'eleven' && x.m.t === 'log').map((x) => x.m.line);
  out('slow handler:', JSON.stringify(d11), `${slowHandlerMs} ms`, JSON.stringify(elevenLines), 'isRunning:', sb.isRunning('eleven'));
  const slowHandlerSurvived =
    d11.ok && slowHandlerMs > 5_000 && elevenLines.includes('slow handler finished') && sb.isRunning('eleven') && !gone;

  await sb.stopAll();
  const checks = {
    loads: s1.ok && s2.ok,
    eventHandled: d1.ok,
    logged: lines.includes('got launch TST'),
    callAnswered: lines.includes('price 0.0042'),
    fetchBlocked: lines.includes('net fetch-blocked'),
    wsBlocked: lines.includes('ws ws-blocked'),
    rtcBlocked: lines.some((l) => /^rtc (rtc-blocked|rtc-no-candidates)\b/.test(l)),
    noNode: lines.some((l) => /^require undefined process undefined/.test(l)),
    refusalRejects: lines.some((l) => /buy refused: refused by the host/.test(l)),
    watchdogKilled: !d2.ok && /killed/.test(d2.error ?? ''),
    goneReported: goneTwo,
    badLoadFails: !s3.ok && badLoadMs < 5_000,
    forgedDoneStillKilled: s4.ok && forgeKilled,
    windowCloseReported: s5.ok && closeReported,
    floodLimited: s6.ok && floodLogs < 500 && floodErr.some((l) => /flooded the sandbox channel/.test(l)),
    topLevelAwait: s7.ok && sevenLines.includes('top-level await got 0.0042'),
    slowTopLevelAwaitSurvives: s8.ok && slowMs > 8_000 && eightLines.includes('slow start finished'),
    brokenPreloadNamed:
      !s9.ok &&
      s9.retryable === true &&
      /broken install/.test(s9.message) &&
      badPreloadMs < 8_000,
    recoversAfterBrokenPreload: s10.ok,
    // Waiting is not wedging: a responsive handler past the deadline is given
    // more time, and its script keeps its memory.
    slowHandlerSurvives: s11.ok && slowHandlerSurvived,
    noUncaught: uncaught.length === 0,
  };
  for (const [k, v] of Object.entries(checks)) out(`${v ? 'ok  ' : 'FAIL'} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  out(ok ? 'SANDBOX LIVE: PASS' : 'SANDBOX LIVE: FAIL');
  app.exit(ok ? 0 : 1);
});
