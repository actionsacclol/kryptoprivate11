import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, PlayCircle, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { OrdersSnapshot } from '@shared/orders';
import type { TokenSummary } from '@shared/market';
import { Card, Empty, GhostButton, Page, PrimaryButton, Section } from '../components/common';
import { OrderRow, OrdersPanel } from '../components/terminal/OrdersPanel';
import { TemplatePanel } from '../components/terminal/TemplatePanel';
import { useToast } from '../state/ToastProvider';
import { cls, fmtUsd } from '../utils/format';

/** A mint address, structurally. The engine re-checks; this only decides
 *  whether it is worth spending a provider call on the lookup. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Every advanced order across every token (term.txt §2).
//
// The restart banner is the important element on this page. Orders persist,
// but they come back paused — so the one state that must never be quiet is
// "you have protection you think is running and it is not".

export function OrdersPage({ onOpenToken }: { onOpenToken: (mint: string) => void }) {
  const toast = useToast();
  const [snap, setSnap] = useState<OrdersSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  // The per-trade cap. The panel refuses a buy order above it BEFORE the
  // click; without this it silently skipped that check on this page while
  // the token page enforced it, so the same order was offered here and
  // rejected by the engine.
  const [maxLiveSol, setMaxLiveSol] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await window.krypt.orders.list();
    if (r.ok && r.data) setSnap(r.data);
  }, []);

  useEffect(() => {
    void (async () => {
      const r = await window.krypt.settings.get();
      if (r.ok && r.data) setMaxLiveSol(r.data.execution.maxLiveSol ?? null);
    })();
  }, []);

  useEffect(() => {
    void load();
    // Push-driven: the engine emits `orders` on every change, so the 10 s
    // poll that sat beside it only re-fetched a snapshot already on screen.
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'orders') setSnap(ev.snapshot);
    });
    return off;
  }, [load]);

  const cancel = async (id: string): Promise<void> => {
    const r = await window.krypt.orders.cancel(id);
    if (r.ok) toast.info(r.message);
    else toast.error(r.message);
    if (r.data) setSnap(r.data);
  };

  const resume = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.krypt.orders.resume();
      if (r.ok) toast.success(r.message);
      if (r.data) setSnap(r.data);
    } finally {
      setBusy(false);
    }
  };

  const clearDone = async (): Promise<void> => {
    const r = await window.krypt.orders.clearCompleted();
    if (r.ok) toast.info(r.message);
    if (r.data) setSnap(r.data);
  };

  // ── Place an order from here ────────────────────────────────────────
  // The token page can only write orders for the token it has open. This
  // page had no way to place one at all, which made it a viewer of a feature
  // rather than the feature. Paste a mint, and the same panel the token page
  // uses appears — same validation, same engine call, no second code path.
  const [mintText, setMintText] = useState('');
  const [token, setToken] = useState<TokenSummary | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const mintOk = MINT_RE.test(mintText.trim());

  const lookUp = async (): Promise<void> => {
    const mint = mintText.trim();
    if (!MINT_RE.test(mint) || lookingUp) return;
    setLookingUp(true);
    try {
      const r = await window.krypt.market.summary(mint);
      if (r.ok && r.data) setToken(r.data);
      else toast.error(r.message || 'Could not read that token');
    } catch (e) {
      toast.error(`Lookup failed: ${(e as Error).message}`);
    } finally {
      setLookingUp(false);
    }
  };

  const orders = snap?.orders ?? [];
  const active = orders.filter((o) => o.state === 'armed' || o.state === 'triggered');
  const paused = orders.filter((o) => o.state === 'paused');
  const done = orders.filter((o) => !active.includes(o) && !paused.includes(o));
  const blockedArmed = active.filter((o) => o.note?.includes('NOT executed'));

  return (
    <Page
      title="Orders"
      subtitle="Write and manage stop losses, take profits, trailing stops, limit and trigger orders — carried out by the app, decided by you."
      actions={
        <div className="flex items-center gap-2">
          {done.length > 0 && (
            <GhostButton onClick={() => void clearDone()} className="!py-2 !px-3 text-xs">
              <Trash2 className="h-3.5 w-3.5" />
              Clear finished
            </GhostButton>
          )}
          <button
            onClick={() => void load()}
            className="h-9 w-9 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-krypt-muted hover:text-white transition"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <TemplatePanel />

      <Section
        title="Place an order"
        description="Paste any token's mint address and write a stop loss, take profit, trailing stop, limit or trigger order for it — the same form the token page uses, with the same rules. An order fires later, without a click at that moment, which is the whole point of a stop."
      >
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={mintText}
              onChange={(e) => setMintText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void lookUp();
              }}
              placeholder="token mint address"
              spellCheck={false}
              className="w-[26rem] max-w-full rounded-md border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[12px] text-white outline-none focus:border-krypt-purple/60"
            />
            <PrimaryButton onClick={() => void lookUp()} disabled={!mintOk || lookingUp} className="!py-1.5">
              <Search className={cls('h-3.5 w-3.5', lookingUp && 'animate-pulse')} />
              {lookingUp ? 'Reading…' : 'Load token'}
            </PrimaryButton>
            {token && (
              <>
                <GhostButton onClick={() => onOpenToken(token.mint)}>Open token page</GhostButton>
                <GhostButton
                  onClick={() => {
                    setToken(null);
                    setMintText('');
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                  Clear
                </GhostButton>
              </>
            )}
          </div>
          {mintText.trim() && !mintOk && (
            <div className="mt-2 text-[11px] text-rose-300">That is not a mint address (32–44 base58 characters).</div>
          )}

          {token && (
            <div className="mt-4 border-t border-white/8 pt-4">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[15px] font-semibold text-white">{token.symbol || token.mint.slice(0, 6)}</span>
                <span className="text-[12px] text-krypt-muted">{token.name}</span>
                <span className="font-mono text-[11px] text-krypt-muted">
                  {token.marketCapUsd !== null ? `${fmtUsd(token.marketCapUsd)} MC` : 'market cap unknown'}
                  {token.priceSol !== null ? ` · ${token.priceSol.toExponential(2)} SOL` : ' · no price'}
                </span>
              </div>
              {/* The panel is the same component the token page renders, so
                  the two can never drift apart. */}
              <OrdersPanel
                token={token}
                orders={orders.filter((o) => o.mint === token.mint)}
                executable={snap?.executable ?? false}
                blockedReason={snap?.blockedReason ?? null}
                maxLiveSol={maxLiveSol}
                onChanged={() => void load()}
              />
            </div>
          )}
        </Card>
      </Section>

      {/* The one banner that must never be quiet. */}
      {paused.length > 0 && (
        <div className="mb-5 rounded-lg border border-arc-gold/45 bg-arc-gold/10 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-arc-gold flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold text-arc-gold text-sm">
              {paused.length} order{paused.length === 1 ? '' : 's'} paused after restart — not protecting you
            </div>
            <p className="text-[12px] text-arc-gold/80 mt-1 leading-relaxed">
              Orders survive a restart but never re-arm themselves, so a stop loss can't fire into a market the app
              wasn't watching. Review them below, then resume. Anything that was mid-execution when the app closed
              stays paused until you've checked your wallet.
            </p>
          </div>
          <PrimaryButton onClick={() => void resume()} disabled={busy} className="!py-2 !px-3 text-xs flex-shrink-0">
            <PlayCircle className="h-4 w-4" />
            Resume all
          </PrimaryButton>
        </div>
      )}

      {blockedArmed.length > 0 && (
        <div className="mb-5 rounded-lg border border-rose-400/45 bg-rose-500/10 px-4 py-3">
          <div className="font-semibold text-rose-200 text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {blockedArmed.length} order{blockedArmed.length === 1 ? "'s" : "s'"} condition has been met but could not
            execute
          </div>
          <p className="text-[12px] text-rose-200/80 mt-1 leading-relaxed">
            {snap?.blockedReason
              ? `Blocked because ${snap.blockedReason}. `
              : ''}
            These orders are still armed and will fire as soon as execution is possible — potentially at a much worse
            price than the trigger.
          </p>
        </div>
      )}

      {snap && !snap.executable && paused.length === 0 && blockedArmed.length === 0 && active.length > 0 && (
        <div className="mb-5 rounded-lg border border-white/12 bg-black/25 px-4 py-2.5">
          <p className="text-[12px] text-krypt-muted">
            Orders are armed but cannot execute — {snap.blockedReason}.
          </p>
        </div>
      )}

      {orders.length === 0 ? (
        <Empty
          title="No orders"
          message="Open a token and use the Orders panel to set a stop loss, take profit, trailing stop or limit order."
        />
      ) : (
        <>
          {active.length > 0 && (
            <Section title={`Active (${active.length})`}>
              <div className="space-y-2">
                {active.map((o) => (
                  <div key={o.id} onDoubleClick={() => onOpenToken(o.mint)} className="cursor-pointer">
                    <OrderRow order={o} onCancel={(id) => void cancel(id)} showSymbol />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {paused.length > 0 && (
            <Section title={`Paused (${paused.length})`}>
              <div className="space-y-2">
                {paused.map((o) => (
                  <div key={o.id} onDoubleClick={() => onOpenToken(o.mint)} className="cursor-pointer">
                    <OrderRow order={o} onCancel={(id) => void cancel(id)} showSymbol />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {done.length > 0 && (
            <Section title={`Finished (${done.length})`}>
              <div className="space-y-2">
                {done.map((o) => (
                  <div key={o.id} onDoubleClick={() => onOpenToken(o.mint)} className="cursor-pointer">
                    <OrderRow order={o} onCancel={(id) => void cancel(id)} showSymbol />
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      <Card className={cls('mt-4', 'border-white/8')}>
        <h3 className="font-display text-[10px] font-semibold uppercase tracking-[0.28em] text-krypt-muted mb-2">
          How these behave
        </h3>
        <ul className="text-[11px] text-krypt-muted space-y-1.5 leading-relaxed">
          <li>
            <span className="text-white">Exactly once.</span> An order can fire one time. The state change is written
            to disk before anything is signed, so a crash mid-execution can never produce a second transaction.
          </li>
          <li>
            <span className="text-white">A blocked order is not spent.</span> If the condition is met while live
            execution is off or the engine is disarmed, the order stays armed and warns you rather than quietly
            failing.
          </li>
          <li>
            <span className="text-white">Failures are not retried.</span> A rejected transaction ends the order with
            the reason, because retrying against an unknown on-chain state is how you sell twice.
          </li>
          <li>
            <span className="text-white">Breakers stop buys, never sells.</span> A loss-limit pause blocks an
            order-driven buy but never blocks an exit.
          </li>
          <li>
            <span className="text-white">Sells are built locally when they can be.</span> The local builder sizes a
            partial sell as well as a full one, and the relayer is only a fallback when it cannot build the route.
          </li>
        </ul>
      </Card>
    </Page>
  );
}
