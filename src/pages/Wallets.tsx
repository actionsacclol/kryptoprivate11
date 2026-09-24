import { useCallback, useEffect, useState } from 'react';
import { EVM_CHAIN_META, nativeSymbolOf, type ChainKind, type EvmWalletSummary } from '@shared/evm';
import { Copy, FlaskConical, Plus, RotateCcw, Trash2, TriangleAlert, Users, Zap } from 'lucide-react';
import {
  DEFAULT_COPIES_PER_MINUTE,
  DEFAULT_EXIT_MAX_HOLD_MIN,
  DEFAULT_EXIT_STOP_LOSS_PCT,
  DEFAULT_EXIT_TAKE_PROFIT_PCT,
  DEFAULT_FOMO_CROWD_EXIT_PCT,
  DEFAULT_FOMO_MIN_WALLETS,
  DEFAULT_FOMO_TOP_N,
  DEFAULT_FOMO_WINDOW_SEC,
  FOMO_SOURCES,
  FOMO_SOURCE_LABEL,
  directionOf,
  fomoRuleOf,
  isFomo,
  LEADER_RANK_KEYS,
  MIN_TRIPS_FOR_RANK,
  copySize,
  defaultConfig,
  leaderTooFast,
  leaderWinRate,
  rankLeaders,
  validateConfig,
  winRate,
  type CopyConfig,
  type CopyLatency,
  type CopySnapshot,
  type LeaderRankKey,
  type CopyStats,
  type FomoSource,
  chainOf,
} from '@shared/copytrade';
import type { WalletSummary, WatchedWallet } from '@shared/types';
import { Card, Empty, GhostButton, Page, PrimaryButton, Section } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { useTerminal } from '../state/TerminalProvider';
import { useModal } from '../state/ModalProvider';
import { cls, fmtAgo, fmtDur, shortAddr, toneFor } from '../utils/format';

// Wallet tracking + copy trading (term.txt §9 and §11).
//
// The layout puts the PAPER SCORECARD next to the live switch on purpose.
// Deciding to copy a wallet with real money is the highest-variance choice
// this app offers, and the only useful input to it is the record of what
// following that wallet would actually have done — including the trades the
// filters skipped and the latency you configured.

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-micro uppercase tracking-label text-krypt-muted/70 mb-1">{label}</div>
      {children}
      {hint && <div className="text-micro text-krypt-muted/50 mt-0.5">{hint}</div>}
    </div>
  );
}

const numBox =
  'w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-note font-mono text-white outline-none focus:border-krypt-purple/50';

/** Where the copy trading stands, live and paper apart — they are different experiments. */
/** A chain's name for a label, whichever of the three it is. */
const chainName = (c: ChainKind): string => (c === 'solana' ? 'Solana' : EVM_CHAIN_META[c].name);

function CopyTotals({ snap }: { snap: CopySnapshot }) {
  const chainsSeen = [...new Set(snap.configs.map((c) => chainOf(c)))];
  const rows = (['live', 'paper'] as const).flatMap((mode) =>
    chainsSeen.map((chain) => {
      const configs = snap.configs.filter((c) => c.mode === mode && chainOf(c) === chain);
      const ids = new Set(configs.map((c) => c.id));
      const stats = Object.values(snap.stats).filter((s) => s.mode === mode && ids.has(s.configId));
      const sum = (f: (s: CopyStats) => number) => stats.reduce((a, s) => a + f(s), 0);
      return {
        mode,
        chain,
        sym: nativeSymbolOf(chain),
        name: chainName(chain),
        configs: configs.length,
        running: configs.filter((c) => c.enabled).length,
        trades: sum((s) => s.trades),
        wins: sum((s) => s.wins),
        losses: sum((s) => s.losses),
        pnl: sum((s) => s.realizedPnlSol),
        open: sum((s) => s.openCount),
        openCost: sum((s) => s.openCostSol),
        skipped: sum((s) => s.skipped + s.blocked),
      };
    }),
  );
  const shown = rows.filter((r) => r.configs > 0);
  if (shown.length === 0) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {shown.map((r) => (
        <div key={`${r.mode}-${r.chain}`} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="mb-2 flex items-center gap-2 text-body font-semibold uppercase tracking-wide text-white/80">
            {r.mode === 'paper' ? <FlaskConical className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
            {r.mode} · {r.name} · {r.running} of {r.configs} running
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Tot label="Copies" value={String(r.trades)} />
            <Tot label="Up / down" value={`${r.wins} / ${r.losses}`} />
            <Tot label="Realised" value={`${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(4)} ${r.sym}`} tone={r.pnl > 0 ? 'good' : r.pnl < 0 ? 'bad' : undefined} />
            <Tot label="Open" value={r.open ? `${r.open} · ${r.openCost.toFixed(4)} ${r.sym}` : '0'} />
          </div>
          {r.skipped > 0 && <div className="mt-1.5 text-label text-krypt-muted">{r.skipped} skipped by filters or limits — counted, not hidden.</div>}
        </div>
      ))}
    </div>
  );
}

function Tot({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <div className="text-label uppercase tracking-wide text-krypt-muted">{label}</div>
      <div className={cls('font-mono text-note', tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : 'text-white')}>{value}</div>
    </div>
  );
}

/**
 * Where the time goes between a leader's fill and ours.
 *
 * A tester timed ~5–6 s from outside and could not tell which half was
 * which (2026-09-21). Every stage is a median over this session's copies,
 * and a stage nothing measured shows an em dash rather than a zero — "did
 * not happen" and "took no time" are different facts.
 */
function CopyLatencyPanel({ l }: { l: CopyLatency }) {
  const ms = (n: number | null): string =>
    n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
  // The delivery half is the chain, the RPC and the transport; the rest is
  // this app. Splitting them is the whole question.
  const heard = (l.detectMs ?? 0) + (l.readMs ?? 0) + (l.decodeMs ?? 0);
  const ours = (l.checkMs ?? 0) + (l.delayMs ?? 0) + (l.sendMs ?? 0);
  const mixed = l.feeds.logs > 0 && l.feeds.tx > 0;
  return (
    <Section
      title="Where a copy's time goes"
      description="Median across this session's copies, paper and live. Measured from the leader's own block time, so it is the same stopwatch you would hold watching two wallets side by side."
    >
      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <Tot label="Their fill → ours" value={ms(l.totalMs)} />
          <Tot label="Heard about it" value={ms(l.detectMs)} />
          <Tot label="Read the tx" value={ms(l.readMs)} />
          <Tot label="Decode" value={ms(l.decodeMs)} />
          <Tot label="Checks" value={ms(l.checkMs)} />
          <Tot label="Your delay" value={ms(l.delayMs)} />
          <Tot label="Our order" value={ms(l.sendMs)} />
        </div>
        <p className="mt-3 text-body leading-relaxed text-krypt-muted">
          {l.samples < 5 ? (
            <>
              <span className="text-arc-gold">{l.samples} copy{l.samples === 1 ? '' : ' copies'} so far</span> — too few
              to read as a measurement yet.{' '}
            </>
          ) : (
            <>Over {l.samples} copies. </>
          )}
          {heard > 0 && ours > 0 && (
            <>
              Roughly <span className="text-white">{ms(heard)}</span> of it is hearing about the trade and{' '}
              <span className="text-white">{ms(ours)}</span> is placing yours.{' '}
            </>
          )}
          {l.factsMs !== null && l.checkMs !== null && l.factsMs > l.checkMs / 2 && (
            <>
              Most of the checks is one token lookup ({ms(l.factsMs)}), which is a network call on a mint nothing has
              seen before.{' '}
            </>
          )}
          {mixed ? (
            <>Mixed transports this session ({l.feeds.logs} read back, {l.feeds.tx} delivered whole).</>
          ) : l.feeds.tx > 0 ? (
            <>Delivered whole by transactionSubscribe — no read-back at all.</>
          ) : l.feeds.logs > 0 ? (
            <>
              Delivered as a signature, so every trade costs a read-back — the &ldquo;read the tx&rdquo; column above. A
              Helius key on a plan that serves transactionSubscribe removes that stage entirely, because the
              transaction arrives with the notification.
            </>
          ) : null}
        </p>
      </Card>
    </Section>
  );
}

