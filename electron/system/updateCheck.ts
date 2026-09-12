// Asking krypt.cc whether there is a newer build.
//
// One request, to one constant URL, at most every six hours. It reads a small
// JSON document and compares versions; it downloads nothing, writes nothing to
// disk, and cannot install anything. `shared/version.ts` explains why it is a
// notice rather than an updater.
//
// ─── The endpoint answers 200 with HTML today ────────────────────────────
//
// krypt.cc is a static site with a catch-all route, so `GET /version.json`
// currently returns the site's own page with HTTP 200 (measured 2026-09-11).
// Every guard below exists because of that:
//
//   · the content type must be JSON — HTML is refused before it is parsed;
//   · the body must parse AND satisfy `readVersionDoc`;
//   · anything else is `unknown`, which the UI renders as "could not check".
//
// So publishing the document turns the feature on, and not publishing it
// leaves the app saying it does not know — never saying you are up to date.
//
// ─── Host discipline ─────────────────────────────────────────────────────
//
// Same rule as launchMeta.ts and data/http.ts: the URL is a CONSTANT. Nothing
// here takes a host, a path or a URL from a caller or from the renderer, so
// there is no way to point it somewhere else. Redirects are refused — a 30x
// to a private address is the standard way out of an allowlist — and the body
// is capped while it is read rather than after.

import { app } from 'electron';
import { readVersionDoc, updateStatus, type UpdateStatus, type VersionDoc } from '@shared/version';
import { logger } from './logger';

/** The only URL this module will ever request. */
const VERSION_URL = 'https://krypt.cc/version.json';

/** Where a user goes to get it. Opened by the renderer, never by this module. */
export const DOWNLOAD_URL = 'https://krypt.cc';

/** A version document is a few hundred bytes. Anything larger is not one. */
const MAX_BYTES = 8 * 1024;
const TIMEOUT_MS = 10_000;

/**
 * How often a check may actually leave the machine.
 *
 * Six hours, and the clock is not reset by a failure: an endpoint that is not
 * published yet would otherwise be retried on every call for the life of the
 * process.
 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let doc: VersionDoc | null = null;
let checkedAt: number | null = null;
let failure: string | null = null;
let inFlight: Promise<void> | null = null;

/** Overridable so tests do not depend on Electron's packaged version. */
let currentVersion = (): string => {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
};

/** Test seam. */
export function _setCurrentVersion(fn: () => string): void {
  currentVersion = fn;
}

/** Test seam: forget everything, as if the app had just started. */
export function _reset(): void {
  doc = null;
  checkedAt = null;
  failure = null;
  inFlight = null;
}

/** What we currently believe, without asking anyone. */
export function status(): UpdateStatus {
  return updateStatus(currentVersion(), doc, { checkedAt, failure });
}

async function read(res: Response): Promise<string> {
  // Capped while streaming: a body is only refused for being too large after
  // it is already in memory if you check `.text()` first.
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('the answer was too large to be a version document');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Ask, unless we asked recently.
 *
 * `force` is the Settings button. Never throws: a failed check is a state the
 * UI shows, not an error the caller handles.
 */
export async function check(force = false): Promise<UpdateStatus> {
  const now = Date.now();
  if (!force && checkedAt !== null && now - checkedAt < CHECK_INTERVAL_MS) return status();
  if (inFlight) {
    await inFlight;
    return status();
  }
  inFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(VERSION_URL, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        // `cache: 'no-store'` is not in undici's RequestInit; the header
        // does the same job and works on both.
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      });
      // The clock advances whatever happened, so a site that does not publish
      // the document is asked twice a day, not on every keystroke.
      checkedAt = Date.now();
      if (!res.ok) {
        doc = null;
        failure = `krypt.cc answered HTTP ${res.status}`;
        return;
      }
      // The guard that matters today. A catch-all route answering 200 with a
      // page of HTML is a refusal, and treating it as an answer would make
      // every user's version look unknowable in the best case and wrong in
      // the worst.
      const type = res.headers.get('content-type') ?? '';
      if (!/\bjson\b/i.test(type)) {
        doc = null;
        failure = 'krypt.cc is not publishing a version document yet';
        void res.body?.cancel().catch(() => undefined);
        return;
      }
      const text = await read(res);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        doc = null;
        failure = 'the version document could not be read';
        return;
      }
      const next = readVersionDoc(parsed);
      if (!next) {
        doc = null;
        failure = 'the version document did not name a version';
        return;
      }
      doc = next;
      failure = null;
      logger.info(`update check: published version is ${next.version}, this build is ${currentVersion()}`);
    } catch (e) {
      checkedAt = Date.now();
      doc = null;
      failure = (e as Error).name === 'AbortError' ? 'the check timed out' : (e as Error).message;
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
  })();
  await inFlight;
  return status();
}
