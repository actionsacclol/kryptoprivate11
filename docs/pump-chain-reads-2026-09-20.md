# Pump coins read from the chain, not from pump.fun (2026-09-20)

## The problem, measured

Two provider snapshots of the running dev app, a few minutes apart, on the
user's own profile with a token page open:

| provider | calls | errors | state |
| --- | --- | --- | --- |
| pump.fun | 4 → 7 | 3 → 6 | parked 80 s, then 120 s: "rate limited (429)" |
| Jupiter | 19 → 54 | 0 | 5/500 of its window |
| DexScreener | 6 → 20 | 0 | fine |

pump.fun was the only provider ever parked, and it was parked almost all
the time. The host allows about 60 requests a minute for everything and
answered most of ours with 429. The park then doubled itself on every
retry that failed.

Where the calls came from: `buildSummary` bought `/coins/{mint}` for every
pump-suffixed mint on every build, memoised 6 s against a 5 s summary TTL,
which meant

- one call every ~6 s per open token page,
- one call per armed order / alert / open copy every 12 s (`startOrdersPoll`
  → `summaryMany`),
- one call per holding on every portfolio pass,

and while parked, `usable('pumpfun')` was false, the call was skipped, and a
coin forty seconds old had no price at all — Jupiter and DexScreener do not
index it yet. So the app was both rate limited and blind on exactly the
coins it is for.

## What the coin record was for, and where else it lives

| field | on chain | account |
| --- | --- | --- |
| price | virtual reserves | bonding-curve PDA (`["bonding-curve", mint]`) |
| progress | virtual token reserve (token-side) | same |
| exit liquidity | `real_sol_reserves` | same |
| complete, creator, mayhem, cashback | flags | same |
| decimals, supply, token program | mint account | the mint |
| name, symbol, uri | Metaplex `Metadata` PDA, or the Token-2022 `TokenMetadata` extension in the mint | derived |
| graduated price | quote vault + **virtual quote reserve** over base vault | canonical PumpSwap pool + its two ATAs |
| image, socials, created_timestamp, is_banned, nsfw, king_of_the_hill, ath | **not on chain** | pump.fun |

Every address in the first column is derived from the mint (the PumpSwap
builder already derives the pool and its vaults), so one
`getMultipleAccounts` reads three accounts per mint, thirty-three mints per
call, on an RPC budget the app is nowhere near (public endpoint: 50 per
10 s window for this method).

## What was built

`electron/data/pumpChain.ts`

- `readMany(httpUrl, mints)`: pass one reads `[curve, mint, metadata]` per
  mint in chunks of 33; pass two reads `[pool, quoteVault, baseVault]` for
  the graduated ones. Results are cached 4 s per mint; a mint with no curve
  account is remembered as "not a pump coin" for 60 s; an RPC that did not
  answer is remembered as nothing and asked again.
- The mint bytes seed `onchain.mintFacts` (new `seedMintFacts`), so the
  summary's own mint read that follows is a cache hit rather than a fourth
  request.
- `toSummary(coin, solUsd)`: name, symbol, decimals, supply, creator,
  price, market cap (derived), exit liquidity, token-side progress (100
  once complete), pool address and dex id, with `onchain` sources. Nothing
  the chain cannot know is claimed.
- Price rules: `curvePriceSol = vSol / vTok`;
  `poolPriceSol = (quoteVault + virtualQuote) / baseVault` — the rule
  pumpSwapBuilder fitted to twelve real swaps to the lamport.

`electron/chain/addresses.ts`: `METADATA_PROGRAM`, `metadataFor(mint)`.

`electron/data/market.ts`

- `buildSummary` fires the chain read in parallel with the providers and
  merges it FIRST, so the chain's fields win and providers fill the rest.
  A graduated coin registers its canonical pool for the AMM tape from the
  chain's answer, with no DexScreener dependency.
- The scanner's own row (`TerminalContext.liveLaunch(mint)`, new) fills
  creator, name and detection time for a tracked coin.
- pump.fun is asked for IDENTITY only — `pf.coinIdentity(mint)`, a
  ten-minute memo that first consults any record already in hand — and
  only on a build a person is looking at. `summaryMany` (portfolio, orders
  poll, watchlist) builds with `identity: false`: never a per-mint pump.fun
  call, only the batched routes and the chain.
- `summaryMany` warms the chain reads for its cold pump mints in the same
  step as Jupiter's and DexScreener's batches.

## Verified

- `test/pumpchain.test.mjs` (12): batch shape (two RPC calls for four
  mints, forty mints are two calls), the mint-facts seed, negative vs
  unknown caching, Token-2022 metadata, non-ATA vaults, both price rules,
  both summaries, a graduated coin with an unreadable pool states no price.
- `npm run test:pumpchain:live`: $KRYPTO read from the public RPC in
  262 ms — Token-2022 metadata named it, the pool pass priced it at
  2.5097e-7 SOL against DexScreener's 2.4930e-7 (0.67 %).
- `npm run test:pumpchain:e2e` against the running app, one minute of
  five-second summaries for $KRYPTO and a fresh curve coin (24 builds that
  used to be 24 `/coins/{mint}` calls): pump.fun +1, Jupiter +17,
  DexScreener +6. $KRYPTO priced `onchain` at 2.5097e-7 SOL on the
  canonical pool, named from the chain, image and creation date from the
  identity record; the curve coin at 12.0 % progress priced from the
  engine's own tape with the chain's liquidity. The one pump.fun call still
  answered 429 (the host parks this IP on almost any request now), and the
  page no longer cares.
- `test/marketcalls.test.mjs` 15/15 unchanged.

## What stays with pump.fun

The Discover columns' list routes (`/coins?…`, one call per column poll,
already windowed at 30/min and backed by the scanner's live launches when
parked), and the identity record per opened token per ten minutes. A
parked pump.fun now costs a token page its image and creation date, not
its price.

## Not built

- Fetching the metadata `uri` JSON for the image: that is a
  creator-controlled URL fetched from the user's machine, the exact thing
  `metadata.ts` was locked down over; the image stays with the provider.
- A vault `accountSubscribe` for graduated coins: the per-mint
  `logsSubscribe` already carries PumpSwap swaps once the pool is
  registered, which the chain read now does.

## Later the same day: the uri, and the image + socials

The Token-2022 metadata extension's `uri` is now read (it was not — the
walk stopped at the symbol, so every create_v2 coin had `uri: null`), and
the image and the socials come from the metadata JSON that uri points at
(`engine/metadata.ts`, merged last in `buildSummary`), not from pump.fun's
record, which only copies that file minutes later. See
docs/links-panel-2026-09-20.md, "Evening".