function ConfigEditor({
  initial,
  wallets,
  evmWallets,
  onSave,
  onCancel,
}: {
  initial: Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string };
  wallets: WalletSummary[];
  evmWallets: Record<'robinhood' | 'bnb', EvmWalletSummary[]>;
  onSave: (c: Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string }) => void;
  onCancel: () => void;
}) {
  const [c, setC] = useState(initial);
  const set = <K extends keyof typeof c>(k: K, v: (typeof c)[K]): void => setC((p) => ({ ...p, [k]: v }));
  // Main is the authority (ipc.ts `copy:save` tests a real base58 address
  // before handing it to the wallet watcher). `validateConfig` only asks for
  // 32 characters, so without this the form would enable Save on a string
  // the handler is going to refuse.
  const chain = chainOf(c);
  const sym = nativeSymbolOf(chain);
  const ownWallets: Array<{ id: string; label: string }> = chain === 'solana' ? wallets : evmWallets[chain];
  const base = validateConfig(c);
  const validity =
    base.ok && !isFomo(c) && (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.wallet.trim()) : !/^0x[0-9a-fA-F]{40}$/.test(c.wallet.trim()))
      ? { ok: false, message: chain === 'solana' ? 'Enter a valid wallet address' : `Enter a valid 0x address on ${EVM_CHAIN_META[chain].name}` }
      : base;
  const optNum = (raw: string): number | null => (raw.trim() === '' ? null : Number(raw));
  // Token age is stored in seconds (the unit competitors and the engine use)
  // and edited in minutes, which is how a person thinks about it.
  const optMinutes = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v / 60));
  const fromMinutes = (raw: string): number | null => (raw.trim() === '' ? null : Number(raw) * 60);
  // The blocklists are edited as text (one address per line) and carried as
  // arrays. Local text keeps the newline the user just typed; the array is
  // rebuilt from it on every change, empties dropped.
  const [blockedMintsText, setBlockedMintsText] = useState((initial.blockedMints ?? []).join('\n'));
  const [blockedCreatorsText, setBlockedCreatorsText] = useState((initial.blockedCreators ?? []).join('\n'));
  const parseList = (raw: string): string[] | null => {
    const out = raw.split(/[\s,]+/).map((s) => s.trim()).filter((s, i, a) => s && a.indexOf(s) === i);
    return out.length ? out : null;
  };

  return (
    <Card className="space-y-3 border-krypt-purple/25">
      <Field label="Chain" hint={isFomo(c) ? 'FOMO listens to the Solana feeds only' : undefined}>
        <select
          value={chain}
          disabled={isFomo(c)}
          onChange={(e) => setC((p) => ({ ...p, chain: e.target.value as ChainKind, walletId: null, onlyPumpfun: e.target.value === 'solana' ? p.onlyPumpfun : false }))}
          className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-note text-white disabled:opacity-60"
        >
          <option value="solana">Solana</option>
          <option value="robinhood">Robinhood Chain</option>
          <option value="bnb">BNB Smart Chain</option>
        </select>
        {chain !== 'solana' && (
          <p className="mt-1 text-label leading-relaxed text-krypt-muted">
            On {EVM_CHAIN_META[chain].name} a leader is followed through the Observatory&rsquo;s trade feed: their launchpad-curve
            trades while a token is on its curve. That chain&rsquo;s scanner has to be watching, and a live copy needs the chain
            armed on its wallet page. Sells mirror the share they sold, read from their balance.
          </p>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        {!isFomo(c) && (
          <Field label="Wallet address">
            <input
              value={c.wallet}
              onChange={(e) => set('wallet', e.target.value.trim())}
              spellCheck={false}
              placeholder="7jA…8K"
              className={numBox}
            />
          </Field>
        )}
        <Field label="Label">
          <input
            value={c.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="Good Pump Trader"
            maxLength={40}
            className={numBox}
          />
        </Field>
      </div>

      {/*
        Mode, in the editor.

        A config is created on paper and could only be changed afterwards, on
        its card — so the form never said which it was making, and choosing
        paper deliberately was not something the page let you do. Copying a
        wallet with real money is the highest-variance choice here; the mode
        belongs next to the decision, the way the Scripts page has it.

        Switching to live DISARMS, exactly as the card's toggle does: arming is
        a separate, confirmed click and must never be inherited from an edit.
      */}
      <Field label="Mode">
        <div className="flex rounded-md border border-white/10 overflow-hidden">
          {(['paper', 'live'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setC((prev) => ({ ...prev, mode: m, enabled: m === 'live' ? false : prev.enabled }))}
              className={cls(
                'inline-flex items-center gap-1.5 px-3 py-1.5 text-body font-semibold transition',
                c.mode === m
                  ? m === 'live'
                    ? 'bg-rose-500/30 text-white'
                    : 'bg-krypt-purple/25 text-white'
                  : 'text-krypt-muted hover:text-white',
              )}
            >
              {m === 'paper' ? <FlaskConical className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
              {m === 'paper' ? 'Paper' : 'Live'}
            </button>
          ))}
        </div>
      </Field>
      {c.mode === 'paper' ? (
        <p className="text-label leading-relaxed text-krypt-muted">
          Paper simulates each fill — your configured delay and the protocol fee included — so the record is one a real
          execution could have produced. Nothing is spent.
        </p>
      ) : (
        <p className="flex items-start gap-2 text-label leading-relaxed text-rose-200/90">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Live copies spend real {sym} on their own, every time that wallet trades. Saving leaves this switched off;
            arming it is a separate, confirmed click.
          </span>
        </p>
      )}

      {/*
        Direction (2026-09-20). Copy buys when they buy and mirrors their
        sells. Reverse buys when they SELL and exits when they buy back. FOMO
        follows a CROWD: several wallets from a set buying the same coin
        inside a window. Reverse and FOMO have no leader sell to close them,
        so they carry their own exits; a copy may set them too. Measured
        nowhere (reverse) or measured to hurt (FOMO) — paper first.
      */}
      <Field label="Direction">
        <div className="flex rounded-md border border-white/10 overflow-hidden">
          {(['copy', 'reverse', 'fomo'] as const).map((d) => (
            <button
              key={d}
              onClick={() =>
                setC((p) => {
                  const dir = directionOf(p);
                  if (dir === d) return p;
                  const next = { ...p, direction: d };
                  // Leaving or entering FOMO swaps the wallet for the sentinel
                  // and back, and FOMO is Solana-only.
                  if (d === 'fomo') return { ...next, wallet: defaultConfig('', '', 'solana', 'fomo').wallet, chain: 'solana', walletId: p.chain === 'solana' ? p.walletId : null, fomoSource: p.fomoSource ?? 'followed' };
                  if (dir === 'fomo') return { ...next, wallet: '' };
                  return next;
                })
              }
              className={cls(
                'inline-flex items-center gap-1.5 px-3 py-1.5 text-body font-semibold transition',
                directionOf(c) === d ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
              )}
            >
              {d === 'copy' ? 'Copy' : d === 'reverse' ? 'Reverse' : 'FOMO'}
            </button>
          ))}
        </div>
      </Field>
      <p className="text-label leading-relaxed text-krypt-muted">
        {directionOf(c) === 'reverse'
          ? 'Reverse buys when this wallet SELLS and sells when it buys back — betting the coin keeps going after they leave. Nothing has measured that bet, so it starts on paper. A reverse position also closes on its own take-profit, stop-loss or max hold, since a leader rarely buys the same coin twice.'
          : directionOf(c) === 'fomo'
            ? 'FOMO buys when several wallets from the set below pile into the same coin within the window — the crowd is the signal, not any one wallet. It gets out when enough of that crowd has sold, or on its own take-profit, stop-loss or max hold.'
            : 'Copy buys when this wallet buys and mirrors its sells, proportionally to what you hold.'}
      </p>
      {directionOf(c) === 'fomo' && (
        <>
          <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-label leading-relaxed text-amber-200/90">
            Measured over 9.3 million trades on this rail: when two to four strong wallets converged on a coin within minutes, the
            follower&rsquo;s outcome got WORSE with each extra wallet, from −15% to −32% an hour later. That is the definition of
            FOMO. It ships because people ask for it, and it starts on paper.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="The crowd" hint="which wallets count">
              <select
                value={fomoRuleOf(c).source}
                onChange={(e) => set('fomoSource', e.target.value as FomoSource)}
                className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-note text-white"
              >
                {FOMO_SOURCES.map((src) => (
                  <option key={src} value={src}>
                    {FOMO_SOURCE_LABEL[src]}
                  </option>
                ))}
              </select>
            </Field>
            {fomoRuleOf(c).source === 'top' ? (
              <Field label="Top N" hint={`by Copy score · blank = ${DEFAULT_FOMO_TOP_N}`}>
                <input type="number" value={c.fomoTopN ?? ''} onChange={(e) => set('fomoTopN', optNum(e.target.value))} className={numBox} />
              </Field>
            ) : (
              <div />
            )}
            <Field label="Wallets to trigger" hint={`distinct · blank = ${DEFAULT_FOMO_MIN_WALLETS}`}>
              <input type="number" value={c.fomoMinWallets ?? ''} onChange={(e) => set('fomoMinWallets', optNum(e.target.value))} className={numBox} />
            </Field>
            <Field label="Within" hint={`seconds · blank = ${DEFAULT_FOMO_WINDOW_SEC}`}>
              <input type="number" value={c.fomoWindowSec ?? ''} onChange={(e) => set('fomoWindowSec', optNum(e.target.value))} className={numBox} />
            </Field>
            <Field label="Exit when the crowd leaves" hint={`% of them sold · blank = ${DEFAULT_FOMO_CROWD_EXIT_PCT}`}>
              <input type="number" value={c.fomoCrowdExitPct ?? ''} onChange={(e) => set('fomoCrowdExitPct', optNum(e.target.value))} className={numBox} />
            </Field>
          </div>
          <p className="text-label leading-relaxed text-krypt-muted">
            {FOMO_SOURCE_LABEL[fomoRuleOf(c).source] === FOMO_SOURCE_LABEL.followed
              ? 'The wallets your enabled copy and reverse configs follow.'
              : fomoRuleOf(c).source === 'saved'
                ? 'The wallets you saved on the Wallet Scout.'
                : fomoRuleOf(c).source === 'tracked'
                  ? 'The wallets on your tracked list on this page.'
                  : 'The Scout\u2019s best wallets by Copy score right now; the list moves as the score does.'}
          </p>
        </>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Field label="Take profit" hint={directionOf(c) === 'copy' ? '% · blank = off' : `% · blank = ${DEFAULT_EXIT_TAKE_PROFIT_PCT}`}>
          <input type="number" value={c.exitTakeProfitPct ?? ''} onChange={(e) => set('exitTakeProfitPct', optNum(e.target.value))} className={numBox} />
        </Field>
        <Field label="Stop loss" hint={directionOf(c) === 'copy' ? '% · blank = off' : `% · blank = ${DEFAULT_EXIT_STOP_LOSS_PCT}`}>
          <input type="number" value={c.exitStopLossPct ?? ''} onChange={(e) => set('exitStopLossPct', optNum(e.target.value))} className={numBox} />
        </Field>
        <Field label="Max hold" hint={directionOf(c) === 'copy' ? 'minutes · blank = off' : `minutes · blank = ${DEFAULT_EXIT_MAX_HOLD_MIN}`}>
          <input type="number" value={c.exitMaxHoldMin ?? ''} onChange={(e) => set('exitMaxHoldMin', optNum(e.target.value))} className={numBox} />
        </Field>
      </div>
      {directionOf(c) === 'copy' && (
        <p className="text-label leading-relaxed text-krypt-muted">
          Your own exits on top of theirs, judged on every price tick. Blank means their sells alone decide.
        </p>
      )}

      <Field label="Copy with">
        <select
          value={c.walletId ?? ''}
          onChange={(e) => setC({ ...c, walletId: e.target.value || null })}
          className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-note text-white"
        >
          <option value="">Active wallet{chain !== 'solana' ? ` on ${EVM_CHAIN_META[chain].name}` : ''}</option>
          {ownWallets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-label leading-relaxed text-krypt-muted">
          Which of your wallets signs the copies. Pick a different one from your trading wallet to keep the two apart, and give each
          followed leader its own — every config is its own runner.
        </p>
      </Field>

      <div className="grid grid-cols-4 gap-3">
        <Field label="Sizing">
          <div className="flex rounded-md border border-white/10 overflow-hidden">
            {(['fixed', 'proportional'] as const).map((m) => (
              <button
                key={m}
                onClick={() => set('sizing', m)}
                className={cls(
                  'flex-1 px-2 py-1.5 text-label font-semibold transition',
                  c.sizing === m ? 'bg-krypt-purple/25 text-white' : 'text-krypt-muted hover:text-white',
                )}
              >
                {m === 'fixed' ? 'Fixed' : '% of theirs'}
              </button>
            ))}
          </div>
        </Field>
        <Field label={c.sizing === 'fixed' ? `${sym} per trade` : '% of their size'}>
          <input type="number" value={c.sizeValue} onChange={(e) => set('sizeValue', Number(e.target.value))} className={numBox} />
        </Field>
        <Field label="Max per trade" hint={sym}>
          <input type="number" value={c.maxTradeSol} onChange={(e) => set('maxTradeSol', Number(e.target.value))} className={numBox} />
        </Field>
        <Field label="Delay" hint="ms after their trade">
          <input type="number" value={c.delayMs} onChange={(e) => set('delayMs', Number(e.target.value))} className={numBox} />
        </Field>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Field label="Min liquidity" hint="USD · blank = any">
          <input
            type="number"
            value={c.minLiquidityUsd ?? ''}
            onChange={(e) => set('minLiquidityUsd', optNum(e.target.value))}
            className={numBox}
          />
        </Field>
        <Field label="Max market cap" hint="USD · blank = any">
          <input
            type="number"
            value={c.maxMarketCapUsd ?? ''}
            onChange={(e) => set('maxMarketCapUsd', optNum(e.target.value))}
            className={numBox}
          />
        </Field>
        <Field label="Min Krypt score" hint="blank = any">
          <input
            type="number"
            value={c.minKryptScore ?? ''}
            onChange={(e) => set('minKryptScore', optNum(e.target.value))}
            className={numBox}
          />
        </Field>
        <Field label="Max slippage" hint="%">
          <input type="number" value={c.maxSlippagePct} onChange={(e) => set('maxSlippagePct', Number(e.target.value))} className={numBox} />
        </Field>
      </div>

      <div className="grid grid-cols-5 gap-3">
        <Field label="Daily loss limit" hint={sym}>
          <input type="number" value={c.dailyLossLimitSol} onChange={(e) => set('dailyLossLimitSol', Number(e.target.value))} className={numBox} />
        </Field>
        <Field label="Daily trade limit">
          <input type="number" value={c.dailyTradeLimit} onChange={(e) => set('dailyTradeLimit', Number(e.target.value))} className={numBox} />
        </Field>
        {/* The burst wall. The daily limit is checked against copies that
            have already resolved, so a leader firing eight swaps in one slot
            can out-run it; this one is a refusal inside any rolling 60 s.
            Blank means the shipped default, not "off". */}
        <Field label="Copies per minute" hint={`1–120 · blank = ${DEFAULT_COPIES_PER_MINUTE}`}>
          <input
            type="number"
            value={c.maxCopiesPerMinute ?? ''}
            onChange={(e) => set('maxCopiesPerMinute', optNum(e.target.value))}
            className={numBox}
          />
        </Field>
        <Field label={directionOf(c) === 'reverse' ? 'Exit when they buy back' : directionOf(c) === 'fomo' ? 'Mirror the crowd’s sells' : 'Copy their sells'}>
          <button
            onClick={() => set('copySells', !c.copySells)}
            className={cls(
              'w-full rounded-md border px-2 py-1.5 text-label font-semibold transition',
              c.copySells ? 'border-krypt-purple/45 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-krypt-muted',
            )}
          >
            {c.copySells ? 'Yes' : 'No'}
          </button>
        </Field>
        <Field label="Pump.fun only">
          <button
            onClick={() => set('onlyPumpfun', !c.onlyPumpfun)}
            className={cls(
              'w-full rounded-md border px-2 py-1.5 text-label font-semibold transition',
              c.onlyPumpfun ? 'border-krypt-purple/45 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-krypt-muted',
            )}
          >
            {c.onlyPumpfun ? 'Yes' : 'Any launchpad'}
          </button>
        </Field>
      </div>

      {/* The 2026-09-21 filters — the controls every competitor ships and this
          page lacked (docs/copy-trade-competitors-2026-09-21.md). Blank is
          off; every refusal lands on the record with its reason, and a fact
          the engine cannot read refuses rather than guesses. */}
      <div className="pt-1 text-micro uppercase tracking-label text-krypt-muted/60">More filters · blank = off</div>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Min market cap" hint="USD">
          <input type="number" value={c.minMarketCapUsd ?? ''} onChange={(e) => set('minMarketCapUsd', optNum(e.target.value))} className={numBox} />
        </Field>
        <Field label="Their trade at least" hint={sym}>
          <input type="number" value={c.minLeaderSol ?? ''} onChange={(e) => set('minLeaderSol', optNum(e.target.value))} className={numBox} />
        </Field>
        <Field label="Their trade at most" hint={sym}>
          <input type="number" value={c.maxLeaderSol ?? ''} onChange={(e) => set('maxLeaderSol', optNum(e.target.value))} className={numBox} />
        </Field>
        <Field label="Max buys per token" hint="1 = buy once">
          <input type="number" value={c.maxBuysPerToken ?? ''} onChange={(e) => set('maxBuysPerToken', optNum(e.target.value))} className={numBox} />
        </Field>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Token at least" hint="minutes old">
          <input type="number" value={optMinutes(c.minTokenAgeSec)} onChange={(e) => set('minTokenAgeSec', fromMinutes(e.target.value))} className={numBox} />
        </Field>
        <Field label="Token at most" hint="minutes old">
          <input type="number" value={optMinutes(c.maxTokenAgeSec)} onChange={(e) => set('maxTokenAgeSec', fromMinutes(e.target.value))} className={numBox} />
        </Field>
        <Field label="Mirror sells of at least" hint="% of their bag">
          <input type="number" value={c.minLeaderSellPct ?? ''} onChange={(e) => set('minLeaderSellPct', optNum(e.target.value))} className={numBox} />
        </Field>
        <Field label="Trailing stop" hint="% below the peak">
          <input type="number" value={c.exitTrailingPct ?? ''} onChange={(e) => set('exitTrailingPct', optNum(e.target.value))} className={numBox} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Never copy these tokens" hint="one address per line">
          <textarea
            value={blockedMintsText}
            onChange={(e) => {
              setBlockedMintsText(e.target.value);
              set('blockedMints', parseList(e.target.value));
            }}
            rows={2}
            className={cls(numBox, 'min-h-[52px] resize-y')}
            spellCheck={false}
          />
        </Field>
        <Field label="Never copy these creators" hint="one address per line">
          <textarea
            value={blockedCreatorsText}
            onChange={(e) => {
              setBlockedCreatorsText(e.target.value);
              set('blockedCreators', parseList(e.target.value));
            }}
            rows={2}
            className={cls(numBox, 'min-h-[52px] resize-y')}
            spellCheck={false}
          />
        </Field>
      </div>

      {!validity.ok && <p className="text-body text-rose-300">{validity.message}</p>}

      <div className="flex items-center gap-2">
        <PrimaryButton onClick={() => onSave(c)} disabled={!validity.ok} className="!py-2 !px-4 text-xs">
          Save
        </PrimaryButton>
        <GhostButton onClick={onCancel} className="!py-2 !px-4 text-xs">
          Cancel
        </GhostButton>
        <span className="text-label text-krypt-muted/60 ml-2">
          A trade of 1 {sym} by them would copy as{' '}
          <span className="font-mono text-white/80">{copySize(c as CopyConfig, 1).toFixed(3)} {sym}</span>.
        </span>
      </div>
    </Card>
  );
}

export function WalletsPage() {
  const toast = useToast();
  const modal = useModal();
  const [snap, setSnap] = useState<CopySnapshot | null>(null);
  const [tracked, setTracked] = useState<WatchedWallet[]>([]);
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [evmWallets, setEvmWallets] = useState<Record<'robinhood' | 'bnb', EvmWalletSummary[]>>({ robinhood: [], bnb: [] });
  const { chain: termChain } = useTerminal();
  const walletsFor = (c: ChainKind): Array<{ id: string; label: string }> => (c === 'solana' ? wallets : evmWallets[c]);
  const [editing, setEditing] = useState<(Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string }) | null>(null);
  const [newAddr, setNewAddr] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [rankBy, setRankBy] = useState<LeaderRankKey>('realizedPnlSol');

  const load = useCallback(async () => {
    const [c, w, ws, rh, bnb] = await Promise.all([
      window.krypt.copy.list(),
      window.krypt.watchlist.get(),
      window.krypt.wallet.list(),
      window.krypt.evm.wallet.list('robinhood').catch(() => null),
      window.krypt.evm.wallet.list('bnb').catch(() => null),
    ]);
    if (c.ok && c.data) setSnap(c.data);
    if (w.ok && w.data) setTracked(w.data);
    if (ws.ok && ws.data) setWallets(ws.data);
    setEvmWallets({ robinhood: rh && rh.ok && rh.data ? rh.data : [], bnb: bnb && bnb.ok && bnb.data ? bnb.data : [] });
  }, []);

  useEffect(() => {
    void load();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'copy') setSnap(ev.snapshot);
    });
    // Copy configs arrive by push; only the tracked-wallet list has no event,
    // and it changes on this page's own buttons, so a slow backstop is plenty.
    const id = setInterval(() => {
      void window.krypt.watchlist.get().then((w) => {
        if (w.ok && w.data) setTracked(w.data);
      });
    }, 60_000);
    return () => {
      off();
      clearInterval(id);
    };
  }, [load]);

  const addTracked = async (): Promise<void> => {
    const r = await window.krypt.watchlist.add(newAddr.trim(), newLabel.trim());
    if (r.ok) {
      toast.success('Wallet tracked');
      setNewAddr('');
      setNewLabel('');
      void load();
    } else {
      toast.error(r.message);
    }
  };

  const save = async (c: Omit<CopyConfig, 'id' | 'createdAt'> & { id?: string }): Promise<void> => {
    const r = await window.krypt.copy.save(c as Partial<CopyConfig>);
    if (r.ok) {
      toast.success(r.message);
      setEditing(null);
      if (r.data) setSnap(r.data);
    } else {
      toast.error(r.message);
    }
  };

  const toggle = async (c: CopyConfig): Promise<void> => {
    if (!c.enabled && c.mode === 'live') {
      const yes = await modal.confirm({
        title: 'Arm LIVE copy trading',
        message:
          (isFomo(c)
            ? `Every time ${fomoRuleOf(c).minWallets} of ${FOMO_SOURCE_LABEL[fomoRuleOf(c).source].toLowerCase()} buy the same coin within ${fomoRuleOf(c).windowSec} s, ${c.label || 'this crowd'} will spend real ${nativeSymbolOf(chainOf(c))} on ${chainName(chainOf(c))}, up to ${c.maxTradeSol} per trade, `
            : `Every ${directionOf(c) === 'reverse' ? 'SELL' : 'buy'} by ${c.label || shortAddr(c.wallet)} will spend real ${nativeSymbolOf(chainOf(c))} on ${chainName(chainOf(c))}, up to ${c.maxTradeSol} per trade, `) +
          `until you hit your ${c.dailyLossLimitSol} ${nativeSymbolOf(chainOf(c))} daily loss limit. ` +
          (directionOf(c) === 'reverse' ? 'Reverse copying bets the coin keeps going after they leave; nothing has measured that bet. ' : '') +
          (isFomo(c) ? 'Measured, wallets converging on a coin made the follower’s outcome WORSE with each extra wallet. ' : '') +
          `Six months of research in this repo failed to find a profitable automated memecoin strategy — run it on paper first if you have not.`,
        confirmLabel: 'Arm live copying',
        destructive: true,
      });
      if (!yes) return;
    }
    await save({ ...c, enabled: !c.enabled });
  };

  const setMode = async (c: CopyConfig, mode: 'paper' | 'live'): Promise<void> => {
    // Switching to live always disarms first — the user then has to arm it
    // deliberately, having seen the confirmation.
    await save({ ...c, mode, enabled: mode === 'live' ? false : c.enabled });
  };

  const remove = async (id: string): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Stop following',
      message: 'Remove this config and its paper record?',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.copy.remove(id);
    if (r.ok && r.data) setSnap(r.data);
  };

  // The leaderboard: THEIR record per followed wallet (every swap seen,
  // copied or not), next to what copying them did for us.
  const leaderRows = snap ? rankLeaders(Object.values(snap.leaders).filter((l) => l.buys + l.sells > 0), rankBy) : [];
  // How much of the visible top is unreachable? Drives the warning above the
  // table. Counted over the first ten rows because that is what a user reads.
  const tooFastTop = leaderRows.slice(0, 10).filter(leaderTooFast).length;
  const labelFor = (wallet: string): string => snap?.configs.find((c) => c.wallet === wallet)?.label || shortAddr(wallet, 6);
  const ourCopies = (wallet: string): { copies: number; closed: number; realized: number } => {
    const out = { copies: 0, closed: 0, realized: 0 };
    if (!snap) return out;
    for (const c of snap.configs) {
      if (c.wallet !== wallet) continue;
      const st = snap.stats[c.id];
      if (!st) continue;
      out.copies += st.trades;
      out.closed += st.wins + st.losses;
      out.realized += st.realizedPnlSol;
    }
    return out;
  };
  const signed = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
  const resetLeader = async (wallet: string): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Start this record over',
      message: `Clear the scored trades for ${labelFor(wallet)}? Your config and your copies stay.`,
      confirmLabel: 'Clear record',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.copy.resetStats(wallet);
    if (r.ok && r.data) setSnap(r.data);
    else if (!r.ok) toast.error(r.message);
  };

  // Paper results only. "Remove" deletes the config, the live history AND
  // the leader's own record — three different things, bundled only because
  // there was no other button (user report, 2026-09-13).
  const resetPaper = async (c: { id: string; label: string; wallet: string } | null): Promise<void> => {
    const who = c ? c.label || shortAddr(c.wallet, 6) : 'every followed wallet';
    const yes = await modal.confirm({
      title: 'Clear paper results',
      message:
        `Clear the paper record for ${who} and start the scorecard over?

` +
        'Kept: your settings, whether each wallet is on paper or live, every live trade, ' +
        'the leaders’ own records, and anything your wallet actually holds. ' +
        'Only simulated results are cleared — including open paper positions.',
      confirmLabel: 'Clear paper results',
      destructive: true,
    });
    if (!yes) return;
    const r = await window.krypt.copy.resetPaper(c?.id);
    if (r.ok && r.data) {
      setSnap(r.data);
      toast.success(r.message);
    } else if (!r.ok) toast.error(r.message);
  };

  return (
    <Page
      title="Copy Trading"
      subtitle="Track other traders' wallets, and follow them on paper before you follow them with money. Your own keys live under Wallet."
      actions={
        <div className="flex items-center gap-2">
          <GhostButton
            onClick={() => setEditing(defaultConfig('', '', 'solana', 'fomo'))}
            className="!py-2 !px-3 text-xs"
          >
            <Users className="h-3.5 w-3.5" />
            New FOMO copy
          </GhostButton>
          <PrimaryButton
            onClick={() => setEditing(defaultConfig('', '', termChain))}
            className="!py-2 !px-3 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            Follow a wallet
          </PrimaryButton>
        </div>
      }
    >
      {/* The copy store exists but could not be read, so NOTHING is being
          saved this session. It has to be said before the user types a
          config, not after they lose it: the page otherwise looks like a
          fresh install and every Save appears to work. Same shape as the
          EVM wallet panel's unreadable-file banner. */}
      {snap?.loadFailure && (
        <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2.5 flex items-start gap-2">
          <TriangleAlert className="h-4 w-4 text-rose-300 flex-shrink-0 mt-0.5" />
          <p className="text-body text-rose-200 leading-relaxed">
            Your copy-trading file could not be read — <span className="font-semibold">nothing was overwritten</span>, and
            nothing is being saved this session. {snap.loadFailure} Configs, copies and leader records you add now are
            gone at the next start. Close the app, copy that file somewhere safe, and check it before continuing.
          </p>
        </div>
      )}

      {snap && <CopyTotals snap={snap} />}

      {editing && (
        <Section title={editing.id ? 'Edit config' : 'New copy config'}>
          <ConfigEditor initial={editing} wallets={wallets} evmWallets={evmWallets} onSave={(c) => void save(c)} onCancel={() => setEditing(null)} />
        </Section>
      )}

      {/* Leaderboard — THEIR record, whether or not a copy happened. */}
      {snap && leaderRows.length > 0 && (
        <Section
          title="Leaderboard"
          description="Every swap seen on a followed wallet is scored as THEIR trade — whether or not your filters let a copy through — so wallets run on paper compare on their own record. Every SOL figure here is theirs, not yours: only the 'Your copies' column is your side of it. Sells of tokens bought before you followed are counted, not scored."
        >
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5 text-label">
              <span className="uppercase tracking-label text-krypt-muted/60 mr-1">Rank by</span>
              {LEADER_RANK_KEYS.map((k) => (
                <button
                  key={k.key}
                  onClick={() => setRankBy(k.key)}
                  className={cls(
                    'rounded-md border px-2 py-1 font-semibold transition',
                    rankBy === k.key ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 text-krypt-muted hover:text-white',
                  )}
                >
                  {k.label}
                </button>
              ))}
              <span className="flex-1" />
              <span className="text-krypt-muted/50">fewer than {MIN_TRIPS_FOR_RANK} closed trades ranks last</span>
            </div>
            {tooFastTop > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-krypt-warn/25 bg-krypt-warn/[0.07] px-2.5 py-2 text-label text-krypt-muted">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-krypt-warn mt-[1px]" />
                <span>
                  <span className="text-white/85">{tooFastTop} of the top {Math.min(10, leaderRows.length)} finish most trades inside a minute.</span>{' '}
                  Ranking by a wallet&rsquo;s own profit favours wallets whose edge is speed, and speed is the one edge a copy
                  cannot take: their trade is over before yours lands. Sort by <span className="text-white/70">Hold time</span> to
                  see the wallets you could actually be in.
                </span>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-body font-mono">
                <thead>
                  <tr className="text-micro uppercase tracking-label text-krypt-muted/60">
                    <th className="text-left font-normal py-1 pr-2">#</th>
                    <th className="text-left font-normal py-1 pr-3">Wallet</th>
                    <th className="text-right font-normal py-1 px-2">Trades</th>
                    <th className="text-right font-normal py-1 px-2">Win</th>
                    <th className="text-right font-normal py-1 px-2" title="SOL this wallet has realised on closed round trips — their money, not yours">
                      Realized SOL
                    </th>
                    <th className="text-right font-normal py-1 px-2" title="Realised SOL as a percentage of what they put in">Return %</th>
                    <th className="text-right font-normal py-1 px-2" title="Positions they still hold · SOL they paid for them">Open</th>
                    <th className="text-right font-normal py-1 px-2" title="SOL they are up or down on what they still hold">Unreal. SOL</th>
                    <th
                      className="text-right font-normal py-1 px-2"
                      title="Median hold across their closed round trips — median, not average, because one long position drags an average by orders of magnitude. A trip shorter than a minute was over before a copy could have joined it."
                    >
                      Hold
                    </th>
                    <th className="text-right font-normal py-1 px-2">/ day</th>
                    <th className="text-right font-normal py-1 px-2" title="Copies you took from this wallet · SOL you realised on the closed ones">
                      Your copies
                    </th>
                    <th className="text-right font-normal py-1 pl-2">Since</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {leaderRows.map((l, i) => {
                    const wr = leaderWinRate(l);
                    const small = l.roundTrips < MIN_TRIPS_FOR_RANK;
                    const tooFast = leaderTooFast(l);
                    const ours = ourCopies(l.wallet);
                    const scored = l.roundTrips > 0 || l.realizedPnlSol !== 0;
                    return (
                      <tr key={l.wallet} className="border-t border-white/[0.06] hover:bg-white/[0.03]">
                        <td className="py-1.5 pr-2 text-krypt-muted/60">{i + 1}</td>
                        <td className="py-1.5 pr-3">
                          <div className="text-white/90 truncate max-w-[10rem]">{labelFor(l.wallet)}</div>
                          <div className="text-micro text-krypt-muted/60">
                            {shortAddr(l.wallet, 4)}
                            {small ? ` · ${l.roundTrips}/${MIN_TRIPS_FOR_RANK} closed` : ''}
                          </div>
                          {tooFast && (
                            <div
                              className="text-micro text-krypt-warn/90"
                              title={`${l.tooFastPct?.toFixed(0)}% of this wallet's closed round trips opened and closed inside a minute. A copy has to see the buy, land it, then do the same to exit — those trades were over first. Their profit on them is not reachable, however good it looks.`}
                            >
                              too fast to copy
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right text-white/85">
                          {l.roundTrips}
                          <span className="text-krypt-muted/60"> ({l.wins}/{l.losses})</span>
                        </td>
                        <td className="py-1.5 px-2 text-right text-white/85">{wr === null ? '—' : `${wr.toFixed(0)}%`}</td>
                        <td className={cls('py-1.5 px-2 text-right', scored ? toneFor(l.realizedPnlSol) : 'text-krypt-muted')}>
                          {scored ? signed(l.realizedPnlSol) : '—'}
                        </td>
                        <td className={cls('py-1.5 px-2 text-right', l.returnPct === null ? 'text-krypt-muted' : toneFor(l.returnPct))}>
                          {l.returnPct === null ? '—' : `${l.returnPct >= 0 ? '+' : ''}${l.returnPct.toFixed(0)}%`}
                        </td>
                        <td className="py-1.5 px-2 text-right text-white/85">
                          {l.openCount}
                          {l.openCount > 0 ? <span className="text-krypt-muted/60"> · {l.openCostSol.toFixed(2)}</span> : null}
                        </td>
                        <td className={cls('py-1.5 px-2 text-right', l.unrealizedPnlSol === null ? 'text-krypt-muted' : toneFor(l.unrealizedPnlSol))}>
                          {l.unrealizedPnlSol === null ? '—' : signed(l.unrealizedPnlSol)}
                        </td>
                        <td
                          className={cls('py-1.5 px-2 text-right', tooFast ? 'text-krypt-warn' : 'text-white/85')}
                          title={
                            l.avgHoldMs === null
                              ? undefined
                              : `average ${fmtDur(l.avgHoldMs)}${l.tooFastPct === null ? '' : ` · ${l.tooFastPct.toFixed(0)}% of their trips finished inside a minute`}`
                          }
                        >
                          {l.medianHoldMs === null ? '—' : fmtDur(l.medianHoldMs)}
                        </td>
                        <td className="py-1.5 px-2 text-right text-white/85">{l.tradesPerDay === null ? '—' : l.tradesPerDay.toFixed(1)}</td>
                        <td className="py-1.5 px-2 text-right text-white/85">
                          {ours.copies}
                          {ours.closed > 0 ? <span className={toneFor(ours.realized)}> · {signed(ours.realized)}</span> : null}
                        </td>
                        <td className="py-1.5 pl-2 text-right text-krypt-muted/70">{l.watchedSince ? `${fmtAgo(l.watchedSince)} ago` : '—'}</td>
                        <td className="py-1.5 pl-2 text-right">
                          <button
                            onClick={() => void resetLeader(l.wallet)}
                            title="Start this wallet's record over"
                            className="text-krypt-muted/50 hover:text-white transition"
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {leaderRows.some((l) => l.unscoredSells > 0) && (
              <p className="text-label text-krypt-muted/60">
                Sells of tokens bought before you followed: {leaderRows.reduce((a, l) => a + l.unscoredSells, 0)} — counted in the
                trade rate, left out of PnL.
              </p>
            )}
          </Card>
        </Section>
      )}

      <Section
        title="Followed wallets"
        description="Paper mode simulates the fills — including your configured delay and the 1%/side protocol fee — so the record is one a real execution could have produced."
      >
        {snap && snap.configs.length > 0 ? (
          <div className="space-y-2">
            {snap.configs.map((c) => {
              const st = snap.stats[c.id];
              const wr = st ? winRate(st) : null;
              return (
                <Card key={c.id} className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={cls(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-bold uppercase tracking-wider',
                        c.mode === 'paper'
                          ? 'border-white/15 bg-white/5 text-krypt-muted'
                          : 'border-rose-400/40 bg-rose-500/15 text-rose-300',
                      )}
                    >
                      {c.mode === 'paper' ? <FlaskConical className="h-2.5 w-2.5" /> : <Zap className="h-2.5 w-2.5" />}
                      {c.mode}
                    </span>
                    {directionOf(c) === 'reverse' && (
                      <span
                        className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-amber-300"
                        title="Buys when they sell, sells when they buy back; closes on its own take-profit, stop-loss or max hold."
                      >
                        reverse
                      </span>
                    )}
                    {isFomo(c) && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-krypt-purple/40 bg-krypt-purple/10 px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-krypt-purple"
                        title="Buys when several wallets from a set pile into the same coin; exits when the crowd leaves or on its own take-profit, stop-loss or max hold."
                      >
                        <Users className="h-2.5 w-2.5" />
                        fomo
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="text-value font-semibold text-white truncate">
                        {c.label || (isFomo(c) ? FOMO_SOURCE_LABEL[fomoRuleOf(c).source] : shortAddr(c.wallet, 6))}
                      </div>
                      {isFomo(c) ? (
                        <div className="text-label text-krypt-muted">
                          {fomoRuleOf(c).minWallets} of {FOMO_SOURCE_LABEL[fomoRuleOf(c).source].toLowerCase()} within {fomoRuleOf(c).windowSec} s
                        </div>
                      ) : (
                        <div className="text-label font-mono text-krypt-muted">{shortAddr(c.wallet, 6)}</div>
                      )}
                      <div className="text-label text-krypt-muted">
                        {chainName(chainOf(c))} · signs with{' '}
                        {c.walletId ? (walletsFor(chainOf(c)).find((w) => w.id === c.walletId)?.label ?? 'a wallet that no longer exists') : 'the active wallet'}
                      </div>
                    </div>

                    <div className="flex-1" />

                    <div className="flex items-center rounded-md border border-white/10 overflow-hidden">
                      {(['paper', 'live'] as const).map((m) => (
                        <button
                          key={m}
                          onClick={() => void setMode(c, m)}
                          className={cls(
                            'px-2.5 py-1 text-label font-semibold transition',
                            c.mode === m
                              ? m === 'live'
                                ? 'bg-rose-500/25 text-rose-200'
                                : 'bg-white/10 text-white'
                              : 'text-krypt-muted hover:text-white',
                          )}
                        >
                          {m}
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={() => void toggle(c)}
                      className={cls(
                        'rounded-md border px-3 py-1.5 text-body font-bold uppercase tracking-wider transition',
                        c.enabled
                          ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                          : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white',
                      )}
                    >
                      {c.enabled ? 'Following' : 'Paused'}
                    </button>

                    <GhostButton onClick={() => setEditing(c)} className="!py-1.5 !px-2.5 text-body">
                      Edit
                    </GhostButton>
                    <button
                      onClick={() => void resetPaper({ id: c.id, label: c.label, wallet: c.wallet })}
                      title="Clear this wallet's paper results — settings, live trades and their own record all stay"
                      className="text-krypt-muted/60 hover:text-white transition"
                    >
                      <FlaskConical className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => void remove(c.id)}
                      className="text-krypt-muted/60 hover:text-rose-300 transition"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Scorecard */}
                  {st && (
                    <div className="grid grid-cols-3 md:grid-cols-7 gap-3 pt-2 border-t border-white/8">
                      {[
                        ['Copies', String(st.trades)],
                        ['Open', String(st.openCount)],
                        ['Win rate', wr === null ? '—' : `${wr.toFixed(0)}%`],
                        ['W / L', `${st.wins}/${st.losses}`],
                        ['Realized SOL', st.wins + st.losses === 0 ? '—' : `${st.realizedPnlSol >= 0 ? '+' : ''}${st.realizedPnlSol.toFixed(3)}`],
                        ['Filtered out', String(st.skipped)],
                        ['Limit-blocked', String(st.blocked)],
                      ].map(([label, value], i) => (
                        <div key={label}>
                          <div className="text-micro uppercase tracking-label text-krypt-muted/60">{label}</div>
                          <div
                            className={cls(
                              'text-value font-mono font-semibold mt-0.5',
                              i === 4 && st.wins + st.losses > 0 ? toneFor(st.realizedPnlSol) : 'text-white',
                            )}
                          >
                            {value}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* "How would I cash out?" was the single most asked
                      question about copy trading (2026-09-13): the page
                      shows a running PnL and no sell button anywhere, so it
                      reads as money locked inside the feature. Say where the
                      position actually lives. */}
                  {st && st.openCount > 0 && (
                    <p className="text-label text-krypt-muted/70 leading-relaxed">
                      {c.mode === 'live' ? (
                        <>
                          {st.openCount} open cop{st.openCount === 1 ? 'y is' : 'ies are'} ordinary holdings in your
                          wallet — sell {st.openCount === 1 ? 'it' : 'them'} on Portfolio, or on the token page, like
                          anything else you bought. Copies also close on their own when this wallet sells.
                        </>
                      ) : (
                        <>
                          {st.openCount} open cop{st.openCount === 1 ? 'y is' : 'ies are'} simulated — nothing was
                          bought and there is nothing to cash out. They close when this wallet sells, or when your exit
                          rules fire. Switch to live to trade this wallet for real.
                        </>
                      )}
                    </p>
                  )}

                  {/* How the wallet is being watched. Every followed wallet
                      has its own subscription on the live socket, on any DEX;
                      this line is what turns silence into an explanation. */}
                  {c.enabled && isFomo(c) && (() => {
                    const crowd = snap?.crowd?.[c.id];
                    if (!crowd) return null;
                    if (crowd.wallets === 0) {
                      return (
                        <p className="text-label text-arc-gold/90">
                          Listening to nobody: {FOMO_SOURCE_LABEL[crowd.source].toLowerCase()} is empty right now, so this crowd cannot fire.
                        </p>
                      );
                    }
                    return (
                      <p className="text-label text-krypt-muted/60">
                        Listening to {crowd.wallets} wallet{crowd.wallets === 1 ? '' : 's'} ({FOMO_SOURCE_LABEL[crowd.source].toLowerCase()}) on the
                        curve feed and their own subscriptions.
                      </p>
                    );
                  })()}
                  {c.enabled && !isFomo(c) && (() => {
                    const w = snap?.watch?.[c.wallet];
                    if (!w) return null;
                    if (w.state === 'over-cap') {
                      return (
                        <p className="text-label text-arc-gold/90">
                          Not watched: the endpoint refused this subscription. It may be busy — the app will keep the
                          others watched and retry this one.
                        </p>
                      );
                    }
                    // An EVM leader has no subscription of its own — it is
                    // seen through that chain's scanner poll — so it gets its
                    // own wording rather than a line about a socket it is not on.
                    const evm = (c.chain ?? 'solana') !== 'solana';
                    if (w.state === 'off') {
                      return (
                        <p className="text-label text-rose-300/80">
                          {evm
                            ? `Not watched — the ${nativeSymbolOf(c.chain ?? 'solana')} chain scanner is not running, and this wallet is only seen through it.`
                            : 'Not watched — no websocket endpoint is configured.'}
                        </p>
                      );
                    }
                    if (w.state === 'connecting') {
                      return <p className="text-label text-krypt-muted/60">{evm ? 'Starting the chain scanner…' : 'Connecting to the live socket…'}</p>;
                    }
                    if (evm) {
                      return (
                        <p className="text-label text-krypt-muted/60">
                          Watching through the chain scanner{w.lastSeenAt ? `, last polled ${fmtAgo(w.lastSeenAt)} ago` : ''} · {w.swaps} trade
                          {w.swaps === 1 ? '' : 's'} seen{w.lastSwapAt ? ` (last ${fmtAgo(w.lastSwapAt)} ago)` : ''}
                        </p>
                      );
                    }
                    return (
                      <p className="text-label text-krypt-muted/60">
                        Watching on the live socket{w.feed === 'tx' ? ' with pushed transactions' : ''}, any DEX · {w.seen} transaction{w.seen === 1 ? '' : 's'} seen
                        {w.lastSeenAt ? `, last ${fmtAgo(w.lastSeenAt)} ago` : ' so far'} · {w.swaps} swap{w.swaps === 1 ? '' : 's'}
                        {w.lastSwapAt ? ` (last ${fmtAgo(w.lastSwapAt)} ago)` : ''}
                        {(w.notSwap ?? 0) > 0 && <span title="Read fine, but not a swap this copier acts on — a transfer, an LP move, a claim."> · {w.notSwap} not swaps</span>}
                        {(w.unreadable ?? 0) > 0 && (
                          // The stage where a trade disappears silently: the socket saw
                          // it, the RPC would not hand it over. Those were NOT copied.
                          <span className="text-rose-300/80" title="Seen on the socket, but the RPC could not return the transaction after every retry. Those trades were not copied — the Console has the reason for each.">
                            {' '}· {w.unreadable} unreadable
                          </span>
                        )}
                      </p>
                    );
                  })()}
                  {st && st.trades === 0 && c.enabled && (
                    <p className="text-label text-krypt-muted/60">
                      Nothing copied yet. Every trade this wallet signs is read from the live socket, whatever DEX it
                      used; buys that pass your filters appear here, and skipped ones say why.
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        ) : (
          <Empty
            title="Not following anyone"
            message="Add a wallet to paper-trade it. The app records what following it would have done, filters and latency included, so you can decide with evidence."
          />
        )}

        {snap && !snap.liveExecutable && snap.configs.some((c) => c.mode === 'live' && c.enabled) && (
          <div className="mt-3 rounded-lg border border-arc-gold/35 bg-arc-gold/10 px-3 py-2 flex items-start gap-2">
            <TriangleAlert className="h-4 w-4 text-arc-gold flex-shrink-0 mt-0.5" />
            <p className="text-body text-arc-gold/90">
              Live copying is armed but cannot execute — {snap.liveBlockedReason}.
            </p>
          </div>
        )}
      </Section>

      {/* Where the time goes (2026-09-21). Shown whenever anything has been
          timed, paper included — the detection half costs the same either
          way, so a follower can measure it without spending. */}
      {snap?.latency && snap.latency.samples > 0 && <CopyLatencyPanel l={snap.latency} />}

      {/* Recent copies */}
      {snap && snap.recent.length > 0 && (
        <Section title="Recent copies" description="Including the ones your filters rejected — a scorecard that hides the skips is measuring the wrong thing.">
          <div className="space-y-1">
            {snap.recent.slice(0, 30).map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 rounded-md px-3 py-1.5 text-body font-mono hover:bg-white/[0.04] transition"
              >
                <span className="text-krypt-muted/60 w-14">{fmtAgo(t.at)}</span>
                <span
                  className={cls(
                    'w-16 font-bold',
                    t.leftoverRaw ? 'text-arc-gold' : t.state === 'skipped' ? 'text-krypt-muted/50' : t.state === 'open' ? 'text-krypt-pink' : 'text-white/80',
                  )}
                >
                  {t.kind === 'exit' ? (t.state === 'skipped' ? 'no sell' : 'sold') : t.leftoverRaw ? 'leftover' : t.state}
                </span>
                <span className="w-24 truncate text-white/85">{t.symbol || shortAddr(t.mint, 4)}</span>
                <span className="w-24 text-krypt-muted">they {t.theirSol.toFixed(2)}</span>
                <span className="w-28 text-white/85">us {t.ourSol.toFixed(3)} {nativeSymbolOf(t.chain ?? 'solana')}</span>
                <span className={cls('w-20 text-right', toneFor(t.pnlSol ?? t.realizedSol ?? null))}>
                  {(() => {
                    const v = t.pnlSol ?? t.realizedSol ?? null;
                    return v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
                  })()}
                </span>
                <span className="flex-1 text-krypt-muted/55 truncate text-right">
                  {t.reason ??
                    (t.kind === 'exit'
                      ? // `soldPct` is OUR share; `leaderPct` only exists when the two
                        // differ, and that gap is the thing worth reading.
                        `sold ${t.soldPct ?? 100}%${t.leaderPct !== undefined ? ` — they sold ${t.leaderPct}%` : ' with them'}${t.signature ? '' : t.mode === 'live' ? '' : ' (paper)'}`
                      : t.state === 'open' && t.remainingPct !== undefined && t.remainingPct < 100
                        ? `${Math.round(t.remainingPct)}% still held`
                        : '')}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Tracker */}
      <Section
        title="Tracked wallets"
        description="Labelled wallets show up on token pages, in the trade tape, and can raise alerts. Tracking alone never trades."
      >
        <Card className="space-y-3">
          <div className="flex gap-2">
            <input
              value={newAddr}
              onChange={(e) => setNewAddr(e.target.value)}
              placeholder="Wallet address"
              spellCheck={false}
              className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white outline-none focus:border-krypt-purple/50"
            />
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Label"
              maxLength={32}
              className="w-48 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/50"
            />
            <GhostButton onClick={() => void addTracked()} disabled={newAddr.trim().length < 32}>
              Track
            </GhostButton>
          </div>

          {tracked.length === 0 ? (
            <p className="text-body text-krypt-muted/60">No tracked wallets yet.</p>
          ) : (
            <div className="space-y-1">
              {tracked.map((w) => (
                <div key={w.address} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.04] transition">
                  <span className="text-note text-arc-gold w-40 truncate">{w.label || '—'}</span>
                  <button
                    onClick={() => void window.krypt.app.openExternal(`https://solscan.io/account/${w.address}`)}
                    className="font-mono text-body text-white/80 hover:text-krypt-purple"
                  >
                    {shortAddr(w.address, 6)}
                  </button>
                  <div className="flex-1" />
                  <GhostButton
                    onClick={() => setEditing({ ...defaultConfig(w.address, w.label) })}
                    className="!py-1 !px-2 text-label"
                  >
                    <Copy className="h-3 w-3" />
                    Paper-copy
                  </GhostButton>
                  <button
                    onClick={() => {
                      void window.krypt.watchlist.remove(w.address).then(() => load());
                    }}
                    className="text-krypt-muted/60 hover:text-rose-300 transition"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>
    </Page>
  );
}
