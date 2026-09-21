// The Links tab under the token chart (2026-09-20): everything the app can
// honestly say about a coin's off-chain face, each fact with its source.
//
//   • the numbers the Links panel read off the X page when a person opened
//     it there (followers, or likes for a post), with their age;
//   • what Telegram's public preview says about the linked room — members
//     or subscribers, online — fetched by main from t.me when this page
//     opened; a private invite shows no count and says so;
//   • the website's domain record from its registry (RDAP): registered when,
//     by which registrar, expiring when — or the shared platform the site
//     sits on instead; and what the site itself says when a person opened
//     it in the Links panel: does it name the contract, which X and
//     Telegram does it link, how much of a site is it;
//   • the links the creator published, opened in the system browser;
//   • the free, offline classification of the X link and how many other
//     launches on screen point at the same account or post.
//
// Visitor numbers are not here: no free source publishes them, and a guess
// would be worse than nothing. The tab says so where a person would look.

import { ExternalLink } from 'lucide-react';
import type { TokenSummary } from '@shared/market';
import { tokenLinks } from '@shared/tokenLinks';
import { describeXStats, fmtCount } from '@shared/xStats';
import { describeTelegram, domainAgeDays, fmtAge, fmtRegistered } from '@shared/linkIntel';
import { siteLinksX } from '@shared/siteRead';
import { parseXLink } from '@shared/xLink';
import { useXStats } from '../../state/useXStats';
import { useLinkIntel } from '../../state/useLinkIntel';
import { useSiteRead } from '../../state/useSiteRead';
import { XLinkPanel } from './XLinkPanel';

const ago = (t: number): string => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
};

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'gold' | 'dim' }) {
  return (
    <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2">
      <div className="text-micro uppercase tracking-label text-krypt-muted/70">{label}</div>
      <div className={`mt-0.5 font-mono text-base font-semibold ${tone === 'gold' ? 'text-arc-gold' : tone === 'dim' ? 'text-krypt-muted' : 'text-white'}`}>{value}</div>
    </div>
  );
}

function Heading({ children }: { children: string }) {
  return <div className="mb-2 text-micro uppercase tracking-label text-krypt-muted/70">{children}</div>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-label text-krypt-muted/70">{children}</p>;
}

