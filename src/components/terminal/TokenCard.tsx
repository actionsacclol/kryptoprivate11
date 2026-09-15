import { Globe, Send, Star, Twitter, Zap } from 'lucide-react';
import { memo } from 'react';
import { imageSrc, windowExceedsAge, type StatsWindow, type TokenSummary } from '@shared/market';
import { nativeSymbolOf } from '@shared/evm';
import { cls, fmtAge, fmtChange, fmtNum, fmtPctOrDash, fmtUsd, scoreTone, shortAddr, toneFor } from '../../utils/format';
import { ODDS_BUCKET_LABEL, oddsChipClass } from '../../utils/odds';

// One Discover row. This is the screen a memecoin trader actually scans, so
// the density is deliberate: everything in term.txt's token-card list that
// a provider can answer, in one 3-line block, with quick-buy on the right.
//
// The null discipline from the data layer carries all the way here. A metric
// nobody could answer renders as an em dash in muted grey — never as 0, and
// never omitted, because an omitted row silently changes what the card means.

function Metric({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 overflow-hidden" title={title}>
      <div className="text-micro uppercase tracking-label text-krypt-muted/60 leading-none truncate">{label}</div>
      <div className={cls('text-body font-mono font-medium mt-0.5 truncate', tone ?? 'text-white/90')}>{value}</div>
    </div>
  );
}

