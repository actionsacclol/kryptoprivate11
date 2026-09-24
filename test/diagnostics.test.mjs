// The support bundle (electron/system/diagnostics.ts).
//
// This file is the one thing a user is invited to send to a stranger, so the
// checks here are about what must NEVER be in it and what must always be:
// no key, no seed, no token — but enough shape left that a reader can tell a
// key IS set. Plus the truncation rule, because a bundle nobody can attach is
// a bug report nobody files.

import assert from 'node:assert';
import fs from 'node:fs';
import { BUNDLE_MAX_BYTES, NOTE_MAX_CHARS, buildBundle, bundleName, humanUptime, recentErrors, scrubUrl, stripSecrets } from './.diagnostics.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const NOW = Date.UTC(2026, 8, 21, 14, 30, 0);

const deps = (over = {}) => ({
  now: NOW,
  app: { name: 'Krypto Terminal', version: '4.0.0', electron: '43.4.1', node: '22.0.0', chrome: '130', platform: 'win32', arch: 'x64', packaged: true, locale: 'en-GB' },
  uptimeMs: 3 * 3_600_000 + 12 * 60_000,
  settings: {},
  state: ['LIVE trading is armed'],
  providers: [],
  files: [],
  crashes: [],
  logs: [],
  problems: [],
  ...over,
});

// ── secrets are removed, not masked ──────────────────────────────────────
{
  const settings = {
    rpc: { httpUrl: 'https://mainnet.helius-rpc.com/?api-key=abc123secret', heliusApiKey: 'abc123secret', commitment: 'confirmed' },
    bots: { telegram: { token: '123456:AAEexampleBotToken', enabled: true, ownerId: '99' } },
    // REGRESSION, found by running this against a real profile 2026-09-21:
    // the first rule only knew `apikey`, so `anthropicKey` walked straight
    // through it — and so would heliusKey, birdeyeKey, or whatever the next
    // provider is called. A name ending in "key" is a secret now, unless it
    // is one of the two that are public by definition.
    ai: { apiKey: 'sk-live-not-a-real-key', anthropicKey: 'ant-real-looking-key-value', provider: 'anthropic' },
    providers: { heliusKey: 'helius-shaped-value', birdeyeKey: 'birdeye-shaped-value', giphyApiKey: 'giphy-shaped-value' },
    wallet: { publicKey: '2NWQUKUgexampleaddressnotasecret', pubkey: 'alsonotasecret' },
    mcp: { token: 'a'.repeat(64), enabled: true, port: 8787, access: 'read' },
    evm: { bnb: { rpcUrl: 'https://bnb.example.com/v2/LONGKEYLONGKEYLONGKEYLONGKEY', enabled: true } },
    alerts: { webhookUrl: 'https://discord.com/api/webhooks/123/abcdefghijklmnop' },
    execution: { liveEnabled: true, maxLiveSol: 0.5 },
  };
  const out = stripSecrets(settings);
  const text = JSON.stringify(out);

  for (const secret of [
    'abc123secret',
    'AAEexampleBotToken',
    'sk-live-not-a-real-key',
    'ant-real-looking-key-value',
    'helius-shaped-value',
    'birdeye-shaped-value',
    'giphy-shaped-value',
    'a'.repeat(64),
    'LONGKEYLONGKEYLONGKEYLONGKEY',
    'abcdefghijklmnop',
  ]) {
    assert.ok(!text.includes(secret), `the bundle must not contain "${secret.slice(0, 12)}…"`);
  }
  // The SHAPE survives: a reader can tell a key is set without learning it.
  assert.equal(out.rpc.heliusApiKey, '<set>', 'the key is still reported as present');
  assert.equal(out.bots.telegram.token, '<set>');
  assert.equal(out.mcp.token, '<set>');
  assert.equal(out.alerts.webhookUrl, '<set>');
  // Non-secrets are untouched — they are the diagnosis.
  assert.equal(out.rpc.commitment, 'confirmed');
  assert.equal(out.execution.liveEnabled, true);
  assert.equal(out.execution.maxLiveSol, 0.5);
  assert.equal(out.mcp.port, 8787);
  assert.equal(out.bots.telegram.enabled, true);
  assert.equal(out.ai.anthropicKey, '<set>', 'a provider key nobody added to a list is still a secret');
  assert.equal(out.providers.heliusKey, '<set>');
  assert.equal(out.providers.birdeyeKey, '<set>');
  // A public key is public: it is an address, and it is a diagnosis.
  assert.equal(out.wallet.publicKey, '2NWQUKUgexampleaddressnotasecret', 'a PUBLIC key is not a secret and is kept');
  assert.equal(out.wallet.pubkey, 'alsonotasecret');
  // A URL keeps its HOST, which is what a reader needs, and loses the rest.
  assert.ok(out.rpc.httpUrl.includes('mainnet.helius-rpc.com'), 'the host survives');
  assert.ok(!out.rpc.httpUrl.includes('abc123secret'));
  assert.ok(out.evm.bnb.rpcUrl.includes('bnb.example.com'));
  ok('every key, token, seed and webhook is removed; the host and every non-secret value survive so the file is still a diagnosis');
}

