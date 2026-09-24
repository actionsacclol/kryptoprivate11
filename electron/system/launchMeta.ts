// Pinning a launch's image and metadata to IPFS.
//
// ─── Why this is not in data/http.ts ─────────────────────────────────────
//
// That module's rule is "a provider may only ever contact a host hardcoded in
// this file", and everything it does — the per-provider queue, the gap, the
// park, the escalating backoff — is built for polling market endpoints on a
// timer. This is the opposite shape: one user-initiated multipart upload, at
// the moment a person clicks a button, to one host.
//
// The rule that matters is kept, and kept the same way: the host below is a
// CONSTANT. Nothing in this module takes a URL, a host, or a path component
// from the caller or from the renderer, so there is no way to point it
// somewhere else. Redirects are refused for the same reason they are there —
// a 30x to a private address is the classic way out of an allowlist.
//
// ─── Why pump's uploader, for both chains ────────────────────────────────
//
// It pins to IPFS and hands back a plain `https://ipfs.io/ipfs/<cid>` gateway
// URL — a public CID, not a pump-owned link. That URL is what goes into the
// token, so a Robinhood launch is not depending on pump for anything after
// the upload; it is depending on IPFS, like every other token on both chains.
// Verified against the live endpoint 2026-09-10: POST multipart, response
// `{ metadata: { …, image }, metadataUri }`.
//
// The alternative was asking every user to find their own pinning service and
// paste a URL. The form does not offer that today; if it ever does, it is the
// fallback, not the default.

import { readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger';

/** The only host this module will ever contact. */
const UPLOAD_URL = 'https://pump.fun/api/ipfs';

/** Bigger than this and the upload is refused before it is attempted. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const IMAGE_EXTENSIONS = Object.keys(CONTENT_TYPES).map((e) => e.slice(1));

export interface UploadedMetadata {
  /** Pinned image, an https IPFS gateway URL. */
  imageUrl: string;
  /** Pinned metadata JSON — what a Solana mint points at. */
  metadataUri: string;
}

export interface MetadataFields {
  name: string;
  symbol: string;
  description: string;
  twitter: string;
  telegram: string;
  website: string;
}

/**
 * Read an image off disk and pin it, with its metadata, to IPFS.
 *
 * `filePath` comes from the app's own file dialog in the main process — never
 * from the renderer, which cannot name a path this module will read.
 */
export async function uploadLaunchMetadata(filePath: string, fields: MetadataFields): Promise<UploadedMetadata | { error: string }> {
  const ext = path.extname(filePath).toLowerCase();
  const type = CONTENT_TYPES[ext];
  if (!type) return { error: `${ext || 'That file'} is not an image this can upload (${IMAGE_EXTENSIONS.join(', ')}).` };

  let bytes: Buffer;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { error: 'That is not a file.' };
    if (info.size > MAX_IMAGE_BYTES) {
      return { error: `The image is ${(info.size / 1024 / 1024).toFixed(1)} MB; ${MAX_IMAGE_BYTES / 1024 / 1024} MB is the maximum.` };
    }
    if (info.size === 0) return { error: 'The image file is empty.' };
    bytes = await readFile(filePath);
  } catch (e) {
    return { error: `Could not read the image: ${(e as Error).message}` };
  }

  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], { type }), path.basename(filePath));
  form.set('name', fields.name);
  form.set('symbol', fields.symbol);
  form.set('description', fields.description);
  form.set('twitter', fields.twitter);
  form.set('telegram', fields.telegram);
  form.set('website', fields.website);
  form.set('showName', 'true');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(UPLOAD_URL, { method: 'POST', body: form, redirect: 'error', signal: controller.signal });
    if (!res.ok) return { error: `The pinning service answered HTTP ${res.status}. Nothing was created; try again.` };
    const json = (await res.json()) as { metadataUri?: unknown; metadata?: { image?: unknown } };
    const metadataUri = typeof json.metadataUri === 'string' ? json.metadataUri : '';
    const imageUrl = typeof json.metadata?.image === 'string' ? json.metadata.image : '';
    // A 200 that does not carry the links is a refusal, not a success — the
    // same trap the provider layer was taught about (API swarm 2026-09-09).
    if (!/^https:\/\//.test(metadataUri) || !/^https:\/\//.test(imageUrl)) {
      return { error: 'The pinning service answered without the links it should have returned. Nothing was created.' };
    }
    logger.info(`launch: pinned metadata ${metadataUri}`);
    return { imageUrl, metadataUri };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'timed out after 60 s' : (e as Error).message;
    return { error: `Upload failed: ${msg}. Nothing was created.` };
  } finally {
    clearTimeout(timer);
  }
}


/**
 * Pin a picture on its own and hand back the gateway URL.
 *
 * For a pump.fun profile picture, which is a URL rather than an upload — the
 * image has to be hosted somewhere before `profileImage` can point at it, and
 * this is the route that already does that here.
 *
 * It goes through the same multipart upload as a launch because that is the
 * endpoint that exists; the metadata JSON it also pins is ignored. Sending a
 * second, untested request shape at the same host to avoid one unused JSON
 * file would be the worse trade.
 *
 * `filePath` comes from the app's own file dialog in main, never from the
 * renderer — the same rule as the launch upload above.
 */
export async function uploadProfileImage(filePath: string): Promise<{ imageUrl: string } | { error: string }> {
  const r = await uploadLaunchMetadata(filePath, {
    name: 'profile picture',
    symbol: '',
    description: '',
    twitter: '',
    telegram: '',
    website: '',
  });
  if ('error' in r) return r;
  return { imageUrl: r.imageUrl };
}
