// The wallet drawer — everything the Scout actually knows about one wallet,
// and the Copy score with its checks laid out (2026-09-20).
//
// The board's row is a summary; this is the record behind it: how a follower
// would have done, trip by trip, with the lag and the costs stated, next to
// what the wallet itself made. The score's checks are shown as measured
// figures with the points each earned, so a number on the board is never a
// number nobody can explain. Same shared functions as the board
// (`summarise`, `scoreOfRow`), so the drawer cannot disagree with the row.
//
// Honest-null throughout: every unmeasured figure is an em dash, and the
// footer says what the model does not capture (slippage, partial exits).

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bookmark, BookmarkCheck, Copy, Loader2, X } from 'lucide-react';
import { EVM_CHAIN_META } from '@shared/evm';
import {
  MIN_TRIPS_FOR_RANK,
  SCOUT_WINDOW_DAYS,
  SCOUT_WINDOW_LABEL,
  dayOf,
  scoreOfRow,
  summarise,
  type ScoutChain,
  type ScoutRow,
  type ScoutTrip,
  type ScoutWallet,
  type ScoutWindow,
} from '@shared/walletScout';
import { FOLLOWER_COST_PER_SIDE, FOLLOWER_LAG_MS, scoreTone, type WalletCheck, type WalletFlag } from '@shared/walletScore';
import { cls, fmtAgo } from '../utils/format';

const UNIT: Record<ScoutChain, string> = { solana: 'SOL', robinhood: EVM_CHAIN_META.robinhood.nativeSymbol, bnb: EVM_CHAIN_META.bnb.nativeSymbol };

