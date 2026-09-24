# Wallet groups and the Copier — 2026-09-22

Groups and group following are back, after being removed on 2026-09-14. The
goal stated by the user is spacing and privacy: a position held across a few of
your own addresses rather than all in one, entered over time rather than in one
visible buy. Not bundling.

The shape landed on is a single path: you buy less on your trading wallet, and
the group follows, spaced out. A separate “split this buy” panel was built and
removed the same day as redundant clutter — see Where it lives.

## Why it was removed, and what changed

The removal commit (`b46b569`) said:

> Both manufactured trading activity across wallets one person controls, which
> reads as wash trading / market manipulation whatever the intent behind it.

That reasoning did not stop being true, so the feature comes back shaped by it.
Reading the old code, the description was fair:

- **The fan-out buy** ran `Promise.all` across every wallet with a random delay
  of up to two seconds, **defaulting to zero**. Every wallet bought in the same
  slot unless you asked otherwise.
- **The Copier** gave each follower an **independent timer with a floor of
  zero**, so they could all repeat a trade at once.

Both are now sequential with a real, randomised gap. That single change is what
separates splitting an entry from bundling, and it happens to be the thing the
feature is *for* — someone spacing out an entry wants the gap; only someone
manufacturing the look of independent demand needs them in the same block.

## The limits

| | Value |
|---|---|
| Wallets per coin | 10 (was 5 until 09-22) |
| Minimum gap | 5 seconds |
| Maximum gap | 5 minutes |
| Default range | 10–45 seconds |
| Worst case, 10 wallets | 45 minutes |

Five seconds is about a dozen Solana blocks. "Bundling" means one block or one
Jito bundle, so anything separated by blocks is a sequence of ordinary buys.

The gaps are **randomised inside the range**, a fresh draw each time, because an
exact interval is its own signature — a metronome is what a script looks like.
This is about the entry not being one recognisable event. It is **not** about
making related wallets look unrelated, and the split planner's old comment
describing its jitter as making buys "not identical round numbers that
obviously came from one operator" was rewritten for exactly that reason.

The ceiling exists because a queued buy is a decision made earlier and executed
later. On a memecoin, twenty minutes is already a different proposition than the
one you decided on.

**None of these are settings.** The cap and the floor are enforced in main, in
`fanoutPreflight` and `fanoutBuy`, so the form cannot reach around them. A limit
the user can raise is not a limit.

## The acknowledgement

Off by default. Everything refuses until it is given, and an acceptance given to
older **wording** does not carry forward — the version invalidates it.

The words live in `shared/multiWallet.ts` and quote the real numbers, with a
test asserting those match what the code enforces so the two cannot drift. The
wording names wash trading plainly rather than gesturing at "risks". Main stamps
the version from the shared constant; the renderer cannot send one, so nothing
can claim consent to words the user never saw.

Storing it hit the settings-validator trap from 2026-09-08 immediately: a `null`
default for the timestamp makes the validator's type comparison fail against
every real value (`typeof null` is `'object'`), so the acceptance would have
silently never saved. It is a plain number, `0` meaning never.

## Where it lives

- **Wallet Lab → Copier.** Which group follows, how much, the gap range, and
  the acknowledgement that gates all of it. It edits settings only and places
  no trades. It shows the gap that will *actually* be applied, since main
  floors it either way.
- Creator and Funder are unchanged — groups, membership and funding were never
  removed.

**There is no split-buy panel.** One was built and removed the same day. A
user who wants a smaller position buys less on their trading wallet and lets
the Copier’s followers do the rest, which is one path instead of two. The IPC
that would have driven it is gone as well: a money-spending handler with no
caller is a liability rather than a feature.

`fanoutBuy` and its gate stay in the engine, because the LAUNCHER uses them
for its single-wallet dev buy and the gate is the right defence if a
multi-wallet caller is ever added back.

**The acknowledgement moved to the Copier** after a few hours on the Wallet
page. A switch on one page gating a feature on another is the kind of thing
nobody connects.

## The Copier

A group repeats the trade you made by hand. Size is a share of what you spent, a
fixed amount, or **a random draw from a range** — with a hard per-wallet ceiling
over all three. Sells are optional and mirror the same share of each follower's
own bag.

The random range is the same reasoning as the gap, applied to the amount: an
exact repeated number is its own signature, and someone spreading an entry over
their own wallets does not want every leg identical. The draw is **fresh per
follower** (`followSize` is called inside the member loop, not once per trade) —
one draw shared across the group would be a fixed size with extra steps. A range
typed backwards is read as a range rather than refused; the person meant the same
two numbers.

It is in **SOL**, like every other amount on that page. There is no dollar field,
because a size pinned to a moving price is a different SOL amount for each
follower for a reason that has nothing to do with the trade.

**A launch counts as a manual buy.** The creator's first buy is spent by the
launcher as a fan-out of one rather than through `testTrade`, so it used to miss
the Copier entirely and a group sat out the single coin its owner had just
created. `followLaunchBuy` hands it to the ordinary follow path, naming the buyer —
the launch wallet is not the active one, and a group member that launched would
otherwise buy its own launch a second time. Same
acknowledgement, same per-coin cap, same randomised spacing. It re-implements
none of those gates, so it cannot skip one.

Two things carried over from the old implementation deliberately:

- **The total is checked against the live cap before anything is scheduled.**
  Without it (found as lab-4) nineteen followers each under the per-leg cap
  spent nineteen times what one trade is allowed to, and the only signal was a
  toast counting legs, emitted after the timers were already running.
- **The active wallet never follows itself.**

New: the cap counts **across every group at once**, so two groups of three is not
a way to put six wallets on one coin, and the acknowledgement is re-checked at
fire time rather than only when the group was configured.

## The Warmer is not coming back

Random autotrading across a group under a loss cap was the other thing removed
on 2026-09-14, and it stays removed. Trading a group with no purpose beyond
activity is manufactured volume with nothing else to call it. `parseLab` reads
a saved `follow` block forward and drops a saved `random` one;
`test/labguards.test.mjs` pins both halves of that.

## Pinned by

`test/multiwallet.test.mjs` — 16 checks. The load-bearing one asserts the
execution loop is **not** `Promise.all` over the shares: tidying that back into
a parallel map would silently restore the exact behaviour the feature was
deleted for, and nothing at runtime would look wrong.
