// Offline test runner. The suite used to be one `a && b && …` chain in
// package.json; at 45+ suites it passed Windows' command-line limit
// ("The command line is too long") and npm test silently ran NOTHING while
// exiting 1. Steps live in scripts/test-steps.json (one command per entry,
// same esbuild bundle + `node test/x.test.mjs` lines as before); add new
// suites there. Stops at the first failure and exits with its code.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = JSON.parse(readFileSync(path.join(root, 'scripts', 'test-steps.json'), 'utf8'));
const only = process.argv[2]; // optional substring filter, e.g. `npm test -- odds`
let ran = 0;
const t0 = Date.now();
for (const step of steps) {
  const isTest = step.startsWith('node test/');
  if (only && isTest && !step.includes(only)) continue;
  const r = spawnSync(step, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`\nFAILED (exit ${r.status}): ${step}`);
    process.exit(r.status ?? 1);
  }
  if (isTest) ran += 1;
}
console.log(`\n${ran} suites passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
