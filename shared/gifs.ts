// GIF search for card and replay backgrounds — the pure half.
//
// Two rules shape this file. First, the renderer never names a host or a URL:
// it sends a provider id and a search string, main builds the request, and
// picking a result sends back an ID from the last search rather than a link.
// Second, an API key never appears here — keys live in settings, are read in
// main, and are appended to the request there, so nothing in this module (or
// its test) can leak or log one.
//
// Both providers require attribution when you show their results. That is a
// condition of use, not decoration, so ATTRIBUTION travels with the provider
// and the picker renders it.

export type GifProvider = 'giphy' | 'tenor';

export const GIF_PROVIDERS: GifProvider[] = ['giphy', 'tenor'];

/** The only hosts this feature will ever contact. */
export const GIF_HOSTS: Record<GifProvider, string> = {
  giphy: 'api.giphy.com',
  tenor: 'tenor.googleapis.com',
};

export const GIF_LABEL: Record<GifProvider, string> = {
  giphy: 'GIPHY',
  tenor: 'Tenor',
};

/** Required by both providers wherever their results are displayed. */
export const ATTRIBUTION: Record<GifProvider, string> = {
  giphy: 'Powered by GIPHY',
  tenor: 'Powered by Tenor',
};

/** Where a user gets a free key, shown when one is missing. */
export const KEY_URL: Record<GifProvider, string> = {
  giphy: 'https://developers.giphy.com/dashboard/',
  tenor: 'https://developers.google.com/tenor/guides/quickstart',
};

export const MAX_GIF_RESULTS = 24;
/** Long queries are a sign of a paste, not a search. */
export const MAX_QUERY_LENGTH = 60;

export interface GifItem {
  /** Stable within one search; what the renderer sends back to pick one. */
  id: string;
  title: string;
  /** Small looping preview, for the grid. */
  previewUrl: string;
  /** The one that becomes the background. */
  fullUrl: string;
  width: number;
  height: number;
}

/**
 * Path and query for a search, WITHOUT the key. Ratings are pinned to the
 * tamer end at both providers: this puts an image behind a number someone
 * will post, and the default should not be a surprise.
 */
export function searchPath(provider: GifProvider, query: string, limit: number): string {
  const q = encodeURIComponent(query.trim().slice(0, MAX_QUERY_LENGTH));
  const n = Math.max(1, Math.min(MAX_GIF_RESULTS, Math.floor(limit) || 1));
  if (provider === 'giphy') return `/v1/gifs/search?q=${q}&limit=${n}&rating=pg-13&bundle=messaging_non_clips`;
  return `/v2/search?q=${q}&limit=${n}&contentfilter=medium&media_filter=gif,tinygif&client_key=krypto_bot`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
/** Only https survives; anything else is dropped rather than fetched. */
const https = (v: unknown): string => {
  const s = str(v);
  return s.startsWith('https://') ? s : '';
};

/** GIPHY's search payload. Anything malformed is skipped, not guessed at. */
export function parseGiphy(body: unknown): GifItem[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: GifItem[] = [];
  for (const row of data) {
    const r = row as { id?: unknown; title?: unknown; images?: Record<string, { url?: unknown; width?: unknown; height?: unknown }> };
    const id = str(r?.id);
    const images = r?.images ?? {};
    const full = https(images.downsized?.url) || https(images.original?.url);
    const preview = https(images.fixed_width_small?.url) || https(images.preview_gif?.url) || full;
    if (!id || !full || !preview) continue;
    const src = images.downsized ?? images.original ?? {};
    out.push({
      id,
      title: str(r?.title) || 'GIF',
      previewUrl: preview,
      fullUrl: full,
      width: num(src.width),
      height: num(src.height),
    });
  }
  return out;
}

/** Tenor v2's search payload. */
export function parseTenor(body: unknown): GifItem[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: GifItem[] = [];
  for (const row of results) {
    const r = row as { id?: unknown; content_description?: unknown; media_formats?: Record<string, { url?: unknown; dims?: unknown }> };
    const media = r?.media_formats ?? {};
    const id = str(r?.id);
    const full = https(media.gif?.url) || https(media.mediumgif?.url);
    const preview = https(media.tinygif?.url) || full;
    if (!id || !full || !preview) continue;
    const dims = Array.isArray(media.gif?.dims) ? (media.gif?.dims as unknown[]) : [];
    out.push({
      id,
      title: str(r?.content_description) || 'GIF',
      previewUrl: preview,
      fullUrl: full,
      width: num(dims[0]),
      height: num(dims[1]),
    });
  }
  return out;
}

export function parseSearch(provider: GifProvider, body: unknown): GifItem[] {
  return provider === 'giphy' ? parseGiphy(body) : parseTenor(body);
}
