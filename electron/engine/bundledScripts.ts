// Scripts that ship with the app, read from bundled/scripts/ at BUILD time
// (Vite's ?raw import inlines the file as a string into the main bundle, so
// it is obfuscated and bytecode-compiled like the rest; nothing is read from
// disk at run time). automation.seedBundled installs each one once per user,
// switched off and in paper mode.
//
// To ship another: add the .js file under bundled/scripts/ and one entry
// below with a NEW key (the key is how a user's copy is recognised; never
// reuse or rename one).
import kryptoScript from '../../bundled/scripts/krypto-script.js?raw';
import graduationScalper from '../../bundled/scripts/graduation-scalper.js?raw';
import type { BundledScript } from '@shared/automation';

/** The name a user sees: the first line's "// Name — …" if present. */
export function bundledName(code: string, fallback: string): string {
  const m = /^\/\/\s*([^\n—–-]{1,60}?)\s*(?:[—–-]|\n)/.exec(code);
  return m?.[1]?.trim() || fallback;
}

export const BUNDLED_SCRIPTS: BundledScript[] = [
  { key: 'krypto-script', name: bundledName(kryptoScript, 'Krypto Script'), code: kryptoScript },
  // 2026-09-29: buy the graduation, sell into the pool's first minutes.
  // Paper-first; the header of the script says what was measured.
  { key: 'graduation-scalper', name: bundledName(graduationScalper, 'Graduation Scalper'), code: graduationScalper },
];
