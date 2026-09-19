// One callout, rendered the same way wherever it appears.
//
// The rail and the dashboard widget show the same rows, so the row is its own
// component rather than two drifting copies. It is INTEL: clicking opens the
// coin's chart, and there is no buy button on it, deliberately. A call is
// someone being paid for attention — the app can show you that it happened
// without putting a trigger next to it.
//
// The line that earns this feature its place is `skinInTheGame`. pump's feed
// carries the caller's own position in the coin they are calling, so a row can
// say "called it, holds none" — which is the single most useful fact about a
// call and is not on pump's own card.

import { ExternalLink } from 'lucide-react';
import type { Callout } from '@shared/callouts';
import { skinInTheGame } from '@shared/callouts';
import { cls, fmtAge, fmtUsd, shortAddr } from '../utils/format';

/** pump's name for a chain this app cannot open. */
function chainLabel(c: Callout): string {
  if (c.chain === 'solana') return 'SOL';
  if (c.chain === 'bnb') return 'BNB';
  if (c.chain === 'robinhood') return 'RBH';
  return c.rawChain.toUpperCase();
}

/** The multiple since the call, as pump reports it. Unknown is an em dash —
 *  never 1x, which would read as "flat" when it means "not read". */
function Multiple({ v }: { v: number | null }) {
  if (v === null) return <span className="text-krypt-muted">—</span>;
  const up = v >= 1;
  return (
    <span className={cls('font-mono tabular-nums', up ? 'text-emerald-300' : 'text-rose-300')}>
      {v.toFixed(2)}x
    </span>
  );
}

/**
 * What the caller is doing with their own call.
 *
 * `holding` is not praise and `sold` is not an accusation — both are just what
 * their wallet says. Unknown renders nothing at all rather than a neutral
 * badge, because an absent fact should take up no space.
 */
function Skin({ c }: { c: Callout }) {
  const s = skinInTheGame(c);
  if (s === null) return null;
  const map = {
    holding: { text: 'holds it', cn: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300/90' },
    sold: { text: 'already sold', cn: 'border-rose-400/25 bg-rose-500/10 text-rose-300/90' },
    never: { text: 'never bought', cn: 'border-amber-400/25 bg-amber-500/10 text-amber-300/90' },
  } as const;
  const m = map[s];
  return <span className={cls('rounded border px-1 py-px text-nano font-sans', m.cn)}>{m.text}</span>;
}

export function CalloutRow({ c, onOpen }: { c: Callout; onOpen?: (mint: string, chain: NonNullable<Callout['chain']>) => void }) {
  // A chain this app has no rail for is shown but not clickable: offering to
  // open a hyperevm coin and then failing is worse than a row that is plainly
  // just information.
  const openable = c.chain !== null && !!onOpen;
  const open = (): void => {
    if (c.chain && onOpen) onOpen(c.mint, c.chain);
  };

  return (
    <div
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={openable ? open : undefined}
      onKeyDown={openable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } : undefined}
      className={cls(
        'rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2 transition',
        openable && 'cursor-pointer hover:border-krypt-purple/40 hover:bg-white/[0.05]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-display text-xs text-white/90">
          {c.symbol ?? shortAddr(c.mint, 4)}
        </span>
        <span className="shrink-0 rounded border border-white/10 bg-black/30 px-1 py-px text-nano font-mono text-krypt-muted">
          {chainLabel(c)}
        </span>
        <span className="ml-auto shrink-0 text-nano font-mono text-krypt-muted">{fmtAge(c.at)}</span>
        <Multiple v={c.multiple} />
        {openable && <ExternalLink className="h-3 w-3 shrink-0 text-krypt-muted/60" />}
      </div>

      {c.thesis && (
        <div className="mt-1 line-clamp-2 text-xs leading-snug text-white/70">{c.thesis}</div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-nano text-krypt-muted">
        <span className="truncate text-krypt-muted/90">
          {c.caller.name ?? (c.caller.wallet ? shortAddr(c.caller.wallet, 4) : 'unknown caller')}
        </span>
        {c.caller.totalCallouts !== null && <span>· {c.caller.totalCallouts} calls</span>}
        <Skin c={c} />
        {/* Called at what size. This is the number that says whether a 3x was
            3x of something real or 3x of four thousand dollars. */}
        {c.calledAtMcapUsd !== null && <span className="ml-auto font-mono">called at {fmtUsd(c.calledAtMcapUsd)}</span>}
      </div>
    </div>
  );
}
