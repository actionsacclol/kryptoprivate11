// Collect third-party licence text into resources/THIRD-PARTY-LICENSES.txt.
//
// The Software Terms tell the user "the corresponding licence text is included
// with the software". That sentence is a promise, and a promise in a legal
// document with nothing behind it is exactly the failure legalcheck.md warns
// about for retention periods. This is the code that makes it true.
//
// Walks the actual dependency tree of the SHIPPED build (production
// dependencies and everything they pull in), not a hand-kept list, so a new
// dependency cannot silently arrive without its licence.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'node_modules');
const LICENCE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING', 'LICENSE-MIT'];

/** Every package reachable from the production dependencies. */
function resolveTree() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const seen = new Set();
  const queue = Object.keys(rootPkg.dependencies ?? {});
  const found = [];

  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = path.join(modules, ...name.split('/'));
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue; // an optional dep that was never installed
    }
    let text = '';
    let file = '';
    for (const candidate of LICENCE_FILES) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) {
        text = fs.readFileSync(full, 'utf8').trim();
        file = candidate;
        break;
      }
    }
    found.push({
      name,
      version: pkg.version ?? 'unknown',
      license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see text'),
      repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? ''),
      text,
      file,
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push(dep);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const pkgs = resolveTree();
const missing = pkgs.filter((p) => !p.text);

const header = [
  'THIRD-PARTY LICENCES',
  '',
  'Krypto Terminal includes the open-source components listed below. Each is',
  'governed by its own licence, which prevails over the Krypt Software Terms',
  'for that component.',
  '',
  `Components: ${pkgs.length}`,
  '',
  'Where a licence requires an offer of source code, that offer is available by',
  'writing to support@krypt.cc.',
  '',
  '='.repeat(72),
  '',
].join('\n');

const body = pkgs
  .map((p) => {
    const head = [
      `${p.name}@${p.version}`,
      `Licence: ${p.license}`,
      p.repository ? `Source: ${p.repository.replace(/^git\+/, '').replace(/\.git$/, '')}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n');
    const text = p.text
      ? p.text
      : `[No licence file was shipped in this package. Declared licence: ${p.license}. Contact support@krypt.cc and we will obtain it.]`;
    return `${head}${text}\n\n${'-'.repeat(72)}\n`;
  })
  .join('\n');

const outDir = path.join(root, 'resources');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'THIRD-PARTY-LICENSES.txt');
fs.writeFileSync(out, header + body, 'utf8');

console.log(`wrote ${path.relative(root, out)} — ${pkgs.length} components`);
if (missing.length) {
  // Reported rather than hidden: a component whose licence text we could not
  // find is exactly what someone needs to know about before shipping.
  console.log(`NOTE: ${missing.length} package(s) shipped no licence file: ${missing.map((m) => m.name).join(', ')}`);
}
