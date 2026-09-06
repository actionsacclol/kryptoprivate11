// Does the guard actually defeat Node's fatal default?
//
// The unit tests drive `handle()` through a seam, which proves the POLICY but
// not the WIRING. Node 20 kills the process on an unhandled rejection unless a
// listener is registered, and that is the whole reason this module exists — so
// this file causes a real unhandled rejection and a real uncaught exception in
// a real process, and checks the process is still standing afterwards.
//
// Run: node test/crashguard.live.mjs   (offline, ~2s)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, fileNameFor, crashCount } from './.crashguard.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-crashlive-'));
const quits = [];

install({
  dir,
  log: (level, line) => console.log(`  [${level}] ${line.slice(0, 90)}…`),
  windowUp: () => true, // pretend the UI is up, so policy says "keep running"
  quit: (reason) => quits.push(reason),
  notify: () => {},
  context: () => ({ test: 'live' }),
});

console.log('node', process.version, '— default for an unhandled rejection is FATAL\n');

// A genuinely unhandled rejection: nothing ever attaches a .catch to this.
Promise.reject(new Error('synthetic unhandled rejection'));

// A genuinely uncaught exception, thrown from a timer so it escapes this frame.
setTimeout(() => {
  throw new Error('synthetic uncaught exception');
}, 100);

setTimeout(() => {
  const file = path.join(dir, fileNameFor(Date.now()));
  const wrote = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  const survived = true; // reaching this callback at all is the proof
  const sawRejection = /synthetic unhandled rejection/.test(wrote);
  const sawException = /synthetic uncaught exception/.test(wrote);

  console.log('\nresult');
  console.log('  process survived both faults :', survived);
  console.log('  crashes counted              :', crashCount());
  console.log('  rejection written to disk    :', sawRejection);
  console.log('  exception written to disk    :', sawException);
  console.log('  quit() called                :', quits.length === 0 ? 'no (correct)' : quits);

  fs.rmSync(dir, { recursive: true, force: true });

  const pass = survived && sawRejection && sawException && crashCount() === 2 && quits.length === 0;
  console.log(pass ? '\nPASS — the guard holds the process up and records both.' : '\nFAIL');
  process.exit(pass ? 0 : 1);
}, 900);
