// The support bundle — one file a user can attach when something went wrong.
//
// WHY A FILE AND NOT A SERVER. This app sends no telemetry, and that is a
// promise in its privacy policy, not a default someone can flip. So there is
// no "phone home" here and never will be: the user presses a button, reads
// what the file contains, and decides whether to send it. Nothing leaves the
// machine unless a person moves it.
//
// WHAT IS IN IT, and why each part earns its place:
//
//   1. Versions and platform — half of all "it does not work for me" reports
//      are answered by the build number alone.
//   2. The settings, with every secret STRIPPED (not masked — removed). A
//      support reader needs to know a user is on the public RPC with the
//      scanner off; they never need the key.
//   3. What is switched on right now: live or paper, the scanner, how many
//      copy configs and scripts exist and in which mode, whether the AI
//      connection is open. Most reports are really "this feature was on and
//      I did not know".
//   4. The provider board — which data sources are parked, and why. A parked
//      provider explains most "no price" and "chart is empty" reports.
//   5. A file inventory: name, size, modified time for every state file. Not
//      the contents. `creators.json` at 6 MB or `settings.json` missing
//      entirely are both diagnoses, and neither needs the data inside.
//   6. The log itself, `app.log.1` then `app.log`, tail-first if it has to be
//      cut.
//
// WHAT IS NOT IN IT: no private key, no seed, no API key, no wallet balances,
// no trade history, no token holdings, no addresses beyond the truncated
// active wallet. The logs may name a mint or a signature a user traded — they
// already do on screen — and the header says so plainly so nobody is
// surprised by what they forwarded.
//
// Pure-ish: every input arrives through `BundleDeps`, so the whole thing is
// testable offline (test/diagnostics.test.mjs) without a running app.

/** Total size of the finished file. Discord's free attachment limit is 8 MB
 *  and a bundle that cannot be attached is a bundle nobody sends. */
export const BUNDLE_MAX_BYTES = 6 * 1024 * 1024;

export interface BundleFileInfo {
  name: string;
  bytes: number;
  modifiedAt: number | null;
}

export interface BundleDeps {
  now: number;
  app: { name: string; version: string; electron: string; node: string; chrome: string; platform: string; arch: string; packaged: boolean; locale: string };
  /** Milliseconds this process has been up. */
  uptimeMs: number;
  /** The settings object. Secrets are stripped HERE, by `stripSecrets`. */
  settings: unknown;
  /** One line per switched-on thing, already in plain words. */
  state: string[];
  /** The provider board, as the Settings panel shows it. */
  providers: Array<{ id: string; host: string; enabled: boolean; usable: boolean; calls: number; errors: number; cooldownMs: number; lastError: string | null }>;
  /** Every file in the profile: name, size, modified. Contents are never read. */
  files: BundleFileInfo[];
  /** Crash dump filenames, if any. */
  crashes: string[];
  /** `app.log.1` then `app.log`, oldest first. Missing files are simply absent. */
  logs: Array<{ name: string; text: string }>;
  /** What the app could not gather, so the reader knows a gap is a gap. */
  problems: string[];
  /** What the user says went wrong, typed on the Logs panel. Optional. */
  note?: string;
}

/** Longest a user's description may be. A report, not an essay. */
export const NOTE_MAX_CHARS = 4000;
/** How many of the newest warnings and errors are pulled to the top. */
export const RECENT_ERRORS = 40;

/**
 * The newest WARN / ERROR lines across the logs, oldest first.
 *
 * A 5 MB log is mostly INFO. The thing a reader wants first is what went
 * wrong, so it is lifted out and printed near the top (2026-09-23); the full
 * log still follows, so nothing is lost by the summary.
 */
