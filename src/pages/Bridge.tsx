// Bridge — moving value between chains, which is not a swap.
//
// It has its own page, its own switch and its own warning because it asks
// something of the user that nothing else in this app does: for the seconds
// between two chains, a third party holds their money and owes them the other
// side. A swap fills or reverts and nobody ever holds anything.
//
// The page's job is to be honest about three things the code cannot fix:
// the funds transit somebody else's contract; on a Solana source we cannot
// verify the destination from the bytes we sign; and a transfer in flight is
// in neither wallet, so "could not check" is a real state and must never be
// dressed as "nothing pending".

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Loader2, Shuffle } from 'lucide-react';
import {
  BRIDGE_CHAINS,
  HARD_FLOOR_USD,
  STATUS_LABEL,
  chainLabel,
  costPct,
  emptyDraft,
  nativeSymbolOf,
  routeId,
  sizeWarning,
  type BridgeChain,
  type BridgeDraft,
  type BridgeQuote,
  type InFlight,
} from '@shared/bridge';
import { Card, Empty, Page, Section } from '../components/common';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { cls, fmtClock } from '../utils/format';

const inputCls =
  'w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-white placeholder:text-krypt-muted/60 focus:border-krypt-purple/60 focus:outline-none';

const fromRaw = (raw: string, dec: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** dec : 0;
};

