// What the token's X link actually is — free, offline, no key.
//
// The terminal used to say "socials: yes" for four very different things. A
// link to someone else's viral post is not an account; a community is a room;
// a search is nothing. This panel says which, names the handle when there is
// one, and counts how many other launches on screen point at the SAME account
// or the SAME post — which is how a farm looks from the outside.
//
// Everything here is computed from links the app already has. Nothing is
// requested, so X learns nothing about what the user is researching. There is
// no score: these are facts and a count, and the reader draws the conclusion.

import { ExternalLink, Twitter } from 'lucide-react';
import type { TokenSummary } from '@shared/market';
import { countReuse, hasAccount, parseXLink } from '@shared/xLink';
import { cls } from '../../utils/format';

/** What a reader should check on the account itself, since we do not read it. */
const CHECKLIST = [
  'When was the account created — before the token, or an hour ago?',
  'Does it post about anything except this launch?',
  'Do the replies look like people, or like the same four accounts?',
  'Has the handle been renamed (X shows this under About this account)?',
];

export function XLinkPanel({
  mint,
  twitter,
  launches,
}: {
  mint: string;
  twitter: string | null;
  /** Every token currently loaded in Discover — the reuse count comes from
   *  these, so it costs nothing and reveals nothing. */
  launches: TokenSummary[];
}) {
  const link = parseXLink(twitter);
  if (link.kind === 'none') return null;

  const reuse = countReuse(
    link,
    launches.map((l) => ({ mint: l.mint, twitter: l.socials?.twitter ?? null })),
    mint,
  );
  const farmed = reuse.handle >= 3 || reuse.post >= 3;
  const isAccount = hasAccount(link);

  return (
    <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <Twitter className="h-3.5 w-3.5 text-krypt-muted" />
        <span className="font-display text-[9px] uppercase tracking-[0.28em] text-krypt-muted">X link</span>
        <div className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
        {twitter && (
          <a
            href={twitter}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-krypt-muted transition hover:text-white"
          >
            Open <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cls('text-[12px] font-semibold', isAccount ? 'text-white' : 'text-arc-gold')}>{link.label}</span>
        {!isAccount && (
          <span className="text-[11px] text-krypt-muted">
            {link.kind === 'post'
              ? 'the launcher linked a post, not an account of their own'
              : 'there is no account here to look at'}
          </span>
        )}
      </div>

      {(reuse.handle > 0 || reuse.post > 0) && (
        <div className={cls('mt-2 rounded-md px-2.5 py-2 text-[11px] leading-relaxed', farmed ? 'bg-rose-500/10 text-rose-200' : 'bg-white/[0.03] text-krypt-muted')}>
          {reuse.post > 0 && (
            <div>
              The same post is linked by <span className="font-mono text-white/90">{reuse.post}</span> other launch
              {reuse.post === 1 ? '' : 'es'} on screen.
            </div>
          )}
          {reuse.handle > 0 && (
            <div>
              The same account is linked by <span className="font-mono text-white/90">{reuse.handle}</span> other launch
              {reuse.handle === 1 ? '' : 'es'} on screen.
            </div>
          )}
          {farmed && <div className="mt-1 font-semibold">That is a launch farm reusing one identity, not a project.</div>}
        </div>
      )}

      {isAccount && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] text-krypt-muted/70 hover:text-white">
            What to check on the account itself
          </summary>
          <ul className="mt-1.5 space-y-1">
            {CHECKLIST.map((line) => (
              <li key={line} className="flex gap-2 text-[10px] leading-relaxed text-krypt-muted/80">
                <span className="mt-[6px] h-1 w-1 flex-shrink-0 rotate-45 bg-krypt-purple/60" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] leading-relaxed text-krypt-muted/50">
            The app does not read X: doing so would need a paid key and would tell X which tokens you look at. The count
            above is computed from links already on your screen.
          </p>
        </details>
      )}
    </div>
  );
}
