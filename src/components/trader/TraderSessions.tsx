// Krypto Trader — the sessions list (design §1, right column).
//
// A sibling of terminal/KryptoSessions rather than a parameterised copy: a
// Trader session keeps a book from its own fills (base units, lots, fees),
// a "vs just holding" line, an in-flight record and user-set limits, while a
// Krypto Mode bot has its own funded wallet, a goal and a withdraw step. The
// two cards share almost no fields, and Krypto Mode's behaviour stays
// exactly as it was.
//
// Every number the app has not read is an em dash, never 0. "Sell session
// bag" is on every row in every state — it is an exit, and exits are never
// blocked (order-safety rule 2).

import { useCallback, useEffect, useState } from 'react';
import { CandlestickChart, Loader2 } from 'lucide-react';
import {
  PAPER_IMPACT_NOTE,
  TRADER_DRIVER_TEXT,
  TRADER_MAX_THESIS,
  TRADER_PRESET_TEXT,
  traderAiCostEstimate,
  traderMoney,
  traderNativeText,
  type TraderLimits,
  type TraderOptions,
  type TraderRow,
} from '@shared/kryptoTrader';
import { useToast } from '../../state/ToastProvider';
import { useModal } from '../../state/ModalProvider';
import { cls, shortAddr } from '../../utils/format';
import { Empty } from '../common';
import { AntiWashLine, TraderLimitsFields } from './LimitsFields';

const DASH = '—';
// Money is the session chain's coin: SOL, ETH on Robinhood Chain, or BNB.
const sol = (v: number | null | undefined, dp = 4, unit = 'SOL'): string => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(dp)} ${unit}` : DASH);
const signed = (v: number | null | undefined, dp = 4, unit = 'SOL'): string => (typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(dp)} ${unit}` : DASH);
const chainTag = (c: TraderRow['options']['chain']): string => (c === 'bnb' ? 'BNB' : c === 'robinhood' ? 'Robinhood' : 'Solana');
const tone = (v: number | null | undefined): string => (typeof v !== 'number' || !Number.isFinite(v) || v === 0 ? 'text-white/90' : v > 0 ? 'text-emerald-300' : 'text-rose-300');
const tokens = (v: number | null): string => (v === null ? DASH : v.toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 0 : 4 }));

function nextTrade(at: number | null, now: number): string {
  if (at === null) return DASH;
  const s = Math.round((at - now) / 1000);
  if (s <= 0) return 'now';
  if (s < 90) return `in ${s} s`;
  return `in ${Math.round(s / 60)} min`;
}

type Act = 'pause' | 'resume' | 'goLive' | 'sellAll' | 'remove' | 'reconcile' | 'adopt';

