# Rate-limit swarm (2026-09-06)

Trigger: users reporting HTTP 429s and "being rate limited on stuff". Nine parallel
auditors, one per dimension, read-only; every finding below was re-verified by hand
against the file:line before anything was changed. Line numbers are as of commit
c1df49c (beta.9, branch release/beta.7) unless marked *after*.

Dimensions: A provider HTTP layer · B provider call volume · C RPC HTTP volume ·
D websockets · E trade path under 429 · F multipliers (fan-out, Wallet Lab, copy) ·
G renderer / user-facing surface · H bots, images, metadata, Jito · I documented limits
(fetched live).

## 0. What was actually happening

Two mechanisms, one on each side of the network layer, turned a single 429 into a storm:

1. **Provider layer (`electron/data/http.ts`).** The 20 s park after a 429 was checked
   only when a call was *queued*. Every call already chained behind the one that 429'd
   still fired into the park, 429'd in turn, and re-set the 20 s clock — a backlog of
   forty calls kept the provider hammered at full gap rate for the whole "cooldown".
   Retry-After was never read. Priority calls (chart, six concurrent liquidation quotes)
   bypassed the park *and* each other, so they re-parked a provider a real sell needed.
2. **RPC layer (`electron/engine/rpcClient.ts`).** Nothing remembered a 429. N concurrent
   callers each paused 400 ms and re-hit the same host, then failed over — a burst that
   crossed the limit became 2–3× the traffic on two hosts. No bucket, no concurrency cap:
   a ten-wallet fan-out was ~30 calls at t=0 against Helius free's 10 rps.

On top of that the app's *demand* exceeded several documented ceilings on its own:
Discover re-asked Jupiter for forty mints it had just listed every four seconds
(~85/min idle), the portfolio priced sixty mints with sixty searches and sixty Shield
calls per refresh from three pollers, Birdeye's free package (1 rps per account) was
hit at 8 rps, and the rug/odds attach kept draining after its 2 s budget — including
Migrated rows nobody badges.

## 1. Documented limits (fetched 2026-09-06; agent I)

| Service | Limit | Notes |
|---|---|---|
| `api.mainnet-beta.solana.com` | 100 req/10 s, 40/10 s per method, 40 conns, **`x-ratelimit-pubsub-limit: 10`** | Sends `retry-after: 10` and `x-ratelimit-*` headers on every reply now. Binding constraint is connection rate; we keep-alive via undici so request count is ours. |
| Helius free | **10 rps** RPC, **1 rps sendTransaction**, 2 rps DAS, **5 WS connections**, 1 M credits | No Retry-After documented. Sender: 0 credits, tip ≥ 0.001 SOL. |
| Jupiter `lite-api.jup.ag` | none observed (60 at 10-parallel all 200) | **Officially deprecated 2025-12-31, still alive.** Keyless `api.jup.ag` is 0.5 rps (bucket 5); a free key is 1 rps. A keyed path is future work. |
| DexScreener | 300/min pairs · 60/min profiles/orders | `/tokens/v1/solana/{30 mints}` batch exists, unused. |
| GeckoTerminal | 30/min | Edge-sensitive: 429'd after four burst calls on 08-24. |
| Birdeye Standard (free) | **1 rps per ACCOUNT**, 30 000 CU/mo | holder route = 30 CU. |
| RugCheck | ~60/min community, 15 burst measured | Unverified officially. |
| pump.fun `/coins?…` | `x-ratelimit-limit: 60` per 60 s (observed header) | `/coins/{mint}` shows no header and took 30 at 10-parallel. |
| swap-api.pump.fun | `x-ratelimit-limit: 1000`, window unverified | |
| PumpPortal | 25 rps, bans expire hourly | Relayer is LAST in the router anyway. |
| Jito | **1 req/s per IP per region**, tip_floor included | |
| Telegram | 1 msg/s per chat, 20/min per group, 30/s overall; `parameters.retry_after` | |
| Discord | 50 req/s global, per-route buckets; **10 000 invalid requests / 10 min → IP ban** | Rich Presence 5 updates / 20 s. |

