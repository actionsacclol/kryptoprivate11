// Search a GIF to sit behind a card or a replay (2026-09-03).
//
// The renderer types a query and clicks a result. It never handles a host, a
// URL or an API key: main builds the request, previews arrive through the
// hardened image handler, and picking one sends back an ID from the last
// search. The chosen GIF comes back as bytes, which is also what keeps the
// canvas exportable.
//
// Attribution is a condition of using either API, so the mark renders
// whenever results do — not as a setting.

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, Search, X } from 'lucide-react';
import { ATTRIBUTION, GIF_LABEL, GIF_PROVIDERS, KEY_URL, type GifProvider } from '@shared/gifs';
import { cls } from '../../utils/format';
import { useToast } from '../../state/ToastProvider';

type Row = { id: string; title: string; preview: string | null; width: number; height: number };

export function GifPicker({ onPick, onClose }: { onPick: (dataUrl: string) => void; onClose: () => void }) {
  const toast = useToast();
  const [provider, setProvider] = useState<GifProvider>('giphy');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = async (): Promise<void> => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setProblem(null);
    try {
      const r = await window.krypt.gifs.search(provider, q);
      if (r.ok && r.data) {
        setRows(r.data);
        if (!r.data.length) setProblem(`No results for “${q}” on ${GIF_LABEL[provider]}.`);
      } else {
        setRows([]);
        setProblem(r.message);
      }
    } finally {
      setSearching(false);
    }
  };

  const choose = async (row: Row): Promise<void> => {
    if (picking) return;
    setPicking(row.id);
    try {
      const r = await window.krypt.gifs.pick(provider, row.id);
      if (r.ok && r.data) {
        onPick(r.data.dataUrl);
        onClose();
      } else toast.error(r.message);
    } finally {
      setPicking(null);
    }
  };

  const needsKey = problem?.includes('key is set');

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="plate w-full max-w-2xl animate-pop-in rounded-xl p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <h3 className="font-display text-[11px] font-semibold uppercase tracking-[0.28em] text-krypt-muted">
            Background GIF
          </h3>
          <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
          <div className="flex items-center overflow-hidden rounded-md border border-white/10">
            {GIF_PROVIDERS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setProvider(p);
                  setRows([]);
                  setProblem(null);
                }}
                className={cls(
                  'px-2.5 py-1 text-[10px] font-semibold transition',
                  provider === p ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
                )}
              >
                {GIF_LABEL[p]}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="ml-1 text-krypt-muted transition hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run();
            }}
            placeholder={`Search ${GIF_LABEL[provider]} — moon, pepe, explosion…`}
            maxLength={60}
            className="flex-1 rounded-md border border-white/15 bg-black/40 px-2 py-1.5 text-[12px] text-white outline-none focus:border-krypt-purple/60"
          />
          <button
            onClick={() => void run()}
            disabled={!query.trim() || searching}
            className="inline-flex items-center gap-2 rounded-lg border border-krypt-purple/50 bg-krypt-gradient px-3 py-1.5 text-[12px] font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            Search
          </button>
        </div>

        {problem && (
          <div className="mt-3 rounded-md border border-arc-gold/30 bg-arc-gold/10 px-3 py-2 text-[11px] leading-relaxed text-arc-gold">
            {problem}
            {needsKey && (
              <>
                {' '}
                Both providers give one away free. Paste it into Settings → Data.{' '}
                <a
                  href={KEY_URL[provider]}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline hover:text-white"
                >
                  Get a {GIF_LABEL[provider]} key <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div className="mt-3 grid max-h-[22rem] grid-cols-4 gap-2 overflow-y-auto pr-1">
              {rows.map((row) => (
                <button
                  key={row.id}
                  onClick={() => void choose(row)}
                  title={row.title}
                  className="group relative aspect-square overflow-hidden rounded-md border border-white/10 bg-black/40 transition hover:border-krypt-purple/60"
                >
                  {row.preview && (
                    <img src={row.preview} alt={row.title} className="h-full w-full object-cover" loading="lazy" />
                  )}
                  {picking === row.id && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/60">
                      <Loader2 className="h-5 w-5 animate-spin text-white" />
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] text-krypt-muted">
              <span>{ATTRIBUTION[provider]}</span>
              <span>Downloaded once and kept locally. A PNG saves one frame; Save video keeps the motion.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
