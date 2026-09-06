// Regenerate the obfuscated attribution blob in shared/presenceIntegrity.ts.
//
// Run this after changing anything in shared/presence.ts:
//   node scripts/gen-presence-integrity.mjs
//
// It reads the readable identity from presence.ts (one source of truth),
// packs it in the documented field order, re-encodes the blob and rewrites
// the two generated constants. The keystream parameters must match the ones
// in presenceIntegrity.ts.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const presencePath = path.join(root, 'shared', 'presence.ts');
const integrityPath = path.join(root, 'shared', 'presenceIntegrity.ts');

const src = fs.readFileSync(presencePath, 'utf8');

// Pull the literal out of the PRESENCE constant. Deliberately strict: a shape
// this script cannot read is a shape it must not silently mis-encode.
const grab = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${what} in shared/presence.ts`);
  return m;
};

const clientId = grab(/clientId: '([^']*)'/, 'clientId')[1];
const buttons = [...src.matchAll(/\{ label: '([^']*)', url: '([^']*)' \}/g)].map((m) => ({
  label: m[1],
  url: m[2],
}));
if (buttons.length !== 2) throw new Error(`expected 2 presence buttons, found ${buttons.length}`);
const largeImageKey = grab(/largeImageKey: '([^']*)'/, 'largeImageKey')[1];
const largeImageText = grab(/largeImageText: '([^']*)'/, 'largeImageText')[1];

// Must match packIdentity() in presence.ts.
const PACKED = [clientId, buttons[0].label, buttons[0].url, buttons[1].label, buttons[1].url, largeImageKey, largeImageText].join('|');
if (PACKED.split('|').length !== 7) throw new Error('a field contains a "|" — the pack format cannot represent it');

const ROWS = 1664525;
const COLS = 1013904223;
const SPAN = 2 ** 32;
const ORIGIN = 0x6b727970;

let s = ORIGIN;
const enc = [];
for (let i = 0; i < PACKED.length; i++) {
  s = (Math.imul(ROWS, s) + COLS) % SPAN;
  enc.push(PACKED.charCodeAt(i) ^ ((s >>> 11) & 0xff));
}
const sum = crypto.createHash('sha256').update(PACKED).digest('hex');

// Wrap the byte list so the file stays readable-ish without a formatter fight.
const lines = [];
for (let i = 0; i < enc.length; i += 22) lines.push('  ' + enc.slice(i, i + 22).join(', ') + ',');

let out = fs.readFileSync(integrityPath, 'utf8');
out = out.replace(/const TABLE: number\[\] = \[[\s\S]*?\];/, `const TABLE: number[] = [\n${lines.join('\n')}\n];`);
out = out.replace(/const TABLE_SHA256 = '[0-9a-f]*';/, `const TABLE_SHA256 = '${sum}';`);
fs.writeFileSync(integrityPath, out, 'utf8');

console.log(`re-encoded presence identity (${enc.length} bytes) for client ${clientId} into shared/presenceIntegrity.ts`);
