import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { EVM_CHAIN_META, type ChainKind, type EvmChainKind, type EvmPortfolio } from '@shared/evm';
import { Card, Section } from '../common';
import { cls, fmtNum, fmtUsd, shortAddr, toneFor } from '../../utils/format';
import { fmtNative, fmtNativeSigned, fmtTokens } from '../../utils/evm';

// A compact per-chain EVM strip on the Portfolio page (one per enabled EVM
// chain). Renders nothing at all when this install has no EVM wallet, so
// the Solana-only user never sees an empty card for a chain they do not use.

export function EvmPortfolioCard({ chain, onOpenToken }: { chain: EvmChainKind; onOpenToken: (address: string, chain: ChainKind) => void }) {
  const meta = EVM_CHAIN_META[chain];
  const sym = meta.nativeSymbol;
  const [data, setData] = useState<EvmPortfolio | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.krypt.evm.portfolio(chain);
      if (r.ok && r.data && r.data.chain === chain) setData(r.data);
    } finally {
      setLoading(false);
    }
  }, [chain]);

  useEffect(() => {
    setData(null);
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    const off = window.krypt.engine.onEvent((ev) => {
      if ((ev.kind === 'evmFill' && ev.fill.chain === chain) || (ev.kind === 'evmState' && ev.state.chain === chain)) void load();
    });
    return () => {
      clearInterval(id);
      off();
    };
  }, [load, chain]);

  if (!data || data.address === null) return null;

  const usd = (v: number | null): string => (v === null || data.nativeUsd === null ? '' : ` (${fmtUsd(v * data.nativeUsd)})`);

  return (
    <Section
      title={meta.name}
      description={`Wallet ${shortAddr(data.address, 6)} — positions priced spot × amount, cost basis from this install's ledger.`}
      actions={
        <button
          onClick={() => void load()}
          className="h-8 w-8 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white transition"
          title="Refresh"
        >
          <RefreshCw className={cls('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      }
    >
      <Card className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div>
            <div className="text-micro uppercase tracking-label text-krypt-muted/70">{sym} balance</div>
            <div className="text-base font-mono font-semibold text-white mt-0.5">
              {fmtNative(data.nativeBalance, sym)}
              <span className="text-label text-krypt-muted/70">{usd(data.nativeBalance)}</span>
            </div>
          </div>
          <div>
            <div className="text-micro uppercase tracking-label text-krypt-muted/70">Positions</div>
            <div className="text-base font-mono font-semibold text-white mt-0.5">{data.positions.length}</div>
          </div>
          <div>
            <div className="text-micro uppercase tracking-label text-krypt-muted/70">Unrealized</div>
            <div className={cls('text-base font-mono font-semibold mt-0.5', toneFor(data.unrealizedPnlNative))}>{fmtNativeSigned(data.unrealizedPnlNative, sym)}</div>
          </div>
          <div>
            <div className="text-micro uppercase tracking-label text-krypt-muted/70">Realized</div>
            <div className={cls('text-base font-mono font-semibold mt-0.5', toneFor(data.realizedPnlNative))}>{fmtNativeSigned(data.realizedPnlNative, sym)}</div>
          </div>
          <div>
            <div className="text-micro uppercase tracking-label text-krypt-muted/70">Gas + fees paid</div>
            <div className="text-base font-mono font-semibold text-white mt-0.5">
              {/* Both halves are computed independently, so either can be
                  unknown on its own. Dashing only when BOTH are null printed a
                  definite-looking total with the unknown half silently counted
                  as zero — a sum is only a fact when every term is one. */}
              {data.gasPaidNative === null || data.feesPaidNative === null ? '—' : fmtNative(data.gasPaidNative + data.feesPaidNative, sym)}
            </div>
          </div>
        </div>

        {data.unreconciled > 0 && (
          <p className="text-body text-arc-gold/85">
            {data.unreconciled} of {data.fills} fill(s) could not be read from the chain yet — their cost is left out, not guessed.
          </p>
        )}

        {data.positions.length > 0 && (
          <div className="space-y-1">
            {data.positions.map((p) => (
              <button
                key={p.token}
                onClick={() => onOpenToken(p.token, chain)}
                className="w-full flex items-center gap-3 rounded-md px-2 py-1.5 text-body text-left hover:bg-white/[0.04] transition"
              >
                <span className="font-semibold text-white/90 w-24 truncate">{p.symbol || shortAddr(p.token, 4)}</span>
                <span className="font-mono text-krypt-muted w-24 text-right">{fmtTokens(p.amount)}</span>
                <span className="font-mono text-white/85 w-28 text-right">{fmtNative(p.valueNative, sym)}</span>
                <span className={cls('font-mono w-28 text-right', toneFor(p.unrealizedPnlNative))}>
                  {p.unrealizedPnlNative === null
                    ? '—'
                    : `${fmtNativeSigned(p.unrealizedPnlNative, sym)}${p.unrealizedPnlPct === null ? '' : ` · ${p.unrealizedPnlPct >= 0 ? '+' : ''}${fmtNum(p.unrealizedPnlPct, 1)}%`}`}
                </span>
                <span className="flex-1 text-right text-micro uppercase tracking-wider text-krypt-muted/60">{p.basisKnown ? '' : 'no basis'}</span>
              </button>
            ))}
          </div>
        )}
      </Card>
    </Section>
  );
}
