# Krypto Bot 3.1.0

A copied sell is settled in tokens now instead of guessed at in SOL, a leader's
trade that arrives late is treated as late, several charts stay open at once,
and holding $KRYPTO turns Krypt's own fee off.

---

## Copied sells are settled in base units, from confirmed fills

A user reported a copy exit recorded as **100%** while the live request sold
**52% of the remaining tokens**. The transaction succeeded, 83,236 NON stayed in
the wallet, and the copy was marked closed — inventory outside every
open-position view the app has.

Two independent faults. The sell was **sized** by scaling the leader's fraction
by this config's share of what the wallet *paid* for the bag; a cost share is
only a token share when every buy filled at the same price, which is never. And
the book was moved by the **leader's** fraction, so "they fully exited" closed
our row whatever our sell actually did.

A live copy now carries the only number that settles it: base units, from the
confirmed fill. What the buy delivered, what the copy still holds, what a sell
asked for, what it actually moved — and a copy is closed **only** when the
remainder is dust. When a full exit comes back short, the copier asks once more
for the measured remainder and then stops, because a leftover you can see beats
a retry loop you cannot.

`reconcileQuantities` is the net under it: off the same holdings read the app
already makes, it flags a row the book calls closed that the wallet still holds
tokens for. It never trades.

A row with no tracked quantity keeps the old percentage path exactly — unknown
is never read as zero and never as "all of it" — and rows opened before this
recover their quantity from the ledger's own record of their buy, refusing an
ambiguous match rather than guessing.

## "Sold late" was a sell that was never seen

Fourteen positions sold late, one about an hour and a half after the leader. It
was not slow execution. `logsSubscribe` is live-only: everything a followed
wallet did while the socket was down was never delivered, and nothing asked for
it afterwards. The position sat open until the leader happened to sell *again*.

Two silent holes fed it. There was no catch-up after a gap, and a transaction
that could not be read was given up on after about two seconds **in silence**.

Now: a bounded catch-up runs on every resubscribe (but never on the first
subscribe of a session, which has no gap behind it) and on a round-robin
heartbeat, because a subscription can go quietly dead while every health check
passes. Reads are chased properly and a give-up says so, naming the trade it
could not copy.

And trades carry **when they landed**, not when we read them — a Solana block
time, a pump event's own clock, an EVM block timestamp. A sell older than
fifteen minutes is recorded rather than mirrored; one inside it fires and says
how far behind it was. A buy more than a minute old is refused, because it is a
different trade at a different price. Ages are measured against the fastest
delivery actually seen, so a machine with a badly set clock corrects itself
instead of refusing everything.

## Several charts at once

The scrolling launch ticker is gone. The strip it occupied is the open tokens:
a tab per coin across the Terminal workspace, so a chart is one click away from
the watchlist or Discover rather than a round trip back through the list you
came from. Only the active token renders — a tab is a remembered address, not a
mounted page. Ctrl+Tab cycles, Alt+1–9 jumps, middle-click closes.

## Hold 1,000,000 $KRYPTO and Krypt charges you nothing

Across any wallet in the app, on every chain. It covers Krypt's own 0.5% a side
only — pump.fun's 1% and the network's fees are not ours to waive.

The threshold is a token count rather than a dollar value on purpose: a dollar
threshold on a memecoin moves under the holder, and it needs a price, which is a
second thing that can be unreadable. An unreadable holding is **charged**, never
waived, or breaking one request would be the cheapest way to trade for free.

Every screen that names the fee reads the same answer, so the trade panel can
never say "incl. Krypt 0.5%" while the signer charges nothing.

## Scripts say which coin they spend

`nativeFieldLabel` was written for this and never called, so a script on
Robinhood Chain described itself in SOL at every turn — including in the
confirmation shown as it was armed. Every money label now follows the script's
chain, and the Scripts page has a tab per chain so the chain is chosen before
there is a script to choose it on. A live script on a chain that cannot execute
now says so instead of showing a page with nothing wrong on it.

## Mayhem coins are a choice

Solana scanner: **All**, **No mayhem**, or **Mayhem only**. A mayhem coin trades
against inflated virtual reserves, so it is read free from the launch event with
no extra request. A launch the app cannot classify survives "No mayhem" and is
refused by "Mayhem only" — both readings put the unknown on the side that makes
no claim the app cannot support.

## Speed, measured rather than assumed

The backlog said "move feed decode to a utilityProcess". Measured first, on real
mainnet fixtures: decoding a whole log notification costs **19 µs**, about 1.5%
of one core at firehose rates, while the IPC hop it would add costs more than
that. It was not built.

The real cost was **922 µs per launch** deriving PDAs — forty-eight times a
whole decode, and a single unbroken stall. Those derivations are memoised (a PDA
is a pure function of its seeds), skipped entirely for a launch that is
hard-rejected, and skipped before anything at all for one the mayhem filter
turns away. Your own wallet's volume accumulator, re-derived on every single
trade build, is now effectively free.

## A spent API allowance is not a rate limit

Birdeye answered `HTTP 400 — Compute units usage limit exceeded` and the app made
**1,743 calls collecting 1,743 errors**, because only a 429 parked a provider. A
monthly allowance does not come back in twenty seconds: it now parks for hours
and says how to fix it. Under that sits a general net — ten failures in an
unbroken run stand a provider down whatever the reason, so the next one of these
stops at ten instead of seventeen hundred.

## Also

- **Any provider can have the execution lane.** The fast endpoint used to be
  reachable only with a Helius key; `rpc.fastHttpUrl` gives it to QuickNode,
  Triton, Shyft or your own validator, while bulk reads stay on the cheap one.
  A **Measure** button in Settings times the endpoints you have configured —
  median round trip and the slot each reports, so an endpoint that is fast
  because it is behind the chain shows as behind.
- **Sell percentages carry two decimals** end to end, so a sell sized from real
  token quantities is not rounded back up into tokens nobody sold.
- **The EVM watchlist batches**: one request per chain instead of one per pinned
  token, every twenty seconds.
- **An EVM copy config starts the feed it needs.** A followed wallet there is
  seen only through that chain's scanner, and an armed config on a stopped one
  watched nothing, silently.
- **The session ledger says which accounting it is showing.** It renders paper
  positions when idle and live-session counters when armed, and swapping between
  them looked exactly like the numbers being wiped.
- The three shadow research modules now default **off** for new installs. They
  trade nothing, but they do per-event work and write rows through the recorder,
  and the study they were built for is over.