export function LinksPanel({
  mint,
  chain,
  summary,
  launches,
}: {
  mint: string;
  chain: string;
  summary: TokenSummary | null;
  launches: Parameters<typeof XLinkPanel>[0]['launches'];
}) {
  const xs = useXStats(mint);
  const intel = useLinkIntel(chain === 'solana' ? mint : null);
  const site = useSiteRead(mint);
  const links = tokenLinks(chain, mint, summary?.launchpad ?? null, summary?.socials ?? null);
  const st = xs?.stats ?? null;
  const hasTelegram = links.some((l) => l.kind === 'telegram');
  const hasWebsite = links.some((l) => l.kind === 'website');
  const tokenX = parseXLink(summary?.socials.twitter ?? null).handle;
  const tg = intel?.telegram ?? null;
  const web = intel?.website ?? null;
  const yes = (v: boolean | null): string => (v === null ? '—' : v ? 'yes' : 'no');

  return (
    <div className="space-y-3">
      {/* The numbers first, the links under them (user's ask, 2026-09-20). */}
      <section>
        <Heading>The X page, as read in the Links panel</Heading>
        {!st ? (
          <p className="text-body text-krypt-muted">
            Nothing read yet. Add the Links panel on the Widgets page and open this token’s X page there — the numbers on that page land here, and in Scripts.
          </p>
        ) : st.loginWall ? (
          <p className="text-body text-krypt-muted">{describeXStats(st)}</p>
        ) : (
          <>
            {st.page === 'profile' && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Cell label="Followers" value={fmtCount(st.followers)} />
                <Cell label="Following" value={fmtCount(st.following)} />
                <Cell label="Joined" value={st.joined ?? '—'} />
                <Cell label="Verified" value={st.verified === null ? '—' : st.verified ? 'yes' : 'no'} tone={st.verified ? 'gold' : undefined} />
              </div>
            )}
            {st.page === 'post' && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Cell label="Likes" value={fmtCount(st.likes)} />
                <Cell label="Reposts" value={fmtCount(st.reposts)} />
                <Cell label="Replies" value={fmtCount(st.replies)} />
                <Cell label="Views" value={fmtCount(st.views)} />
                <Cell label="Bookmarks" value={fmtCount(st.bookmarks)} />
              </div>
            )}
            {st.page === 'other' && <p className="text-body text-krypt-muted">The page that was open was neither a profile nor a post — nothing to read.</p>}
            <Note>
              {st.handle ? `@${st.handle} · ` : ''}
              {st.page === 'post' ? 'a post' : st.page === 'profile' ? 'a profile' : 'a page'}, read {ago(xs?.readAt ?? Date.now())} ago off the page in the Links panel — no API, no extra request. “—” is a number the page did not show.
            </Note>
          </>
        )}
      </section>

      <section>
        <Heading>Telegram, from its public preview</Heading>
        {!hasTelegram ? (
          <p className="text-body text-krypt-muted">{summary ? 'No Telegram link published.' : 'Waiting for the providers to answer for this token’s links.'}</p>
        ) : chain !== 'solana' ? (
          <p className="text-body text-krypt-muted">Looked up for Solana tokens only, for now.</p>
        ) : !tg || tg.state === 'none' || tg.state === 'pending' ? (
          <p className="text-body text-krypt-muted">Asking t.me for the public preview…</p>
        ) : tg.state === 'failed' || !tg.preview ? (
          <p className="text-body text-krypt-muted">{tg.reason ?? 'Nothing readable on the preview page.'}</p>
        ) : tg.preview.privateInvite ? (
          <p className="text-body text-krypt-muted">{describeTelegram(tg.preview)}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Cell label={tg.preview.countWord === 'subscribers' ? 'Subscribers' : 'Members'} value={fmtCount(tg.preview.members)} />
              <Cell label="Online" value={tg.preview.online === null ? '—' : fmtCount(tg.preview.online)} tone={tg.preview.online === null ? 'dim' : undefined} />
              <Cell label="Kind" value={tg.preview.kind} />
              <Cell label="Title" value={tg.preview.title ?? '—'} />
            </div>
            <Note>
              What t.me shows anyone who opens the link, read {tg.readAt ? `${ago(tg.readAt)} ago` : 'just now'} — no account, no API. A channel shows no online count; a private invite shows no count at all.
            </Note>
          </>
        )}
      </section>

      <section>
        <Heading>The website: its domain, and what the page says</Heading>
        {!hasWebsite ? (
          <p className="text-body text-krypt-muted">{summary ? 'No website published.' : 'Waiting for the providers to answer for this token’s links.'}</p>
        ) : (
          <>
            {chain !== 'solana' ? (
              <p className="text-body text-krypt-muted">Domain records are looked up for Solana tokens only, for now.</p>
            ) : !web || web.state === 'none' || web.state === 'pending' ? (
              <p className="text-body text-krypt-muted">Asking the registry for the domain’s record…</p>
            ) : web.hostedOn ? (
              <p className="text-body text-krypt-muted">
                Hosted on <span className="font-semibold text-white/90">{web.hostedOn}</span> — no domain of its own, so there is no registration date to read; the platform’s says nothing about the coin.
              </p>
            ) : web.state === 'failed' || !web.record ? (
              <p className="text-body text-krypt-muted">
                {web.domain ?? web.host}: {web.reason ?? 'no record read'}.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Cell label="Domain" value={web.record.domain} />
                <Cell label="Registered" value={web.record.registeredAt ? `${fmtRegistered(web.record.registeredAt)} · ${fmtAge(domainAgeDays(web.record.registeredAt))}` : '—'} />
                <Cell label="Expires" value={fmtRegistered(web.record.expiresAt)} />
                <Cell label="Registrar" value={web.record.registrar ?? '—'} />
              </div>
            )}
            {!site ? (
              <p className="mt-2 text-body text-krypt-muted">
                Nothing read off the site yet. Open it in the Links panel on the Widgets page and what the page says about itself lands here — whether it names this contract, which X and Telegram it links, how much of a site it is.
              </p>
            ) : (
              <>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Cell label="Names the contract" value={yes(site.read.namesContract)} tone={site.read.namesContract ? 'gold' : undefined} />
                  <Cell label={tokenX ? `Links @${tokenX}` : 'Links an X'} value={tokenX ? yes(siteLinksX(site.read, tokenX)) : site.read.xHandles.length ? `@${site.read.xHandles[0]}` : 'no'} />
                  <Cell label="Telegram links" value={String(site.read.telegramLinks.length)} />
                  <Cell label="Words · outbound hosts" value={`${site.read.wordCount} · ${site.read.outboundHosts}`} />
                </div>
                {site.read.mentionsConnectWallet && (
                  <p className="mt-2 text-body text-white/90">The page asks visitors to connect a wallet or claim something — the words a drainer page uses. Said as what the page says, not as a verdict.</p>
                )}
                <Note>
                  {site.read.title ? `“${site.read.title}” · ` : ''}
                  {site.read.generator ? `built with ${site.read.generator} · ` : ''}
                  read {ago(site.readAt)} ago off the page in the Links panel. The app never fetches a token’s website itself.
                </Note>
              </>
            )}
            <Note>Visitor numbers are not shown: no free source publishes a site’s traffic, and a guess would be worse than nothing.</Note>
          </>
        )}
      </section>

      <section>
        <Heading>Links the creator published</Heading>
        {links.length === 0 ? (
          <p className="text-body text-krypt-muted">
            {summary ? 'No X, website or launchpad page on record for this token.' : 'Waiting for the providers to answer for this token’s links.'}
          </p>
        ) : (
          <div className="space-y-1">
            {links.map((l) => (
              <div key={l.url} className="flex items-center gap-3 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-body">
                <span className="w-20 shrink-0 font-semibold text-white/90">{l.label}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-krypt-muted" title={l.url}>
                  {l.host}
                  {l.url.replace(/^https:\/\/[^/]+/, '').replace(/\/$/, '')}
                </span>
                <button
                  onClick={() => void window.krypt.app.openExternal(l.url)}
                  className="flex shrink-0 items-center gap-1 text-krypt-muted transition hover:text-krypt-purple"
                  title="Open in your browser"
                >
                  Open
                  <ExternalLink className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <Note>As the providers relayed them; the app never visits a token’s website on its own. The Links panel on the Widgets page shows these pages inside the app.</Note>
      </section>

      {/* Free, offline: what the X link actually points at, and whether the
          same account or post is behind other launches on screen. */}
      <XLinkPanel mint={mint} twitter={summary?.socials.twitter ?? null} launches={launches} />
    </div>
  );
}