const pct = (v: number | null, digits = 1): string => (v === null ? '—' : `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(digits)}%`);
const amt = (v: number): string => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 1 : 4)}`;
const hold = (ms: number | null): string => {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};

export const FLAG_TEXT: Record<WalletFlag, { label: string; title: string }> = {
  bot: { label: 'bot', title: 'Holds for seconds and trades constantly. A bot wins on latency you do not have — copying one is not the same trade.' },
  thin: { label: 'thin', title: `Fewer than ${MIN_TRIPS_FOR_RANK} closed round trips in this window — too small a sample to score.` },
  unreachable: { label: 'unreachable', title: 'Under a quarter of this wallet\'s trips could have been copied at all: the leader was out before a follower could fill, or nothing printed to fill at.' },
  concentrated: { label: 'concentrated', title: 'Most trips are on the same few coins. That is a relationship with those coins, not a knack for picking the next one.' },
  partial: { label: 'partial', title: 'The copy figures come from fewer than half of this wallet\'s trips in the window — the rest happened before the copy model was recording. The score stands on the slice it measured.' },
};

function ScoreRing({ score }: { score: number | null }) {
  const tone = scoreTone(score);
  const color = tone === 'good' ? '#34d399' : tone === 'mid' ? '#fbbf24' : tone === 'bad' ? '#fb7185' : 'rgba(240,237,226,0.25)';
  const r = 26;
  const c = 2 * Math.PI * r;
  const share = score === null ? 0 : Math.max(0, Math.min(1, score / 100));
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(240,237,226,0.08)" strokeWidth="5" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${c * share} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-value font-semibold text-white/90">{score === null ? '—' : score}</div>
    </div>
  );
}

function CheckRow({ c }: { c: WalletCheck }) {
  const tone = c.points === null ? null : scoreTone(c.points);
  return (
    <div className="rounded-md border border-white/10 bg-black/25 px-2.5 py-2" title={c.note}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-label text-white/85">{c.label}</span>
        <span className="text-micro text-krypt-muted/70">×{c.weight}</span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="font-mono text-body text-white/90">{c.value}</span>
        <span className={cls('font-mono text-body', tone === 'good' ? 'text-emerald-300' : tone === 'mid' ? 'text-amber-300' : tone === 'bad' ? 'text-rose-300' : 'text-krypt-muted')}>
          {c.points === null ? 'not measured' : `${c.points} pts`}
        </span>
      </div>
      <p className="mt-1 text-nano leading-snug text-krypt-muted">{c.note}</p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'muted' }) {
  return (
    <div className="rounded-md border border-white/10 bg-black/25 px-2.5 py-2">
      <div className="text-micro uppercase tracking-label text-krypt-muted/80">{label}</div>
      <div className={cls('mt-0.5 font-mono text-xs tabular-nums', tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : tone === 'muted' ? 'text-krypt-muted' : 'text-white/90')}>{value}</div>
    </div>
  );
}

const TRIP_NOTE: Record<ScoutTrip['followerNote'], string> = {
  filled: 'copy filled both legs',
  'too-fast': 'over before a copy could enter',
  'no-entry': 'no print to enter at',
  'no-exit': 'no print to exit at',
};

export interface WalletDrawerProps {
  chain: ScoutChain;
  address: string | null;
  window: ScoutWindow;
  /** The board's row, so the drawer opens on it at once while the record loads. */
  row: ScoutRow | null;
  saved: boolean;
  following: boolean;
  onClose: () => void;
  onToggleSave: (address: string) => void;
  onFollow: (address: string, direction?: 'copy' | 'reverse') => void;
  onCopyAddress: (address: string) => void;
}

export function WalletDrawer({ chain, address, window: win, row, saved, following, onClose, onToggleSave, onFollow, onCopyAddress }: WalletDrawerProps) {
  const [wallet, setWallet] = useState<ScoutWallet | null>(null);
  const [loading, setLoading] = useState(false);
  const [symbols, setSymbols] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!address) return;
    let alive = true;
    setLoading(true);
    setWallet(null);
    void window.krypt.scout.detail(chain, address).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r.ok && r.data) setWallet(r.data.wallet);
    });
    return () => {
      alive = false;
    };
  }, [chain, address]);

  // Names for the recent trips' mints, from the market cache — a batch, and
  // only when the drawer is open. Solana only: the EVM rows are curve addresses.
  const tripMints = useMemo(() => (wallet?.recentTrips ?? []).map((t) => t.mint).filter((m, i, a) => a.indexOf(m) === i), [wallet]);
  useEffect(() => {
    if (chain !== 'solana' || !tripMints.length) return;
    let alive = true;
    void window.krypt.market.summaries(tripMints).then((r) => {
      if (!alive || !r.ok || !r.data) return;
      const out: Record<string, string> = {};
      for (const [mint, s] of Object.entries(r.data as Record<string, { symbol?: string }>)) if (s?.symbol) out[mint] = s.symbol;
      setSymbols(out);
    });
    return () => {
      alive = false;
    };
  }, [chain, tripMints]);

  const live = useMemo(() => (wallet ? summarise(wallet, win) : row), [wallet, win, row]);
  const span = SCOUT_WINDOW_DAYS[win];
  const windowDays = live ? (span === null ? Math.max(1, dayOf(Date.now()) - dayOf(wallet?.firstSeen ?? Date.now()) + 1) : span) : null;
  const score = useMemo(() => (live ? scoreOfRow(live, windowDays !== null && windowDays >= 3 ? windowDays : null) : null), [live, windowDays]);
  const unit = UNIT[chain];

  return (
    <AnimatePresence>
      {address && (
        <>
          <motion.div key="wallet-drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
          <motion.aside
            key="wallet-drawer"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed right-0 top-0 bottom-0 z-50 flex w-[440px] max-w-full flex-col border-l border-white/10 bg-krypt-panel/95 shadow-krypt-card backdrop-blur-md"
            data-testid="wallet-drawer"
          >
            <div className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="min-w-0">
                <div className="text-micro uppercase tracking-label text-krypt-muted/70">Wallet · {SCOUT_WINDOW_LABEL[win]}</div>
                <button onClick={() => onCopyAddress(address)} className="mt-0.5 flex items-center gap-1.5 font-mono text-body text-white/90 transition hover:text-krypt-purple" title={`${address} — click to copy`}>
                  <span className="truncate">{address.slice(0, 8)}…{address.slice(-6)}</span>
                  <Copy className="h-3 w-3 shrink-0 opacity-60" />
                </button>
              </div>
              <button onClick={onClose} className="rounded-md p-1 text-krypt-muted transition hover:bg-white/5 hover:text-white" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-4">
              {/* Score */}
              <section className="flex items-center gap-4">
                <ScoreRing score={live?.copyScore ?? null} />
                <div className="min-w-0">
                  <div className="text-value font-semibold text-white">Copy score</div>
                  <p className="mt-0.5 text-label leading-snug text-krypt-muted">
                    How a copier would have done mirroring this wallet — not how the wallet did. Ranks least-bad to follow; measured across the whole tape, even the best wallets lose a little per copied trade.
                  </p>
                  {live && live.roundTrips > 0 && (
                    <p className="mt-1 text-nano text-krypt-muted/80">
                      Copy figures from {live.judgedTrips} of {live.roundTrips} trip{live.roundTrips === 1 ? '' : 's'} in this window.
                    </p>
                  )}
                  {live && live.flags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {live.flags.map((f) => (
                        <span key={f} className={cls('rounded-full border px-1.5 text-micro', f === 'bot' || f === 'unreachable' ? 'border-amber-400/30 bg-amber-400/10 text-amber-300' : 'border-white/10 bg-white/5 text-krypt-muted')} title={FLAG_TEXT[f].title}>
                          {FLAG_TEXT[f].label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Checks */}
              {score && (
                <section className="space-y-1.5">
                  <div className="text-micro uppercase tracking-label text-krypt-muted/70">
                    The checks · {score.resolved} of {score.total} measured
                  </div>
                  {score.checks.map((c) => (
                    <CheckRow key={c.id} c={c} />
                  ))}
                </section>
              )}

              {/* The follower's side vs theirs */}
              {live && (
                <section>
                  <div className="mb-1.5 text-micro uppercase tracking-label text-krypt-muted/70">If you had copied them</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <Stat label="Median / trip" value={pct(live.fMedianReturnPct)} tone={live.fMedianReturnPct === null ? 'muted' : live.fMedianReturnPct >= 0 ? 'good' : 'bad'} />
                    <Stat label="Win rate" value={pct(live.fWinRatePct)} tone={live.fWinRatePct === null ? 'muted' : undefined} />
                    <Stat label="Reachable" value={live.reachablePct === null ? '—' : `${live.fTrips} of ${live.judgedTrips}`} tone={live.reachablePct !== null && live.reachablePct < 25 ? 'bad' : undefined} />
                  </div>
                  <div className="mb-1.5 mt-3 text-micro uppercase tracking-label text-krypt-muted/70">What they did</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <Stat label={`Profit (${unit})`} value={live.roundTrips === 0 && live.buys + live.sells === 0 ? '—' : amt(live.pnl)} tone={live.pnl > 0 ? 'good' : live.pnl < 0 ? 'bad' : undefined} />
                    <Stat label="Return" value={pct(live.returnPct)} />
                    <Stat label="Win rate" value={pct(live.winRatePct)} />
                    <Stat label="Round trips" value={String(live.roundTrips)} />
                    <Stat label={`Volume (${unit})`} value={amt(live.volume)} tone="muted" />
                    <Stat label="Median hold" value={hold(live.medianHoldMs)} tone={live.fastPct !== null && live.fastPct >= 50 ? 'bad' : undefined} />
                    <Stat label="Under a minute" value={pct(live.fastPct, 0)} tone={live.fastPct !== null && live.fastPct >= 50 ? 'bad' : 'muted'} />
                    <Stat label="Coins" value={live.distinctMints ? String(live.distinctMints) : '—'} tone="muted" />
                    <Stat label="Active days" value={windowDays !== null && windowDays >= 3 ? `${live.activeDays} of ${windowDays}` : String(live.activeDays)} tone="muted" />
                  </div>
                  {wallet && (
                    <p className="mt-1.5 text-nano text-krypt-muted">
                      First seen {fmtAgo(wallet.firstSeen)} ago · last {fmtAgo(wallet.lastSeen)} ago · {wallet.openCount} open position{wallet.openCount === 1 ? '' : 's'} ({amt(wallet.openCost)} {unit} in, unvalued)
                    </p>
                  )}
                </section>
              )}

              {/* Recent trips */}
              <section>
                <div className="mb-1.5 text-micro uppercase tracking-label text-krypt-muted/70">Recent closed trips</div>
                {loading ? (
                  <div className="flex items-center gap-2 py-3 text-note text-krypt-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the record…
                  </div>
                ) : !wallet || wallet.recentTrips === undefined || wallet.recentTrips.length === 0 ? (
                  <p className="text-note text-krypt-muted">No closed trips recorded yet. Trips are kept once the wallet has enough of them to rank.</p>
                ) : (
                  <table className="w-full text-label">
                    <thead className="text-micro uppercase tracking-wider text-krypt-muted/60">
                      <tr>
                        <th className="py-1 text-left font-medium">Coin</th>
                        <th className="py-1 text-right font-medium">Hold</th>
                        <th className="py-1 text-right font-medium">Theirs</th>
                        <th className="py-1 text-right font-medium">Copy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wallet.recentTrips.map((t) => (
                        <tr key={`${t.mint}-${t.closedAt}`} className="border-t border-white/5" title={`${t.mint}\n${fmtAgo(t.closedAt)} ago · put in ${amt(t.cost)} ${unit} · ${TRIP_NOTE[t.followerNote]}`}>
                          <td className="py-1 font-mono text-white/85">{symbols[t.mint] ?? `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`}</td>
                          <td className={cls('py-1 text-right font-mono', t.holdMs < 60_000 ? 'text-amber-300' : 'text-krypt-muted')}>{hold(t.holdMs)}</td>
                          <td className={cls('py-1 text-right font-mono', t.pnl > 0 ? 'text-emerald-300' : t.pnl < 0 ? 'text-rose-300' : 'text-krypt-muted')}>{amt(t.pnl)}</td>
                          <td className={cls('py-1 text-right font-mono', t.followerReturnPct === null ? 'text-krypt-muted' : t.followerReturnPct >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                            {t.followerReturnPct === null ? (t.followerNote === 'too-fast' ? 'too fast' : t.followerNote === 'no-exit' ? 'pending' : 'no fill') : pct(t.followerReturnPct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <p className="text-nano leading-relaxed text-krypt-muted">
                The copy figures assume a fill at the first trade on the coin {FOLLOWER_LAG_MS / 1000} s after theirs, on both legs, paying {(FOLLOWER_COST_PER_SIDE * 100).toFixed(1)}% a side. They do not model slippage or a leader's partial exits, so they are, if anything, generous. Nothing here predicts.
              </p>
            </div>

            <div className="flex items-center gap-2 border-t border-white/10 px-4 py-3">
              <button
                onClick={() => onToggleSave(address)}
                className={cls('flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-body transition', saved ? 'border-krypt-purple/50 text-krypt-purple' : 'border-white/10 text-krypt-muted hover:text-white')}
              >
                {saved ? <BookmarkCheck className="h-3.5 w-3.5" /> : <Bookmark className="h-3.5 w-3.5" />}
                {saved ? 'Saved' : 'Save'}
              </button>
              {chain === 'solana' &&
                (following ? (
                  <span className="rounded-lg border border-krypt-purple/40 bg-krypt-purple/10 px-3 py-1.5 text-body text-krypt-purple" title="Already on the Copy Trading page — paper, and switched off until you arm it">
                    Following
                  </span>
                ) : (
                  <>
                    <button onClick={() => onFollow(address)} className="rounded-lg border border-krypt-purple/60 bg-krypt-purple/15 px-3 py-1.5 text-body text-white transition hover:bg-krypt-purple/25" title="Add to copy trading — paper, and switched off until you arm it">
                      Follow on paper
                    </button>
                    <button
                      onClick={() => onFollow(address, 'reverse')}
                      className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-body text-amber-200 transition hover:bg-amber-400/20"
                      title="Reverse copy — buy when they sell, sell when they buy back, with its own take-profit, stop-loss and max hold. Paper, switched off until you arm it. Nothing has measured this bet."
                    >
                      Reverse on paper
                    </button>
                  </>
                ))}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
