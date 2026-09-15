import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, ExternalLink, Loader2, RefreshCw, Star } from 'lucide-react';
import { imageSrc, type CandleInterval, type CandleSeries } from '@shared/market';
import type { AppSettings } from '@shared/types';
import { EVM_CHAIN_META, explorerToken, VENUE_LABEL, type EvmChainKind, type EvmTokenDetail } from '@shared/evm';
import { KryptChart, type KryptChartHandle } from '../components/terminal/KryptChart';
import { EvmTradePanel } from '../components/terminal/EvmTradePanel';
import { EvmPositionPanel } from '../components/terminal/EvmPositionPanel';
import { useEvmState } from '../state/useEvmState';
import { useTerminal } from '../state/TerminalProvider';
import { useToast } from '../state/ToastProvider';
import { cls, fmtAge, fmtChange, fmtNum, fmtPctOrDash, fmtPriceUsd, fmtUsd, shortAddr, toneFor } from '../utils/format';
import { fmtNative, fmtPriceNative, weiToNumber } from '../utils/evm';
import { Stat } from '../components/common';

// The EVM token page — one page for Robinhood Chain and BNB Smart Chain,
// told which by `chain` (an 0x address alone cannot say). Deliberately
// smaller than the Solana one: the chart, the curve, the pools, the trade
// panel and your position. The Solana-only panels (odds, launch intel,
// holder map, orders, alerts) have no data on these chains yet and are not
// faked here.

const INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h'];

const BUCKET_SEC: Record<CandleInterval, number> = {
  '1s': 1,
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
};

/** What each launchpad's curve does, in the words the card uses. */
const CURVE_COPY: Record<EvmChainKind, { title: string; graduates: string; note: string }> = {
  robinhood: {
    title: 'Pons curve',
    graduates: 'Ready to graduate — the next buy sweeps it into a locked Uniswap v4 pool',
    note: 'A snipe tax starts at 99% of a buy and decays to zero within the first seconds after launch; the quote in the trade panel includes it. At 4.2 ETH the curve sweeps into a locked Uniswap v4 pool.',
  },
  bnb: {
    title: 'four.meme curve',
    graduates: 'Ready to graduate — the next buy pairs it on PancakeSwap v2',
    note: 'At 18 BNB the curve closes and the raised BNB pairs with the remaining tokens as a PancakeSwap v2 pair with permanent liquidity. Trades then route through PancakeSwap.',
  },
};