## 2. Findings and status

Severity: P1 = users hit 429 / a feature breaks in normal use; P2 = plausible heavier use
or a bad degradation; P3 = hygiene. **Fixed** = in this branch, pinned by a test where
the rule is a rule.

### Provider layer (A)

| # | Sev | Finding | Status |
|---|---|---|---|
| A2 | P1 | Park checked at enqueue only; queued calls fire into it and each re-extends it; Retry-After ignored; no escalation | **Fixed** — park re-checked at the front of the queue and again after the window wait; Retry-After honoured (clamped 2–120 s); 20→40→80→120 s escalation, strikes decay 5 min; a park is only ever extended; 429 bodies cancelled. `test/http.test.mjs` |
| A4 | P2 | `priority` calls had no mutual spacing; used by display paths (chart, liquidation quotes) | **Fixed** — priority calls run on their own serial chain (spaced, still ahead of the queue); liquidation quotes are no longer priority and are memoised 20 s |
| A6 | P2 | Queue unbounded; wait outside the timeout; nothing cancels | **Fixed (bounded)** — a call that waited > 20 s in a queue is answered "busy" without a request; `queueDepth()` exposed |
| A5 | P2 | Negative results never cached (curve tokens re-hit DexScreener/Gecko every 5 s rebuild) | Open — needs a negative-TTL sentinel in `memo`; lower priority now the Jupiter half is cached |
| A7 | P3 | `helius` provider entry has zero callers | Open (cosmetic) |
| — | — | Gaps: birdeye 120 → **1 100 ms** (1 rps free tier), dexscreener 220 → 250, helius 60 → 110; per-minute windows for `pumpfun:list` (55), geckoterminal (28), rugcheck (50) | **Fixed** |

### Provider volume (B)

| # | Sev | Finding | Status |
|---|---|---|---|
| B1/A3 | P1 | Jupiter ~85/min idle on Discover: `byMints` keyed on first-mint+count, `shield` on the joined row set — both missed on every row change | **Fixed** — every list/batch row remembered per mint (8 s / 30 s); `byMints`/`shield` fetch only misses, keyed by sorted membership; `search(mint)` answers from memory |
| B2/F5 | P1 | Portfolio priced ≤ 60 mints with one `summary()` each (2 Jupiter calls per mint) + 6 concurrent priority quotes, from three pollers | **Fixed** — `market.summaryMany()` (one search + one Shield for the set, 4-wide assembly); the summary itself shared for 3 s across callers; `holdings()` shared 2 s |
| B3/A1 | P1 | Rug/odds attach workers kept draining after the 2 s budget; Migrated rows judged too → 110–200 pump.fun calls/min | **Fixed** — the budget is a deadline for *starting* rows; curve rows only |
| B4 | P1 | swap-api seek demand 200–600/min vs 200 gate → FIFO grew without bound | **Fixed** by B3 + the 20 s queue-wait cap |
| B5/G5 | P2 | Watchlist: one `summary` per pin every 20 s, on every toggle, while hidden | **Fixed** — `market:summaries` batch channel; hidden-window gate; stale rows kept with a note |
| B7/E2 | P1 | Orders/alerts poll: per-mint sequential, non-priority → a parked provider = no price = **stop-loss blind, nothing logged** | **Fixed** — one batched *priority* Jupiter search+Shield per tick; in-flight guard; after 20 s without a price the user gets a warn toast + log naming the parked provider |
| B6/G9 | P2 | Discover and chain polls continue while hidden | Partly — PositionPanel and Watchlist gated; Discover columns / Positions / Wallet still poll hidden (open) |
| B8 | P3 | Trades tab 3 s poll rebuilds `summary()` every other tick | Open |

### RPC (C)

