// The Trades page for an EVM chain: every fill this install made there, read
// back from the chain, and the totals the ledger has reconciled.
//
// Until 2026-09-11 the Trades page showed Solana round trips whatever chain
// was active and pointed at the Wallet page for the rest — a page that
// changes meaning with the top-bar chain has to change content with it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ExternalLink, RefreshCw } from 'lucide-react';
import { EVM_CHAIN_META, type ChainKind, type EvmChainKind, type EvmFill, type EvmPortfolio } from '@shared/evm';
import { Card, Empty, IconButton, Section, Stat } from '../common';
import { cls } from '../../utils/format';

const fmtNative = (wei: string | null, decimals = 18, places = 6): string => {
  if (wei === null) return '—';
  const n = Number(BigInt(wei)) / 10 ** decimals;
  return `${n >= 0 ? '+' : ''}${n.toFixed(places)}`;
};

const fmtTokens = (raw: string | null, decimals: number | null): string => {
  if (raw === null || decimals === null) return '—';
  const n = Math.abs(Number(BigInt(raw)) / 10 ** decimals);
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 0 : 4 });
};

const ago = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};

export function EvmFillsSection({ chain, onOpenToken }: { chain: EvmChainKind; onOpenToken: (address: string, chain: ChainKind) => void }) {
  const meta = EVM_CHAIN_META[chain];
  const [fills, setFills] = useState<EvmFill[] | null>(null);
  const [portfolio, setPortfolio] = useState<EvmPortfolio | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [f, p] = await Promise.all([window.krypt.evm.fills(chain), window.krypt.evm.portfolio(chain)]);
      if (f.ok && f.data) setFills([...f.data].sort((a, b) => b.at - a.at));
      if (p.ok && p.data) setPortfolio(p.data);
    } finally {
      setLoading(false);
    }
  }, [chain]);

  useEffect(() => {
    setFills(null);
    setPortfolio(null);
    void load();
    // A fill on this chain lands here the moment the rail records it.
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'evmFill' && ev.fill.chain === chain) void load();
    });
    return off;
  }, [chain, load]);

  const totals = useMemo(() => {
    if (!fills) return null;
    const real = fills.filter((f) => f.state !== 'pending');
    const buys = real.filter((f) => f.side === 'buy').length;
    const sells = real.length - buys;
    return { buys, sells, pending: fills.length - real.length };
  }, [fills]);

  const sym = meta.nativeSymbol;
  return (
    <>
      <Section
        title={`${meta.name} fills`}
        description={`Every buy and sell this install made on ${meta.name}, read back from the chain. The ${sym} column is the wallet's net change for that transaction, gas included — negative means ${sym} left.`}
        actions={
          <IconButton onClick={() => void load()} title="Re-read fills" disabled={loading}>
            <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} />
          </IconButton>
        }
      >
        {portfolio && (
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Realised" value={portfolio.realizedPnlNative === null ? '—' : `${portfolio.realizedPnlNative >= 0 ? '+' : ''}${portfolio.realizedPnlNative.toFixed(6)} ${sym}`} tone={portfolio.realizedPnlNative === null ? undefined : portfolio.realizedPnlNative >= 0 ? 'good' : 'bad'} />
            <Stat label="Unrealised" value={portfolio.unrealizedPnlNative === null ? '—' : `${portfolio.unrealizedPnlNative >= 0 ? '+' : ''}${portfolio.unrealizedPnlNative.toFixed(6)} ${sym}`} />
            <Stat label="Gas paid" value={portfolio.gasPaidNative === null ? '—' : `${portfolio.gasPaidNative.toFixed(6)} ${sym}`} />
            <Stat label="Fees paid" value={portfolio.feesPaidNative === null ? '—' : `${portfolio.feesPaidNative.toFixed(6)} ${sym}`} />
          </div>
        )}
        <Card>
          {fills === null ? (
            <div className="px-3 py-6 text-center text-note text-krypt-muted">Reading the ledger…</div>
          ) : fills.length === 0 ? (
            <Empty title={`No ${meta.name} fills yet`} message={`Buys and sells made through Krypt on ${meta.name} are recorded here and reconciled against the chain.`} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-body">
                <thead className="text-krypt-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">When</th>
                    <th className="px-3 py-2 text-left font-medium">Side</th>
                    <th className="px-3 py-2 text-left font-medium">Token</th>
                    <th className="px-3 py-2 text-right font-medium">Asked</th>
                    <th className="px-3 py-2 text-right font-medium">Tokens</th>
                    <th className="px-3 py-2 text-right font-medium">{sym} net</th>
                    <th className="px-3 py-2 text-right font-medium">Fee</th>
                    <th className="px-3 py-2 text-left font-medium">Venue</th>
                    <th className="px-3 py-2 text-left font-medium">State</th>
                    <th className="px-3 py-2 text-left font-medium">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.map((f) => {
                    const delta = f.nativeDeltaWei === null ? null : Number(BigInt(f.nativeDeltaWei)) / 1e18;
                    return (
                      <tr key={f.id} className="border-t border-white/5">
                        <td className="px-3 py-1.5 font-mono text-krypt-muted" title={new Date(f.at).toLocaleString()}>{ago(f.at)} ago</td>
                        <td className="px-3 py-1.5">
                          <span className={cls('inline-flex items-center gap-1', f.side === 'buy' ? 'text-emerald-300' : 'text-rose-300')}>
                            {f.side === 'buy' ? <ArrowDownRight className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                            {f.side}
                          </span>
                        </td>
                        <td className="px-3 py-1.5">
                          <button onClick={() => onOpenToken(f.token, chain)} className="font-medium text-white/90 hover:text-white">
                            {f.symbol || `${f.token.slice(0, 8)}…`}
                          </button>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">{f.side === 'buy' ? `${f.requested} ${sym}` : `${f.requested}%`}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{fmtTokens(f.tokenDeltaRaw, f.decimals)}</td>
                        <td className={cls('px-3 py-1.5 text-right font-mono', delta !== null && delta < 0 ? 'text-rose-300' : delta !== null ? 'text-emerald-300' : '')}>
                          {fmtNative(f.nativeDeltaWei)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-krypt-muted">{f.feeWei === null ? '—' : (Number(BigInt(f.feeWei)) / 1e18).toFixed(6)}</td>
                        <td className="px-3 py-1.5 text-krypt-muted">{f.venue}</td>
                        <td className="px-3 py-1.5">
                          <span
                            className={cls(
                              'rounded-full border px-1.5 py-0.5 text-label',
                              f.state === 'reconciled'
                                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                                : f.state === 'pending'
                                  ? 'border-arc-gold/30 bg-arc-gold/10 text-arc-gold'
                                  : 'border-white/10 bg-white/5 text-krypt-muted',
                            )}
                            title={f.note ?? undefined}
                          >
                            {f.state}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-label text-krypt-muted">
                          <a href={`${meta.explorer}/tx/${f.hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-white">
                            {f.hash.slice(0, 10)}… <ExternalLink className="h-3 w-3" />
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {totals && (
          <p className="mt-2 text-label text-krypt-muted">
            {totals.buys} buy{totals.buys === 1 ? '' : 's'}, {totals.sells} sell{totals.sells === 1 ? '' : 's'}
            {totals.pending ? ` · ${totals.pending} still waiting for a receipt` : ''}. A pending or unreconciled fill counts toward nothing until the chain has answered for it.
          </p>
        )}
      </Section>
    </>
  );
}

