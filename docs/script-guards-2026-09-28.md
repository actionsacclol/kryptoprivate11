# Script guards, from one bad night (2026-09-28)

A live script (`scorenow` v2.5) ran unattended from 22:00 to 11:00 local
time and took a wallet from about 0.36 SOL to 0.013. From the chain ledger:
52 coins, 50 buys, 65 sells, 0.838 SOL deployed, 0.498 back, **−0.34 SOL**,
of which **0.179 SOL was network fees** (the 0.001 buy / 0.002 sell
priority-fee floors on 0.013–0.02 SOL bags). Six winners. Thirty-one of the
fifty positions were stopped within eight minutes at a mean of −70 %; the
−40 % stop filled at −55…−127 %, and five sells returned less SOL than they
cost to send. From 05:00 to 11:00 it bought 30 coins and won none.

The script's own header says the bag loses on average; the 09-26 study found
no entry or exit rule that held out of sample. These guards bound the bleed.
They do not make the strategy positive, and nothing here should be read as
permission to run it unattended.

## Why nothing stopped it

1. **The per-script daily loss stop only counted the script's own sells.**
   `rt.realizedToday` was added to in the `bot.sell` path alone. Stop-loss and
   take-profit ORDERS sold 61 of the 65 bags, and the stop never heard about
   them: it read −0.0088 SOL against a real −0.31. Fees were never counted.
   And 0.5 SOL, the default, could never bind on a 0.36 SOL wallet.
2. **The engine fitted the last buy down to what was left, silently.** The
   script asked for 0.0151 SOL; `planBuySize` trimmed it to 0.0063 (balance
   minus the exit reserve) and the script's own log still said "bought
   0.0151". The bag was too small for pump to accept a callout and stopped at
   −100 %.
3. **The app-wide live breakers were off.** `execution.maxLiveSessionLossSol`
   and `execution.maxLiveConsecutiveLosses` were both 0 in the profile. They
   exist, they read the same settled fills, and either would have disarmed
   live trading hours earlier. Turn them on.
4. **The script had no brakes of its own**, and its creator filter degraded to
   "the app's own record, 0 prior launches seen" whenever pump's creator API
   was parked, which was most of the night.

## What changed

### App

- **The loss stop counts every exit, from the chain.** The engine's script
  host gained `onFillSettled`: every reconciled sell fill, priced with the
  ledger's `realizedPnlForSell` (proceeds against the wallet's own average
  cost, fees inside), reaches the script host. A live script whose `opened`
  or `closed` record holds the mint books it, judges the episode once a 100 %
  sell settles, and checks the stop. The script's own live sell no longer
  books an estimate; the settled fill counts it, once. Paper is unchanged:
  the book knows its result at the sell.
- **The stop is also a share of the wallet.** New budget field
  `maxLossPctOfWallet` (default 25, optional on old scripts). The stop in
  force is the SOL figure or that share of what the wallet held before
  today's losses, whichever is smaller. Shown on the Scripts page and used
  by the widget.
- **A cool-off after a losing streak.** Three losing full exits in a row on a
  live script pause its buys for an hour, with a toast and a desktop
  notification; sells and orders keep running; a winning exit resets the
  streak. Persisted, so a restart does not clear it.
- **A live buy under 0.03 SOL is refused.** The two priority-fee floors take
  more than a tenth of anything smaller on the round trip. Solana, live
  only; paper rehearses any size. Checked last of the live gates, so a
  blocked engine still says "not armed" first.
- **An unattended buy is refused rather than shrunk.** `planBuySize` takes
  `minShare`; the engine passes 0.8 for every non-manual buy. A click keeps
  the trim and its toast.
- **An unattended sell that would return less than its priority fee is held
  as dust.** `manualSell({ dustGuard })`, set by the script host and the
  order executor, never by a click. Only when the proceeds estimate is
  KNOWN: an unpriced sell goes out, because a stale price must not block an
  exit.

### Script (`scorenow.runner.js`, `calloutfarm.js`, the bundled Callout Farm; v2.6)

- A creator the app has never seen no longer passes as "0 launches" when
  pump's record is parked. Unknown is unknown.
- No buy when the wallet holds less than the buy plus a 0.05 SOL reserve.
- The curve cap defaults to 30 %, the number the rug data pointed at.

### Deployed inputs to change by hand (the code cannot change a saved input)

- `maxCurvePct` 100 → 30; `confirmRisingMins` 0 → 2; budget
  `maxOpenPositions` 20 → 2; budget `maxLossSolPerDay` 0.5 → 0.1 and the new
  wallet share 25.
- Settings › Execution: `maxLiveConsecutiveLosses` 4, `maxLiveSessionLossSol`
  0.1.
- `buySol` below 0.03 will now be refused live; either raise it or accept
  that the fee floors make the bag uneconomic.

## Measured against the night

Replaying the actual sequence: a 0.15 SOL stop that counts every exit
avoids 0.20 SOL of the 0.37; a 0.10 stop 0.26; the three-loss cool-off 0.22;
no entries 05:00–11:00 (hindsight only) 0.29.

## Pins

`test/automation.test.mjs` (in the gate): an order's settled sell counts
toward the stop and disables; a fill of a mint the script never opened
changes nothing; the script's own live sell books no estimate and the fill
counts once; the stop is the smaller of the SOL figure and the wallet
share, and the reason names which; a script saved without the share reads
as the default and the field survives a save; three losing exits pause
buys with toast and notification, a win resets the streak; a live buy under
0.03 SOL is refused and paper is not. `test/exitbudget.test.mjs`: the
unattended refusal at 80 %, the fee share, the dust rule.