| # | Sev | Finding | Status |
|---|---|---|---|
| C2 | P1 | No 429 memory; same-host retry ×N; callers add their own retries (txBuilder double read, learn batch) | **Fixed** — per-host park (Retry-After or 1 s doubling to 10 s); parked host skipped for the fallback, or waited out (≤ 2.5 s + jitter) when there is none; per-host token bucket (public 10/s + 4/s per method, Helius 9/s; `sendTransaction` never delayed); `getTransactions` batches share it at their real cost; txBuilder's blind second read removed. `test/rpcratelimit.test.mjs` |
| C1/F1 | P1 | Fan-out: N full pipelines at once, 500 ms status polls each → 165 `getSignatureStatuses`/10 s for five wallets | **Fixed (paced)** — the bucket spreads the burst; with the confirm socket open the poll is 1 s / 1.5 s (was 500 ms / 1 s); a 429'd poll backs off ×2 to +3 s. Sharing the curve read across wallets is still open |
| C3/E1 | P1 | A read 429 at simulate / pre-balance killed a SELL with no retry | **Fixed** — see E1 |
| C4 | P2 | Template learn bursts 20–60 `getTransaction` inline on a cold buy | Open (paced by the bucket now; moving it to the prewarm heartbeat is future work) |
| C5/F6 | P2 | DBC watcher: one `getTransaction` per swap, uncapped | **Fixed (bounded)** — max 6 in flight, overflow dropped |
| C9 | P3 | Fee estimator's raw fetches ignored 429 and asked Helius twice | **Fixed** — both backends go through `rpcCall`; a Helius 429 skips the raw method |
| C10/F8 | P3 | `refreshAllBalances` = N parallel `getBalance` | **Fixed** — one `getMultipleAccounts` |
| C6/F9 | P3 | Holder graph: 75 sequential calls per token page | Open (paced by the bucket) |

### Websockets (D)

| # | Sev | Finding | Status |
|---|---|---|---|
| D1 | P2 | Handshake 429 retried per socket class from 1–2 s, no shared park | **Fixed** — `noteSocketRateLimit` parks the host 30 s for every socket class; feed.ts and priorityFeed wait it out before dialling |
| D2 | P2 | feed.ts backoff reset on the FIRST notification → accept-stream-drop hosts redialled at 1 s forever | **Fixed** — only 30 s of staying up resets it |
| D3 | P2 | feed.ts pong deadline ignored inbound frames (the 09-03 storm shape) | **Fixed** — a frame clears the pong timer |
| D4 | P2 | priorityFeed reset attempts on `open`; subscribe error replies dropped silently | **Fixed** — reset on first ack/notification; rejections logged, mint stays on the public pool |
| — | P2 | Public wss caps subscriptions at 10 per socket (agent I) — up to 28 were requested unkeyed | **Fixed** — unkeyed priority socket stops at 10 (positions first) and says so once a minute |
| D5 | P2 | confirmSocket has no self-reconnect (30 s heartbeat) | Open |
| D7/D8 | P3 | Tape LRU evict does not unwatch; signatureSubscribe never unsubscribed on timeout | Open |

### Trade path (E)

| # | Sev | Finding | Status |
|---|---|---|---|
| E1 | P1 | 429 at simulate/pre-balance → sell dead; advanced order → `failed` | **Fixed** — `shouldRetryPreBroadcast` (shared/liveBreakers): a pre-broadcast failure whose message mentions a rate limit is retried once after 1.5 s at the same slippage; an advanced order refused pre-broadcast by a rate limit (no signature) is **re-armed**, bounded at 5, with a toast. `test/advorders.test.mjs`, `test/livebreakers.test.mjs` |
| E3 | P1 | Jupiter quote/swap: one 429 ended the order; the portfolio's own quotes caused it | **Fixed** — quote and swap retry once after 1.2 s on a 429; display quotes off the priority lane and memoised |
| E4 | P2 | A transport 429 counted as a derived-layout strike (3 → 30 min suspension) | **Fixed** — transport failures keep the template |
| E11 | P3 | Loss-guard refusal dropped the RPC message | **Fixed** |
| E6 | P2 | Relayer: three guaranteed failing tries; failure message leads with the least relevant reason | Open |
| E7 | P2 | `allowedDexLabels` 429 → unrestricted quote → signer refuses | Open |