export function TraderSessions() {
  const toast = useToast();
  const modal = useModal();
  const [rows, setRows] = useState<TraderRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<{ id: string; what: 'envelope' | 'limits' } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    const l = await window.krypt.kryptoTrader.list();
    if (l.ok && l.data) {
      setRows(l.data.sessions);
      setFailure(l.data.failure);
    } else setRows((cur) => cur ?? []);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.krypt.kryptoTrader.list().then((r) => {
      if (!alive) return;
      if (r.ok && r.data) {
        setRows(r.data.sessions);
        setFailure(r.data.failure);
      } else setRows([]);
    });
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'kryptoTrader') setRows(ev.sessions);
    });
    // The "next trade" countdown only; nothing is fetched on this tick.
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      off();
      window.clearInterval(t);
    };
  }, []);

  const act = useCallback(
    async (s: TraderRow, what: Act) => {
      const name = s.symbol || shortAddr(s.options.mint, 4);
      if (what === 'goLive') {
        const yes = await modal.confirm({
          title: `Take ${name} live`,
          message:
            traderNativeText(
              `From now on this session spends real SOL from ${shortAddr(s.address, 6)} on ${chainTag(s.options.chain)}, up to its ${s.options.budgetSol} SOL budget, ` +
                `each trade within your per-trade cap. Its paper book is set aside and the live book starts empty; `,
              s.options.chain,
            ) +
            `whatever this wallet already holds of the coin is excluded and never sold by the session. ` +
            `In our tests every preset lost money on the typical coin.`,
          confirmLabel: 'Go live',
          destructive: true,
        });
        if (!yes) return;
      }
      if (what === 'sellAll' && s.mode === 'live') {
        const yes = await modal.confirm({
          title: `Sell ${name}'s session bag`,
          message: 'Sells only the tokens this session bought, at market, and stops the session once the sell lands. Tokens the wallet held before are untouched.',
          confirmLabel: 'Sell session bag',
          destructive: true,
        });
        if (!yes) return;
      }
      if (what === 'adopt' && s.inFlight === null && s.unsettled.length === 0) {
        const yes = await modal.confirm({
          title: 'Fit the session to the wallet',
          message:
            'If the wallet now holds less of this coin than the session booked (tokens moved out, or a sell whose result could not be read), the session’s bag shrinks to what the wallet holds. The missing tokens are booked as sold for nothing. It never grows the bag.',
          confirmLabel: 'Fit to wallet',
        });
        if (!yes) return;
      } else if (what === 'adopt') {
        const yes = await modal.confirm({
          title: 'Adopt the balance change',
          message:
            'A trade was sent but its fill could not be read. Adopt takes the change in this wallet’s balance of the coin since the session went live as the session’s own. ' +
            traderNativeText('The cost is taken as the SOL asked for, not read from the chain. Use Reconcile first; adopt only if it cannot find the trade.', s.options.chain),
          confirmLabel: 'Adopt',
        });
        if (!yes) return;
      }
      if (what === 'remove') {
        const yes = await modal.confirm({ title: `Remove ${name}`, message: 'Removes the session and its trade log.', confirmLabel: 'Remove', destructive: true });
        if (!yes) return;
      }
      setBusy(`${s.id}:${what}`);
      try {
        const r = await window.krypt.kryptoTrader[what](s.id);
        if (r.ok) toast.success(r.message);
        else toast.error(r.message);
        await reload();
      } finally {
        setBusy('');
      }
    },
    [modal, reload, toast],
  );

  if (rows === null) return <div className="text-body text-krypt-muted">Loading…</div>;

  return (
    <div className="space-y-3">
      {failure && <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-body text-rose-200">{failure}</div>}
      {rows.length === 0 ? (
        <Empty title="No sessions yet" message="Pick a coin, a wallet and a preset on the left, then Start (paper)." />
      ) : (
        rows.map((s) => {
          const d = s.derived;
          const u = traderMoney(s.options.chain).symbol;
          const b = (w: string) => busy === `${s.id}:${w}`;
          const stuck = s.inFlight !== null || s.unsettled.length > 0;
          const heldRaw = !/^0*$/.test(s.book.tokensRaw);
          const removable = s.status === 'stopped' && !(s.mode === 'live' && (heldRaw || stuck));
          return (
            <div key={s.id} data-session={s.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CandlestickChart className="h-4 w-4 text-krypt-purple" />
                  <span className="text-note font-semibold text-white">{s.symbol || shortAddr(s.options.mint, 4)}</span>
                  <span className={cls('rounded-full border px-2 py-0.5 text-micro font-bold uppercase tracking-wider', s.mode === 'live' ? 'border-krypt-pink/40 bg-krypt-pink/15 text-white' : 'border-white/15 bg-white/5 text-krypt-muted')}>
                    {s.mode}
                  </span>
                  <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-micro uppercase tracking-wider text-krypt-muted">{s.status}</span>
                  <span data-chain-tag className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-micro uppercase tracking-wider text-krypt-muted">{chainTag(s.options.chain)}</span>
                  {/* Stale whenever the figures lean on an old price — a paused or stopped row with a bag too (review #22). */}
                  {d.priceStale && (s.status === 'running' || heldRaw) && (
                    <span
                      data-price-stale
                      className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-micro uppercase tracking-wider text-amber-300"
                      title={
                        s.status === 'running'
                          ? 'The price is older than a minute: only exits run until a fresh one is read.'
                          : `Unrealised, Equity, Gross P&L and vs just holding use the last price read${s.lastPriceAt ? ` (${new Date(s.lastPriceAt).toLocaleString()})` : ''} — not a current one.`
                      }
                    >
                      price stale
                    </span>
                  )}
                </div>
                <span className="text-label text-krypt-muted">
                  {TRADER_PRESET_TEXT[s.options.preset].label} · {TRADER_DRIVER_TEXT[s.options.driver].label}
                </span>
              </div>
              <div className="mt-1.5 select-all break-all font-mono text-label text-krypt-muted">wallet {s.address}</div>
              <div className="select-all break-all font-mono text-label text-krypt-muted/70">coin {s.options.mint}</div>

              {s.note && <div className="mt-2 text-label text-krypt-muted">{s.note}</div>}
              {s.pendingExit && (
                <div className="mt-2 rounded-md border border-rose-400/30 bg-rose-500/10 p-2 text-label text-rose-200">
                  Stop waiting to sell: {s.pendingExit.reason}. It fires as soon as selling is possible again.
                </div>
              )}
              {stuck && (
                <div className="mt-2 rounded-md border border-amber-400/25 bg-amber-400/[0.07] p-2 text-label text-amber-100/85">
                  {s.inFlight
                    ? `A ${s.inFlight.side} was in flight and its result is unknown.`
                    : s.unsettled.some((x) => x.unprovable)
                      ? `Whether a trade landed cannot be proven from the chain (${s.unsettled.find((x) => x.unprovable)?.unprovable}).`
                      : `${s.unsettled.length} trade${s.unsettled.length === 1 ? '' : 's'} still settling.`}{' '}
                  Reconcile reads the chain for it; Adopt takes the wallet’s balance change instead.
                </div>
              )}
              {d.antiWashOff.length > 0 && (
                <div className="mt-2">
                  <AntiWashLine />
                </div>
              )}
              {s.options.driver === 'ai' && <AiStrip s={s} now={now} />}
              {s.options.driver === 'mcp' && (
                <div data-mcp-strip className="mt-2 rounded-md border border-white/10 bg-white/[0.03] p-2 text-label text-krypt-muted">
                  Driven over MCP · seq <span className="font-mono text-white/85">{s.seq}</span>
                  {s.status === 'running' ? ' · waiting for trader_act; the stops run without it.' : ` · ${s.status}: trader_act is refused until you resume it.`}
                </div>
              )}

              <div className="mt-2 grid grid-cols-2 gap-2 text-body sm:grid-cols-4">
                <Fig label="Budget" value={sol(s.options.budgetSol, 3, u)} />
                <Fig label="Room left" value={sol(d.roomSol, 4, u)} />
                <Fig label="Tokens" value={tokens(d.tokens)} />
                <Fig label={`${u} in (held)`} value={sol(s.book.openCostSol, 4, u)} />
                <Fig label="Average cost" value={d.avgCostSol === null ? DASH : `${d.avgCostSol.toPrecision(4)} ${u}`} />
                <Fig label="Realised" value={signed(s.book.realisedSol, 4, u)} cls={tone(s.book.realisedSol)} />
                <Fig label="Unrealised" value={signed(d.unrealisedSol, 4, u)} cls={tone(d.unrealisedSol)} />
                <Fig label="Equity" value={sol(d.equitySol, 4, u)} />
                <Fig label="Gross P&L" value={signed(d.grossPnlSol, 4, u)} cls={tone(d.grossPnlSol)} hint="Before fees" />
                <Fig label="Fees paid" value={sol(s.book.feesSol, 4, u)} hint="Krypt + pool + network, estimated" />
                <Fig label="vs just holding" value={signed(d.vsHoldSol, 4, u)} cls={tone(d.vsHoldSol)} hint="Against the same budget bought at the start and held" />
                <Fig label="Next trade" value={s.status === 'running' ? nextTrade(d.nextTradeAt, now) : DASH} />
              </div>

              {s.trades.length > 0 && (
                <div className="mt-2 max-h-40 space-y-0.5 overflow-auto rounded-lg border border-white/5 bg-black/20 p-2 font-mono text-label">
                  {s.trades.slice(0, 20).map((t, i) => (
                    <div key={`${t.at}-${t.side}-${i}`} className={t.ok ? 'text-white/80' : 'text-rose-300/80'}>
                      {new Date(t.at).toLocaleTimeString()} {t.mode === 'paper' ? 'paper ' : ''}
                      {t.side} {t.side === 'buy' ? sol(t.sol, 4, u) : `${t.pct ?? DASH}% of bag${t.walletPct !== null ? ` (${t.walletPct}% of wallet)` : ''}${t.sol !== null ? ` → ${sol(t.sol, 4, u)}` : ''}`}
                      {' · '}
                      {t.reason}
                      {t.by !== 'strategy' ? ` · by ${t.by}` : ''}
                      {t.ok ? '' : ` · ${t.message}`}
                      {t.notes.length > 0 && (
                        <span className={cls(t.notes.includes(PAPER_IMPACT_NOTE) ? 'text-amber-200/70' : 'text-krypt-muted')}> · {t.notes.join(' · ')}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.status === 'running' && <Btn onClick={() => void act(s, 'pause')} busy={b('pause')}>Pause</Btn>}
                {s.status === 'paused' && <Btn onClick={() => void act(s, 'resume')} busy={b('resume')}>Resume</Btn>}
                {s.mode === 'paper' && s.status !== 'stopped' && (
                  <Btn onClick={() => void act(s, 'goLive')} busy={b('goLive')} strong>
                    Go live…
                  </Btn>
                )}
                <Btn onClick={() => void act(s, 'sellAll')} busy={b('sellAll')}>Sell session bag</Btn>
                {stuck && s.inFlight && <Btn onClick={() => void act(s, 'reconcile')} busy={b('reconcile')}>Reconcile</Btn>}
                {stuck && s.mode === 'live' && <Btn onClick={() => void act(s, 'adopt')} busy={b('adopt')}>Adopt…</Btn>}
                {/* Always a way out when the book outgrew the wallet (tokens moved out, a sell the ledger could not read): shrink it to what the wallet holds (review #3). */}
                {!stuck && s.mode === 'live' && heldRaw && s.status !== 'running' && (
                  <Btn onClick={() => void act(s, 'adopt')} busy={b('adopt')}>
                    Fit to wallet…
                  </Btn>
                )}
                <Btn onClick={() => setEditing(editing?.id === s.id && editing.what === 'envelope' ? null : { id: s.id, what: 'envelope' })} busy={false}>
                  {editing?.id === s.id && editing.what === 'envelope' ? 'Close envelope' : 'Edit envelope'}
                </Btn>
                <Btn onClick={() => setEditing(editing?.id === s.id && editing.what === 'limits' ? null : { id: s.id, what: 'limits' })} busy={false}>
                  {editing?.id === s.id && editing.what === 'limits' ? 'Close limits' : 'Edit limits'}
                </Btn>
                {removable && <Btn onClick={() => void act(s, 'remove')} busy={b('remove')}>Remove</Btn>}
              </div>
              {editing?.id === s.id && editing.what === 'envelope' && <EnvelopeEditor key={`${s.id}:env`} s={s} onSaved={() => void reload()} />}
              {editing?.id === s.id && editing.what === 'limits' && <LimitsEditor key={`${s.id}:lim`} s={s} onSaved={() => void reload()} />}
            </div>
          );
        })
      )}
    </div>
  );
}

/** The AI driver on a row: model, what it cost today against the cap, what
 *  it is expected to cost, and its last answer. The reason for each trade it
 *  made is on that trade's line in the log below. */
function AiStrip({ s, now }: { s: TraderRow; now: number }) {
  const a = s.ai;
  const model = a?.lastModel ?? s.options.aiModel ?? null;
  const today = new Date(now).toISOString().slice(0, 10);
  // The ask count and a pause reason are the AI day's too: a paused session
  // is not rolled over at midnight, so yesterday's are not shown as today's
  // (review #24).
  const isToday = s.aiSpend.day === today;
  const spent = isToday ? s.aiSpend.usd : 0;
  const est = model ? traderAiCostEstimate(model, s.options.limits) : null;
  const money = (v: number): string => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
  return (
    <div data-ai-strip className="mt-2 space-y-0.5 rounded-md border border-white/10 bg-white/[0.03] p-2 text-label text-krypt-muted">
      <div>
        AI <span className="font-mono text-white/85">{model ?? 'default model'}</span> · spent today <span className="font-mono text-white/85">{money(spent)}</span>
        {s.options.aiDailyUsdCap > 0 ? ` of ${money(s.options.aiDailyUsdCap)}` : ' (no daily cap)'}
        {est && (
          <>
            {' '}
            · est. <span className="font-mono text-white/85">{money(est.typicalPerHourUsd)}/hour</span>, <span className="font-mono text-white/85">{money(est.typicalPerDayUsd)}/day</span>
            {est.estimate ? ' (price not confirmed)' : ''}
          </>
        )}
        {isToday && a && a.asksToday > 0 ? ` · ${a.asksToday} ask${a.asksToday === 1 ? '' : 's'} today` : ''}
      </div>
      {isToday && a?.pausedReason && <div className="text-amber-200/90">{a.pausedReason}</div>}
      {a?.lastError && <div className="text-rose-300/85">{a.lastError}</div>}
      {a?.lastAction && (
        <div>
          Last answer: <span className="text-white/85">{a.lastAction}</span>
          {a.lastReason ? ` — ${a.lastReason}` : ''}
          {a.lastTrigger ? <span className="text-krypt-muted/70"> (asked on {a.lastTrigger})</span> : null}
        </div>
      )}
    </div>
  );
}

function Fig({ label, value, cls: c, hint }: { label: string; value: string; cls?: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-label text-krypt-muted">{label}</div>
      <div className={cls('font-mono tabular-nums', c ?? 'text-white/90')}>{value}</div>
    </div>
  );
}

type Envelope = Pick<TraderOptions, 'maxLossPct' | 'timeLimitH' | 'atExpiry' | 'reinvest' | 'thesis'>;

/** Max loss, time limit, what happens at expiry, reinvest, thesis. */
export function EnvelopeFields({ v, onChange }: { v: Envelope; onChange: (patch: Partial<Envelope>) => void }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <NumBox label="Max loss (% of budget)" hint="10–90. The session sells its bag and stops when its equity falls this far." value={v.maxLossPct} onChange={(n) => onChange({ maxLossPct: n })} />
        <NumBox label="Time limit (hours)" hint="1–168, from the start (and again from going live)." value={v.timeLimitH} onChange={(n) => onChange({ timeLimitH: n })} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-body">
        <span className="text-label text-krypt-muted">At the time limit</span>
        {(['sell', 'hold'] as const).map((x) => (
          <label key={x} className="inline-flex cursor-pointer items-center gap-1.5 text-white/85">
            <input type="radio" checked={v.atExpiry === x} onChange={() => onChange({ atExpiry: x })} className="accent-[rgb(var(--krypt-accent))]" />
            {x === 'sell' ? 'Sell the session bag' : 'Keep holding it'}
          </label>
        ))}
      </div>
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" checked={v.reinvest} onChange={(e) => onChange({ reinvest: e.target.checked })} className="mt-0.5 accent-[rgb(var(--krypt-accent))]" />
        <span>
          <span className="block text-body text-white/85">Reinvest profit</span>
          <span className="block text-label text-krypt-muted/70">Off: profit is never re-spent. On: realised profit can grow the room, up to 2× the budget.</span>
        </span>
      </label>
      <label className="block">
        <span className="block text-label text-krypt-muted">Your thesis (optional)</span>
        <textarea
          value={v.thesis}
          maxLength={TRADER_MAX_THESIS}
          rows={2}
          onChange={(e) => onChange({ thesis: e.target.value.slice(0, TRADER_MAX_THESIS) })}
          placeholder="Why you think this coin is worth trading. Sent to an AI driver as your opinion, never as an instruction."
          className="mt-0.5 w-full resize-y rounded-md border border-white/10 bg-black/30 px-2 py-1 text-body text-white/90 outline-none placeholder:text-krypt-muted/50 focus:border-krypt-purple/50"
        />
        <span className="block text-right text-micro text-krypt-muted/60">
          {v.thesis.length}/{TRADER_MAX_THESIS}
        </span>
      </label>
    </div>
  );
}

function NumBox({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="block">
      <span className="block text-label text-krypt-muted">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text ?? String(value)}
        onFocus={() => setText(String(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number((text ?? '').trim());
          if (text !== null && text.trim() !== '' && Number.isFinite(n)) onChange(n);
          setText(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className="mt-0.5 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-body text-white/90 outline-none focus:border-krypt-purple/50"
      />
      <span className="block text-micro text-krypt-muted/60">{hint}</span>
    </label>
  );
}

function EnvelopeEditor({ s, onSaved }: { s: TraderRow; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<Envelope>({ maxLossPct: s.options.maxLossPct, timeLimitH: s.options.timeLimitH, atExpiry: s.options.atExpiry, reinvest: s.options.reinvest, thesis: s.options.thesis });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const r = await window.krypt.kryptoTrader.setEnvelope(s.id, v);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-white/10 bg-black/20 p-2.5">
      <EnvelopeFields v={v} onChange={(p) => setV((cur) => ({ ...cur, ...p }))} />
      <Btn onClick={() => void save()} busy={saving} strong>
        Save envelope
      </Btn>
    </div>
  );
}

function LimitsEditor({ s, onSaved }: { s: TraderRow; onSaved: () => void }) {
  const toast = useToast();
  const [limits, setLimits] = useState<TraderLimits>(s.options.limits);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const r = await window.krypt.kryptoTrader.setLimits(s.id, limits);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-white/10 bg-black/20 p-2.5">
      <p className="text-label text-krypt-muted">Applied at once to the running session.</p>
      <TraderLimitsFields limits={limits} driver={s.options.driver} onChange={setLimits} />
      <Btn onClick={() => void save()} busy={saving} strong>
        Save limits
      </Btn>
    </div>
  );
}

function Btn({ children, onClick, busy, strong }: { children: React.ReactNode; onClick: () => void; busy: boolean; strong?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cls(
        'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-body transition disabled:opacity-40',
        strong ? 'border-krypt-pink/40 bg-krypt-pink/15 text-white hover:bg-krypt-pink/25' : 'border-white/10 bg-white/5 text-white/90 hover:bg-white/10',
      )}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      {children}
    </button>
  );
}