export function EvmTokenPage({ chain, address, onBack }: { chain: EvmChainKind; address: string; onBack: () => void }) {
  const toast = useToast();
  const meta = EVM_CHAIN_META[chain];
  const sym = meta.nativeSymbol;
  const { evm } = useEvmState(chain);
  // The provider tracks the open token (and its chain) the way Token.tsx
  // does for Solana; only functions are read into effects, never `term`
  // itself (its identity changes on every Discover poll).
  const term = useTerminal();
  const setOpenOnProvider = term.openToken;
  const watched = term.isWatched(address, chain);
  useEffect(() => {
    setOpenOnProvider(address, chain);
    return () => setOpenOnProvider(null);
  }, [address, chain, setOpenOnProvider]);
  const [detail, setDetail] = useState<EvmTokenDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [interval, setInterval_] = useState<CandleInterval>('1m');
  const [chartMode, setChartMode] = useState<'price' | 'mcap'>('mcap');
  const [series, setSeries] = useState<CandleSeries | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [posKey, setPosKey] = useState(0);
  const chartApiRef = useRef<KryptChartHandle>(null);
  const seriesRef = useRef<CandleSeries | null>(null);
  seriesRef.current = series;

  const loadDetail = useCallback(async () => {
    setLoading(true);
    const r = await window.krypt.evm.token(chain, address);
    if (r.ok && r.data) {
      setDetail(r.data);
      setError(null);
    } else if (!r.ok) {
      setError(r.message);
    }
    setLoading(false);
  }, [chain, address]);

  useEffect(() => {
    setDetail(null);
    setSeries(null);
    setError(null);
    void loadDetail();
    void window.krypt.settings.get().then((r) => {
      if (r.ok && r.data) setSettings(r.data);
    });
    const id = setInterval(() => {
      if (!document.hidden) void loadDetail();
    }, 8_000);
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'evmFill' && ev.fill.chain === chain && ev.fill.token.toLowerCase() === address.toLowerCase()) {
        void loadDetail();
        setPosKey((k) => k + 1);
      }
    });
    return () => {
      clearInterval(id);
      off();
    };
  }, [chain, address, loadDetail]);

  // Chart: one full load per chain+address+interval, then a 20 s tail merged
  // through the chart handle so the user's pan/zoom survives the poll.
  useEffect(() => {
    let cancelled = false;
    setChartLoading(true);
    setChartError(null);
    void window.krypt.evm.candles(chain, address, interval, 500).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data) setSeries(r.data);
      else if (!r.ok) setChartError(r.message);
      setChartLoading(false);
    });
    const id = setInterval(() => {
      if (document.hidden) return;
      void window.krypt.evm.candles(chain, address, interval, 60).then((r) => {
        if (cancelled || !r.ok || !r.data) return;
        const cur = seriesRef.current;
        if (!cur || cur.candles.length === 0) {
          setSeries(r.data);
          return;
        }
        chartApiRef.current?.appendCandles(r.data.candles.slice(-12));
      });
    }, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [chain, address, interval]);

  const s = detail?.summary ?? null;
  const st = detail?.state ?? null;
  const nativeUsd = s?.priceUsd && s.priceSol ? s.priceUsd / s.priceSol : evm?.nativeUsd ?? null;
  const change24 = s?.stats['24h']?.priceChangePct ?? null;

  const copyAddress = (): void => {
    void navigator.clipboard.writeText(address).then(
      () => toast.success('Address copied'),
      () => toast.error('Could not copy'),
    );
  };

  if (loading && !detail) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-krypt-purple" />
      </div>
    );
  }

  if (error && !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-rose-300">{error}</p>
        <button onClick={onBack} className="text-note text-krypt-muted hover:text-white underline underline-offset-2">
          Back to Discover
        </button>
      </div>
    );
  }

  const curve = st?.curve ?? null;
  const curveReal = curve ? weiToNumber(curve.realQuoteWei) : null;
  const curveThreshold = curve ? weiToNumber(curve.thresholdWei) : null;
  const copy = CURVE_COPY[chain];
  const isLaunchpad = s?.launchpad === meta.launchpad;
  const explorerName = chain === 'robinhood' ? 'Blockscout' : 'BscScan';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-4 pb-3 border-b border-white/8">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="h-8 w-8 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white transition"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <div className="h-10 w-10 rounded-md overflow-hidden border border-white/10 bg-black/40 flex-shrink-0">
            {imageSrc(s?.imageUrl) ? (
              <img src={imageSrc(s?.imageUrl) as string} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full flex items-center justify-center text-body font-display text-krypt-muted">
                {(s?.symbol || '?').slice(0, 3)}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-display text-xl font-semibold text-white truncate">{s?.symbol || shortAddr(address)}</h1>
              <span className="text-sm text-krypt-muted truncate max-w-[240px]">{s?.name}</span>
              <span className="rounded-full border border-arc-gold/30 bg-arc-gold/10 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-arc-gold/90">
                {isLaunchpad ? meta.launchpadLabel : meta.shortName}
              </span>
              <span
                className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-krypt-muted/70"
                title={`${meta.name}, chain id ${meta.id}`}
              >
                {meta.name}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <button onClick={copyAddress} className="flex items-center gap-1 text-body font-mono text-krypt-muted hover:text-white transition">
                {shortAddr(address, 6)}
                <Copy className="h-3 w-3" />
              </button>
              <button
                onClick={() => void window.krypt.app.openExternal(explorerToken(chain, address))}
                className="flex items-center gap-1 text-body text-krypt-muted hover:text-krypt-purple transition"
              >
                {explorerName}
                <ExternalLink className="h-3 w-3" />
              </button>
              <button
                onClick={() => void window.krypt.app.openExternal(`https://dexscreener.com/${meta.dexscreenerChain}/${address}`)}
                className="flex items-center gap-1 text-body text-krypt-muted hover:text-krypt-purple transition"
              >
                DexScreener
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-6">
            <Stat label="Price" value={fmtPriceUsd(s?.priceUsd)} />
            <Stat label={`In ${sym}`} value={fmtPriceNative(s?.priceSol, sym)} />
            <Stat label="Market cap" value={fmtUsd(s?.marketCapUsd)} />
            <Stat label="Liquidity" value={fmtUsd(s?.liquidityUsd)} />
            <Stat label="Holders" value={fmtNum(s?.holders)} />
            <Stat label="24h" value={fmtChange(change24)} tone={toneFor(change24)} />
            <Stat label="Age" value={fmtAge(s?.createdAt)} />
          </div>

          <button
            onClick={() => term.toggleWatch(address, chain)}
            title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
            className={cls(
              'h-8 w-8 rounded-lg border flex items-center justify-center transition',
              watched ? 'border-arc-gold/45 bg-arc-gold/15 text-arc-gold' : 'border-white/10 bg-white/5 text-krypt-muted hover:text-arc-gold',
            )}
          >
            <Star className="h-4 w-4" fill={watched ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => void loadDetail()}
            title="Refresh"
            className="h-8 w-8 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white transition"
          >
            <RefreshCw className={cls('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>

        {detail?.warnings.length ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {detail.warnings.map((w) => (
              <span key={w} className="rounded border border-arc-gold/25 bg-arc-gold/10 px-2 py-0.5 text-label text-arc-gold/90">
                {w}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 p-4 overflow-hidden">
        <div className="min-w-0 flex flex-col gap-4 overflow-y-auto pr-1">
          {/* Curve */}
          {curve && (
            <div className="plate rounded-lg p-3">
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-display text-label font-semibold uppercase tracking-heading text-krypt-muted whitespace-nowrap">{copy.title}</h3>
                <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
                <span className="text-label font-mono text-white/80">
                  {curve.graduated ? 'Graduated' : `${fmtPctOrDash(curve.progressPct, 1)} to graduation`}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-krypt-purple to-arc-gold transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, curve.progressPct))}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-body text-krypt-muted">
                <span>
                  In the curve{' '}
                  <span className="font-mono text-white/85">
                    {curve.isNativeQuote ? fmtNative(curveReal, sym, 3) : curveReal === null ? '—' : `${curveReal.toFixed(2)} pair units`}
                  </span>{' '}
                  of{' '}
                  <span className="font-mono text-white/85">
                    {curve.isNativeQuote ? fmtNative(curveThreshold, sym, 1) : curveThreshold === null ? '—' : `${curveThreshold.toFixed(1)} pair units`}
                  </span>
                </span>
                <span>
                  Fee per fill{' '}
                  <span className="font-mono text-white/85">
                    {(curve.feeBps / 100).toFixed(1)}%
                    {curve.creatorTaxBps > 0 ? ` + ${(curve.creatorTaxBps / 100).toFixed(1)}% creator tax` : ''}
                  </span>
                </span>
                {!curve.isNativeQuote && <span className="text-arc-gold/80">Paired with {shortAddr(curve.pairToken, 4)}, not {sym}</span>}
                {curve.readyToGraduate && !curve.graduated && <span className="text-emerald-300">{copy.graduates}</span>}
              </div>
              <p className="mt-1.5 text-label text-krypt-muted/60 leading-relaxed">{copy.note}</p>
            </div>
          )}

          {/* Chart */}
          <div className="plate rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
                {INTERVALS.map((iv) => (
                  <button
                    key={iv}
                    onClick={() => setInterval_(iv)}
                    className={cls(
                      'px-2 py-1 text-label font-mono font-semibold transition',
                      interval === iv ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white hover:bg-white/5',
                    )}
                  >
                    {iv}
                  </button>
                ))}
              </div>
              <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
                {(['mcap', 'price'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setChartMode(m)}
                    className={cls(
                      'px-2.5 py-1 text-label font-semibold uppercase tracking-wider transition',
                      chartMode === m ? 'bg-arc-gold/20 text-arc-gold' : 'text-krypt-muted hover:text-white hover:bg-white/5',
                    )}
                  >
                    {m === 'mcap' ? 'MC' : 'Price'}
                  </button>
                ))}
              </div>
              {chartLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-krypt-purple" />}
              <div className="flex-1" />
              {series && <span className="text-label text-krypt-muted/60 uppercase tracking-label">via {series.source}</span>}
            </div>

            {series && series.candles.length > 0 ? (
              <KryptChart
                ref={chartApiRef}
                candles={series.candles}
                mode={chartMode}
                supply={series.supplyForMcap}
                bucketSec={BUCKET_SEC[series.effectiveInterval ?? interval]}
                height={360}
              />
            ) : (
              <div className="h-[360px] flex items-center justify-center rounded-md border border-dashed border-white/10">
                <p className="max-w-md text-center text-note text-krypt-muted leading-relaxed px-6">
                  {series?.note ?? chartError ?? (chartLoading ? 'Loading candles…' : 'No chart data for this token yet.')}
                </p>
              </div>
            )}
            {series?.note && series.candles.length > 0 && <p className="text-label text-krypt-muted/60 mt-2 leading-relaxed">{series.note}</p>}
          </div>

          {/* Route + pools */}
          <div className="plate rounded-lg p-3">
            <div className="flex items-center gap-3 mb-2">
              <h3 className="font-display text-label font-semibold uppercase tracking-heading text-krypt-muted whitespace-nowrap">Where it trades</h3>
              <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
              <span className="text-label font-mono text-white/80">{st ? VENUE_LABEL[st.venue] : '—'}</span>
            </div>
            {detail && detail.pools.length > 0 ? (
              <div className="space-y-1">
                {detail.pools.slice(0, 6).map((p) => (
                  <div key={p.address} className="flex items-center gap-2 text-body">
                    <span className="text-krypt-muted uppercase text-micro tracking-wider w-24 truncate">{p.dexId}</span>
                    <span className="font-mono text-white/80 truncate flex-1">{p.label}</span>
                    <span className="font-mono text-krypt-muted/70 hidden md:inline">{shortAddr(p.address, 4)}</span>
                    <span className="font-mono text-krypt-muted">{fmtUsd(p.liquidityUsd)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-body text-krypt-muted">No pool listed by any provider yet.</p>
            )}
            {st?.launch && (
              <p className="mt-2 text-label text-krypt-muted/60 font-mono">
                {/* Unknown deployer is an em dash, never the zero address — that
                    reads as "renounced". `phase` is Pons vocabulary, so BNB
                    says where the token actually is instead. */}
                Deployer {st.launch.deployer ? shortAddr(st.launch.deployer, 6) : '—'}
                {chain === 'bnb' ? ` · ${st.venue === 'fourmeme-curve' ? 'on the curve' : 'graduated'}` : ` · phase ${st.launch.phase}`}
                {detail?.holders?.top10Pct !== null && detail?.holders?.top10Pct !== undefined ? ` · top 10 hold ${fmtPctOrDash(detail.holders.top10Pct)}` : ''}
              </p>
            )}
          </div>
        </div>

        {/* Right rail */}
        <div className="min-w-0 overflow-y-auto">
          <div className="plate rounded-lg p-3">
            {s && settings ? (
              <EvmTradePanel
                chain={chain}
                address={address}
                symbol={s.symbol}
                decimals={st?.decimals ?? s.decimals}
                state={st}
                settings={settings}
                nativeUsd={nativeUsd}
                onTraded={() => {
                  void loadDetail();
                  setPosKey((k) => k + 1);
                }}
              />
            ) : (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-krypt-purple" />
              </div>
            )}
          </div>

          {s && (
            <EvmPositionPanel
              chain={chain}
              address={address}
              nativeUsd={nativeUsd}
              armed={evm?.live.armed === true}
              refreshKey={posKey}
              onTraded={() => {
                void loadDetail();
                setPosKey((k) => k + 1);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
