// GIF search, main-process side.
//
// Same shape as every other outbound call in this app: a fixed host, https
// only, redirects refused, a hard timeout, and the body capped while it
// streams rather than after it has all arrived. The API key is read from
// settings here and never crosses an IPC boundary in either direction.
//
// Picking a GIF does not send a URL back either. The last search is kept in
// memory and the renderer picks by ID; main fetches those bytes and returns a
// data: URL, which is also what keeps the canvas exportable — an image from a
// custom scheme would taint it and break both the PNG and the video.

import {
  GIF_HOSTS,
  MAX_GIF_RESULTS,
  parseSearch,
  searchPath,
  type GifItem,
  type GifProvider,
} from '@shared/gifs';

const TIMEOUT_MS = 8_000;
/** A search response is JSON metadata; 512 KB is already generous. */
const MAX_JSON_BYTES = 512 * 1024;
/** One GIF, as a background. Above this it is not worth the memory. */
const MAX_GIF_BYTES = 12 * 1024 * 1024;

/** The last search per provider, so a pick never needs a URL from outside. */
const lastResults = new Map<GifProvider, GifItem[]>();

async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

export interface GifSearchResult {
  ok: boolean;
  message: string;
  items: GifItem[];
}

/**
 * Search one provider. `apiKey` comes from settings in the caller; an empty
 * one is reported as a missing key rather than sent and refused, so the user
 * gets a sentence instead of a 401.
 */
export async function search(provider: GifProvider, query: string, apiKey: string): Promise<GifSearchResult> {
  const key = apiKey.trim();
  if (!key) return { ok: false, message: `No ${provider} key is set — add one in Settings to search GIFs.`, items: [] };
  const q = query.trim();
  if (!q) return { ok: true, message: 'ok', items: [] };

  const path = searchPath(provider, q, MAX_GIF_RESULTS);
  const sep = path.includes('?') ? '&' : '?';
  const keyParam = provider === 'giphy' ? 'api_key' : 'key';
  const url = `https://${GIF_HOSTS[provider]}${path}${sep}${keyParam}=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // Never echo the response body: it can contain the key back.
      const why = res.status === 401 || res.status === 403 ? 'the key was refused' : `HTTP ${res.status}`;
      return { ok: false, message: `${provider} search failed — ${why}.`, items: [] };
    }
    const raw = await readCapped(res, MAX_JSON_BYTES);
    if (!raw) return { ok: false, message: `${provider} sent more than expected — ignored.`, items: [] };
    const items = parseSearch(provider, JSON.parse(raw.toString('utf8')));
    lastResults.set(provider, items);
    return { ok: true, message: `${items.length} result(s)`, items };
  } catch (err) {
    const msg = (err as Error).message.replace(key, '***');
    return { ok: false, message: `${provider} search failed: ${msg}`, items: [] };
  }
}

/**
 * The bytes of one result from the last search, as a data: URL. The id must
 * be one this process handed out — a caller cannot name an arbitrary target.
 */
export async function pick(provider: GifProvider, id: string): Promise<{ ok: boolean; message: string; dataUrl?: string }> {
  const item = (lastResults.get(provider) ?? []).find((x) => x.id === id);
  if (!item) return { ok: false, message: 'That GIF is no longer in the last search — search again.' };
  try {
    const res = await fetch(item.fullUrl, {
      redirect: 'error',
      headers: { accept: 'image/gif,image/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, message: `The GIF host answered ${res.status}.` };
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/') || type === 'image/svg+xml') {
      return { ok: false, message: 'That link is not an image.' };
    }
    const body = await readCapped(res, MAX_GIF_BYTES);
    if (!body || !body.length) return { ok: false, message: 'That GIF is larger than this app will load (12 MB).' };
    return { ok: true, message: 'ok', dataUrl: `data:${type};base64,${body.toString('base64')}` };
  } catch (err) {
    return { ok: false, message: `Could not load that GIF: ${(err as Error).message}` };
  }
}

/** Dropped on a settings change that turns network data off. */
export function clear(): void {
  lastResults.clear();
}
