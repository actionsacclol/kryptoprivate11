// Replay a firehose day-file through the launch-mode filter and report what
// launch mode would have kept: bytes and records per kind, plus the
// filtered file itself (same JSONL envelope) so the dataset builder can be
// run against it.
//
//   npx esbuild electron/engine/launchRecorder.ts --bundle --format=esm --platform=node --outfile=test/.launchrecorder.mjs
//   node scripts/analysis/estimate_launchtape.mjs E:\data\2026-07-25.jsonl E:\data\work\launch-mode-sample\2026-07-25.jsonl
//
// Streams the input (never loads it); ~10 GB takes a few minutes. The
// numbers it prints are what recorder.ts LAUNCH_MODE_MEASURED_GB_PER_DAY
// and the Settings copy quote. `at` (the recorder's receive time) is the
// clock, exactly as the live recorder would have seen it.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { LaunchFilter } from '../../test/.launchrecorder.mjs';

const [src, out] = process.argv.slice(2);
if (!src) {
  console.error('usage: estimate_launchtape.mjs <day.jsonl> [filtered-out.jsonl]');
  process.exit(2);
}

const filter = new LaunchFilter();
const KIND_RE = /^\{"t":"([A-Za-z_]+)"/;
const AT_RE = /"at":(\d+)/;
const MINT_RE = /"mint":"([1-9A-HJ-NP-Za-km-z]+)"/;
const RECV_RE = /"receivedAt":(\d+)/;

const bytesIn = {};
const bytesKept = {};
const recsIn = {};
const recsKept = {};
let totalIn = 0;
let totalKept = 0;
let firstAt = null;
let lastAt = null;
let lines = 0;

let ws = null;
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  ws = fs.createWriteStream(out);
}
async function write(line) {
  if (!ws) return;
  if (!ws.write(line + '\n')) await new Promise((r) => ws.once('drain', r));
}

const rl = readline.createInterface({ input: fs.createReadStream(src, { highWaterMark: 1 << 24 }), crlfDelay: Infinity });
const t0 = Date.now();
for await (const line of rl) {
  lines++;
  const n = Buffer.byteLength(line) + 1;
  totalIn += n;
  const km = KIND_RE.exec(line);
  const kind = km ? km[1] : '?';
  bytesIn[kind] = (bytesIn[kind] ?? 0) + n;
  recsIn[kind] = (recsIn[kind] ?? 0) + 1;
  const am = AT_RE.exec(line);
  const at = am ? Number(am[1]) : null;
  if (at !== null) {
    if (firstAt === null) firstAt = at;
    lastAt = at;
  }
  // Cheap payload: the filter only reads `mint` and `receivedAt`.
  const mm = MINT_RE.exec(line);
  const rm = RECV_RE.exec(line);
  const payload = { mint: mm ? mm[1] : undefined, receivedAt: rm ? Number(rm[1]) : undefined };
  let keep = filter.accept(kind, payload, at ?? undefined);
  if (kind === 'engine_start' && ws) {
    // What the live recorder writes in launch mode: the mode + filter config.
    const cfg = filter.config();
    const patched = line.replace(/\}$/, `,"mode":"launch","launch":${JSON.stringify(cfg)}}`);
    await write(patched);
    keep = false;
    totalKept += Buffer.byteLength(patched) + 1;
    bytesKept[kind] = (bytesKept[kind] ?? 0) + Buffer.byteLength(patched) + 1;
    recsKept[kind] = (recsKept[kind] ?? 0) + 1;
  }
  if (keep) {
    totalKept += n;
    bytesKept[kind] = (bytesKept[kind] ?? 0) + n;
    recsKept[kind] = (recsKept[kind] ?? 0) + 1;
    await write(line);
  }
  if (lines % 5_000_000 === 0) {
    console.error(`${lines.toLocaleString()} lines, ${(totalIn / 1e9).toFixed(2)} GB in, ${(totalKept / 1e6).toFixed(0)} MB kept, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
if (ws) await new Promise((r) => ws.end(r));

const hours = firstAt !== null && lastAt !== null ? (lastAt - firstAt) / 3_600_000 : null;
const report = {
  src,
  out: out ?? null,
  lines,
  tapeHours: hours,
  bytesIn: totalIn,
  bytesKept: totalKept,
  keptPct: (100 * totalKept) / totalIn,
  firehoseGbPerDay: hours ? (totalIn / 1e9) * (24 / hours) : null,
  launchGbPerDay: hours ? (totalKept / 1e9) * (24 / hours) : null,
  perKind: Object.fromEntries(
    Object.keys(bytesIn)
      .sort((a, b) => bytesIn[b] - bytesIn[a])
      .map((k) => [k, { recsIn: recsIn[k], recsKept: recsKept[k] ?? 0, mbIn: +(bytesIn[k] / 1e6).toFixed(1), mbKept: +((bytesKept[k] ?? 0) / 1e6).toFixed(1) }]),
  ),
  filter: filter.stats(),
  seconds: (Date.now() - t0) / 1000,
};
delete report.filter.kept;
delete report.filter.dropped;
console.log(JSON.stringify(report, null, 2));
