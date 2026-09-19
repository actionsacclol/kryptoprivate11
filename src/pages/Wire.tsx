// The Wire — the information hub.
//
// Two panels, both of which exist because nobody else shows them:
//
//   RAILS — the state of the things a trade depends on. It answers the
//   question people ask at the worst possible moment: did that fail because
//   of me, or because of them? Assembled entirely from telemetry the app
//   already keeps, so opening this page polls nothing new.
//
//   PAID PLACEMENT — who is paying DexScreener to promote a coin, and how
//   much. Public, keyless, and unlabelled everywhere else.
//
// There is no headline feed, deliberately. shared/wire.ts carries the full
// reasoning; the short version is that no leading terminal ships one, macro
// headlines do not move sub-$1M memecoins, and the outlets' own terms forbid
// exactly this use.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, HelpCircle, Megaphone, RefreshCw, XCircle } from 'lucide-react';
import type { ProviderStatus } from '@shared/market';
import {
  engineRail,
  providerRails,
  worstState,
  hubChainLabel,
  type BoostedToken,
  type RailRow,
  type RailState,
  type TokenProfile,
} from '@shared/wire';
import type { ChainKind } from '@shared/evm';
import { Card, Page, Section } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import { cls, fmtAgo, shortAddr } from '../utils/format';

const TONE: Record<RailState, { cn: string; Icon: typeof CheckCircle2 }> = {
  ok: { cn: 'text-emerald-300', Icon: CheckCircle2 },
  degraded: { cn: 'text-amber-300', Icon: AlertTriangle },
  down: { cn: 'text-rose-300', Icon: XCircle },
  unknown: { cn: 'text-krypt-muted', Icon: HelpCircle },
};

function Rail({ row }: { row: RailRow }) {
  const { cn, Icon } = TONE[row.state];
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
      <Icon className={cls('mt-0.5 h-4 w-4 shrink-0', cn)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-body text-white/90">{row.label}</span>
          {/* The host, verbatim — the same string the privacy panel shows. */}
          <span className="truncate text-nano font-mono text-krypt-muted/70">{row.source}</span>
          <span className="ml-auto shrink-0 text-nano text-krypt-muted/60">
            {row.at ? fmtAgo(row.at) : '—'}
          </span>
        </div>
        <div className="mt-0.5 text-nano leading-snug text-krypt-muted">{row.detail}</div>
      </div>
    </div>
  );
}

