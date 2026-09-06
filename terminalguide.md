# TERMINAL GUIDE — turning a bot into a terminal

Written after converting **Krypt Sniper** (a Pump.fun sniping bot) into **Krypto Bot**
(a Solana memecoin trading terminal) over 2026-08-24. Everything here is generalised so it
applies to the next three: a **Polymarket** bot, a **Kalshi** bot, and a **weather
predictor** bot.

Read §1–§5 before writing any code. §9 is the list of bugs that cost the most time — read it
twice.

---

## 1. The reframe

A **bot** answers one question: *should I act, right now, on this one thing I am watching?*

A **terminal** answers a different one: *what is going on, and what should I do about it?*

That difference drives every decision below. It is not a UI project. A bot is allowed to
know nothing about anything it did not personally observe; a terminal is not.

| | Bot | Terminal |
|---|---|---|
| Scope | things it watched live | **anything the user names** |
| State | in-memory, session-scoped | assembled on demand, per entity |
| Data | one feed it owns | many sources that disagree |
| Failure | miss a trade | **show a wrong number** |
| Success | profitable | **used daily** |
| Who decides | the bot | **the user** |

The last row is the one that matters most. Six months of research on Krypt found no
profitable automated strategy — that negative result is *why* it became a terminal. If your
bot were reliably profitable you would not be reading this; you would be scaling it. Turning
a bot into a terminal is usually an admission that **the edge is in the operator, not the
automation** — so build for the operator.

---

## 2. The one rule that defines the product

> **A value nobody could produce is `null`, renders as an em dash, and is never coerced to
> `0` or to a default.**

This sounds like a formatting detail. It is the entire differentiator.

Every terminal in every domain shows numbers assembled from sources that are late, partial,
or wrong. The temptation is to fill gaps: an unknown holder count becomes `0`, an unread
safety check becomes a pass, a missing cost basis becomes break-even. Each of those is a
specific, confident lie the user will trade on.

Concretely, in Krypt:

- The security score is an **average over the checks that actually resolved**, and it says
  so ("averaged over the 6 of 11 checks that resolved"). Under four resolved checks it
  refuses to print a score at all.
- A position whose tokens did not come through the app has **no cost basis**, so its PnL
  reads as unknown — never as zero.
- The chart never invents a candle for a period with no trades.
- A filter over a metric that has not arrived yet **skips** that row rather than hiding it.

Corollary: **when something cannot be shown, say why and what would fix it.** "No holder
data" is useless. "The free public RPC refuses holder lookups — add a Helius key in Settings"
is a product.

There is one deliberate exception, and it is worth stating because it looks like an
inconsistency: **numeric filters skip unknowns; categorical filters exclude them.** "holders
≥ 500" on an unknown holder count is a threshold on a quantity that has not arrived, so
skipping is honest. `launchpad = pumpfun` is the user naming a set, and "I don't know" is not
a member of it. Both behaviours are pinned by tests.

---

## 3. The five architectural moves

### 3.1 Split the contract in two

The bot's data model is not the terminal's. Keep them apart from day one.

- `shared/types.ts` — the **engine** contract. `LaunchRow` only exists for mints the feed
  caught inside this session.
- `shared/market.ts` — the **terminal** contract. `TokenSummary` describes *any* mint, is
  assembled from providers, and is the row shape every screen renders.

If you merge them you will end up with one struct where half the fields are only populated
sometimes, and no way to tell which half.

### 3.2 A provider layer, with per-field provenance

No single source answers everything. Build a merge with an explicit priority:

1. **Your own authoritative read** (the chain, the exchange's own API for your positions)
2. **Your own live feed** (what you observed, timestamped when *you* saw it)
3. **The source that is best at that specific field**
4. **`null`**

Then carry **which source produced each number** on the row itself:

```ts
sources: Partial<Record<'price' | 'marketCap' | 'liquidity' | 'holders', DataSource>>
```

The UI shows it on hover. A terminal that shows a price without saying whether it came from
your own feed or a cached third-party index is asking for trust, and trust is exactly what
you are trying not to require.

Merge helper rule: **a provider returning `null` must never erase a better provider's
answer.** Do not use object spread for this.

### 3.3 Your own feed is the differentiator

The bot already has something no competitor has: a real-time feed it decodes itself, with
**local arrival timestamps**.

In Krypt that became 1-second candles for tokens no chart provider indexes at all — built
from our own tape, priced when *we* received the trade, with no indexer lag. It is the one
dataset that is strictly better than what a hosted competitor shows.

Find the equivalent in your domain (§5) and make it a headline feature. It is free — you
already built it — and it cannot be copied by anyone using the same public APIs.

Two rules for it:
- **Gate it on subscription.** Recording every entity is a memory leak with a UI attached.
  The screen the user has open names what to record.
- **Never fill gaps.** A period with no activity produces no candle, not a flat synthetic
  one. An invented candle in an illiquid market is how someone buys a corpse.

### 3.4 Keep the automation — but re-frame who decides

Do not delete the bot. Re-frame it as **user-directed automation**:

- The app never *decides* to act. No strategy, score or signal opens a position.
- Every action traces to something the user did — a click, or **an instruction they wrote
  down** (a stop loss, an alert, a copy-trade config) that executes later.
- That last category is the entire point of a stop loss, so it is not a contradiction — but
  it must be gated identically to a manual action, and the user must be able to see and
  cancel every pending one on a single page.

The bot's strategy machinery becomes: order evaluation, alert evaluation, and paper
simulation. Same code, different framing.

### 3.5 Structural safety, not filtered safety

Where the terminal touches something dangerous, close it by **construction** rather than by a
check you have to get right every time.

- **No IPC channel accepts a URL or a host.** The renderer names an *entity, a column, an
  interval*. Main decides which of its hardcoded hosts to contact. That is the structural fix
  for SSRF; a URL validator is the fragile one.
- Outbound fetch: fixed host allowlist, `redirect: 'error'`, size cap applied **while
  streaming** (not after buffering), hard timeout, per-host rate gate.
- Anything that spends money is gated in the **main process**, never only in the UI. Assume
  the renderer is hostile.

---

## 4. The four screens

Every terminal is the same four screens. Name them in your domain and build in this order.

| Screen | Question | Krypt | Polymarket / Kalshi | Weather |
|---|---|---|---|---|
| **Discover** | what is happening? | New / Graduating / Migrated / Trending | New / Closing soon / High volume / Resolving | New events / Active watches / Biggest model disagreement |
| **Entity page** | is this one good? | chart, security, holders, trades | probability history, resolution rules, order book, holders | forecast vs observed, model spread, station reliability |
| **Act** | do it | buy/sell, orders, alerts | buy/sell YES/NO, limit at probability | alerts, or route to the market |
| **Track** | how did I do? | portfolio, PnL, trade history | same | forecast skill / calibration |

**Build order that worked:**

1. The **contract** (`shared/*.ts`) — types first, they force the honest-null decisions.
2. The **provider layer** + merge + provenance.
3. **Discover** — proves the data layer against reality immediately.
4. **Entity page** — the chart is the hardest single piece; do it early.
5. **Act** — reuse the bot's existing execution path; do not rewrite it.
6. **Track** — needs a real fill ledger (§6), so it comes after Act.
7. Everything else (alerts, hotkeys, copy trading, visualisations).

---

## 5. Mapping to your three bots

The abstraction is: **entity**, **price**, **history**, **risk**, **your own feed**.

### Polymarket / Kalshi (prediction markets)

| Concept | Maps to |
|---|---|
| Entity | a market (Polymarket condition id / Kalshi ticker) |
| Price | probability in cents, 0–100 — bounded, unlike a token price |
| Chart | probability over time. **Y axis is bounded 0–100** — use that, it is a gift |
| "Security" panel | **resolution risk**: who resolves it, on what source, how ambiguous is the wording, has this issuer disputed before, what is the settlement date |
| Liquidity | order book depth, not a pool. Show the actual spread and the size at each level |
| Your own feed | your bot's websocket order book, with local timestamps → **your own microstructure**: real spread over time, quote lifetime, fill probability at a price |
| Portfolio | positions + cost basis, same as Krypt. Prediction markets settle to 0 or 1, so **realised PnL is exact** — better than crypto |
| Orders | limit at a probability; stop loss expressed in probability points, not % |

**The security panel is where the value is.** In crypto it is rug risk; in prediction markets
it is **resolution risk**, and almost nobody surfaces it well. Concretely: does the resolution
source still exist, is the wording ambiguous, what is the history of this market maker, is
there a related market whose price contradicts this one.

**Cross-venue is your unfair advantage.** Polymarket and Kalshi list overlapping questions.
A terminal that shows the *same question priced on both venues*, with the spread, is
immediately useful and nobody has to trust you to verify it.

Note the domain difference: **Kalshi is a regulated US exchange (CFTC)**, Polymarket is not
the same thing legally. Do not build one UI that silently blurs them — surface the venue,
its rules, and its settlement guarantees per market. That is an honesty feature, and it is
also the thing that keeps you out of trouble.

### Weather predictor

This one is not a trading terminal, so map it honestly rather than forcing it.

| Concept | Maps to |
|---|---|
| Entity | a location + horizon (e.g. "NYC, high temp, tomorrow") |
| "Price" | the forecast value **plus its confidence interval** — never the point estimate alone |
| Chart | forecast trajectory over time vs. what was actually observed |
| "Security" panel | **model skill**: historical accuracy at this horizon, station reliability, spread between models (GFS/ECMWF/HRRR), known biases |
| Your own feed | your bot's own station polls / model runs, timestamped — **you know when a forecast changed and by how much**, which is not in any public UI |
| Portfolio → **Track record** | calibration. When you said 70%, did it happen 70% of the time? A reliability diagram is the portfolio page |
| Orders → Alerts | notify when a forecast crosses a threshold, or when models diverge sharply |

**Calibration is the whole product.** A weather terminal that shows forecasts is a worse
version of a free website. One that shows *how wrong this model has been at this horizon for
this station, historically* is something you cannot get elsewhere. The honest-null rule maps
directly: never show a skill score for a horizon you have not verified enough times.

### The obvious composition

**Weather predictor + Kalshi = weather markets.** Kalshi lists temperature and precipitation
contracts. Your forecaster produces a probability; the market produces a price; the terminal
shows the **edge between them**, along with your historical calibration at that horizon so
you know whether to believe your own number.

That is one terminal, not three. If that is the real goal, build the shared shell once
(§3, §4) and make the venue and the model into providers.

---

## 6. Track: get cost basis from the source of truth

The single most important thing on the Track screen is **what it actually cost**, and the
naive answer is always wrong.

Krypt originally recorded what it *asked for* ("buy 0.1 SOL"). The real cost included the
priority fee, the tip, the relayer's cut, account rent and slippage — every one of which
makes the naive number wrong **in the user's favour, on every single row.**

The fix generalises: after a fill lands, **reconcile it against the venue's own ledger**.

- Crypto: fetch the confirmed transaction, diff your own wallet's pre/post balance.
- Polymarket / Kalshi: read the fills endpoint — actual fill price, fees, partial fills.

A fill that cannot be reconciled is stored as `unreconciled`, **excluded from every figure**,
and counted in a warning strip. Never guessed at.

Also state your convention. Krypt uses **average cost, not FIFO**, because that is what a
trader means by "I'm up 2x on my bag" — and the UI says so, so nobody has to guess.

---

## 7. Cost discipline

A bot makes a handful of requests. A terminal polls four columns, a chart, a holder list and
a portfolio, forever. Budget it from the start.

- **Per-host serial queue with a minimum gap.** Not a global limiter — per host.
- **TTL cache on everything**, tuned to how fast that data actually changes. Discovery lists
  change slower than a chart candle.
- **Back off on 429.** Park the provider, fail fast without a request, and **do not let the
  doomed calls hold the queue** — otherwise a burst of low-value requests starves a
  high-value one. This bit us: a Discover refresh 429'd the provider and the *chart* went
  blank, while a plain `curl` to the same endpoint returned 200.
- **Expensive analysis is opt-in.** Krypt's funding-graph analysis costs ~3 calls per holder,
  so it never runs automatically — there is a button, and the result reports exactly how many
  calls it spent. Put the price in the UI, not in a background poll.
- **Know which calls the free tier refuses.** Measure, do not assume. Both free Solana RPCs
  refuse `getTokenLargestAccounts` (429 and 403) — so every holder feature needs a key, and
  the app says so rather than showing an empty panel.

---

## 8. Privacy, if you are claiming local-first

If the pitch is "we don't know what you trade", make it checkable:

- **No backend.** The user's machine talks to providers directly.
- A **privacy panel** that names every host verbatim, says what each is used for, shows live
  call/error/latency counts, and has one switch that turns it all off.
- The app must still work with it off — degraded, and honest about what is missing.
- Do not add webhooks "for convenience". A Discord webhook posts the user's positions to
  someone else's server on every fire. Desktop notifications stay on the machine.

Watch for the accidental leaks: remote fonts, telemetry defaults, rich presence, and
**images**. Krypt serves token images through a hardened main-process handler rather than
opening the CSP, because a token image URL is chosen by the token's creator — opening
`img-src https:` hands every creator the IP of every install that scrolls past their coin.

---

## 9. Traps that actually cost us time

Read this section twice. Every one of these shipped silently and looked fine.

1. **Instruction indexes span lookup-table addresses.** `programIdIndex` and
   `pre/postBalances` index the *full* account list (static + ALT-loaded), not
   `message.accountKeys`. Reading only the static array yields `undefined`, the instruction is
   skipped, and the code *appears* to work — no error, just silently zero results on every
   transaction using a lookup table. It made an entire feature a no-op.
   *General form: when an index can exceed an array, check that it does not.*

2. **React context identity churn.** A `useEffect` depending on the whole provider context
   re-ran every poll, tearing down and rebuilding a subscription — which deleted the recorded
   data, so a live chart could never accumulate. It only appeared to work because React
   batched the state writes into no net change. **Depend on the stable callback, never the
   context object.**

3. **A threshold that discarded our own data.** The chart required ≥3 candles from our tape
   before using it; six real trades clustered into two seconds produced two candles, failed
   the gate, fell through to a provider that does not index the entity, and reported "no data"
   while holding the only tape that existed. *Any* real data beats none — say it is thin.

4. **Sorting by the wrong field returns stale garbage.** `sort=market_cap` on a "still
   active" filter returned year-old dead listings reporting multi-million caps whose actual
   reserves said 0% progress. Sort by *activity*, compute the metric yourself, re-rank.

5. **Unit mismatches on chart overlays.** Order lines were drawn in SOL on a USD axis — the
   stop-loss line sat ~94× below where it belonged. Visually convincing, completely wrong.
   **Convert to the series' own unit, and draw nothing if the rate is missing.**

6. **Providers emit duplicate timestamps.** Same bucket twice in one response. The chart lib
   throws on a non-ascending series. Normalise (sort + collapse) at the source.

7. **Never hardcode a protocol constant that is actually per-config.** We saw migration
   thresholds spanning 0.000499 to 66.04 — five orders of magnitude. Read it, cache it per
   config, and if you cannot read it, report `null`.

8. **A provider's "first pool" is not the pool you want.** It returned the *mint address* for
   one launchpad and a *post-graduation* pool for another. Verify by reading the account's
   owner rather than trusting a label.

9. **Duplicate work in a page load.** The same on-chain read fired 3–4× per page because
   several assemblers each called it. Memoise, and **render progressively** so the slowest
   panel does not hold the whole page shut.

10. **Silent counters.** A decoder-drift counter with zero readers is not a safety mechanism.
    If you count a failure, something must surface it.

---

## 10. Testing discipline

Three layers, and you need all three. Green unit tests hid two of the bugs above.

**Unit — pure logic, no network.** Filters, layout geometry, state machines, PnL maths,
normalisation. Fast, offline, runs in CI.

**Live provider checks — hit the real APIs, run by hand.** This is the layer people skip and
it is the one that catches the real breakage: routes that vanished, response shapes that
changed, rate limits you did not know about. Keep it out of `npm test` (it is slow and
depends on someone else's uptime) and run it after touching any provider.

**Drive the actual app.** Launch it, click through every route, screenshot, read the console.
Two of our worst bugs were invisible in screenshots — the chart looked "empty because the
token is new", which is a plausible-looking lie. **Measure through the real API**, not by
eyeballing the UI.

Two hard-won harness lessons:

- **Await your async tests.** A fire-and-forget runner printed "22 passed" over a real
  failure, because the assertions escaped as unhandled rejections.
- **CSS `text-transform` changes `innerText` and accessible names.** Case-sensitive selectors
  and regexes against uppercased UI text will fail and look like app bugs. It cost me four
  false alarms.

And: **when a test fails, find out which side is wrong.** Twice the *test* was wrong (an
assumed constant that is actually per-config; an assumed graduation threshold). Fixing the
code to satisfy a wrong test would have shipped a bug.

---

## 11. Checklist for the next one

- [ ] Name the **entity**. Everything hangs off it.
- [ ] Write the **terminal contract** first; keep it separate from the bot's.
- [ ] Decide the **honest-null policy** per field before writing the UI.
- [ ] List the **providers**, what each is genuinely best at, and what each costs.
- [ ] Identify **your own feed's unfair advantage** and make it a headline.
- [ ] Build **Discover** first — it validates the data layer against reality on day one.
- [ ] Reuse the bot's **execution path**; do not rewrite it.
- [ ] Reconcile fills against the **venue's ledger**, not against what you requested.
- [ ] Put a **rate budget and 429 backoff** in from the start.
- [ ] Make expensive analysis **opt-in with a visible price**.
- [ ] Write the **live provider check** the same day you write the provider.
- [ ] **Drive the app** before believing anything works.

---

## 12. What we actually shipped

For calibration on scope. One codebase, ~24k lines, 224 tests.

**Terminal:** Discover (4 live multi-platform columns, ~20 min/max filters, presets), token
page (1s–4h charts with a market-cap toggle, security report, holder list + bubble map with
funding-cluster analysis, live trades, trader scan), search-any-CA, watchlist, portfolio with
chain-reconciled PnL and shareable cards, orders (stop loss / take profit / trailing / limit /
conditional), alerts, hotkeys, paper-first copy trading, privacy panel.

**Kept underneath:** the original live feed, decoders, risk checks, scoring, paper exit
machine, shadow strategy labs and JSONL recorder.

**Deliberately not built:** anything needing a data source that does not honestly exist
(social sentiment on a free tier), and anything requiring custody surgery (multi-wallet)
without a design conversation first.

---

*Companion to `kryptguidelines.md` (brand, stack, UI kit). That covers how it should look;
this covers what it should be.*