export function recentErrors(logs: Array<{ name: string; text: string }>, max = RECENT_ERRORS): string[] {
  // Repeats collapse to their newest line with a count: a provider parking
  // itself forty times ("rate limited — paused 20s, strike 7") would
  // otherwise push every real error out of the summary. The key is the line
  // without its timestamp and with its numbers blurred.
  const seen = new Map<string, { line: string; level: string; n: number }>();
  for (const f of logs) {
    for (const line of f.text.split(/\r?\n/)) {
      const m = /^(\S+)\s+(WARN|ERROR)\b\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = `${m[2]} ${m[3].replace(/\d+(\.\d+)?/g, '#')}`;
      const prev = seen.get(key);
      seen.delete(key); // re-insert so the map stays ordered by LAST seen
      seen.set(key, { line: line.length > 500 ? `${line.slice(0, 499)}…` : line, level: m[2], n: (prev?.n ?? 0) + 1 });
    }
  }
  const all = [...seen.values()];
  const fmt = (e: { line: string; n: number }): string => (e.n > 1 ? `${e.line}   (×${e.n})` : e.line);
  // Errors first — they are rarer and matter more — then warnings, each
  // newest-last, together within `max`.
  const errors = all.filter((e) => e.level === 'ERROR').slice(-max);
  const warns = all.filter((e) => e.level === 'WARN').slice(-(max - errors.length));
  return [...errors.map(fmt), ...(errors.length && warns.length ? [''] : []), ...warns.map(fmt)];
}

/**
 * Keys whose VALUE is removed entirely rather than masked.
 *
 * Masking is what the logger does, because a log line is prose and cutting it
 * would lose the sentence. A settings dump is structured, so the honest thing
 * is to delete the value and leave the key — the reader learns "a Helius key
 * is set" without learning the key.
 */
const SECRET_KEYS = /(apikey|api[-_]key|token|secret|password|passphrase|private[-_]?key|seed|mnemonic|webhook|credential|bearer)/i;
/**
 * …and anything whose name simply ENDS in "key".
 *
 * Found by running this against a real profile on 2026-09-21: `anthropicKey`
 * sailed straight through a rule that only knew `apikey`, and so would
 * `heliusKey`, `birdeyeKey` or whatever the next provider is called. The
 * lesson is that an allowlist of known secret names is a list someone has to
 * remember to add to, and nobody does. So the rule is inverted: a name
 * ending in "key" is a secret unless it is one of the two that are public by
 * definition.
 */
const KEYISH = /key$/i;
const PUBLIC_KEYS = /^(public[-_]?key|pub[-_]?key)$/i;
/** A URL can carry a key in its path or query, so URLs are scrubbed not dropped. */
const URL_KEYS = /url$/i;

/** Strip an API key out of a URL while keeping the host, which is the useful part. */
export function scrubUrl(value: string): string {
  if (!value) return value;
  try {
    const u = new URL(value);
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
    // A long path segment is a key far more often than it is a route.
    const path = u.pathname.replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/***');
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return '***';
  }
}

/**
 * A settings object with the secrets taken out.
 *
 * Recursive, and it replaces rather than deletes so the SHAPE survives: a
 * reader can still see that `rpc.heliusApiKey` exists and is set, which is
 * the diagnostic, without the value, which is the risk.
 */
export function stripSecrets(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripSecrets(v, k);
    return out;
  }
  if (typeof value !== 'string' || !value) return value;
  if (PUBLIC_KEYS.test(key)) return value;
  if (SECRET_KEYS.test(key) || KEYISH.test(key)) return '<set>';
  if (URL_KEYS.test(key)) return scrubUrl(value);
  return value;
}

const pad = (s: string): string => `── ${s} ${'─'.repeat(Math.max(0, 68 - s.length))}`;
const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);
const when = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toISOString());

/** How long the process has been up, in words a reader can use. */
export function humanUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Build the file.
 *
 * Deterministic for a given input — the test pins the whole layout — and it
 * never throws: a bundle that fails to build is a user who cannot report
 * their bug, so anything unreadable becomes a line in `problems` instead.
 */