### Multipliers (F)

| # | Sev | Finding | Status |
|---|---|---|---|
| F2 | P1 | Wallet Lab warming: no cross-group cap (20 groups at 5 s = 160 trades/min) | **Fixed** — a lab BUY keeps a global 10 s distance from any other lab trade; sells are exits and are never held (they move the clock) |
| F3 | P2 | Copier follow allows delay 0 | Open (bucket-paced) |
| F7 | P2 | Copy trade: no per-minute cap across configs | Open (bucket-paced) |

### Surface (G)

| # | Sev | Finding | Status |
|---|---|---|---|
| G1 | P1 | Discover swallowed a 429: column blanked under a fresh "2s ago", `error: null` | **Fixed** — `market:discover` carries a park note in `message`; the renderer keeps the rows and shows the note in the column |
| G2 | P1 | No place shows which provider is parked | **Fixed** — `ProviderStatus.cooldownMs` / `queued`; Settings → Market data shows "rate limited · retrying in Ns" |
| G6 | P2 | Cold chart under a park said "No chart data" | **Fixed** — parked note with the retry countdown; the chart's empty slot shows the failure message |
| G7 | P2 | Settings/Onboarding copy claimed the public RPC has "no failures" | **Fixed** |
| G3 | P2 | Chart calls bypass the park and re-extend it; empty-chart retry every ≤ 10 s | Partly — priority calls are now spaced; the park exemption stays (open) |
| G4 | P2 | Token-page burst uncancellable; `tokenDetail` not deduped | Open |
| G8 | P2 | Holders tab spins forever on failure | Open |

### Bots, images, metadata, Jito (H)

| # | Sev | Finding | Status |
|---|---|---|---|
| H1 | P2 | Token icons: no negative cache, no in-flight dedupe → a 429'd CDN replayed on every mount | **Fixed** — refusals cached 10 min (Retry-After honoured, 2 min for 5xx/timeouts); concurrent loads share one fetch |
| H6 | P3 | Jito tip floor polled every 8 s (Jito is 1 req/s per IP for everything) | **Fixed** — 30 s freshness, one in flight, 60 s hold after a refusal |
| H5 | P3 | Telegram `getUpdates` ignored `retry_after` | **Fixed** |
| H2 | P2 | Discord gateway: no RESUME, stale handlers, duplicate IDENTIFYs | Open |
| H3 | P3 | Telegram/Discord send 429 dropped silently, no queue | Open |
| H7 | P3 | Metadata: gateway 429 negative-cached forever; `cloudflare-ipfs.com` retired | Open |

## 3. Open backlog, ranked

1. Share the curve/mint/Global read across a fan-out (F1) and stagger sends ≥ 150 ms/wallet.
2. Move template learning to the prewarm heartbeat (C4); raise the RPC learn lockout.
3. Negative-TTL memo for "no pairs / no pools" (A5) and `tokenDetail` in-flight dedupe (G4).
4. confirmSocket self-reconnect with backoff (D5); `signatureUnsubscribe` on timeout (D8).
5. Discord gateway RESUME + stale-socket guard (H2); bot send queue with `retry_after` (H3).
6. A keyed `api.jup.ag` path for the day `lite-api` actually dies (agent I).
7. Chart: honour the park (fail fast) instead of the priority exemption (G3); holders tab error state (G8).
8. Hidden-window gating for Discover columns, Positions and Wallet polls (G9).

## 4. Verification

- `npm run typecheck` clean (main + renderer).
- New suites: `test/http.test.mjs` (park at dequeue, Retry-After, escalation cap, priority
  spacing), `test/rpcratelimit.test.mjs` (failover on 429, parked host skipped, park waited
  out without a fallback, Retry-After cap, bucket pacing, socket park), three new cases in
  `test/advorders.test.mjs` (re-arm, bound, never with a signature), one in
  `test/livebreakers.test.mjs`.
- `npm test` full suite: see the session log.