/** A restored record that lost its amount says so, rather than "0". */
function amountLabel(t: InFlight): string {
  if (!t.fromAmountRaw || t.fromAmountRaw === '0') return '—';
  return fromRaw(t.fromAmountRaw, t.from === 'solana' ? 9 : 18).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function Bridge() {
  const { settings, updateSettings } = useAppState();
  const toast = useToast();
  const enabled = settings.bridge.enabled;

  const [routes, setRoutes] = useState<Set<string>>(new Set());
  const [inFlight, setInFlight] = useState<InFlight[]>([]);
  const [history, setHistory] = useState<InFlight[]>([]);
  const [recordFailure, setRecordFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState<BridgeDraft>(() => emptyDraft('solana', 'robinhood'));
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [busy, setBusy] = useState<'' | 'quote' | 'check' | 'send' | 'refresh'>('');
  const [checked, setChecked] = useState(false);
  const [amountText, setAmountText] = useState('');
  // A check is good for as long as the quote behind it (main keeps a quote
  // for 60 s and refuses a real send on an older one), so the button goes
  // back to "check it first" on its own rather than sending into a refusal.
  useEffect(() => {
    if (!checked) return;
    const t = setTimeout(() => setChecked(false), 55_000);
    return () => clearTimeout(t);
  }, [checked]);

  const load = useCallback(() => {
    void window.krypt.bridge
      .state()
      .then((r) => {
        if (!r.ok || !r.data) return;
        setRoutes(new Set(r.data.routes));
        setInFlight(r.data.inFlight);
        // Ended transfers, newest first. Until 2026-09-11 these were fetched
        // and never rendered: a refund or a partial delivery vanished from
        // the page at the next reload, and the user was never told.
        setHistory(r.data.history.filter((t) => t.status !== 'pending' && t.status !== 'unknown'));
        setRecordFailure(r.data.failure);
      })
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  // Re-read while anything is in flight. This is free — it asks MAIN what it
  // already knows and never touches the network; the aggregator is polled by
  // main on its own two-minute timer, which is the call that costs something.
  useEffect(() => {
    if (inFlight.length === 0) return;
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [inFlight.length, load]);

  const set = useCallback(<K extends keyof BridgeDraft>(k: K, v: BridgeDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setQuote(null);
    setChecked(false);
  }, []);

  const routeOk = routes.has(routeId(draft.from, draft.to));
  const canQuote = enabled && routeOk && draft.from !== draft.to && draft.amount > 0 && busy === '';

  const getQuote = useCallback(async () => {
    setBusy('quote');
    setChecked(false);
    try {
      const r = await window.krypt.bridge.quote(draft);
      if (!r.ok || !r.data) {
        setQuote(null);
        toast.error(r.message);
        return;
      }
      setQuote(r.data);
    } finally {
      setBusy('');
    }
  }, [draft, toast]);

  const run = useCallback(
    async (simulateOnly: boolean) => {
      setBusy(simulateOnly ? 'check' : 'send');
      // The aggregator paces quotes about 90 s apart; a check that needs a
      // fresh one waits for it. Said after a few seconds, so a wait is not
      // mistaken for a hang.
      const slow = setTimeout(() => toast.info('Still waiting on the aggregator — it paces quotes about 90 seconds apart. Nothing has been sent.'), 5_000);
      try {
        const r = await window.krypt.bridge.send(draft, simulateOnly);
        if (!r.ok) {
          toast.error(r.message);
          return;
        }
        if (simulateOnly) {
          setChecked(true);
          toast.success('The chain accepts this transfer. Nothing was sent.');
        } else {
          setChecked(false);
          setQuote(null);
          setDraft((d) => ({ ...d, amount: 0 }));
          setAmountText('');
          toast.warn('On its way. It is in neither wallet until it lands — watch the list below.');
          load();
        }
      } finally {
        clearTimeout(slow);
        setBusy('');
      }
    },
    [draft, toast, load],
  );

  const refresh = useCallback(async () => {
    setBusy('refresh');
    try {
      const r = await window.krypt.bridge.refresh();
      if (r.ok) load();
      else toast.error(r.message);
    } finally {
      setBusy('');
    }
  }, [toast, load]);

  const warning = quote ? sizeWarning(quote) : null;
  const pct = quote ? costPct(quote) : null;
  const out = quote ? fromRaw(quote.toAmountRaw, quote.toDecimals) : null;
  const outMin = quote ? fromRaw(quote.toAmountMinRaw, quote.toDecimals) : null;

  const disabledRoutes = useMemo(
    () =>
      BRIDGE_CHAINS.flatMap((from) =>
        BRIDGE_CHAINS.filter((to) => to !== from && !routes.has(routeId(from, to))).map((to) => `${chainLabel(from)} → ${chainLabel(to)}`),
      ),
    [routes],
  );

  return (
    <Page title="Bridge" subtitle="Move a chain's own coin to another chain. This is not a swap.">
      {/* ── what you are agreeing to, before the switch ─────────────── */}
      <Section>
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-4">
          <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" /> Read this before you turn it on
          </div>
          <ul className="space-y-1 text-[11px] leading-relaxed text-amber-100/80">
            <li>
              <span className="text-white/90">A bridge is not a swap.</span> Your funds leave your wallet into a contract we do not
              control, and a different party sends you the coin on the other side. For a moment, someone else has your money and
              owes you the other half.
            </li>
            <li>
              <span className="text-white/90">It is two transactions and it cannot be cancelled.</span> If the second one does not
              happen the usual outcome is a refund on the chain you left, and how long that takes is not ours to promise. Nothing
              in this app can recall a transfer.
            </li>
            <li>
              <span className="text-white/90">Our safety check stops at the border.</span> Every transfer is simulated before it is
              signed and refused if it would spend more than you meant. That proof covers the chain you are leaving. We can prove
              nothing about the leg that arrives.
            </li>
            <li>
              <span className="text-white/90">Under ${HARD_FLOOR_USD} is refused outright</span> — below that a failed transfer is
              never refunded at all, because the refund would cost more in gas than it is worth.
            </li>
            <li>Only each chain's own coin can be moved. Bridging a token grants a standing approval, which is how this
              aggregator lost $11.6M in 2024; a native coin grants none.</li>
          </ul>
        </div>
      </Section>

      {/* ── the switch ──────────────────────────────────────────────── */}
      <Section>
        <Card>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13px] font-semibold text-white">Allow this install to bridge</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-krypt-muted">
                Off: the signer refuses any transaction that sends funds to a contract this app did not build, which is every
                bridge. On: it accepts only the bridges this build has measured, and nothing else.
              </div>
            </div>
            <button
              onClick={() => void updateSettings({ bridge: { enabled: !enabled } })}
              className={cls(
                'shrink-0 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition',
                enabled
                  ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white hover:bg-krypt-purple/25'
                  : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10',
              )}
            >
              {enabled ? 'On' : 'Off'}
            </button>
          </div>
        </Card>
      </Section>

      {/* ── the transfer ────────────────────────────────────────────── */}
      <Section title="Send">
        <Card className={cls('space-y-3', !enabled && 'opacity-50')}>
          <div className="flex items-end gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-[11px] font-semibold text-white/80">From</span>
              <select value={draft.from} onChange={(e) => set('from', e.target.value as BridgeChain)} className={inputCls}>
                {BRIDGE_CHAINS.map((c) => (
                  <option key={c} value={c}>{chainLabel(c)} · {nativeSymbolOf(c)}</option>
                ))}
              </select>
            </label>
            <ArrowRight className="mb-2 h-4 w-4 shrink-0 text-krypt-muted" />
            <label className="flex-1">
              <span className="mb-1 block text-[11px] font-semibold text-white/80">To</span>
              <select value={draft.to} onChange={(e) => set('to', e.target.value as BridgeChain)} className={inputCls}>
                {BRIDGE_CHAINS.filter((c) => c !== draft.from).map((c) => (
                  <option key={c} value={c}>{chainLabel(c)} · {nativeSymbolOf(c)}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-white/80">Amount ({nativeSymbolOf(draft.from)})</span>
            {/* The TEXT is the state while typing; the number is derived. A
                box bound to the parsed number re-rendered "0" and "0." as
                empty, so 0.1 could never be typed — found live 2026-09-11. */}
            <input
              type="text"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => {
                const v = e.target.value.replace(',', '.');
                if (!/^\d*\.?\d*$/.test(v)) return;
                setAmountText(v);
                const n = Number(v);
                set('amount', v !== '' && v !== '.' && Number.isFinite(n) ? n : 0);
              }}
              placeholder="0.0"
              className={cls(inputCls, 'font-mono')}
            />
          </label>

          {!routeOk && draft.from !== draft.to && (
            <p className="text-[11px] leading-relaxed text-amber-200/80">
              {chainLabel(draft.from)} to {chainLabel(draft.to)} is not enabled in this build. That route hides accounts inside
              address lookup tables, and this app will not sign a payment to an address it cannot read.
            </p>
          )}

          <button
            onClick={() => void getQuote()}
            disabled={!canQuote}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-white/90 transition hover:bg-white/10 disabled:opacity-40"
          >
            {busy === 'quote' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Get a quote
          </button>

          {quote && (
            <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[11px] leading-relaxed">
              <div className="text-white/90">
                You receive about{' '}
                <span className="font-mono">{out === null ? '—' : out.toLocaleString(undefined, { maximumFractionDigits: 8 })}</span>{' '}
                {nativeSymbolOf(quote.to)}
                {outMin !== null && (
                  <span className="text-krypt-muted"> · at least {outMin.toLocaleString(undefined, { maximumFractionDigits: 8 })}</span>
                )}
              </div>
              <div className="text-krypt-muted">
                via <span className="text-white/70">{quote.tool}</span>
                {quote.durationSec !== null && <> · usually about {quote.durationSec}s</>}
                {pct !== null && <> · costs {pct.toFixed(2)}%</>}
              </div>
              {/* The asymmetry, said plainly. Never a tick that means less on
                  one rail than the other. */}
              <div className={quote.assurance === 'verified' ? 'text-emerald-300/90' : 'text-amber-200/80'}>
                {quote.assurance === 'verified'
                  ? 'Checked: this transaction names your own address on the far side.'
                  : 'Not checkable: a Solana transfer carries no record of where it ends up. The destination is this bridge’s promise, not something we can prove.'}
              </div>
              {warning && <div className="text-amber-200/80">{warning}</div>}
            </div>
          )}

          {quote && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => void run(true)}
                disabled={busy !== ''}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-white/90 transition hover:bg-white/10 disabled:opacity-40"
              >
                {busy === 'check' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Check it first
              </button>
              <button
                onClick={() => void run(false)}
                disabled={busy !== '' || !checked || recordFailure !== null}
                title={
                  recordFailure
                    ? 'The in-flight record cannot be written this session — nothing will be sent'
                    : !checked
                      ? 'Check it first — a transfer cannot be recalled'
                      : undefined
                }
                className="flex items-center gap-1.5 rounded-lg border border-krypt-pink/40 bg-krypt-pink/15 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-krypt-pink/25 disabled:opacity-40"
              >
                {busy === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shuffle className="h-3.5 w-3.5" />}
                Send it
              </button>
              {checked && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-300">
                  <Check className="h-3 w-3" /> checked
                </span>
              )}
            </div>
          )}
        </Card>
      </Section>

      {/* ── in flight ───────────────────────────────────────────────── */}
      <Section title="In flight" description="Money that has left one chain and not yet arrived on the other.">
        <Card>
          {/* The single most important honest-null in this feature: an
              unreadable record must never render as "nothing pending". */}
          {recordFailure ? (
            <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2.5 text-[12px] text-rose-200">
              Could not read your in-flight transfers — {recordFailure}. This is not the same as having none. Nothing will be
              written to that file this session; copy it somewhere safe and check it.
            </div>
          ) : inFlight.length === 0 ? (
            <Empty title="Nothing in flight" message="Transfers appear here from the moment they are sent until they land." />
          ) : (
            <div className="space-y-1.5">
              {inFlight.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[12px] text-white/90">
                      {amountLabel(t)} {nativeSymbolOf(t.from)} · {chainLabel(t.from)} → {chainLabel(t.to)}
                    </div>
                    <div className="truncate font-mono text-[10px] text-krypt-muted">
                      {t.tool} · {fmtClock(t.startedAt)} · {t.txHash.slice(0, 16)}…
                    </div>
                    {t.note && <div className="text-[10px] text-amber-200/80">{t.note}</div>}
                  </div>
                  <span
                    className={cls(
                      'shrink-0 rounded-full border px-2 py-0.5 text-[10px]',
                      t.status === 'done'
                        ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                        : t.status === 'unknown'
                          ? 'border-white/10 bg-white/5 text-krypt-muted'
                          : 'border-arc-gold/30 bg-arc-gold/10 text-arc-gold',
                    )}
                  >
                    {STATUS_LABEL[t.status]}
                  </span>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => void refresh()}
            disabled={busy !== ''}
            className="mt-2 flex items-center gap-1.5 text-[11px] text-krypt-muted transition hover:text-white disabled:opacity-40"
          >
            {busy === 'refresh' && <Loader2 className="h-3 w-3 animate-spin" />}
            Check for updates
          </button>
        </Card>
      </Section>

      {history.length > 0 && (
        <Section title="Ended" description="How each transfer finished. A refund comes back on the chain it left — usually as a stablecoin, not the coin you sent.">
          <Card>
            <div className="space-y-1.5">
              {history.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[12px] text-white/90">
                      {amountLabel(t)} {nativeSymbolOf(t.from)} · {chainLabel(t.from)} → {chainLabel(t.to)}
                      {t.deliveredRaw !== null && t.status !== 'refunded' && (
                        <span className="text-krypt-muted">
                          {' '}
                          · delivered {fromRaw(t.deliveredRaw, t.toDecimals).toLocaleString(undefined, { maximumFractionDigits: 6 })} {nativeSymbolOf(t.to)}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[10px] text-krypt-muted">
                      {t.tool} · {fmtClock(t.startedAt)} · {t.txHash.slice(0, 16)}…
                    </div>
                    {t.note && <div className="text-[10px] text-amber-200/80">{t.note}</div>}
                  </div>
                  <span
                    className={cls(
                      'shrink-0 rounded-full border px-2 py-0.5 text-[10px]',
                      t.status === 'done'
                        ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                        : t.status === 'failed'
                          ? 'border-rose-400/30 bg-rose-500/10 text-rose-300'
                          : 'border-amber-400/30 bg-amber-400/10 text-amber-200',
                    )}
                  >
                    {STATUS_LABEL[t.status]}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </Section>
      )}

      {disabledRoutes.length > 0 && (
        <Section title="Not enabled in this build">
          <Card>
            <p className="text-[11px] leading-relaxed text-krypt-muted">
              {disabledRoutes.join(', ')}. Those routes hide accounts inside address lookup tables, and this app will not sign a
              payment to an address it cannot read. Enabling one means resolving those tables before signing, not relaxing the
              rule.
            </p>
          </Card>
        </Section>
      )}
    </Page>
  );
}