function Boost({
  row,
  onOpen,
}: {
  row: BoostedToken;
  onOpen: (mint: string, chain: ChainKind) => void;
}) {
  // Robinhood Chain is not indexed by DexScreener, so anything here is one of
  // the two it does cover.
  const chain: ChainKind = row.chainId === 'bsc' ? 'bnb' : 'solana';
  const x = row.links.find((l) => (l.type ?? '').toLowerCase() === 'twitter');
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onOpen(row.tokenAddress, chain)}
          className="truncate font-mono text-body text-white/90 transition hover:text-krypt-purple"
        >
          {shortAddr(row.tokenAddress, 5)}
        </button>
        <span className="shrink-0 rounded border border-white/10 bg-black/30 px-1 py-px text-nano font-mono text-krypt-muted">
          {hubChainLabel(row.chainId)}
        </span>
        {/* The number, stated plainly and at the same weight as the coin. */}
        <span className="ml-auto shrink-0 text-nano font-mono text-amber-300">
          {row.totalAmount === null ? '—' : `${row.totalAmount.toLocaleString()} boosts`}
          {row.amount !== null && row.amount !== row.totalAmount ? ` (+${row.amount})` : ''}
        </span>
      </div>
      {row.description && (
        <div className="mt-1 line-clamp-2 text-nano leading-snug text-krypt-muted">{row.description}</div>
      )}
      <div className="mt-1 flex items-center gap-2 text-nano text-krypt-muted/70">
        <span>paid promotion on dexscreener.com</span>
        {x && (
          <button
            type="button"
            onClick={() => void window.krypt.app.openExternal(x.url)}
            className="inline-flex items-center gap-1 transition hover:text-white/80"
          >
            X <ExternalLink className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export function WirePage({ onOpenToken }: { onOpenToken: (mint: string, chain: ChainKind) => void }) {
  const { status, settings } = useAppState();
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [boosts, setBoosts] = useState<BoostedToken[] | null>(null);
  const [profiles, setProfiles] = useState<TokenProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const [p, b, pr] = await Promise.all([
      window.krypt.market.providers().catch(() => null),
      window.krypt.wire.boosts().catch(() => null),
      window.krypt.wire.profiles().catch(() => null),
    ]);
    if (p && p.ok && p.data) setProviders(p.data);
    if (b && b.ok && b.data) {
      setBoosts(b.data);
      setError(null);
    } else {
      setError(b && !b.ok ? b.message : 'DexScreener is not answering right now');
    }
    if (pr && pr.ok && pr.data) setProfiles(pr.data);
    setAt(Date.now());
    setBusy(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rails = useMemo(() => {
    const rows: RailRow[] = [engineRail(status ?? null, null, at)];
    if (providers) rows.push(...providerRails(providers, at));
    return rows;
  }, [status, providers, at]);

  const overall = worstState(rails);
  // Fresh profiles that are NOT boosted: the two lists overlap heavily, and a
  // coin already named above does not need naming twice.
  const boosted = new Set((boosts ?? []).map((b) => b.tokenAddress));
  const fresh = (profiles ?? []).filter((p) => !boosted.has(p.tokenAddress)).slice(0, 12);

  return (
    <Page
      title="Wire"
      subtitle="The state of the rails you trade on, and who is paying for placement. No headlines — see below."
    >
      <Section
        title="Rails"
        description="What a trade depends on, right now. Worst first. Nothing here is polled for this page — it is the telemetry the app already keeps."
      >
        <Card className="space-y-1.5">
          <div className="flex items-center gap-2 pb-1">
            <span className={cls('text-body font-semibold', TONE[overall].cn)}>
              {overall === 'ok'
                ? 'Everything the app can see is working'
                : overall === 'degraded'
                  ? 'Working, but something is degraded'
                  : overall === 'down'
                    ? 'Something a trade depends on is down'
                    : 'Not enough has been read to say'}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              title="Re-read"
              className="ml-auto rounded p-1 text-krypt-muted transition hover:bg-white/10 hover:text-white/90"
            >
              <RefreshCw className={cls('h-3 w-3', busy && 'animate-spin')} />
            </button>
          </div>
          {rails.map((r) => (
            <Rail key={r.id} row={r} />
          ))}
          {!settings.data.networkDataEnabled && (
            <p className="pt-1 text-nano text-amber-300/90">
              Network data is switched off in Settings, so most providers above will read as never called.
            </p>
          )}
        </Card>
      </Section>

      <Section
        title="Paid placement"
        description="Coins someone is paying DexScreener to promote, biggest spend first. Boosts are reported at roughly $3,999 per 24 hours. This is a fact about the listing, not a judgement about the coin."
      >
        <Card className="space-y-1.5">
          {error && !boosts && (
            <p className="rounded-md border border-amber-400/25 bg-amber-500/[0.06] px-2.5 py-2 text-body text-amber-200/90">
              {error}
            </p>
          )}
          {boosts && boosts.length === 0 && (
            <p className="py-3 text-center text-body text-krypt-muted">
              Nobody is paying for placement on your chains right now.
            </p>
          )}
          {(boosts ?? []).slice(0, 15).map((b) => (
            <Boost key={`${b.chainId}:${b.tokenAddress}`} row={b} onOpen={onOpenToken} />
          ))}
          <p className="pt-1 text-nano leading-relaxed text-krypt-muted/70">
            Source: dexscreener.com, read {at ? fmtAgo(at) : '—'}. Krypt does not sell placement and takes
            nothing for showing these.
          </p>
        </Card>
      </Section>

      {fresh.length > 0 && (
        <Section
          title="Newly filled profiles"
          description="Coins whose team has just added socials and a description on DexScreener. Filling a profile costs money too — it says someone is putting effort in, and nothing about whether the coin is good."
        >
          <Card className="space-y-1.5">
            {fresh.map((p) => (
              <div key={`${p.chainId}:${p.tokenAddress}`} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <button
                  type="button"
                  onClick={() => onOpenToken(p.tokenAddress, p.chainId === 'bsc' ? 'bnb' : 'solana')}
                  className="truncate font-mono text-body text-white/90 transition hover:text-krypt-purple"
                >
                  {shortAddr(p.tokenAddress, 5)}
                </button>
                <span className="shrink-0 rounded border border-white/10 bg-black/30 px-1 py-px text-nano font-mono text-krypt-muted">
                  {hubChainLabel(p.chainId)}
                </span>
                {p.cto && (
                  <span className="shrink-0 rounded border border-amber-400/25 bg-amber-500/10 px-1 py-px text-nano text-amber-300">
                    community takeover
                  </span>
                )}
                <span className="ml-auto shrink-0 text-nano text-krypt-muted/70">
                  {p.links.length} link{p.links.length === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </Card>
        </Section>
      )}

      <Section title="Why there are no headlines here">
        <Card>
          <div className="space-y-2 text-body leading-relaxed text-krypt-muted">
            <p>
              <Megaphone className="mr-1.5 -mt-0.5 inline h-3.5 w-3.5 text-krypt-muted/70" />
              No major terminal ships a crypto news feed, and there is no evidence that macro headlines move
              coins this size — the research points the other way. The news that matters to a memecoin is
              local to that coin: the dev moved, liquidity changed, someone called it.
            </p>
            <p>
              The outlets&rsquo; own terms also forbid it. The Block&rsquo;s say their feed may not be used
              &ldquo;in any application other than an RSS feed reader&rdquo;; CoinDesk&rsquo;s are
              non-commercial only. Shipping a headline wall would mean taking a licensing risk to build the
              panel you would ignore first.
            </p>
            <p className="text-krypt-muted/70">
              What replaces it: the callouts rail on the right of every page, and the per-coin intel on each
              token page.
            </p>
          </div>
        </Card>
      </Section>
    </Page>
  );
}