export function buildBundle(d: BundleDeps): { text: string; truncatedBytes: number } {
  const L: string[] = [];
  L.push(`${d.app.name} support bundle`);
  L.push(`generated ${new Date(d.now).toISOString()}`);
  L.push('');
  L.push('WHAT THIS CONTAINS: the app’s log, its settings with every key and token removed,');
  L.push('which features were switched on, the health of its data providers, and a list of');
  L.push('its files by name and size. It does NOT contain your private key, your seed, any');
  L.push('API key, your balances, your holdings or your trade history.');
  L.push('');
  L.push('The log may name coins you looked at and transactions you made — the same things');
  L.push('the app shows on screen. Read it before you send it if that matters to you.');
  L.push('');

  // The user's own words first: they are the reason this file exists.
  const userNote = (d.note ?? '').trim().slice(0, NOTE_MAX_CHARS);
  L.push(pad('what went wrong (in the user’s words)'));
  L.push(userNote || '(nothing written)');
  L.push('');

  L.push(pad('app'));
  L.push(`version      ${d.app.version}${d.app.packaged ? '' : ' (dev build, not packaged)'}`);
  L.push(`electron     ${d.app.electron}   chrome ${d.app.chrome}   node ${d.app.node}`);
  L.push(`platform     ${d.app.platform} ${d.app.arch}   locale ${d.app.locale}`);
  L.push(`running for  ${humanUptime(d.uptimeMs)}`);
  L.push('');

  L.push(pad(`recent warnings and errors (newest ${RECENT_ERRORS}; the full log is at the end)`));
  const errs = recentErrors(d.logs);
  L.push(errs.length ? errs.join('\n') : '(none in the log — good)');
  L.push('');

  L.push(pad('switched on'));
  if (d.state.length) for (const line of d.state) L.push(line);
  else L.push('(nothing reported)');
  L.push('');

  L.push(pad('data providers'));
  if (d.providers.length) {
    L.push('provider         host                            on  ok   calls  errors  parked  last error');
    for (const p of d.providers) {
      const parked = p.cooldownMs > 0 ? `${Math.ceil(p.cooldownMs / 1000)}s` : '—';
      L.push(
        `${p.id.padEnd(16)} ${p.host.slice(0, 30).padEnd(31)} ${(p.enabled ? 'y' : 'n').padEnd(3)} ${(p.usable ? 'y' : 'n').padEnd(4)} ${String(p.calls).padStart(6)}  ${String(p.errors).padStart(6)}  ${parked.padStart(6)}  ${(p.lastError ?? '').slice(0, 90)}`,
      );
    }
  } else L.push('(none reported)');
  L.push('');

  L.push(pad('settings (keys and tokens removed)'));
  try {
    L.push(JSON.stringify(stripSecrets(d.settings), null, 2));
  } catch {
    L.push('(settings could not be read)');
  }
  L.push('');

  L.push(pad('files in the profile (names and sizes only)'));
  if (d.files.length) for (const f of d.files) L.push(`${kb(f.bytes).padStart(9)}  ${when(f.modifiedAt)}  ${f.name}`);
  else L.push('(none found)');
  L.push('');

  L.push(pad('crash files'));
  L.push(d.crashes.length ? d.crashes.join('\n') : '(none — good)');
  L.push('');

  if (d.problems.length) {
    L.push(pad('what could not be gathered'));
    for (const p of d.problems) L.push(`· ${p}`);
    L.push('');
  }

  const head = L.join('\n');
  // The log is whatever room is left. Cut from the FRONT, because the end of
  // a log is the part that explains what just happened.
  const logHeader = `${pad('log')}\n`;
  const body = d.logs.map((f) => `\n===== ${f.name} =====\n${f.text}`).join('');
  const room = Math.max(0, BUNDLE_MAX_BYTES - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(logHeader, 'utf8') - 256);
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes <= room) return { text: `${head}${logHeader}${body}\n`, truncatedBytes: 0 };
  const kept = Buffer.from(body, 'utf8').subarray(bodyBytes - room).toString('utf8');
  const dropped = bodyBytes - Buffer.byteLength(kept, 'utf8');
  const note = `\n[the first ${kb(dropped)} of the log was cut to keep this file under ${kb(BUNDLE_MAX_BYTES)} — the newest lines are below]\n`;
  return { text: `${head}${logHeader}${note}${kept}\n`, truncatedBytes: dropped };
}

/** The filename a user sees in the save dialog. */
export function bundleName(appName: string, now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, '0');
  const slug = appName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  return `${slug}-logs-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
}
