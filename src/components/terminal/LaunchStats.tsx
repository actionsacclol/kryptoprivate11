// My launches, and how they are doing.
//
// The list of what this install launched lives in the renderer: the chain is
// the truth and this is the map to it. Market cap, holders and price are read
// per coin through the ordinary market layer; the creator vault is read per
// creator WALLET, because pump pays every coin that wallet launched into one
// account (pumpFees.ts).
//
// House rule, and it matters more here than almost anywhere: a number that was
// not read is null and renders as an em dash. A creator being told they have
// no holders because an RPC hiccuped is the failure worth avoiding — this is
// a page about someone's own work.

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { Card, GhostButton, Empty } from '../common';
import { cls, fmtUsd } from '../../utils/format';

/** One launch, as the Launch page remembers it. */
export interface LaunchAttemptRow {
  at: number;
  chain: string;
  symbol: string;
  token: string | null;
  hash: string | null;
  outcome: string;
}

type Coin = {
  mint: string;
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
};

type Stats = {
  coins: Coin[];
  creatorWallet: string | null;
  feesLamports: number | null;
  claimableLamports: number | null;
  feesFailure: string | null;
};

/** An unread number is an em dash, never a zero. */
const dash = '—';
const num = (n: number | null): string => (n === null ? dash : n.toLocaleString());
const usd = (n: number | null): string => (n === null ? dash : fmtUsd(n));
const sol = (lamports: number | null): string => (lamports === null ? dash : `${(lamports / 1e9).toFixed(4)} SOL`);

export function LaunchStats({ attempts }: { attempts: LaunchAttemptRow[] }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);

  // Only launches that produced a token can be looked up. One that timed out
  // without a mint is still shown in the list, it just has nothing to read.
  const mints = [...new Set(attempts.map((a) => a.token).filter((t): t is string => !!t))];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.krypt.launch.stats(mints);
      if (r.ok && r.data) setStats(r.data);
    } finally {
      setLoading(false);
    }
    // `mints` is derived from `attempts` each render; depending on its joined
    // form keeps this from re-firing on every render with the same set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mints.join(',')]);

  useEffect(() => {
    void load();
  }, [load]);

  if (attempts.length === 0) {
    return <Empty title="No launches yet" message="Coins you launch from here will be listed with how they are doing." />;
  }

  const landed = attempts.filter((a) => a.token).length;
  const totalMcap = stats?.coins.reduce<number | null>(
    (acc, c) => (c.marketCapUsd === null ? acc : (acc ?? 0) + c.marketCapUsd),
    null,
  ) ?? null;
  const totalHolders = stats?.coins.reduce<number | null>(
    (acc, c) => (c.holders === null ? acc : (acc ?? 0) + c.holders),
    null,
  ) ?? null;

  return (
    <div className="space-y-3">
      {/* The totals. Each is null unless at least one coin answered, so a
          provider being down reads as unknown rather than as zero. */}
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Launched" value={String(attempts.length)} />
          <Stat label="On chain" value={String(landed)} hint={landed < attempts.length ? `${attempts.length - landed} never landed` : undefined} />
          <Stat label="Combined mcap" value={usd(totalMcap)} />
          <Stat label="Holders" value={num(totalHolders)} />
          <Stat label="Creator fees" value={sol(stats?.feesLamports ?? null)} hint={stats?.claimableLamports !== null && stats?.claimableLamports !== undefined ? `${(stats.claimableLamports / 1e9).toFixed(4)} claimable` : undefined} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <GhostButton onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </GhostButton>
          <p className="text-label leading-relaxed text-krypt-muted/70">
            {stats?.feesFailure
              ? `Creator fees could not be read: ${stats.feesFailure}`
              : 'Fees are per launch wallet — every coin it launched pays into one vault. Claim them on the Launch tab.'}
          </p>
        </div>
      </Card>

      {/* One row per launch, newest first, with what the chain says. */}
      <Card className="space-y-1.5">
        {attempts.map((a) => {
          const coin = a.token ? stats?.coins.find((c) => c.mint === a.token) ?? null : null;
          return (
            <div
              key={`${a.at}-${a.hash ?? a.token ?? ''}`}
              className={cls(
                'rounded-lg border px-3 py-2',
                a.token ? 'border-white/10 bg-white/[0.02]' : 'border-arc-gold/25 bg-arc-gold/[0.06]',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-value font-semibold text-white">
                  {coin?.symbol || a.symbol || '(no symbol)'}
                </span>
                {coin?.name && <span className="truncate text-body text-krypt-muted">{coin.name}</span>}
                <span className="text-label text-krypt-muted/70">{a.chain}</span>
                <span className="text-label text-krypt-muted/70">{new Date(a.at).toLocaleString()}</span>
                <div className="flex-1" />
                {a.token && (
                  <a
                    href={`https://pump.fun/coin/${a.token}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-label text-krypt-purple hover:underline"
                  >
                    open <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>

              {a.token ? (
                <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat small label="Market cap" value={usd(coin?.marketCapUsd ?? null)} />
                  <Stat small label="Holders" value={num(coin?.holders ?? null)} />
                  <Stat small label="Liquidity" value={usd(coin?.liquidityUsd ?? null)} />
                  <Stat small label="Price" value={coin?.priceUsd === null || coin?.priceUsd === undefined ? dash : `$${coin.priceUsd.toPrecision(3)}`} />
                </div>
              ) : (
                <p className="mt-1 text-body text-arc-gold/90">
                  {a.outcome} — no token address, so there is nothing to read. Look the transaction up before launching
                  the same coin again.
                </p>
              )}

              {a.token && <div className="mt-1 select-all break-all font-mono text-label text-krypt-muted/70">{a.token}</div>}
              {a.hash && <div className="select-all break-all font-mono text-label text-krypt-muted/70">tx {a.hash}</div>}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function Stat({ label, value, hint, small }: { label: string; value: string; hint?: string; small?: boolean }) {
  return (
    <div>
      <div className={cls('uppercase tracking-wide text-krypt-muted', small ? 'text-label' : 'text-label')}>{label}</div>
      <div className={cls('font-mono text-white', small ? 'text-body' : 'text-note')}>{value}</div>
      {hint && <div className="text-label text-krypt-muted/70">{hint}</div>}
    </div>
  );
}
