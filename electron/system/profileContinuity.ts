// Profile continuity across the product rename (Krypt Terminal → Krypto
// Terminal, 2026-09-01).
//
// Electron derives userData from the product name — in BOTH packaged and
// dev runs (app.getName() reads `productName` from package.json). So the
// rename pointed every existing profile at a brand-new, empty folder: no
// wallet, no settings, terms un-accepted. The first shim looked for a
// `krypt-terminal` dev folder that never held anything and let exactly that
// happen on 2026-09-02 ("the fuck happened to my wallet").
//
// The rule now is about the WALLET, not the settings file: if the new folder
// has no wallets.json and a legacy folder does, use the legacy folder in
// place. Nothing is copied, moved or deleted — the DPAPI-bound wallet file
// stays where it has always been.
//
// Pure so it is unit-tested; main.ts feeds it fs.existsSync.

export const WALLET_FILE = 'wallets.json';

/** Legacy profile folder names, most likely first. */
export const LEGACY_PROFILE_NAMES = ['Krypto Terminal', 'Krypt Terminal', 'krypt-terminal', 'Krypt Sniper'];

export interface ProfilePick {
  /** The folder the app should use. */
  dir: string;
  /** Non-null when the pick is a legacy folder — logged so a support thread
   *  can see which profile the app is on. */
  redirectedFrom: string | null;
}

export function pickUserDataDir(opts: {
  /** Electron's default (new-name) userData folder. */
  current: string;
  /** Candidate legacy folders, absolute, in preference order. */
  legacy: string[];
  /** fs.existsSync, injected. */
  exists: (p: string) => boolean;
  join: (...parts: string[]) => string;
}): ProfilePick {
  const { current, legacy, exists, join } = opts;
  if (exists(join(current, WALLET_FILE))) return { dir: current, redirectedFrom: null };
  for (const dir of legacy) {
    if (exists(join(dir, WALLET_FILE))) return { dir, redirectedFrom: current };
  }
  return { dir: current, redirectedFrom: null };
}
