# Two scripts — the callout farm re-tuned, and a graduation scalper (2026-09-29)

Asked for after the break-even swarms (`docs/breakeven-swarm-2026-09-28.md`):
keep one script farming callouts the way it does now, since a callout stays up
after the bag is sold and pump.fun's programme pays on it; and build the one
idea the swarms found nearest to zero — buy the graduation, sell into the pool's
first minutes — as a second shipped script, paper-first. The user's own guess
for the farm: require the coin's X **and** website "to reach more real
projects", go into fewer coins, confirm within 30 minutes at $20k, and keep
selling half at 2x.

## 1. The farm tuning, measured — and a wrong first reading, corrected

Data: the same five days of runner flags as the swarms (09-24..28; 4,935
classic, non-mayhem flags on a 1-minute candle grid, the confirm agent's loader
and cost model: entry at the confirm-minute close × 1.008, pump 1.25 %/side,
0.0035 SOL fixed per round trip, rent net zero, Krypt 0 for the owner). The
farm's rule as shipped: confirm from minute 10, market cap ≥ $25k, two rising
closes, watch 60 minutes; sell 50 % at 2x and 50 % of the rest at 4x with the
app's moonbag behaviour (the first rung cancels the timer), otherwise sell at
5 minutes; whatever is still held is marked at the 60-minute close. The
script's own `realSite` and `xIsOwn` rules were copied verbatim.

**First pass (wrong).** Links from Jupiter's token index: it lists an X link
for 31 % of these mints and a website for 23 %, so "own X AND homepage" left
22 calls, which averaged +11 % (median −3 %, three coins carrying it). A
coverage check on the website half looked clean. It was not clean on the X
half: Jupiter's X coverage tracks the coins that got attention, and the
intersection of both was a hand-picked sample.

**Second pass (right).** Links read from every coin's own metadata file, the
same file the app reads at the flag: the Token-2022 mint's metadata extension
(4,877 coins) or the Metaplex account (77), then the JSON from three IPFS
gateways. 4,373 of 4,935 resolved; the site verdict agrees with the app's
flag-time reading on 782 of 784 coins the app called site-true. Scripts:
session scratchpad `farm/` (`meta.mjs`, `meta2.mjs`, `farm3.mjs`,
`features.mjs`, outputs `farm3.out`, `features.out`).

| configuration (five days pooled, 0.03 SOL owner) | calls | mean | 95 % CI | top-3 dropped | median | hit 2x |
|---|---|---|---|---|---|---|
| as shipped (no link rule, watch 60, mc 25k) | 137 | −21.0 % | −31 .. −14 | −25 % | −22 % | 14 |
| own X AND homepage, watch 30, mc 20k (the proposal) | 70 | **−24.8 %** | −39 .. −10 | −34 % | −27 % | 12 |
| same, mc 25k | 57 | −22.4 % | −37 .. −5 | −33 % | −27 % | 9 |
| same, hold 15 / hold 30 | 70 | −34.7 % / −34.6 % | | −46 % | −45 % / −56 % | 19 / 21 |
| same, sell all at 3 min | 70 | −11.1 % | −26 .. +9 | −23 % | −13 % | 0 |
| X only (own) | 86 | −18.3 % | −32 .. −6 | −25 % | −22 % | 13 |
| X or homepage | 95 | −21.1 % | −33 .. −9 | −28 % | −24 % | 13 |
| no link rule, watch 30 | 120 | −20.7 % | −31 .. −10 | −26 % | −20 % | |

Per day for the proposal: 09-24 +3 % (n 9), 09-25 +3 % (14), 09-26 −51 %
(19), 09-27 −16 % (11), 09-28 −39 % (17).

What the metadata itself says about a flagged coin's next 30 minutes (all
4,373 resolved flags; base 2x 15.1 %, rug 10.7 %, median x30 0.70):

| feature | n | reaches 2x | falls under 0.3x | median x30 |
|---|---|---|---|---|
| no links at all | 818 | 8.1 % | 1.7 % | 0.81 |
| X is the coin's own account | 1,703 | 20.6 % | 16.9 % | 0.58 |
| X is someone else's | 1,696 | 12.7 % | 9.3 % | 0.72 |
| homepage (real site) | 1,681 | 20.5 % | 17.3 % | 0.58 |
| own X + homepage | 1,320 | 21.8 % | 19.0 % | 0.54 |
| name ≥ 15 characters | 867 | 11.4 % | 7.5 % | 0.75 |

Links pick variance, not edge: the "real project" look doubles the chance of
a 2x and doubles the chance of a rug, and the median path is worse. A coin
with no links at all almost never rugs inside 30 minutes and almost never
runs.