/** A 0..100 bar. Grey when the value is unknown rather than a full red bar. */
function PctBar({ pct, danger }: { pct: number | null; danger: number }) {
  if (pct === null) return <div className="h-1 rounded-full bg-white/5" />;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1 rounded-full bg-white/8 overflow-hidden">
      <div
        className={cls(
          'h-full rounded-full transition-all',
          pct >= danger ? 'bg-rose-400/80' : pct >= danger * 0.6 ? 'bg-arc-gold/80' : 'bg-emerald-400/70',
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/**
 * The measured-rule badges. A rose badge when a hide-severity rug rule
 * fired, an amber chip when a concentration note exists. Deliberately NO
 * green "safe" state: `rug === null` means not judged yet and renders
 * nothing, and a clear report also renders nothing — launches with no
 * flag were still ~77 % dead or dumped on the measured day.
 *
 * Between them sits the graduation-odds chip: the bucket label and the
 * observed graduation rate for that bucket ("about N in 100"), with the
 * full observed line + footer in the tooltip so the number never travels
 * without its n and base. `odds === null` draws nothing — not judged.
 */
function RuleBadges({ token, compact }: { token: TokenSummary; compact?: boolean }) {
  const hideFlag = token.rug?.hide ? token.rug.flags.find((f) => f.severity === 'hide') ?? null : null;
  const vol = token.volatility ?? [];
  const grad = token.odds?.graduate ?? null;
  if (!hideFlag && !grad && vol.length === 0) return null;
  return (
    <>
      {hideFlag && (
        <span
          title={hideFlag.detail}
          className={cls(
            'inline-flex items-center rounded border border-rose-400/40 bg-rose-500/15 font-semibold text-rose-300 truncate',
            compact ? 'px-1 text-nano max-w-[110px]' : 'px-1.5 py-px text-micro max-w-[160px]',
          )}
        >
          {hideFlag.label}
        </span>
      )}
      {grad && token.odds && (
        <span
          title={`${grad.line} ${token.odds.footer}`}
          className={cls(
            'inline-flex items-center rounded border font-semibold whitespace-nowrap',
            oddsChipClass(grad.bucket),
            compact ? 'px-1 text-nano' : 'px-1.5 py-px text-micro',
          )}
        >
          Grad · {ODDS_BUCKET_LABEL[grad.bucket]} · {Math.round(grad.observedPct)} in 100
        </span>
      )}
      {vol.length > 0 && (
        <span
          title={vol[0].detail}
          className={cls(
            'inline-flex items-center rounded border border-arc-gold/40 bg-arc-gold/10 font-semibold text-arc-gold',
            compact ? 'px-1 text-nano' : 'px-1.5 py-px text-micro',
          )}
        >
          volatile
        </span>
      )}
    </>
  );
}

const LAUNCHPAD_LABEL: Record<string, string> = {
  pumpfun: 'PUMP',
  bonk: 'BONK',
  moonshot: 'MOON',
  believe: 'BLV',
  boop: 'BOOP',
  raydium: 'RAY',
  meteora: 'MET',
  pons: 'PONS',
  robinhood: 'HOOD',
  fourmeme: '4MEME',
  bnb: 'BNB',
  unknown: '—',
};

/** A single inline metric for the row layout — label above, value below, fixed
 *  width so the columns line up down the list like a table. */
function Cell({ label, value, tone, title, className }: { label: string; value: string; tone?: string; title?: string; className?: string }) {
  return (
    <div className={cls('min-w-0 overflow-hidden text-right', className)} title={title}>
      <div className="text-nano uppercase tracking-label text-krypt-muted/50 leading-none truncate">{label}</div>
      <div className={cls('text-body font-mono font-medium mt-0.5 truncate', tone ?? 'text-white/90')}>{value}</div>
    </div>
  );
}

function TokenCardInner({
  token,
  window: win,
  onOpen,
  onQuickBuy,
  quickBuySol,
  watched,
  onToggleWatch,
  canQuickBuy,
  quickBuyHint,
  layout = 'card',
}: {
  token: TokenSummary;
  window: StatsWindow;
  onOpen: () => void;
  onQuickBuy: () => void;
  quickBuySol: number;
  watched: boolean;
  onToggleWatch: () => void;
  canQuickBuy: boolean;
  /** Why quick buy is disabled, when it is — the EVM chains have their own
   *  reasons (no EVM wallet, still reading it) that are not "arm live". */
  quickBuyHint?: string;
  /** 'card' = the dense 3-line block for the narrow columns. 'row' = a wide
   *  single-line DexScreener-style row, used when a column is expanded. */
  layout?: 'card' | 'row';
}) {
  const s = token.stats[win];
  // A token younger than the selected window has ONE set of trades, so its 5m
  // and 24h volume are the same number. That is correct, but it makes the
  // window buttons look inert on the New column — so say it instead.
  const youngerThanWindow = windowExceedsAge(token.createdAt, win);
  const buys = s?.buys ?? null;
  const sells = s?.sells ?? null;
  const change = s?.priceChangePct ?? null;
  // The quick-buy size is in the row's own native unit (SOL / ETH / BNB).
  const unit = nativeSymbolOf(token.chain ?? 'solana');

  const open = (url: string | null) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (url) void window.krypt.app.openExternal(url);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };

  const curveLabel =
    token.bondingCurvePct === null ? '—' : token.bondingCurvePct >= 100 ? 'DEX' : fmtPctOrDash(token.bondingCurvePct, 0);

  // ─── Row layout — one token per line, columns aligned like DexScreener ───
  if (layout === 'row') {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={onKey}
        className="group card rounded-lg pl-2.5 pr-2 py-2 cursor-pointer transition-colors focus:outline-none focus:!border-krypt-purple/50 flex items-center gap-3"
      >
        {/* Identity — icon + name, grows to fill */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="relative h-8 w-8 flex-shrink-0 rounded-md overflow-hidden border border-white/10 bg-black/40">
            {imageSrc(token.imageUrl) ? (
              <img src={imageSrc(token.imageUrl) as string} alt="" loading="lazy" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full flex items-center justify-center text-label font-display text-krypt-muted">
                {(token.symbol || '?').slice(0, 3)}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="font-semibold text-value text-white truncate">{token.symbol || shortAddr(token.mint)}</span>
              <span className="text-body text-krypt-muted truncate hidden sm:inline">{token.name}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-label font-mono text-krypt-muted/70">{fmtAge(token.createdAt)}</span>
              <span className="text-micro font-display tracking-label text-arc-gold/70">
                {LAUNCHPAD_LABEL[token.launchpad] ?? '—'}
              </span>
              {token.socials.twitter && (
                <button onClick={open(token.socials.twitter)} title="X / Twitter" className="text-krypt-muted/60 hover:text-krypt-purple">
                  <Twitter className="h-3 w-3" />
                </button>
              )}
              {token.socials.telegram && (
                <button onClick={open(token.socials.telegram)} title="Telegram" className="text-krypt-muted/60 hover:text-krypt-purple">
                  <Send className="h-3 w-3" />
                </button>
              )}
              {token.socials.website && (
                <button onClick={open(token.socials.website)} title="Website" className="text-krypt-muted/60 hover:text-krypt-purple">
                  <Globe className="h-3 w-3" />
                </button>
              )}
              <RuleBadges token={token} compact />
            </div>
          </div>
        </div>

        {/* Metric columns — fixed widths so they line up down the whole list */}
        <Cell className="w-16 hidden sm:block" label={win} value={fmtChange(change)} tone={toneFor(change)} />
        <Cell className="w-20" label="MC" value={fmtUsd(token.marketCapUsd)} title={`Source: ${token.sources.marketCap ?? 'none'}`} />
        <Cell className="w-20 hidden md:block" label="Liq" value={fmtUsd(token.liquidityUsd)} title={`Source: ${token.sources.liquidity ?? 'none'}`} />
        <Cell className="w-20" label={youngerThanWindow ? `Vol*` : 'Vol'} value={fmtUsd(s?.volumeUsd)} />
        <Cell
          className="w-16 hidden lg:block"
          label="B/S"
          value={buys === null && sells === null ? '—' : `${fmtNum(buys)}/${fmtNum(sells)}`}
          tone={buys !== null && sells !== null ? (buys > sells ? 'text-emerald-400' : 'text-rose-400') : undefined}
        />
        <Cell className="w-14 hidden lg:block" label="Hold" value={fmtNum(token.holders)} />
        <Cell className="w-14 hidden xl:block" label="Top10" value={fmtPctOrDash(token.top10Pct)} tone={token.top10Pct !== null && token.top10Pct >= 50 ? 'text-rose-400' : undefined} />
        <Cell className="w-14" label="Curve" value={curveLabel} />
        <Cell className="w-10" label="Score" value={token.kryptScore === null ? '—' : String(token.kryptScore)} tone={scoreTone(token.kryptScore)} />

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0 pl-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleWatch();
            }}
            title={watched ? 'Unwatch' : 'Watch'}
            className={cls('transition', watched ? 'text-arc-gold' : 'text-krypt-muted/40 hover:text-arc-gold/70')}
          >
            <Star className="h-3.5 w-3.5" fill={watched ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onQuickBuy();
            }}
            disabled={!canQuickBuy}
            title={canQuickBuy ? `Quick buy ${quickBuySol} ${unit}` : quickBuyHint ?? 'Arm live execution on the Wallet page to quick-buy'}
            className={cls(
              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-label font-semibold transition',
              canQuickBuy
                ? 'bg-krypt-purple/20 text-krypt-pink hover:bg-krypt-purple/30 border border-krypt-purple/30'
                : 'bg-white/5 text-krypt-muted/50 border border-white/10 cursor-not-allowed',
            )}
          >
            <Zap className="h-3 w-3" />
            {quickBuySol}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onKey}
      // `.card`, not `.plate`: a list item must not carry a 34px blur shadow and
      // an eight-gradient pseudo-element when 160 of them are on screen. The
      // hover glow is dropped for the same reason — it repaints the shadow.
      className="group card rounded-lg px-3 py-2.5 cursor-pointer transition-colors focus:outline-none focus:!border-krypt-purple/50"
    >
      {/* Row 1 — identity */}
      <div className="flex items-start gap-2.5">
        <div className="relative h-9 w-9 flex-shrink-0 rounded-md overflow-hidden border border-white/10 bg-black/40">
          {imageSrc(token.imageUrl) ? (
            <img
              src={imageSrc(token.imageUrl) as string}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-label font-display text-krypt-muted">
              {(token.symbol || '?').slice(0, 3)}
            </div>
          )}
          {token.liveTracked && (
            <span
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]"
              title="This app has its own live tape for this token"
            />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-semibold text-value text-white truncate">{token.symbol || shortAddr(token.mint)}</span>
            <span className="text-body text-krypt-muted truncate">{token.name}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-label font-mono text-krypt-muted/70">{fmtAge(token.createdAt)}</span>
            <span className="text-micro font-display tracking-label text-arc-gold/70">
              {LAUNCHPAD_LABEL[token.launchpad] ?? token.launchpad.toUpperCase()}
            </span>
            {token.socials.twitter && (
              <button onClick={open(token.socials.twitter)} title="X / Twitter" className="text-krypt-muted/60 hover:text-krypt-purple">
                <Twitter className="h-3 w-3" />
              </button>
            )}
            {token.socials.telegram && (
              <button onClick={open(token.socials.telegram)} title="Telegram" className="text-krypt-muted/60 hover:text-krypt-purple">
                <Send className="h-3 w-3" />
              </button>
            )}
            {token.socials.website && (
              <button onClick={open(token.socials.website)} title="Website" className="text-krypt-muted/60 hover:text-krypt-purple">
                <Globe className="h-3 w-3" />
              </button>
            )}
            {token.socials.dexPaid && (
              <span
                className="text-micro font-semibold text-krypt-muted/70"
                title="Creator paid for DexScreener enhanced info — descriptive, no measured edge"
              >
                DEX
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-1 empty:hidden">
            <RuleBadges token={token} />
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <span className={cls('text-value font-mono font-semibold', toneFor(change))}>{fmtChange(change)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleWatch();
              }}
              title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
              className={cls('transition', watched ? 'text-arc-gold' : 'text-krypt-muted/40 hover:text-arc-gold/70')}
            >
              <Star className="h-3.5 w-3.5" fill={watched ? 'currentColor' : 'none'} />
            </button>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onQuickBuy();
            }}
            disabled={!canQuickBuy}
            title={canQuickBuy ? `Buy ${quickBuySol} ${unit}` : quickBuyHint ?? 'Quick buy needs a funded wallet with live execution armed'}
            className={cls(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-label font-bold transition',
              canQuickBuy
                ? 'border-krypt-purple/45 bg-krypt-purple/15 text-white hover:bg-krypt-purple/30 hover:shadow-krypt-glow'
                : 'border-white/8 bg-white/5 text-krypt-muted/50 cursor-not-allowed',
            )}
          >
            <Zap className="h-3 w-3" />
            {quickBuySol}
          </button>
        </div>
      </div>

      {/* Row 2 — the numbers that gate a trade */}
      <div className="grid grid-cols-3 gap-x-2 gap-y-1.5 mt-2.5">
        <Metric label="MC" value={fmtUsd(token.marketCapUsd)} title={`Source: ${token.sources.marketCap ?? 'none'}`} />
        <Metric label="Liq" value={fmtUsd(token.liquidityUsd)} title={`Source: ${token.sources.liquidity ?? 'none'}`} />
        <Metric
          label={youngerThanWindow ? `Vol ${win}*` : `Vol ${win}`}
          value={fmtUsd(s?.volumeUsd)}
          title={
            youngerThanWindow
              ? `This token is younger than ${win}, so this is its whole life — every window shows the same number.`
              : undefined
          }
        />
        <Metric
          label={youngerThanWindow ? 'B/S*' : 'B/S'}
          value={buys === null && sells === null ? '—' : `${fmtNum(buys)}/${fmtNum(sells)}`}
          title={youngerThanWindow ? `Younger than ${win} — this is every trade it has had.` : undefined}
          tone={buys !== null && sells !== null ? (buys > sells ? 'text-emerald-400' : 'text-rose-400') : undefined}
        />
        <Metric label="Holders" value={fmtNum(token.holders)} title={`Source: ${token.sources.holders ?? 'none'}`} />
        <Metric
          label="Score"
          value={token.kryptScore === null ? '—' : String(token.kryptScore)}
          tone={scoreTone(token.kryptScore)}
          title={token.kryptScore === null ? 'Too few checks resolved to score honestly' : 'Krypt score (quick)'}
        />
      </div>

      {/* Row 3 — supply distribution + curve */}
      <div className="grid grid-cols-4 gap-x-2 gap-y-1 mt-2">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-micro uppercase tracking-label text-krypt-muted/60">Dev</span>
            <span className="text-label font-mono text-white/80">{fmtPctOrDash(token.devHoldingPct)}</span>
          </div>
          <PctBar pct={token.devHoldingPct} danger={10} />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-micro uppercase tracking-label text-krypt-muted/60">Top 10</span>
            <span className="text-label font-mono text-white/80">{fmtPctOrDash(token.top10Pct)}</span>
          </div>
          <PctBar pct={token.top10Pct} danger={50} />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-micro uppercase tracking-label text-krypt-muted/60">Bundle</span>
            <span className="text-label font-mono text-white/80">{fmtPctOrDash(token.bundledPct)}</span>
          </div>
          <PctBar pct={token.bundledPct} danger={20} />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-micro uppercase tracking-label text-krypt-muted/60 truncate">Curve</span>
            <span className="text-label font-mono text-white/80">
              {token.bondingCurvePct === null ? '—' : token.bondingCurvePct >= 100 ? 'DEX' : fmtPctOrDash(token.bondingCurvePct, 0)}
            </span>
          </div>
          {token.bondingCurvePct === null ? (
            <div className="h-1 rounded-full bg-white/5" />
          ) : (
            <div className="h-1 rounded-full bg-white/8 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-krypt-purple to-arc-gold transition-all"
                style={{ width: `${Math.max(0, Math.min(100, token.bondingCurvePct))}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoised, and compared BY VALUE.
 *
 * Discover re-renders whenever any column refreshes — four times per poll
 * cycle — and a refresh hands back brand-new row objects even when nothing
 * about a token changed. Reference equality would therefore never hit, so
 * every one of ~160 cards (63 DOM elements each, about 10,000 in total)
 * reconciled on every refresh. That is the jank.
 *
 * Only the fields this card actually draws are compared. Anything else moving
 * is invisible here, so re-rendering for it is pure cost.
 */
export const TokenCard = memo(TokenCardInner, (a, b) => {
  if (a.layout !== b.layout) return false;
  if (a.window !== b.window) return false;
  if (a.watched !== b.watched) return false;
  if (a.canQuickBuy !== b.canQuickBuy) return false;
  if (a.quickBuyHint !== b.quickBuyHint) return false;
  if (a.quickBuySol !== b.quickBuySol) return false;
  const x = a.token;
  const y = b.token;
  if (x === y) return true;
  if (
    x.mint !== y.mint ||
    x.symbol !== y.symbol ||
    x.name !== y.name ||
    x.imageUrl !== y.imageUrl ||
    x.priceUsd !== y.priceUsd ||
    x.marketCapUsd !== y.marketCapUsd ||
    x.liquidityUsd !== y.liquidityUsd ||
    x.holders !== y.holders ||
    x.kryptScore !== y.kryptScore ||
    x.bondingCurvePct !== y.bondingCurvePct ||
    x.top10Pct !== y.top10Pct ||
    x.devHoldingPct !== y.devHoldingPct ||
    x.bundledPct !== y.bundledPct ||
    x.sniperPct !== y.sniperPct ||
    x.createdAt !== y.createdAt ||
    x.launchpad !== y.launchpad ||
    x.socials.dexPaid !== y.socials.dexPaid ||
    x.socials.twitter !== y.socials.twitter ||
    // Measured badges: compare what is DRAWN (hide state, first hide label,
    // first volatility note), not the report object, which the batch lookup
    // rebuilds on every poll.
    (x.rug === null) !== (y.rug === null) ||
    x.rug?.hide !== y.rug?.hide ||
    x.rug?.flags.find((f) => f.severity === 'hide')?.id !== y.rug?.flags.find((f) => f.severity === 'hide')?.id ||
    (x.volatility?.length ?? 0) !== (y.volatility?.length ?? 0) ||
    x.volatility?.[0]?.id !== y.volatility?.[0]?.id ||
    // Odds chip: bucket, window (the +120 s re-judgement replaces the +60 s
    // one) and the rounded rate that is printed.
    (x.odds === null) !== (y.odds === null) ||
    x.odds?.graduate?.bucket !== y.odds?.graduate?.bucket ||
    x.odds?.windowS !== y.odds?.windowS ||
    x.odds?.graduate?.observedPct !== y.odds?.graduate?.observedPct
  ) {
    return false;
  }
  // The stats block for the SELECTED window is the rest of what is drawn.
  const sx = x.stats[a.window];
  const sy = y.stats[b.window];
  if (sx === sy) return true;
  if (!sx || !sy) return false;
  return (
    sx.volumeUsd === sy.volumeUsd &&
    sx.buys === sy.buys &&
    sx.sells === sy.sells &&
    sx.priceChangePct === sy.priceChangePct
  );
});
