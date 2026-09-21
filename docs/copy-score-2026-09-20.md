# The Copy score — a Krypt score for wallets (2026-09-20)

## Why it exists, and what it is not

The Wallet Scout ranked wallets by their own profit. Our own research
(`wallet-convergence-2026-09-14.md`, 9.3 M curve trades, two periods six
weeks apart) says that is the wrong objective:

- Top wallets are real and their edge persists day to day.
- But ranking by their PnL selects for snipers whose median hold is six
  seconds. Their edge is latency — the one thing a follower cannot copy.
- Ranking by what a **follower** realises (both legs filled at a lag, net
  of cost) persists monotonically across all ten deciles in both periods and
  halves the loss of the naive ranking. It still does not reach profit: no
  decile was positive; the best lost ~1–3 % per copied trade.

So the Copy score measures what a copier would have got, not what the wallet
made. It ranks **least-bad to follow**. The page, the drawer, the guide and
the footer all say so in plain words, and nothing calls it an edge.

## What is measured (electron/engine/walletScout.ts)

Every trade the Scout hears — from the live feed or a scan, on any mint, by
anyone — is a **print** on that mint. When a tracked wallet opens a position,
a follower entry is pending at the leader's time plus `FOLLOWER_LAG_MS`
(2 s, what the app's copier actually gets: feed latency plus the measured
~1.4 s to land). The first print at or after that time is the follower's
entry price. When the leader closes the trip, a follower exit is pending the
same way. The trip's follower return is the net of the two, paying
`FOLLOWER_COST_PER_SIDE` (1.5 %: the venue's 1 % plus Krypt's 0.5 %) on
both legs. No slippage is modelled; partial exits are scored on the final
close. Both simplifications make the figures generous, and the drawer says
so.

A trip is **unreachable** when the leader was out before the follower was
due (`too-fast`), when no print came to enter at before the leader sold
(`no-entry`), or when no print came within ten minutes to exit at
(`no-exit`). Unreachable is counted, never priced.

Per day bucket the wallet now carries `fTrips`, `fWins`, `fReturns` (capped
40), `unreachable`, `fast` (trips under the 60 s copy floor). Per wallet:
distinct mints (named up to 60, a floor beyond), the twelve most recent
trips. Persisted for ranked wallets only; records written before this have
the fields absent, which reads as "not measured", never zero.

## The score (shared/walletScore.ts)

Weighted average of the checks that resolved, like the coin score:

| check | weight | resolved when | mapping |
| --- | --- | --- | --- |
| Follower return (median net %, per trip) | 3 | ≥ 5 follower trips | −25 % → 0, −10 % → 35, **−3 % → 60**, 0 % → 75, +10 % → 100 |
| Follower win rate | 2 | ≥ 5 follower trips | 20 % → 0, 45 % → 60, 60 % → 100 |
| Reachable trips (fTrips ÷ trips) | 2 | ≥ 5 trips | 0 → 0, 50 % → 50, 90 % → 100 |
| Active days ÷ window | 1 | window ≥ 3 days | 10 % → 10, 50 % → 60, 90 % → 100 |
| Coins per trip | 1 | ≥ 5 trips | 1 → 100, 2 → 80, 3 → 50, 6 → 0 |

No score under five closed trips or three resolved checks. `partial` flags a score built on fewer than half the window's trips (the rest predate the model); the drawer states "copy figures from N of M trips". The tape-wide
best (~−3 % median, ~45 % win) scores in the middle by design. Flags, not
points: `bot` (median hold under 10 s over ≥ 10 trips), `thin`,
`unreachable` (under a quarter of trips copyable), `concentrated` (≥ 4 trips
per coin — a relationship with those coins, not a knack).

## The page

- Default window 7 days, default sort Copy score; sorts lead with the copy
  figures (Copy score, Follower return) and label the wallet's own figures
  as "Their …".
- Columns: Copy score chip, Copy / trip, Reachable (n of N), their profit,
  their win rate, trips, median hold.
- Click a row → the wallet drawer: score ring, the five checks with the
  measured figure and points each, "If you had copied them" vs "What they
  did", first/last seen and open positions, the recent trips with the
  leader's PnL and the copy's return per trip (or why none), Save /
  Follow on paper. `scout:detail` IPC returns the whole record; the drawer
  windows and scores it with the same shared functions as the board.
- The left panel's Record and Scan controls are real buttons now (35 px,
  labelled with the hours), not pills.
- The Guides page's Scout entry explains the score in plain words.

## Verified

- `test/walletscore.test.mjs` (6): arithmetic, ramps, weights, honest-null
  gates, monotonicity, flags.
- `test/walletscout.test.mjs` (15, +3): a print inside the lag does not
  fill, the first past it does; too-fast and no-exit trips; a wallet whose
  copies all lose scores under 60 while its own PnL is positive; the fields
  survive a save/load.
- `test/scoutscan.test.mjs`, `test/ipccontract.test.mjs` (195 channels).
- `npm run test:scout:e2e` against the running app: column order, sort
  pills, 35 px scan button, footer wording, 50 rows, drawer opens with the
  checks and both sides. Existing records show a dash for the score until
  the feed or a scan has recorded follower fills for them — by design.
- Live, after a one-hour scan (1,846 trades fed): the top rows scored 72–81
  on a slightly positive follower median over 6 judged trips (flagged
  `partial` and, for the top three, `concentrated` — three wallets with
  identical figures on the same three coins, almost certainly one operator);
  the bulk sat at 47–64 with medians of −2.3 % to −3.5 %, the band the
  research predicted; thin rows unscored. Screenshots in the session log.

## Not built, and why

- Reverse copy / FOMO copy modes: separate features on the copier, not the
  Scout; the score would apply to either.
- Twin-wallet detection (several addresses with identical trip records —
  one operator, several keys): visible by eye at the top of the board, not
  yet a flag.
- Scoring the followed wallets on the Wallets page (`LeaderStats`) the same
  way: it has the trip data but not the print stream; wiring it through the
  same pending-fill machinery is the next step.
- A per-wallet lag setting: the copier's own delay is configurable, the
  score's lag is what the app measured. A slider that makes a wallet look
  copyable would be the score lying.
