// How the app's pump.fun requests leave the process.
//
// data/pumpWall.ts holds the gate every pump.fun call goes through; this is what
// it sends with, registered at startup. The transport itself is pumpFetch.ts:
// Chromium's network stack (Cloudflare challenges Node's fetch, 2026-10-22),
// falling back to a request sent from inside a hidden pump.fun page
// (pumpBrowser.ts) when Chromium is challenged or cannot connect because pump's
// hosts now demand a TLS client certificate. A challenge that survives all of
// that is what raises the wall. Injected here, not imported by pumpWall.ts, so
// the wall — which tests bundle without Electron — never imports `electron`.
// See fixpump.md.

import { setTransport } from '../data/pumpWall';
import { pumpFetch } from './pumpFetch';

/** Called once at startup, after Electron is ready. */
export function installPumpTransport(): void {
  setTransport(pumpFetch);
}
