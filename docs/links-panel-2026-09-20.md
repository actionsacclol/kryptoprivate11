# Links panel and token-page links — 2026-09-20

Asked for: a My Layout widget "somewhat of a headless browser" that shows a
token's linked X post or account, its website and its pump.fun page in a box,
with buttons that swap one page for another; and, on a memecoin's terminal
page, the X and website links up top plus a link to the launchpad site
(pump.fun, Pons on Robinhood Chain, four.meme on BNB).

## What a token's links are

`shared/tokenLinks.ts`, pure, used by both surfaces so they cannot disagree:

- `tokenLinks(chain, mint, launchpad, socials)` → X, website, Telegram,
  launchpad, in that order. Only https URLs; a bare handle or an http link is
  dropped, never repaired. The label says where a click goes: a "twitter"
  field that points at TikTok is shown as `tiktok.com`, a website field that
  is really an X link is shown as X.
- `launchpadSite(chain, launchpad, mint)`: pump.fun is certain
  (`https://pump.fun/coin/<mint>`, the same pattern the $KRYPTO card uses).
  four.meme's `/token/<address>` answered 403 (bot wall), not 404, to a plain
  fetch and could not be confirmed further. Pons's token-page path is
  UNVERIFIED — www.ponslaunchpad.com did not resolve from the dev machine —
  so that link opens the launchpad's token browser, not the token. Both are
  one constant each in `LAUNCHPAD_SITES`. Every other launchpad is no link.
- `isEmbeddableUrl(url)`: https, a real public host, no credentials, nothing
  local, under 2 kB. The renderer applies it first; main applies it again.

## The panel

`links` in `src/panels/registry.tsx`. It follows the same token the Chart
panel does (`chartToken`): opening a coin anywhere fills both. It asks
`market.summary` (Solana) or `evm.summary` for the socials and launchpad,
renders one button per link — the launchpad page (pump.fun, four.meme, Pons)
first and OPEN BY DEFAULT, then X, website, Telegram — and an Electron
`<webview>` whose `src` is the active button's URL; clicking another button
swaps the page in the same box, and a new token goes back to its launchpad.
Under the view a line names the host and says the site is external and
sandboxed, every time; a "Browser" button opens the current page outside.

## Why an embedded page is safe here

A `<webview>` is a page the app did not write, inside a window that carries
`window.krypt`. It is safe only because of what it is not given, and every one
of those is enforced in the main process (`webSecurity.guardWebviews`), not
in the renderer that asked for the view:

- `will-attach-webview`: the preload is deleted (no bridge, no `window.krypt`),
  Node off, context isolation and the sandbox on, `webSecurity` on, insecure
  content off, and a `src` that fails `isEmbeddableUrl` is refused outright.
- The guest's own contents: popups denied and handed to the system browser;
  `will-navigate` and `will-redirect` allow only https; its session (partition
  `persist:links`, its own cookie jar, kept on the machine) refuses every
  permission request and every download.
- Both windows that can host a panel (main and popped-out) set
  `webviewTag: true`; nothing else changed in their preferences.

Verified live with `npm run test:links:e2e` against the running dev app: the
guest appears as its own DevTools target, loaded `https://x.com/…` for the
$KRYPTO coin ("Yuhgo (@YuhgoSlavia) / X"), and clicking Website replaced it
with `https://krypt.cc/tools/krypto` in the same box. The app's CSP does not
block the element. No "webview: refused" line in the log.

What the view cannot do: see the wallet, the keys, or any page of ours;
open a window; download; ask for the camera or notifications. What it can
do: be a phishing page. That is why the panel says, under every page, that
nothing on it is Krypt and never to enter a key or seed phrase.

## Token pages

Solana (`Token.tsx`) and EVM (`EvmToken.tsx`) headers list the same links
after the explorer buttons, each opening the system browser.

## Privacy policy

Section 4 now states what the panel sends where (the sites receive the same
requests a browser would, and nothing from the software). A new flow of the
user's requests and cookies to third parties is material, so
`TERMS_VERSION` moved to `2026-09-20.1` and every user re-accepts once.

## Tests

`test/tokenlinks.test.mjs` (in `npm test`): the derivation, the embeddable
rule, and source pins that main strips every capability from a view and both
token pages and the policy are wired. `test/linkspanel.e2e.mjs` needs the dev
app; it temporarily adds the panel and points it at $KRYPTO, then restores
both keys.

## Reading the numbers off an X page (same day)

Asked for: followers on a linked account, likes and comments on a linked
post, "without directly using api or anything". Done exactly that way: the
panel's browser view has already rendered the X page for the person looking
at it, and the host asks that view what is on its screen
(`webview.executeJavaScript` with `xStatsReaderScript()` from
`shared/xStats.ts`). No API, no key, no extra request.

