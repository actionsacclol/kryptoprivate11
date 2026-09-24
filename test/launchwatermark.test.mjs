// The launch watermark, and the launch stats read (2026-09-22).
//
// Every coin launched from this app ends its description with a line saying
// where it was made. It goes into the metadata JSON the mint points at, so it
// travels with the token rather than living in our own records.
//
// Two rules matter. It is applied in MAIN, so it cannot be skipped by a form
// that sends something else. And it is SHOWN in the form, because a watermark
// someone discovers afterwards, on a token that exists forever under their
// name, is exactly the kind of surprise this app does not do.

import assert from 'node:assert';
import fs from 'node:fs';
import { DESCRIPTION_BUDGET, LAUNCH_WATERMARK, LAUNCH_WATERMARKS, MAX_DESCRIPTION, hasWatermark, withWatermark } from './.launchgate.mjs';

// The mark rotates (2026-09-24): check "ends with SOME variation" + "exactly one".
const marked = (s) => LAUNCH_WATERMARKS.some((m) => s.endsWith(m));
const oneMark = (s, body) => s.startsWith(`${body}\n`) && LAUNCH_WATERMARKS.includes(s.slice(`${body}\n`.length));

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

{
  // On a line of its own, as asked 09-22, now a rotated mark: "a memecoin" / <mark>.
  assert.equal(LAUNCH_WATERMARK, 'Launched with krypt.cc/bot', 'the canonical mark is still the first variation');
  assert.ok(LAUNCH_WATERMARKS.length >= 4, 'several variations to rotate');
  assert.ok(LAUNCH_WATERMARKS.every((m) => /krypt|Krypto Bot/i.test(m)), 'every variation names the tool — always discloses');
  assert.ok(oneMark(withWatermark('a memecoin'), 'a memecoin'), 'it goes at the end, on the next line, one mark');
  // A draft stamped with the OLD mark is re-stamped, never carries both.
  assert.ok(oneMark(withWatermark('gm\n\nLaunched using krypt.cc/tools/krypto'), 'gm'), 'the legacy mark is stripped, not doubled');
  assert.equal(hasWatermark('gm\n\nLaunched using krypt.cc/tools/krypto'), true, 'coins launched under the old mark are still ours');
  assert.ok(LAUNCH_WATERMARKS.includes(withWatermark('')), 'an empty description becomes just a mark');
  assert.ok(LAUNCH_WATERMARKS.includes(withWatermark('   ')), 'and so does whitespace');
  assert.ok(oneMark(withWatermark('  padded  '), 'padded'), 'the user text is trimmed, not the line');
  ok('the watermark goes at the end of the description');
}

{
  // IDEMPOTENT. The form stamps it for display and main stamps it again on
  // upload; re-running the metadata step, or editing an already-stamped
  // draft, must never stack two copies.
  const once = withWatermark('gm');
  assert.ok(oneMark(once, 'gm'), 'words, a newline, one mark');
  assert.ok(oneMark(withWatermark(once), 'gm'), 'stamping twice never doubles the line');
  assert.ok(oneMark(withWatermark(withWatermark(withWatermark('gm'))), 'gm'), 'nor three times');
  assert.equal(hasWatermark(once), true);
  assert.equal(hasWatermark('gm'), false);
  // A description that MENTIONS the link mid-text is not stamped — only one
  // that already ends with it.
  assert.equal(hasWatermark('see krypt.cc/bot for more'), false, 'a mention in the middle is not the stamp');
  ok('stamping is idempotent — the line is never doubled');
}

{
  // The budget. The watermark costs characters against pump's limit, so the
  // form has to count down from what is LEFT — otherwise someone fills the
  // full limit and the stamped version is refused at the upload.
  assert.ok(DESCRIPTION_BUDGET < MAX_DESCRIPTION, 'the budget is smaller than the raw limit');
  assert.ok(DESCRIPTION_BUDGET <= MAX_DESCRIPTION - (LAUNCH_WATERMARK.length + 1), 'it reserves the (longest) line and its line break');
  // A description filling the budget exactly still fits once stamped.
  const full = 'x'.repeat(DESCRIPTION_BUDGET);
  assert.ok(withWatermark(full).length <= MAX_DESCRIPTION, 'a full budget still fits after stamping');
  ok('the budget leaves exactly enough room for the line');
}

{
  // Applied in MAIN. A form that sent an unstamped description — an older
  // build, a script, anything — still produces a stamped token.
  const ipc = src('../electron/ipc.ts');
  const upload = ipc.slice(ipc.indexOf("ipcMain.handle('launch:upload'"), ipc.indexOf("ipcMain.handle('launch:upload'") + 1600);
  assert.match(upload, /withWatermark\(/, 'the upload handler stamps the description itself');
  assert.match(upload, /\.slice\(0, MAX_DESCRIPTION\)/, 'and the result is still bounded by the limit');

  // And SHOWN in the form, with the budget counting down from the right
  // number rather than from the raw limit.
  const page = src('../src/pages/Launch.tsx');
  assert.match(page, /LAUNCH_WATERMARK/, 'the form names the line it will add');
  assert.match(page, /\$\{draft\.description\.length\}\/\$\{DESCRIPTION_BUDGET\}/, 'and counts against the budget, not the raw limit');
  assert.match(page, /maxLength=\{DESCRIPTION_BUDGET\}/, 'the field stops at the budget too');
  ok('main always stamps it, and the form says so before you launch');
}

{
  // The stats read. Every number is nullable on the way out — a creator being
  // told they have no holders because an RPC hiccuped is the failure worth
  // avoiding on a page about their own work.
  const ipc = src('../electron/ipc.ts');
  const stats = ipc.slice(ipc.indexOf("ipcMain.handle('launch:stats'"), ipc.indexOf("ipcMain.handle('launch:upload'"));
  assert.ok(stats.length > 0, 'the stats handler exists');
  assert.match(stats, /\?\? null/, 'unread values come back null');
  assert.doesNotMatch(stats, /\?\? 0/, 'never as zero');
  // The requested list drives the rows, so a mint no provider answered for
  // still appears — a coin missing from the table would read as one that does
  // not exist.
  assert.match(stats, /list\.map\(\(mint\) =>/, 'the rows follow the requested mints');
  assert.match(stats, /summaries\.get\(mint\)/, 'and the summary is looked up per mint');

  const ui = src('../src/components/terminal/LaunchStats.tsx');
  assert.match(ui, /const dash = '—'/, 'the UI renders an unread number as an em dash');
  assert.doesNotMatch(ui, /\|\| 0\b/, 'and never falls back to zero');
  ok('launch stats report unknown as unknown, and every launch gets a row');
}

console.log(`\nlaunchwatermark: ${passed}/${passed} passed`);
