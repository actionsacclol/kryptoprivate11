# Discover without pump.fun, and the Jupiter budget (2026-09-20)

Follow-up to `pump-chain-reads-2026-09-20.md`. That change took pump.fun off
the price path (token pages, orders, portfolio). The user's next question was
the Terminal page itself: "the main terminal page always said rate limited by
pumpfun or coingecko" and "20–30 feed loss". Measured, then fixed.

## What the Terminal page showed, measured (before)

150 s on Discover with the scanner running, dev profile, chain-first summaries
already in:

| provider | calls / 150 s | errors | on screen |
| --- | --- | --- | --- |
| pump.fun | 5 | 4 | "Rate limited by pump.fun" on New, Graduating, Migrated the entire time |
| Jupiter | 115 (~46/min) | 2 | parked twice for ~40 s; banner on New and Trending |
| GeckoTerminal | 13 | 0 | quiet (no chart open) |
| swap-api | 21 | 1 | parked 60 s (badges only) |

Feed loss read 13.1 % on two public sockets (mainnet-beta + publicnode); the
Helius key is set but the "Helius feed socket" toggle is off on this profile.

Causes found:

1. The three Discover columns took their pump rows from pump.fun's list
   routes, which 429 on this IP on almost every call, and the park was
   stamped on every column that *could* have used pump.fun — over rows that
   were entirely fresh from the scanner.
2. Jupiter's keyless host (`lite-api.jup.ag`) is not un-throttled any more.
   The app paced it at 120 ms (eight a second in bursts) and it answered 429
   at ~46 calls a minute. Probed the same day: 12 requests at 2/s and 6 at
   1/s all 200. Its limiter is on the burst.
3. The HTTP memo cache held **600** entries. Four columns of forty rows keep
   eight to ten keys per row, so every fill evicted a quarter of the cache
   and the per-mint memos (Jupiter rows, Shield verdicts, chain reads) never
   survived to the next pass. Every pass re-bought them.
4. Route counters (new) showed what Jupiter was spent on: Shield ×58 and the
   enrichment batch ×32 of 141 calls in four minutes — four columns each
   asking for their own rows within a second or two, one request per column.
5. GeckoTerminal 429'd once at *five* calls a minute: its four listings were
   memoised with equal TTLs, expired together, and were re-asked together —
   four requests inside eight seconds. Its limiter is on the burst too.

## What was built

**The feed is the pump source while the scanner runs**
(`electron/engine/liveCurves.ts`, engine hooks, `market.discover`).

- `LiveCurves`: every pump trade the program socket hears — on any mint,
  tracked or not — updates a bounded book of `mint → reserves, last trade`.
  `graduating(n)` is the incomplete curves that traded in the last fifteen
  minutes, at ≥ 20 % token-side progress, most progressed first: pump.fun's
  own "about to graduate" list, computed locally, zero requests.
- `LiveMigrations`: every `amm_migration` event, newest first, deduplicated.
- Graduating and Migrated rows are then priced and named by ONE batched
  chain read (`pumpChain.readMany`: curve/mint/metadata, then pool + vaults
  for the graduated ones). Exact reserves, real SOL, creator, name.
- pump.fun's lists are asked only to **bootstrap** a column the feed has not
  filled yet (fewer than half its rows), and never while pump.fun is parked.
  Scanner stopped: the lists are the source, exactly as before.
- A park banner names only a provider the column **asked** on its last pass
  (`askedByColumn`), not everything in a static table.
- The rug rules and odds on Discover rows never buy the coin record
  (`buyCoin: false`): the record is built from the chain read the column
  just made plus the row's own creation time and creator. The token page
  still buys it (once per ten minutes).

**Jupiter** (`electron/data/http.ts`, `providers/jupiter.ts`)

- Keyless gap 120 → 500 ms; window 50/min keyless, 55/min keyed (was the
  gap-implied 500/min, i.e. none).
- Memo cache 600 → 5,000 entries.
- `recent` list 6 → 12 s, trending lists 6 → 15 s, Shield 30 → 120 s.
- Enrichment (image, holders, volume, audit) remembers a row 45 s and a
  mint Jupiter did not know for 60 s (`byMints({ enrich: true })`); the token
  page's own per-mint memory stays at 8 s because a non-pump price may come
  from it.
- A 1.5 s **coalescer** merges the Shield and enrichment batches of columns
  that ask within the same window into one request each. The priority lane
  (orders) never waits in it.

**GeckoTerminal**: per-dex listing memos staggered 60/75/90 s so the four
listings spread to roughly one every fifteen seconds.

**Rug attach**: two workers instead of three; three concurrent seeks burst
the swap-api at ~3/s and it parked itself for a minute.

**Providers panel**: each provider now lists its most-called routes this
session (`ProviderStatus.routes`), so the next "who is spending this" is a
glance, not a session.

## Measured after

150 s on Discover (scanner stopped on this run — the engine does not
auto-start after a hot restart of the main process):

| provider | calls / 150 s | errors | on screen |
| --- | --- | --- | --- |
| pump.fun | 8 (the lists, scanner stopped) | 2 | **no banner** at any sample |
| Jupiter | 131 (~35/min, before the coalescer) | 0 | no park |
| GeckoTerminal | 10 | 0 | no park |
| swap-api | 46 | 1 | one 60 s park (badges) |

Jupiter routes over the session: Shield 58, search batch 32, search single
14, recent 10, price 9, top-traded 9, top-organic 9 — the numbers the
coalescer was then built against. The earlier scanner-running run (before
the bootstrap-while-parked rule) showed the pump.fun banner for the first
two minutes while the books filled, then none.

Tests: `test/livecurves.test.mjs` (5), `test/marketcalls.test.mjs` (19: four
new — zero pump.fun on a scanner-running pass, bootstrap once then never,
a park stamped only where asked, one Shield and one enrichment request for
three columns asked together), `test/http.test.mjs` (Jupiter gap/window),
`test/launchintel.test.mjs` (32). Live driver: `test/ratelimit.e2e.mjs`.

## Not changed, and why

- **Feed loss** (13–17 % on this profile) is dropped websocket events, not
  HTTP. Two free sockets race; publicnode delivered ~30 % fewer events than
  mainnet-beta. The Helius key is set but the "Helius feed socket" toggle is
  off. Turning it on adds the paid socket to the race — the single biggest
  lever — and bills credits, so it stays the user's call.
- **swap-api seeks** for the rug/odds badges still park occasionally at ~11
  calls a minute. The badges are decoration; the park never touches the
  Discover banner. Two workers reduce the burst; the memo carries the rest.
- **Scanner stopped** keeps pump.fun's lists as the Discover source. The
  live books need the program socket, which only the scanner opens.
