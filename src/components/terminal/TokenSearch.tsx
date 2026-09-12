import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { imageSrc, type TokenSummary } from '@shared/market';
import { EVM_CHAIN_META, isEvmChain, type ChainKind } from '@shared/evm';
import { useTerminal } from '../../state/TerminalProvider';
import { cls, fmtAge, fmtUsd, shortAddr } from '../../utils/format';

// "Search / paste CA anywhere" (term.txt section 21). Ctrl+K from anywhere,
// Enter on a pasted mint address opens it straight away.
//
// A pasted 32–44 char base58 string skips the search API entirely and goes
// to the token loader, so pasting a contract address works even with every
// third-party provider disabled.

const SOL_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** An EVM token address opens its own page the same way — on the selected
 *  EVM chain, or Robinhood while Solana is selected, since the address alone
 *  does not say which chain it lives on. */
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const MINT_RE = { test: (s: string): boolean => SOL_MINT_RE.test(s) || EVM_RE.test(s) };

const chainLabel = (c: ChainKind): string => (c === 'solana' ? 'Solana' : EVM_CHAIN_META[c].shortName);

export function TokenSearch({ onOpen }: { onOpen: (mint: string, chain?: ChainKind) => void }) {
  const { chain } = useTerminal();
  const chainFor = (mint: string): ChainKind => (EVM_RE.test(mint) ? (isEvmChain(chain) ? chain : 'robinhood') : 'solana');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<TokenSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Global hotkey.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Debounced search. A full mint address resolves immediately instead.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setRows([]);
      return;
    }
    if (MINT_RE.test(q)) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(async () => {
      setLoading(true);
      const r = await window.krypt.market.search(q);
      if (!cancelled) {
        setRows(r.ok && r.data ? r.data : []);
        setLoading(false);
      }
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query]);

  const submit = (): void => {
    const q = query.trim();
    if (MINT_RE.test(q)) {
      onOpen(q, chainFor(q));
      setQuery('');
      setOpen(false);
      return;
    }
    if (rows[0]) {
      onOpen(rows[0].mint, rows[0].chain ?? chainFor(rows[0].mint));
      setQuery('');
      setOpen(false);
    }
  };

  const isMint = MINT_RE.test(query.trim());

  return (
    <div ref={boxRef} className="relative w-[340px]">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-krypt-muted/60" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="Search or paste a contract address…"
          className="w-full bg-black/40 border border-white/10 rounded-lg pl-8 pr-14 py-2 text-[12px] text-white outline-none focus:border-krypt-purple/50 placeholder:text-krypt-muted/50"
        />
        <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] font-mono text-krypt-muted/60">
          Ctrl K
        </kbd>
      </div>

      {open && query.trim() && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-white/12 bg-krypt-panel/98 backdrop-blur-md shadow-krypt-card overflow-hidden">
          {isMint ? (
            <button
              onClick={submit}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/5 transition"
            >
              <span className="rounded bg-krypt-purple/20 px-1.5 py-0.5 text-[9px] font-bold text-krypt-pink">CA</span>
              <span className="font-mono text-[11px] text-white truncate">{shortAddr(query.trim(), 8)}</span>
              {/* An address alone does not say which chain it lives on, so name
                  the one it will actually open on — a BNB contract pasted while
                  Robinhood is selected otherwise opens an empty Robinhood page. */}
              <span className="ml-auto text-[10px] text-krypt-muted">
                {chainLabel(chainFor(query.trim()))} · Open ↵
              </span>
            </button>
          ) : loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-krypt-purple" />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-krypt-muted">
              No matches.
              {isEvmChain(chain) && <span className="block mt-1 text-krypt-muted/70">Name search is Solana-only for now — paste a 0x contract address to open a token on {chain === 'bnb' ? 'BNB Smart Chain' : 'Robinhood Chain'}.</span>}
            </div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto">
              {isEvmChain(chain) && (
                <div className="px-3 py-1.5 text-[10px] text-arc-gold/80 border-b border-white/8">
                  Name search is Solana-only for now — these are Solana tokens. Paste a 0x contract address for {chain === 'bnb' ? 'BNB Smart Chain' : 'Robinhood Chain'}.
                </div>
              )}
              {rows.map((t) => (
                <button
                  key={t.mint}
                  onClick={() => {
                    onOpen(t.mint, t.chain ?? chainFor(t.mint));
                    setQuery('');
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition"
                >
                  <div className="h-6 w-6 rounded overflow-hidden border border-white/10 bg-black/40 flex-shrink-0">
                    {imageSrc(t.imageUrl) && (
                      <img src={imageSrc(t.imageUrl) as string} alt="" className="h-full w-full object-cover" />
                    )}
                  </div>
                  <span className="text-[12px] font-semibold text-white">{t.symbol || '—'}</span>
                  <span className="text-[11px] text-krypt-muted truncate flex-1">{t.name}</span>
                  <span className="text-[10px] font-mono text-krypt-muted/70">{fmtAge(t.createdAt)}</span>
                  <span className={cls('text-[11px] font-mono w-16 text-right text-white/80')}>
                    {fmtUsd(t.marketCapUsd)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