- **What is read.** A profile: followers, following, joined, verified,
  handle. A post: likes, reposts, replies, bookmarks, views, and the author.
  Each number is found by more than one route (a test id, an aria-label, a
  link's text) and stays null when none answers — unknown, never 0. X's
  sign-in wall is recognised and named; the strip says "sign in inside the
  box and it reads again". Three looks after load (1.2 s, 2.5 s, 4 s),
  because X paints after load.
- **Where it goes** (the user asked "where do the numbers go"): a stats bar
  at the BOTTOM of the widget, under the view — "@handle · 533 followers ·
  10 following · May 2025 joined · verified · read 0s ago", or likes /
  reposts / replies / views / bookmarks for a post, with Read again. The
  bar shows the last X read WHICHEVER page is open (user's ask, later the
  same day: "the stats should show in totality across all pages"), in a
  slightly larger face (`text-label` bar, `text-body` numbers); under a
  launchpad or website page with no X read yet it says to open X above; a
  **Links tab under the token chart** (`src/components/terminal/LinksPanel.tsx`):
  the X numbers as cells with their age FIRST (or the honest "nothing read
  yet — open the page in the Links panel"), then the published links with
  Open buttons, then the X-link classification with reuse counts, which
  moved there from the Security tab (the user asked for "the stats up top
  and the links below"); the token header's X button ("X · 53 followers", age in the
  tooltip) through `src/state/useXStats.ts` (localStorage, cross-window
  like the chart token); and main, through `links:xstats:set`, validated by
  `validateXStats` into a bounded record, so `bot.links(mint).x.stats`
  carries the whole read and every number is a rule variable —
  `xFollowers`, `xFollowing`, `xVerified`, `xLikes`, `xReposts`,
  `xReplies`, `xViews`, and `xStatsAgeSec` to gate on freshness.
- **What it is not.** It reads the page a person opened, once, and never
  crawls. Loading X pages for every flagged coin with the user's cookies is
  the pattern X detects and suspends accounts for, and it is what our own
  terms tell users not to do to a third party. So a script sees these
  numbers only for coins someone opened in the panel; `xFollowers` is null
  otherwise, and the guide says so.
- **Two shells, and a bug the user caught.** The first live run read the
  $KRYPTO account as "53 followers"; the user has 533. Cause: X renders the
  number and its word with no space ("533Followers"), and `parseCount`'s
  guard against reading "12 Bookmarks" as twelve billion was a look-ahead
  on the WHOLE match, so the regex backed the number off to "53" to satisfy
  it. The look-ahead now belongs to the suffix group only
  (`(?:\s*([KMBkmb])(?![a-z]))?`), pinned by "533Followers" → 533,
  "12.3KFollowers" → 12300, "2Bookmarks" → 2. Probing the real page
  (through the guest's CDP target) showed WHY joined and verified had come
  back unknown: X serves a signed-out shell with no `data-testid` at all.
  There the join date is the text of the `/about` link, the badge is a
  `Verified account` aria-label by the name, the handle's casing is only in
  the title, and a post's counts are the TEXT of controls whose labels are
  the bare words ("Like" → "310K"); views are not shown to a signed-out
  reader, so they stay unknown there. `readXPage` reads both shells now,
  signed-in routes first, and the tests carry a fake of each.
- **Verified live** (`npm run test:xstats:e2e`, signed out, after the fix):
  the $KRYPTO account read as 533 followers, 10 following, joined May 2025,
  verified, handle @YuhgoSlavia; the record reached the token store and
  main. The driver now forgets the token's earlier read and waits for one
  made after it started — the first check had passed on a stale entry.
- **Fragility, stated.** X changes its markup without notice. When a route
  breaks the number reads unknown and the strip says the page could not be
  read; nothing is ever inferred. The selectors live in one function,
  `readXPage`, driven in `test/xstats.test.mjs` against fake profile, post
  and wall pages.

## Telegram members, domain age, and what the website says (same day)

Asked for: "website stats for coins that have a website, see if we can't
snag traffic, and telegram wise we can pull members if it's an invite, like
t.me/kryptback". Three things were possible without a key or an account,
and one was not.

- **Not possible, and not faked: traffic.** Nobody publishes a site's
  visitor numbers for free. SimilarWeb is paid and forbids scraping; the
  Chrome UX Report needs a Google key; the Tranco top-million list would
  read "not listed" for every memecoin site alive. A number here would be
  a guess, so there is none, and the Links tab says so where a person
  would look ("Visitor numbers are not shown…"). If a keyed source is ever
  wanted, the honest one is CrUX ("Google has enough real-user data on this
  origin"), BYO-key like the AI analysis.
- **Telegram members — YES, from the public preview.** `https://t.me/<name>`
  serves a page to anyone: title, description, and "149 subscribers" (a
  channel) or "26 481 members, 1 564 online" (a group). No login, no API,
  no cookie. `shared/linkIntel.ts` parses it (`parseTelegramPreview`,
  fixtures captured live); `electron/data/linkIntel.ts` fetches it. A
  PRIVATE invite (`t.me/+…`) shows Telegram's generic "Join group chat"
  page with no count, and that stays unknown — Telegram publishes no number
  for it, and the tab says so. Verified live: t.me/kryptback → channel,
  149 subscribers, "Krypt.cc".
- **Domain age — YES, from the registry (RDAP).** Every registry publishes
  its domains' records over RDAP, WHOIS's successor: registration date,
  expiry, registrar. IANA's bootstrap (`data.iana.org/rdap/dns.json`)
  names the server per ending, so the lookup asks the registry itself —
  never the token's site — and the fetcher may talk only to hosts that
  list names. Verified live: krypt.cc → registered 16 Feb 2010, NameCheap,
  via tld-rdap.verisign.com. Three honest gaps: .io, .me and .co publish no
  RDAP at all (the record says "the .io registry publishes no RDAP
  record"); a site on a shared platform (Vercel, GitHub Pages, Carrd, 35
  more in `SHARED_HOSTS`) has no domain of its own, so the platform is
  NAMED instead of its age being looked up; an unregistered name reads
  "the registry has no record under that name".
- **What the site says — YES, read off the page a person opened.** The same
  trick as the X read: the Links panel's view has rendered the token's
  website, and the host asks the view (`shared/siteRead.ts`,
  `siteReaderScript(mint)`). Does the page NAME this contract (text or a
  link)? Which X accounts and Telegram rooms does it link — the same ones
  the launch published? How much of a site is it (words, outbound hosts,
  the builder's meta generator)? Does it ask visitors to connect a wallet
  or claim something — the words a drainer page uses, reported as the
  words, never as a verdict. The app never fetches a token's website
  itself: the creator's server sees only the visit the person made.
  Verified live on krypt.cc: 389 words, does not name the $KRYPTO contract,
  links no X — true, and worth fixing on the site.

**When main looks things up.** Only for a token someone asked about: a
person opened its page or the Links panel, or a script called
`bot.links` / `bot.market` for it. Rules evaluating every launch read
the cache and never trigger a lookup, so the scanner's hundreds of coins an
hour do not become hundreds of requests to Telegram and the registries.
Each source has a 60-an-hour budget; a failure is remembered (10 min for
t.me, an hour for a registry, a day for "no RDAP for this ending"); a
redirect is followed by hand, twice at most, only onto an allowlisted host.
The renderer sends a mint and nothing else (`links:intel:get`); main
derives the links from its own facts.

**Where it shows.** The token header's Telegram button carries
"· 149 subscribers" and the Website button "· since 2010" (or "· on
Vercel"); the Links tab has a Telegram section (subscribers/members,
online, kind, title) and a Website section (domain, registered + age,
expires, registrar; then the site read: names the contract, links the
token's X, Telegram links, words · outbound hosts, the connect-wallet
line); the Links panel's bar carries the Telegram count and the domain
date whichever page is open, and the site read while the website is
showing. Scripts: `bot.links(mint)` gains `telegramStats`, `domain`
and `site`; rule variables `tgMembers`, `tgOnline`, `tgKind`,
`domainAgeDays`, `domainHostedOn`, `siteNamesContract`,
`siteLinksX`, `siteOutboundHosts`, `siteMentionsConnectWallet` —
every one null until looked up or read, never 0.

**Legal.** Privacy §4 gained the sentence naming t.me, data.iana.org and
the registries, and what is never fetched; `TERMS_VERSION` →
'2026-09-20.2' (new hosts receive requests). The legal test's by-hand host
list carries both hosts.

**Tests.** `test/linkintel.test.mjs` (parsers over the live fixtures,
the link normaliser, IANA's bootstrap, the shared-platform rule, wiring
pins), `test/siteread.test.mjs` (the reader against a real coin site, a
template, a drainer's words; the validator; the injected script),
additions in `test/automation.test.mjs`; live: `npm run test:linkintel`
(t.me/kryptback + krypt.cc through the real module, .io and an
unregistered name honest), `npm run test:linkintel:e2e` (the token page's
header buttons and Links tab), `npm run test:siteread:e2e` (the panel
reads krypt.cc and main keeps it).