{
  assert.equal(scrubUrl('https://h.example/?api-key=SECRET&x=1'), 'https://h.example/?api-key=***&x=***');
  assert.equal(scrubUrl('https://h.example/v2/AAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'https://h.example/v2/***');
  assert.equal(scrubUrl('not a url at all'), '***', 'something unparseable is dropped rather than passed through');
  assert.equal(scrubUrl(''), '');
  // Nested and array values are walked too.
  const nested = stripSecrets({ a: [{ apiKey: 'x' }, { safe: 'y' }], b: { deep: { secret: 'z' } } });
  assert.equal(nested.a[0].apiKey, '<set>');
  assert.equal(nested.a[1].safe, 'y');
  assert.equal(nested.b.deep.secret, '<set>');
  ok('URLs keep their host and lose their key; arrays and nested objects are walked');
}

// ── the file says what it is ─────────────────────────────────────────────
{
  const { text } = buildBundle(
    deps({
      settings: { rpc: { heliusApiKey: 'zzz' } },
      state: ['LIVE trading is armed', '2 copy configs (1 live)', 'the AI connection is open at read'],
      providers: [{ id: 'jupiter', host: 'lite-api.jup.ag', enabled: true, usable: false, calls: 120, errors: 7, cooldownMs: 41_000, lastError: 'HTTP 429' }],
      files: [{ name: 'settings.json', bytes: 5968, modifiedAt: NOW }],
      crashes: [],
      logs: [{ name: 'app.log', text: 'a line\nanother line' }],
    }),
  );
  // The promise at the top, in the words a user needs before forwarding it.
  assert.match(text, /does NOT contain your private key/);
  assert.match(text, /may name coins you looked at/, 'and the one honest caveat about what IS in there');
  assert.ok(!text.includes('zzz'), 'the key never reaches the file');
  assert.match(text, /"heliusApiKey": "<set>"/);
  assert.match(text, /version      4\.0\.0/);
  assert.match(text, /running for  3h 12m/);
  assert.match(text, /LIVE trading is armed/);
  assert.match(text, /the AI connection is open at read/);
  assert.match(text, /jupiter/);
  assert.match(text, /41s/, 'a parked provider says how long — it explains most "no price" reports');
  assert.match(text, /settings\.json/);
  assert.match(text, /\(none — good\)/, 'no crash files is stated, not left blank');
  assert.match(text, /===== app\.log =====/);
  assert.match(text, /another line/);
  // A dev build is labelled, so nobody debugs a packaged release from it.
  assert.match(buildBundle(deps({ app: { ...deps().app, packaged: false } })).text, /dev build, not packaged/);
  ok('the bundle states what it contains, labels a dev build, and carries the versions, state, providers, files and log');
}

// ── nothing is silently missing ──────────────────────────────────────────
{
  const { text } = buildBundle(deps({ problems: ['wallet-scout.json could not be read (EBUSY)'], files: [], providers: [] }));
  assert.match(text, /what could not be gathered/);
  assert.match(text, /EBUSY/);
  assert.match(text, /\(none found\)/, 'an empty file list says so rather than rendering nothing');
  assert.match(text, /\(none reported\)/);
  // A settings object that cannot be serialised does not take the bundle down.
  const cyclic = {};
  cyclic.self = cyclic;
  const r = buildBundle(deps({ settings: cyclic }));
  assert.match(r.text, /settings could not be read/);
  ok('a gap is reported as a gap, and nothing unreadable can stop the bundle being produced');
}

// ── truncation keeps the END of the log ──────────────────────────────────
{
  // A log far bigger than the cap: the newest lines are what explain the bug.
  const huge = `${'x'.repeat(BUNDLE_MAX_BYTES)}\nLAST LINE BEFORE THE CRASH`;
  const { text, truncatedBytes } = buildBundle(deps({ logs: [{ name: 'app.log', text: huge }] }));
  assert.ok(truncatedBytes > 0, 'it was cut');
  assert.ok(Buffer.byteLength(text, 'utf8') <= BUNDLE_MAX_BYTES, `the file fits an attachment: ${Buffer.byteLength(text, 'utf8')}`);
  assert.match(text, /LAST LINE BEFORE THE CRASH/, 'the END of the log survives — that is the part that explains it');
  assert.match(text, /was cut to keep this file under/, 'and the cut is stated, never silent');
  // Under the cap, nothing is cut and both files are present in order.
  const small = buildBundle(deps({ logs: [{ name: 'app.log.1', text: 'older' }, { name: 'app.log', text: 'newer' }] }));
  assert.equal(small.truncatedBytes, 0);
  assert.ok(small.text.indexOf('app.log.1') < small.text.indexOf('===== app.log ====='), 'oldest first');
  ok('an oversized log is cut from the FRONT and the cut is stated; a small one is kept whole, oldest first');
}

{
  assert.equal(bundleName('Krypto Terminal', NOW).startsWith('krypto-terminal-logs-2026-09-21-'), true, bundleName('Krypto Terminal', NOW));
  assert.match(bundleName('Krypto Terminal', NOW), /\.txt$/);
  assert.equal(bundleName('!!!', NOW).startsWith('app-logs-'), true, 'a name with nothing usable still produces a filename');
  assert.equal(humanUptime(45_000), '45s');
  assert.equal(humanUptime(90_000), '1m');
  assert.equal(humanUptime(3 * 3_600_000), '3h 0m');
  assert.equal(humanUptime(50 * 3_600_000), '2d 2h');
  ok('the filename is dated and safe, and the uptime reads in words');
}

// 2026-09-23: the user's own words first, then a readable error summary.
{
  const log = [
    '2026-09-23T10:00:00.000Z INFO  scanner started',
    '2026-09-23T10:00:01.000Z WARN  provider pumpfun rate limited — paused 20s, strike 1',
    '2026-09-23T10:00:02.000Z ERROR live buy failed: blockhash expired',
    '2026-09-23T10:00:03.000Z WARN  provider pumpfun rate limited — paused 40s, strike 2',
    '2026-09-23T10:00:04.000Z WARN  provider pumpfun rate limited — paused 80s, strike 3',
  ].join('\n');
  const r = recentErrors([{ name: 'app.log', text: log }]);
  assert.equal(r[0], '2026-09-23T10:00:02.000Z ERROR live buy failed: blockhash expired', 'errors come first');
  assert.equal(r.filter((l) => /rate limited/.test(l)).length, 1, 'a repeated warning collapses to one line');
  assert.match(r[r.length - 1], /strike 3 {3}\(×3\)$/, 'the newest copy, with its count');
  assert.ok(!r.some((l) => /INFO/.test(l)), 'info is left in the full log');

  const { text } = buildBundle(deps({ note: 'Discover froze after I bought', logs: [{ name: 'app.log', text: log }] }));
  const at = (s) => text.indexOf(s);
  assert.ok(at('Discover froze after I bought') > 0, 'the user note is in the file');
  assert.ok(at('Discover froze after I bought') < at('recent warnings and errors'), 'before the summary');
  assert.ok(at('recent warnings and errors') < at('LIVE trading is armed'), 'and the summary before everything else');
  assert.match(buildBundle(deps()).text, /\(nothing written\)/, 'no note is said plainly');
  assert.ok(buildBundle(deps({ note: 'x'.repeat(NOTE_MAX_CHARS + 500) })).text.includes('x'.repeat(NOTE_MAX_CHARS)), 'a long note is kept up to the cap');
  assert.ok(!buildBundle(deps({ note: 'x'.repeat(NOTE_MAX_CHARS + 1) })).text.includes('x'.repeat(NOTE_MAX_CHARS + 1)), 'and cut there');
  ok('the user note leads, then a de-duplicated errors-first summary');
}

{
  // Script lines reach app.log (they used to die with the panel), capped.
  const autos = fs.readFileSync(new URL('../electron/engine/automation.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(autos, /case 'log':\n\s+pushLog\(rt, msg\.level, msg\.line\);\n\s+scriptFileLog\(s, msg\.level, msg\.line\);/, 'every sandbox log line goes to the file');
  assert.match(autos, /const SCRIPT_FILE_LINES_PER_MIN = 120;/, 'under a per-script cap');
  const main = fs.readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(main, /console\.error\(`\[ui\] uncaught \$\{described\(/, 'renderer errors are logged as one string, stack included');
  ok('script lines and renderer stacks reach the log file');
}

console.log(`\ndiagnostics: ${passed}/8 passed`);
