// Swap — one token for another, from Wallet Utilities.
//
// Deliberately not a trade panel. No chart, no position, no PnL: a from, a
// to, an amount and what you would get. The quote is re-fetched when the
// inputs settle, and the Swap button stays disabled until a quote exists —
// you never send something the chain has not already priced.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, Loader2, Repeat } from 'lucide-react';
import {
  DEFAULT_SLIPPAGE_PCT,
  KNOWN_MINTS,
  MAX_SLIPPAGE_PCT,
  MIN_SLIPPAGE_PCT,
  SPEED_BLURB,
  SPEED_LABEL,
  SWAP_ABILITY,
  SWAP_CHAINS,
  SWAP_SPEEDS,
  emptyDraft,
  fromRaw,
  isKnownMint,
  looksLikeMint,
  nativeOf,
  nativeSymbol,
  swapProblems,
  type SwapChain,
  type SwapDraft,
  type SwapQuote,
} from '@shared/swap';
import { EVM_CHAIN_META } from '@shared/evm';
import { useToast } from '../../state/ToastProvider';
import { cls } from '../../utils/format';

const inputCls =
  'w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-white placeholder:text-krypt-muted/60 focus:border-krypt-purple/60 focus:outline-none';

const CHAIN_LABEL: Record<SwapChain, string> = {
  solana: 'Solana',
  robinhood: EVM_CHAIN_META.robinhood.shortName,
  bnb: EVM_CHAIN_META.bnb.shortName,
};

const label = (chain: SwapChain, mint: string): string =>
  isKnownMint(chain, mint)?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;

/** A token field: that chain's common ones as chips, anything else pasted. */
function MintField({
  chain,
  value,
  onChange,
  exclude,
}: {
  chain: SwapChain;
  value: string;
  onChange: (m: string) => void;
  exclude: string;
}) {
  const known = isKnownMint(chain, value);
  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-1">
        {KNOWN_MINTS[chain].filter((m) => m.mint !== exclude).map((m) => (
          <button
            key={m.mint}
            onClick={() => onChange(m.mint)}
            className={cls(
              'rounded-md border px-2 py-0.5 text-[10px] font-semibold transition',
              value === m.mint
                ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white'
                : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
            )}
          >
            {m.symbol}
          </button>
        ))}
      </div>
      <input
        value={known ? '' : value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder={known ? `${known.symbol} — or paste any token` : chain === 'solana' ? 'Paste a mint address' : 'Paste a token address (0x…)'}
        className={cls(inputCls, 'font-mono text-[11px]')}
      />
    </div>
  );
}