Two more pre-registered checks, one cell each: watch 30 vs 60 with no link
rule is a wash (−20.7 % vs −21.0 %); and the swarm's least-bad rule, buy the
graduation and take 1.3x within 3 minutes, moves from −4.5 % (n 215, CI
−9.2 .. −0.8) on every flagged graduate to −2.8 % (n 100, CI −9.0 .. +3.5,
top-3 dropped −3.6 %) on the own-X-and-homepage ones at 0.5 SOL for the
owner. Nearer to zero, still not positive, error bars still include it.

What this says, honestly:

- **No link rule makes the farm break even.** The proposal loses the same
  fifth-and-a-bit per trade as no rule, on half the calls. The +11 % in the
  first pass was an artefact of the index it was read from.
- **The rule still does what the user wanted it for**: the calls land on
  coins with a homepage and an account named after the coin, and there are
  half as many of them. That is a choice about which coins get called, not
  a way to make the bags pay, and the script now says exactly that.
- **$20k did not help** (four extra calls, all losers, on the first pass;
  −24.8 % vs −22.4 % on the second). The floor stays at $25k.
- **Watch 30 costs nothing** and frees price subscriptions; kept.
- **Exits:** on the full X-and-homepage set the longer holds are the worst
  (−35 % at 15 and 30 minutes), the same shape as the whole population; the
  first pass's "hold 30 looks better" was the same 22-coin artefact. The
  5-minute timer stays; "sell everything at 3 minutes" is the least-bad exit
  (−11 %) but never banks a 2x, which is what a callout wants to point at.

### What changed in the farm (v2.7, all three copies)

`bundled/scripts/krypto-script.js`, `private/scripts/calloutfarm.js`,
`private/scripts/scorenow.runner.js`: "Links required" defaults to **X and
website** (the own-account rule was already on), "Watch each flag for"
defaults to **30** minutes, the cap floor stays at $25k with a note, and the
header and help texts carry the corrected measurement (the first-pass texts
that quoted +11 % were replaced the same day). Nothing else moved; the
09-28 guards stay.

## 2. Graduation Scalper — `bundled/scripts/graduation-scalper.js`

Ships as the second bundled script (key `graduation-scalper`), off and in paper
like the first. What it does:

1. On the app's `migration` event (the curve completed), it checks: a pump.fun
   mint; not a mayhem curve — the event now carries `isMayhem` from the create
   event, and when the app cannot tell, the completion price has to sit within
   15 % of the classic curve's end price (4.108e-7 SOL); the creator has not
   sold; a slot is free (default one coin at a time); the hourly cap has room;
   optionally, the scanner had flagged the coin as a runner in the last two
   hours.
2. It subscribes to the coin's ticks and waits for the **pool's** first print
   (up to 30 s). The curve completes first; pump's migration and the sniper
   bundle's swaps follow a few seconds later, and the app maps the pool to the
   mint at completion, so the first swap arrives as a tick.
3. First print more than 3x the seed price = a sniper spike, skipped (an
   untested filter, labelled as such; 0 turns it off). Otherwise it buys at
   once (or after an entry delay).
4. It sells everything at the take-profit (default 1.2x the fill), at the
   timer (default 180 s), at an optional stop, or when the creator sells.
5. Every closed trade writes one `GRAD {…}` line with the seed, first-print,
   fill and exit prices, the lag from the first print to the buy, and the
   realized SOL, so the record can be measured from the log.

Expectations are in the script header and the help texts: from the 09-28
tick study, buying 1.2 s after the first print and selling within 1–5 minutes
is −1.4 % to −2.4 % per trade at 0.5 SOL for the owner and about −8 % at
0.05 SOL; each second of lag costs 0.4–1 point; this app hears the print,
builds and lands in about two seconds. Paper fills are the last pool print
with the fee model and no latency, so paper flatters live by a point or two.
The decision to ever run it live is the user's, after the paper record has
enough trades to say something (a hundred, with the top three dropped).

App-side change: `AutomationHost.launchMayhem(mint)` (engine: the tracked
token's create-event flag) and `isMayhem` on the migration payload; the event
table in `shared/automation.ts` says so. The shipped-script test now covers
both files: validation, the sandbox's own `AsyncFunction` compile, the
`@inputs` block, every field's default, every help within the form's 200
characters, and the raw import in `bundledScripts.ts`.

## Not done / caveats

- The scalper has not run against a live feed in this session (the packaged
  app holds the profile lock; a dev instance needs its own profile). Its first
  paper session is the test.
- The farm backtest's links now come from the coins' own metadata files, the
  same source the app reads; 562 of 4,935 files could not be fetched and
  those coins count as "links unknown", which the script also skips.
- Nothing is committed; the working tree also holds the liquid-glass and
  guard changes from 09-28.
