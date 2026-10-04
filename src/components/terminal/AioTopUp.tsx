// "Buy anywhere" in the trade panels (All-in-One wallet, phase 3).
//
// The plan is made while the user is still looking — debounced as they type
// and refreshed before its quote expires — so a click pays only for the move
// and the buy, never for a quote. It only quotes when the chain is actually
// short; on a funded chain the plan is "direct" and costs nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import type { AioChain } from '@shared/aio';
import { LOW_GAS, REFUEL_USD, type AioBuyPlan } from '@shared/aioConvert';

/**
 * Plans for a live buy of `amount` on `chain`, or null while off/not needed.
 * A plan answers for ONE (chain, amount, enabled): after an edit the old one
 * is dropped at once and `pending` stays true until the new answer is in —
 * the button never describes, and a click never sends, a plan made for a
 * different amount (swarm 2026-10-03, UX-2).
 */
export function useAioBuyPlan(chain: AioChain, amount: number, enabled: boolean): { plan: AioBuyPlan | null; pending: boolean; replan: () => void } {
  const key = `${chain}|${amount}|${enabled}`;
  const [answer, setAnswer] = useState<{ key: string; plan: AioBuyPlan | null } | null>(null);
  // What the All-in-One wallet said last time, for any amount: 'off' means it
  // does not apply here, so nobody without it is ever made to wait.
  const [lastKind, setLastKind] = useState<AioBuyPlan['kind'] | null>(null);
  const seq = useRef(0);
  const run = useCallback(() => {
    if (!enabled || !(amount > 0)) {
      setAnswer({ key, plan: null });
      return;
    }
    const my = ++seq.current;
    void window.krypt.aio.buyPlan({ chain, amount }).then((r) => {
      if (my !== seq.current) return; // a newer amount was typed meanwhile
      const p = r.ok && r.data ? r.data : null;
      setAnswer({ key, plan: p });
      setLastKind(p ? p.kind : null);
    });
  }, [chain, amount, enabled, key]);
  useEffect(() => {
    const t = setTimeout(run, 450);
    // Refreshed inside the quote's life (30 s), only while visible.
    const every = setInterval(() => {
      if (!document.hidden) run();
    }, 25_000);
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'aioChanged' || ev.kind === 'walletSwitched') run();
    });
    return () => {
      clearTimeout(t);
      clearInterval(every);
      off();
    };
  }, [run]);
  const current = answer !== null && answer.key === key;
  const plan = current ? answer.plan : null;
  const pending = enabled && amount > 0 && !current && lastKind !== null && lastKind !== 'off';
  return { plan, pending, replan: run };
}

/** Is the All-in-One wallet signing on every chain? (Refuel needs it.) */
export function useAioActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void window.krypt.aio.info().then((r) => {
        if (alive) setActive(!!(r.ok && r.data && r.data.exists && r.data.activeEverywhere));
      });
    };
    read();
    const off = window.krypt.engine.onEvent((ev) => {
      if (ev.kind === 'aioChanged' || ev.kind === 'walletSwitched') read();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return active;
}

/**
 * Out of gas on the sell side: one click moves ~$5 of this chain's coin over
 * from the chain holding the most (an ordinary move). Never in the way of the
 * sell button — an offer beside it.
 */
export function AioRefuel({ chain, balance }: { chain: AioChain; balance: number | null }) {
  const active = useAioActive();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  if (!active || balance === null || balance >= LOW_GAS[chain]) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-400/30 bg-violet-500/5 px-3 py-2 text-body text-white/90">
      <Layers className="h-3.5 w-3.5 flex-shrink-0" />
      <span>Too little gas to sell here.</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setNote(null);
          void window.krypt.aio.refuel(chain).then((r) => {
            setBusy(false);
            setNote({ ok: r.ok, text: r.message });
          });
        }}
        className="rounded-md border border-violet-400/40 px-2 py-0.5 text-label hover:bg-violet-500/20 disabled:opacity-50"
      >
        {busy ? 'Refuelling…' : `Refuel ~$${REFUEL_USD} from another chain`}
      </button>
      {note && <span className={note.ok ? 'text-emerald-300/90' : 'text-rose-300/90'}>{note.text}</span>}
    </div>
  );
}

/** Does this plan change what the Buy button does? */
export const planMoves = (p: AioBuyPlan | null): boolean => p?.kind === 'convert' || p?.kind === 'ask';

/** The line under the amount: what will be converted, at what cost. A
 *  refusal is not shown here — the panel's own blocked line says it. */
export function AioTopUpNote({ plan }: { plan: AioBuyPlan | null }) {
  if (!plan || (plan.kind !== 'convert' && plan.kind !== 'ask')) return null;
  const tone =
    plan.kind === 'ask'
      ? 'border-amber-400/30 bg-amber-500/5 text-amber-100'
      : 'border-violet-400/30 bg-gradient-to-r from-violet-500/10 to-emerald-400/10 text-white/90';
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-body leading-relaxed ${tone}`}>
      <Layers className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
      <span>
        All-in-One: {plan.message}
        {plan.kind === 'ask' ? ' That is more than usual — you will be asked to confirm.' : ''}
      </span>
    </div>
  );
}

/**
 * Run a buy through the plan: top up, wait for the money, buy. A costly
 * top-up (the plan, or a re-plan main had to make) is confirmed first.
 */
export async function buyThroughPlan(args: {
  chain: AioChain;
  token: string;
  amount: number;
  plan: AioBuyPlan;
  confirm: (title: string, message: string) => Promise<boolean>;
}): Promise<{ ok: boolean; message: string; data?: { stage?: string } }> {
  let quoteId = args.plan.convert?.quoteId ?? null;
  let acceptAsk = false;
  if (args.plan.kind === 'ask') {
    const yes = await args.confirm('Top up first?', `${args.plan.message} Go ahead?`);
    if (!yes) return { ok: false, message: 'Cancelled — nothing moved.' };
    acceptAsk = true;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await window.krypt.aio.buy({ chain: args.chain, token: args.token, amount: args.amount, quoteId, acceptAsk });
    if (r.ok) return { ok: true, message: r.message };
    // Sent, not confirmed: a warning, not an error (and nothing was billed).
    if (r.data && 'stage' in r.data && r.data.stage === 'pending') return { ok: false, message: r.message, data: { stage: 'pending' } };
    const again = r.data && 'needsConfirm' in r.data ? r.data.needsConfirm : undefined;
    if (!again || attempt > 0) return { ok: false, message: r.message };
    // The plan had expired and the fresh one costs more than usual: ask.
    const yes = await args.confirm('Top up first?', `${again.message} Go ahead?`);
    if (!yes) return { ok: false, message: 'Cancelled — nothing moved.' };
    quoteId = again.convert?.quoteId ?? null;
    acceptAsk = true;
  }
  return { ok: false, message: 'Could not complete the buy.' };
}
