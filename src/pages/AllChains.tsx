// "ALL" in the chain switch: Portfolio and Trades for every chain at once,
// in dollars. Each chain's own page still exists one click away — these are
// the combined views, built from the same reads those pages make (the wallet
// signing on each chain; the All-in-One wallet when it signs everywhere).
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Card, GhostButton, Page, Section } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import { useTerminal } from '../state/TerminalProvider';
import { AIO_CHAIN_LABEL, mergeAllChainPositions, mergeAllChainTrips, type AioChain, type AllChainPosition, type AllChainTrip } from '@shared/aio';
import { EVM_CHAIN_META, evmClosedTrips, type ChainKind, type EvmChainKind } from '@shared/evm';
import { cls, fmtAgo, fmtDur } from '../utils/format';

const TONE: Record<AioChain, string> = {
  solana: 'text-violet-300 border-violet-400/30 bg-violet-500/10',
  bnb: 'text-amber-300 border-amber-400/30 bg-amber-500/10',
  robinhood: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10',
};

function usd(v: number | null, signed = false): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const s = `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return signed ? `${v < 0 ? '−' : '+'}${s}` : v < 0 ? `−${s}` : s;
}

function ChainTag({ chain }: { chain: AioChain }) {
  return <span className={cls('rounded-full border px-2 py-0.5 text-label whitespace-nowrap', TONE[chain])}>{AIO_CHAIN_LABEL[chain]}</span>;
}

/** The chains to read: Solana always, an EVM chain only when switched on. */
function useChains(): EvmChainKind[] {
  const { settings } = useAppState();
  return (['robinhood', 'bnb'] as EvmChainKind[]).filter((c) => settings.evm[c].enabled);
}

/** A link into one chain's own page. */
function ChainLinks() {
  const { setChain, setAllChains } = useTerminal();
  const evm = useChains();
  const go = (c: ChainKind): void => {
    setAllChains(false);
    setChain(c);
  };
  return (
    <div className="flex items-center gap-1.5 text-label text-krypt-muted">
      One chain:
      {(['solana', ...evm] as ChainKind[]).map((c) => (
        <button key={c} onClick={() => go(c)} className="rounded-full border border-white/10 px-2 py-0.5 hover:border-white/30 hover:text-white">
          {AIO_CHAIN_LABEL[c as AioChain]}
        </button>
      ))}
    </div>
  );
}

export function AllChainsPortfolio({ onOpenToken }: { onOpenToken: (mint: string, chain?: ChainKind) => void }) {
  const evmChains = useChains();
  const [rows, setRows] = useState<AllChainPosition[] | null>(null);
  // `partial`: some of the chain's value is unknown (a coin with no price,
  // an unread balance) — the figure is a floor and says so.
  const [byChain, setByChain] = useState<Array<{ chain: AioChain; usd: number | null; ok: boolean; partial: boolean }>>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [sol, ...evm] = await Promise.all([
      window.krypt.portfolio.summary({ stale: true }),
      ...evmChains.map((c) => window.krypt.evm.portfolio(c)),
    ]);
    setLoading(false);
    const solData = sol.ok && sol.data ? sol.data : null;
    const evmData = evmChains.map((c, i) => ({ chain: c, r: evm[i] }));
    setRows(
      mergeAllChainPositions(
        solData ? { positions: solData.positions, solUsd: solData.solUsd } : null,
        evmData.filter((e) => e.r.ok && e.r.data).map((e) => ({ chain: e.chain, nativeUsd: e.r.data!.nativeUsd, positions: e.r.data!.positions })),
      ),
    );
    // Computed here, never taken from the Solana summary's own total: that
    // one drops the SOL balance when the price is unknown and drops every
    // unpriced position, which reads as a smaller number instead of "this is
    // a floor" (review 2026-10-02). Unknown coin balance or price → no value;
    // an unpriced position → the known part, marked partial.
    const solChain = ((): { usd: number | null; partial: boolean } => {
      if (!solData || solData.solBalance === null || solData.solUsd === null) return { usd: null, partial: true };
      const px = solData.solUsd;
      let v = solData.solBalance * px;
      let partial = false;
      for (const p of solData.positions) {
        if (p.paper) continue;
        const usdV = p.valueUsd ?? (p.valueSol !== null ? p.valueSol * px : null);
        if (usdV === null) partial = true;
        else v += usdV;
      }
      return { usd: v, partial };
    })();
    setByChain([
      { chain: 'solana', usd: solChain.usd, ok: !!solData, partial: solChain.partial },
      ...evmData.map((e) => {
        const d = e.r.ok ? e.r.data : null;
        if (!d) return { chain: e.chain as AioChain, usd: null, ok: false, partial: true };
        if (d.nativeBalance === null || d.nativeUsd === null) return { chain: e.chain as AioChain, usd: null, ok: true, partial: true };
        let native = d.nativeBalance;
        let partial = false;
        for (const p of d.positions) {
          if (p.valueNative === null) partial = true;
          else native += p.valueNative;
        }
        return { chain: e.chain as AioChain, usd: native * d.nativeUsd, ok: true, partial };
      }),
    ]);
  }, [evmChains.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const known = byChain.filter((c) => c.usd !== null);
  // Nothing known anywhere is a dash, not $0.00.
  const total = known.length ? known.reduce((s, c) => s + (c.usd ?? 0), 0) : null;
  const partial = byChain.some((c) => !c.ok || c.usd === null || c.partial);

  return (
    <Page
      title="Portfolio · every chain"
      subtitle="What the wallet signing on each chain holds, in dollars. Each chain's coin and fills are on its own page."
      actions={
        <GhostButton onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} /> Refresh
        </GhostButton>
      }
    >
      <div className="mb-6 rounded-2xl p-[1px] bg-gradient-to-r from-violet-500/50 via-amber-400/40 to-emerald-400/50">
        <div className="rounded-2xl bg-black/80 px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="font-display text-label uppercase tracking-eyebrow text-arc-gold/80">Every chain</div>
            <div className="text-3xl font-bold font-mono tabular-nums text-white">
              {usd(total)}
              {partial && total !== null && <span className="ml-1 text-base text-krypt-muted" title="A chain did not answer, or something on it has no price — this is at least the total">+</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {byChain.map((c) => (
              <span key={c.chain} className={cls('rounded-full border px-2.5 py-1 text-label', TONE[c.chain])}>
                {AIO_CHAIN_LABEL[c.chain]} <span className="font-mono text-white/90">{c.ok ? usd(c.usd) : 'not read'}{c.ok && c.partial && c.usd !== null ? '+' : ''}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <Section title="Positions" actions={<ChainLinks />}>
        <Card padded={false}>
          {rows === null ? (
            <div className="px-4 py-6 text-xs text-krypt-muted">Reading every chain…</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6 text-xs text-krypt-muted">
              {byChain.some((c) => !c.ok)
                ? `No open positions on the chains that answered — not read: ${byChain.filter((c) => !c.ok).map((c) => AIO_CHAIN_LABEL[c.chain]).join(', ')}.`
                : 'No open positions on any chain.'}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-label uppercase tracking-label text-krypt-muted/70 border-b border-white/5">
                  <th className="px-4 py-2 font-normal">Chain</th>
                  <th className="py-2 font-normal">Token</th>
                  <th className="py-2 font-normal text-right">Value</th>
                  <th className="px-4 py-2 font-normal text-right">Unrealised</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.chain}:${r.token}`}
                    onClick={() => onOpenToken(r.token, r.chain)}
                    className="border-b border-white/5 last:border-0 cursor-pointer hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-2 w-28"><ChainTag chain={r.chain} /></td>
                    <td className="py-2 text-white font-semibold">
                      {r.symbol} <span className="font-normal text-krypt-muted">{r.name}</span>
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums text-white">{r.valueUsd === null ? <span className="text-krypt-muted">no price</span> : usd(r.valueUsd)}</td>
                    <td className={cls('px-4 py-2 text-right font-mono tabular-nums', r.pnlUsd === null ? 'text-krypt-muted' : r.pnlUsd >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                      {r.basisKnown ? usd(r.pnlUsd, true) : 'no cost basis'}
                      {r.pnlPct !== null && r.basisKnown && <span className="ml-1 text-krypt-muted">({r.pnlPct >= 0 ? '+' : ''}{r.pnlPct.toFixed(1)}%)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </Section>
    </Page>
  );
}

export function AllChainsTrades({ onOpenToken }: { onOpenToken: (mint: string, chain?: ChainKind) => void }) {
  const evmChains = useChains();
  const [trips, setTrips] = useState<AllChainTrip[] | null>(null);
  /** Chains whose history could not be read — never shown as "no trades". */
  const [unread, setUnread] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [sol, ...evm] = await Promise.all([
      window.krypt.portfolio.summary({ stale: true }),
      ...evmChains.flatMap((c) => [window.krypt.evm.fills(c), window.krypt.evm.portfolio(c)]),
    ]);
    setLoading(false);
    const solData = sol.ok && sol.data ? sol.data : null;
    const chains: Parameters<typeof mergeAllChainTrips>[0] = [];
    const missing: string[] = [];
    if (solData) chains.push({ chain: 'solana', nativeSymbol: 'SOL', nativeUsd: solData.solUsd, trips: solData.closed });
    else missing.push('Solana');
    evmChains.forEach((c, i) => {
      const fills = evm[i * 2] as Awaited<ReturnType<typeof window.krypt.evm.fills>>;
      const port = evm[i * 2 + 1] as Awaited<ReturnType<typeof window.krypt.evm.portfolio>>;
      if (!fills.ok || !fills.data) {
        missing.push(EVM_CHAIN_META[c].name);
        return;
      }
      chains.push({ chain: c, nativeSymbol: EVM_CHAIN_META[c].nativeSymbol, nativeUsd: port.ok && port.data ? port.data.nativeUsd : null, trips: evmClosedTrips(fills.data) });
    });
    setUnread(missing);
    setTrips(mergeAllChainTrips(chains));
  }, [evmChains.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page
      title="Trades · every chain"
      subtitle="Closed round trips on every chain, newest first. Profit is in each chain's own coin; the dollar figure uses today's price of that coin."
      actions={
        <GhostButton onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} /> Refresh
        </GhostButton>
      }
    >
      <Section title="Closed trades" actions={<ChainLinks />}>
        <Card padded={false}>
          {trips === null ? (
            <div className="px-4 py-6 text-xs text-krypt-muted">Reading every chain…</div>
          ) : trips.length === 0 ? (
            <div className="px-4 py-6 text-xs text-krypt-muted">
              {unread.length ? `No closed trades on the chains that answered — not read: ${unread.join(', ')}.` : 'No closed trades yet on any chain.'}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-label uppercase tracking-label text-krypt-muted/70 border-b border-white/5">
                  <th className="px-4 py-2 font-normal">Chain</th>
                  <th className="py-2 font-normal">Token</th>
                  <th className="py-2 font-normal text-right">Profit</th>
                  <th className="py-2 font-normal text-right">At today's price</th>
                  <th className="px-4 py-2 font-normal text-right">Closed</th>
                </tr>
              </thead>
              <tbody>
                {trips.slice(0, 300).map((t, i) => (
                  <tr key={`${t.chain}:${t.mint}:${t.closedAt}:${i}`} onClick={() => onOpenToken(t.mint, t.chain)} className="border-b border-white/5 last:border-0 cursor-pointer hover:bg-white/[0.03]">
                    <td className="px-4 py-2 w-28"><ChainTag chain={t.chain} /></td>
                    <td className="py-2 text-white font-semibold">{t.symbol}</td>
                    <td className={cls('py-2 text-right font-mono tabular-nums', t.pnlNative >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                      {t.pnlNative >= 0 ? '+' : '−'}{Math.abs(t.pnlNative).toPrecision(3)} {t.nativeSymbol}
                      <span className="ml-1 text-krypt-muted">({t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%)</span>
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums text-white/80">{usd(t.pnlUsdNow, true)}</td>
                    <td className="px-4 py-2 text-right text-krypt-muted" title={`Held ${fmtDur(t.holdMs)}`}>{fmtAgo(t.closedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </Section>
    </Page>
  );
}
