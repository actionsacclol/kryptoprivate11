// Stage 1 for the wallet-convergence study: pull `tape_trade` out of the
// firehose into one compact CSV per day.
//
// WHY A SEPARATE EXTRACTOR
//
// scripts/analysis/extract_tape.py already does something like this, but it
// points at D:\memedata (the tape moved to E:\data) and it aggregates per
// token for the launch studies. The convergence question needs the opposite
// shape: every trade, keyed by WALLET, so the same wallet can be followed
// across days and across mints.
//
// The raw day-files are 10-24 GB and ~87% of their lines are `tape_amm`
// base64 blobs this study does not use, so the hot loop rejects on a substring
// BEFORE JSON.parse. That is the whole difference between minutes and hours.
//
// Output: <out>/<day>.csv with a header, one row per curve trade:
//   at,mint,user,isBuy,sol,tokens,price,curvePct,isSmart
//
// Usage:
//   node scripts/analysis/extract_trades.mjs E:/data/2026-09-11.jsonl [--out tape/trades]

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const args = process.argv.slice(2);
const src = args[0];
if (!src) { console.error('usage: extract_trades.mjs <day.jsonl> [--out DIR]'); process.exit(1); }
const outDir = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join('tape', 'trades'));
fs.mkdirSync(outDir, { recursive: true });

const day = path.basename(src).replace(/\.jsonl$/, '');
const outFile = path.join(outDir, `${day}.csv`);
const tmpFile = outFile + '.partial';

// A completed extract is never redone; a partial one is discarded and retried,
// because a truncated CSV silently becomes a short day in the analysis.
if (fs.existsSync(outFile)) { console.log(`${day}: already extracted (${outFile})`); process.exit(0); }

const NEEDLE = '"t":"tape_trade"';
const out = fs.createWriteStream(tmpFile);
out.write('at,mint,user,isBuy,sol,tokens,price,curvePct,isSmart\n');

let lines = 0, kept = 0, bad = 0;
const t0 = Date.now();
const rl = readline.createInterface({ input: fs.createReadStream(src, { highWaterMark: 1 << 22 }), crlfDelay: Infinity });

const buf = [];
rl.on('line', (line) => {
  lines++;
  if (lines % 5_000_000 === 0) {
    const mins = (Date.now() - t0) / 60000;
    console.log(`  ${(lines / 1e6).toFixed(0)}M lines, ${kept.toLocaleString()} trades, ${mins.toFixed(1)}m`);
  }
  if (line.indexOf(NEEDLE) === -1) return;   // reject before parsing — the point of the whole file
  let o;
  try { o = JSON.parse(line); } catch { bad++; return; }
  if (o.t !== 'tape_trade' || !o.mint || !o.user) return;
  const at = o.at ?? o.receivedAt;
  if (typeof at !== 'number') return;
  buf.push(`${at},${o.mint},${o.user},${o.isBuy ? 1 : 0},${o.sol ?? ''},${o.tokens ?? ''},${o.price ?? ''},${o.curvePct ?? ''},${o.isSmart ? 1 : 0}`);
  kept++;
  if (buf.length >= 20000) { out.write(buf.join('\n') + '\n'); buf.length = 0; }
});

rl.on('close', () => {
  if (buf.length) out.write(buf.join('\n') + '\n');
  out.end(() => {
    fs.renameSync(tmpFile, outFile);   // atomic: the file appears only when complete
    const mins = (Date.now() - t0) / 60000;
    console.log(`${day}: ${lines.toLocaleString()} lines -> ${kept.toLocaleString()} trades in ${mins.toFixed(1)}m`
      + `${bad ? ` (${bad} unparseable)` : ''}`);
  });
});
