// Outbound HTTP connection policy for the main process.
//
// Every network call in the engine is a bare global `fetch`. In Electron's
// main process that is Node's fetch, which routes through undici's DEFAULT
// global dispatcher: keep-alive of 4 s, HTTP/1.1, one request per
// connection at a time. The hosts that matter for an order — the RPC, the
// Helius sender, the Jito block engine, PumpPortal — are touched only at
// trade time, so with a 4 s idle limit every order paid a fresh DNS + TCP +
// TLS handshake (~100–250 ms per host) before a single byte of the trade
// went out. Measured 2026-08-29: "tips 595 · send 953" on a warm build.
//
// This installs one shared Agent with a 60 s keep-alive and enough parallel
// connections per origin that the simulate ∥ pre-balance pair never queues.
// `warm()` opens the connection ahead of time (see engine/prewarm.ts) so the
// trade finds a socket already open.
//
// The npm `undici` package shares the global-dispatcher symbol with the
// undici Node bundles, which is exactly why setGlobalDispatcher() here
// changes what the global `fetch` does.

import { Agent, setGlobalDispatcher } from 'undici';

let installed = false;

export function installNetAgent(): void {
  if (installed) return;
  installed = true;
  try {
    setGlobalDispatcher(
      new Agent({
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 600_000,
        connections: 16,
        connect: { timeout: 5_000 },
      }),
    );
  } catch {
    // The stock dispatcher still works; this is a speed layer, never a gate.
    installed = false;
  }
}

/**
 * Open (or refresh) a keep-alive connection to `url` with the cheapest
 * request the host will answer. The response is irrelevant — a 4xx still
 * leaves the TLS session in the pool. Never throws, never awaited on any
 * trade path.
 */
export async function warm(url: string, body?: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(4_000),
    });
    // Drain so the connection returns to the pool instead of being closed.
    try {
      await res.arrayBuffer();
    } catch {
      /* body errors are irrelevant to the warm-up */
    }
    return true;
  } catch {
    return false;
  }
}