export function SwapCard() {
  const toast = useToast();
  const [draft, setDraft] = useState<SwapDraft>(() => emptyDraft());
  const [held, setHeld] = useState<{ amount: number | null; decimals: number | null }>({ amount: null, decimals: null });
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const seq = useRef(0);

  const set = useCallback(<K extends keyof SwapDraft>(k: K, v: SwapDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setQuote(null);
    setChecked(false);
  }, []);

  // Switching chain starts a fresh draft: the token addresses on one chain
  // mean nothing on another, and carrying an amount across would be an
  // amount of something the new chain has never heard of.
  const setChain = useCallback((chain: SwapChain) => {
    setDraft(emptyDraft(chain));
    setQuote(null);
    setChecked(false);
  }, []);

  // What the wallet holds of the input token, for Max and for the "more than
  // you hold" check. An unreadable balance stays null — never 0.
  useEffect(() => {
    let alive = true;
    setHeld({ amount: null, decimals: null });
    if (!looksLikeMint(draft.chain, draft.inputMint)) return;
    void window.krypt.swap
      .balance(draft.inputMint, draft.chain)
      .then((r) => {
        if (alive && r.ok && r.data) setHeld({ amount: r.data.amount, decimals: r.data.decimals });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [draft.inputMint, draft.chain]);

  const problems = useMemo(() => swapProblems(draft, held.amount), [draft, held.amount]);

  // Quote when the inputs settle. Debounced, and every reply carries the
  // sequence it was asked with so a slow answer cannot overwrite a fast one.
  useEffect(() => {
    if (problems.length) {
      setQuote(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      setQuoting(true);
      void window.krypt.swap
        .quote(draft)
        .then((r) => {
          if (mine !== seq.current) return;
          setQuote(r.ok && r.data ? r.data : null);
          if (!r.ok) toast.error(r.message);
        })
        .catch(() => undefined)
        .finally(() => {
          if (mine === seq.current) setQuoting(false);
        });
    }, 450);
    return () => clearTimeout(t);
  }, [draft, problems.length, toast]);

  const flip = useCallback(() => {
    setDraft((d) => ({ ...d, inputMint: d.outputMint, outputMint: d.inputMint, amount: 0 }));
    setQuote(null);
    setChecked(false);
  }, []);

  const run = useCallback(
    async (simulateOnly: boolean) => {
      setBusy(true);
      try {
        const r = await window.krypt.swap.execute(draft, simulateOnly);
        if (!r.ok) {
          toast.error(r.message);
          return;
        }
        if (simulateOnly) {
          setChecked(true);
          // The rail's own words: on EVM that names the venue, the size and
          // whether it was actually rehearsed (a sell that needs an approval
          // first cannot be), instead of one fixed sentence for every case.
          toast.success(r.message || 'The chain accepts this swap. Nothing was sent.');
        } else {
          setChecked(false);
          setDraft((d) => ({ ...d, amount: 0 }));
          setQuote(null);
          toast.success(r.message ?? 'Swapped.');
        }
      } finally {
        setBusy(false);
      }
    },
    [draft, toast],
  );

  // Unknown precision is a dash, never a number off by a power of ten.
  const outAmount = quote && quote.outDecimals !== null ? fromRaw(quote.outAmountRaw, quote.outDecimals) : null;
  const feeSol = quote ? quote.feeLamports / 1e9 : null;

  return (
    <div className="rounded-xl border border-white/10 bg-krypt-panel p-4">
      <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-white">
        <Repeat className="h-3.5 w-3.5 text-krypt-purple" /> Swap
      </div>
      {/* Chain first: everything below it means something different per
          chain, including what can be routed at all. */}
      <div className="mb-3 flex gap-1">
        {SWAP_CHAINS.map((c) => (
          <button
            key={c}
            onClick={() => setChain(c)}
            className={cls(
              'flex-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition',
              draft.chain === c
                ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white'
                : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
            )}
          >
            {CHAIN_LABEL[c]}
          </button>
        ))}
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-krypt-muted">
        {SWAP_ABILITY[draft.chain] === 'any' ? (
          <>
            Any token for any other, routed through Jupiter — the same routing every buy and sell uses. A utility, not a trade: it
            opens no position and records no profit or loss.
          </>
        ) : (
          <>
            On {CHAIN_LABEL[draft.chain]} one side has to be{' '}
            <span className="text-white/80">{nativeSymbol(draft.chain)}</span> — that chain&apos;s rail routes native-to-token and
            back, and nothing else yet. It goes through the ordinary trade path, so the chain must be{' '}
            <span className="text-white/80">armed</span> and the swap is recorded as a fill, because on this chain it is one.
          </>
        )}
      </p>

      <div className="space-y-2">
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[11px] font-semibold text-white/80">From</span>
            <button
              onClick={() => held.amount !== null && set('amount', held.amount)}
              disabled={held.amount === null}
              className="text-[10px] text-krypt-muted transition hover:text-white disabled:opacity-40"
            >
              {/* Unknown renders as a dash, never as 0 — an unreadable balance
                  must not read as "you hold none". */}
              holding {held.amount === null ? '—' : held.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}
              {held.amount !== null && ' · max'}
            </button>
          </div>
          <MintField chain={draft.chain} value={draft.inputMint} onChange={(m) => set('inputMint', m)} exclude={draft.outputMint} />
          <input
            type="number"
            step="any"
            min={0}
            value={draft.amount || ''}
            onChange={(e) => set('amount', Number(e.target.value))}
            placeholder="0.0"
            className={cls(inputCls, 'mt-1 font-mono')}
          />
        </div>

        <div className="flex justify-center">
          <button
            onClick={flip}
            title="Swap the two sides"
            className="rounded-full border border-white/10 bg-white/5 p-1.5 text-krypt-muted transition hover:text-white"
          >
            <ArrowDownUp className="h-3.5 w-3.5" />
          </button>
        </div>

        <div>
          <span className="mb-1 block text-[11px] font-semibold text-white/80">To</span>
          <MintField chain={draft.chain} value={draft.outputMint} onChange={(m) => set('outputMint', m)} exclude={draft.inputMint} />
          <div className="mt-1 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 font-mono text-[12px] text-white">
            {quoting ? (
              <span className="text-krypt-muted">pricing…</span>
            ) : outAmount === null ? (
              <span className="text-krypt-muted">—</span>
            ) : (
              outAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })
            )}
          </div>
        </div>

        {/* Speed. It buys BLOCK POSITION and nothing else — never a better
            price — and the numbers under each are measured, not adjectives.
            Solana only: the EVM rail prices its own gas from the chain's fee
            history, and a control that did nothing would be a lie. */}
        <div className={cls(SWAP_ABILITY[draft.chain] === 'any' ? '' : 'hidden')}>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[11px] font-semibold text-white/80">Speed</span>
            {quote && quote.prioritySource === 'fallback' && (
              <span className="text-[10px] text-krypt-muted/70">estimate unavailable — these are defaults</span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1">
            {SWAP_SPEEDS.map((sp) => {
              const lamports = quote?.priorityBySpeed?.[sp];
              return (
                <button
                  key={sp}
                  onClick={() => set('speed', sp)}
                  title={SPEED_BLURB[sp]}
                  className={cls(
                    'rounded-lg border px-2 py-1.5 text-left transition',
                    draft.speed === sp
                      ? 'border-krypt-purple/50 bg-krypt-purple/10'
                      : 'border-white/10 bg-white/[0.02] hover:bg-white/5',
                  )}
                >
                  <span className="block text-[11px] font-semibold text-white/90">{SPEED_LABEL[sp]}</span>
                  <span className="block font-mono text-[10px] text-krypt-muted">
                    {lamports === undefined ? '—' : `≤ ${(lamports / 1e9).toFixed(6)}`}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-krypt-muted/80">
            A network fee paid to validators, not to us, and a ceiling rather than a charge — a short route consumes less and
            costs less than shown. It buys position in a block; it does not get you a better price.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-krypt-muted">Slippage</span>
          <input
            type="number"
            step="0.1"
            min={MIN_SLIPPAGE_PCT}
            max={MAX_SLIPPAGE_PCT}
            value={draft.slippagePct}
            onChange={(e) => set('slippagePct', Number(e.target.value))}
            className={cls(inputCls, 'w-20 font-mono')}
          />
          <span className="text-[11px] text-krypt-muted">%</span>
          {draft.slippagePct !== DEFAULT_SLIPPAGE_PCT && (
            <button onClick={() => set('slippagePct', DEFAULT_SLIPPAGE_PCT)} className="text-[10px] text-krypt-muted hover:text-white">
              reset
            </button>
          )}
        </div>
      </div>

      {quote && (
        <div className="mt-3 space-y-0.5 rounded-lg border border-white/10 bg-white/[0.02] p-2.5 text-[10px] leading-relaxed text-krypt-muted">
          <div>
            Route: <span className="text-white/70">{quote.route.length ? quote.route.join(' → ') : 'direct'}</span>
          </div>
          <div>
            {/* Where the fee's basis came from is stated rather than implied —
                a token-to-token swap has no SOL leg to charge on, so it says
                so, and an unpriceable one is charged nothing at all. */}
            Platform fee:{' '}
            <span className="text-white/70">
              {quote.feeBasis === 'on-top' || quote.feeBasis === 'follows' || quote.feeBasis === 'inside'
                ? quote.feeNative !== null
                  ? `${quote.feeNative.toFixed(6)} ${nativeSymbol(draft.chain)}`
                  : '0.5%'
                : feeSol === null || feeSol === 0
                  ? 'none'
                  : `${feeSol.toFixed(6)} SOL`}
            </span>
            {quote.feeBasis === 'on-top' ? ` — added on top of the ${nativeSymbol(draft.chain)} you send` : ''}
            {quote.feeBasis === 'follows' ? ' — sent as a second transaction right after the buy lands' : ''}
            {quote.feeBasis === 'inside' ? ' — taken out of the proceeds; the amount above is what you get' : ''}
            {quote.feeBasis === 'quoted' && feeSol ? ' (0.5% of the input priced in SOL)' : ''}
            {quote.feeBasis === 'unpriced' ? ' — this pair could not be priced in SOL, so nothing is charged' : ''}
          </div>
          {quote.appliedSlippagePct !== draft.slippagePct && (
            <div className="text-amber-200/80">
              Slippage: the transaction carries {quote.appliedSlippagePct}%, not {draft.slippagePct}% — sells on this chain never
              go under {quote.appliedSlippagePct}%, so a tight cap cannot strand you in a position.
            </div>
          )}
        </div>
      )}

      {problems.length > 0 && draft.amount > 0 && (
        <ul className="mt-3 space-y-0.5 text-[10px] text-krypt-muted">
          {problems.map((p) => (
            <li key={p}>· {p}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => void run(true)}
          disabled={busy || !quote || problems.length > 0}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-white/90 transition hover:bg-white/10 disabled:opacity-40"
        >
          {busy && !checked && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Check it first
        </button>
        <button
          onClick={() => void run(false)}
          disabled={busy || !quote || problems.length > 0 || !checked}
          title={!checked ? 'Check it first — a swap cannot be undone' : undefined}
          className="flex items-center gap-1.5 rounded-lg border border-krypt-purple/40 bg-krypt-purple/15 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-krypt-purple/25 disabled:opacity-40"
        >
          {busy && checked ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Repeat className="h-3.5 w-3.5" />}
          Swap {draft.amount > 0 ? `${draft.amount} ${label(draft.chain, draft.inputMint)}` : ''}
        </button>
      </div>

      {draft.inputMint.toLowerCase() === nativeOf(draft.chain).toLowerCase() && (
        <p className="mt-2 text-[10px] leading-relaxed text-krypt-muted/80">
          Swapping from {nativeSymbol(draft.chain)} leaves less of it for gas. Keep enough back to sign your next transaction.
        </p>
      )}
    </div>
  );
}
