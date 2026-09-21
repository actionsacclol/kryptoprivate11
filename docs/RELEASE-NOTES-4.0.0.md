# Krypto Bot 4.0.0

Copy trading works again after a network change silently stopped it, and it
grew a simple way in, a Copy score for wallets, and two new directions. Pump
coins are priced from the chain instead of an API that rate-limited the app all
day. A copied sell is settled in tokens, a leader's late trade is treated as
late, several charts stay open at once, and holding $KRYPTO halves Krypt's own
fee.

You will be asked to accept the terms once more: the privacy policy changed
(the Links panel and what the app reads off a token's X page, Telegram group
and website are named in it now).

---

## Copy trading had stopped copying — fixed

On 2026-09-15 Solana switched on transaction version 1. Every read the copier
made asked for "version 0 at most", the node refused with `Transaction version
(1) is not supported`, and for five days a followed wallet's trades were seen,
fetched and dropped: nothing was copied, and positions already open were never
closed. A user with about thirty open copies reported it.

The app now reads version 1 everywhere it reads a transaction (the copier, the
block feed, the leader scanner), including the new wire layout. The copy status
line counts trades it could not read, so a change like this shows as a number
instead of silence. Positions opened before the fix are still yours to close by
hand — the copier cannot know what happened while it was blind.

## Copy Simple

A new page at the top of Automation, and where Automation now lands. Paste a
trader's wallet, pick how much per trade, press **Follow on paper**. The chain
comes from the address; a `0x` address asks Robinhood Chain or BNB. Everything
else is derived: fixed sizing, a cap equal to the size, a daily stop of ten
trades, the leader's sells mirrored. A sentence above the button says what
will happen in words.

Paper is the only first button. Live is a switch on each card, it disarms on
the way over, and arming runs the same confirmation as the full page. A follow
made here is the same config Copy Trading shows, where every control is.

## A Copy score for wallets

The Wallet Scout ranked wallets by their own PnL, which is the one number a
follower cannot have: the leader's edge is being first. The Scout now scores
what **following** a wallet would have realised — entering at the first print
two seconds after them, paying 1.5% a side, out when they are out — from the
prints the Scout already collects. It ranks the least bad wallets to follow.
It does not claim an edge; measured over the same data, the best followable
wallets still lose a few percent a trip.

A wallet opens in a drawer with the checks behind its score, both records
(theirs and yours-if-you-had-followed), recent trips, and **Follow on paper**
/ **Reverse on paper** buttons. Records from before the change say "not
measured" rather than pretending. The Record and Scan buttons are bigger, and
the board can be sorted by the score.

## Reverse and FOMO copying

Two more directions on a copy config, both on paper by default and both
labelled as bets in every place they appear.

**Reverse** buys when the followed wallet **sells** and exits when they buy
back, or on its own take-profit (+25%), stop-loss (−20%) or max hold (30 min).
The research says leaders' exits come early; fading them is a coherent bet
that nobody has measured, and the form says so.

**FOMO** follows a set of wallets — the ones you follow, the ones you saved on
the Scout, your tracked list, or the Scout's top N by Copy score — and buys
when several of them pile into the same coin inside a window (three within
three minutes by default). It gets out when half the crowd has sold, or on its
own exits. Measured over 9.3 million trades, wallets converging on a coin made
the follower's outcome **worse** with each extra wallet, from −15% to −32% an
hour later. That is written on the form in an amber box. It ships because
people ask for it.

A plain copy can now set its own take-profit, stop-loss and max hold too, on
top of the leader's sells. Blank still means their sells alone decide.

## Rate limits: pump coins are priced from the chain

The Terminal page said "rate limited by pump.fun" most of the day and the feed
lost 20–30% of events. Both came from the same place: every pump coin's price
was a pump.fun request, and pump.fun allows very few.

A pump coin is now priced from its own accounts on the chain — the curve, the
mint, the metadata, and for a graduated coin the pool and its vaults — in one
batched read for up to thirty-three coins. pump.fun is asked for identity only
(name, image, socials), once, and remembered. Discover's pump columns come from
the live feed's own books while the scanner runs, so a parked provider no
longer empties the page, and a banner names only a provider that was actually
asked. Jupiter is paced inside its keyless window. In a 150-second run after
the change the app raised no rate-limit banner at all.

## Graduated pump coins build locally

A pump coin that graduated to PumpSwap used to go through the relayer, with its
fee and its outages. The app now builds those trades itself, from the pool's
own accounts, and falls back to Jupiter and then the relayer only if that
fails. The order is local, PumpSwap, Jupiter, relayer.

## Raydium launches

A second Solana rail: Raydium AMM v4 and CPMM pool creations, heard through the
two pool-creation fee accounts rather than the program firehose, with a
per-pool tape decoded from logs. A pool with no SOL or USDC side is not listed
under a guessed mint.

## Looks, accents, languages

Six **looks** (Classic, Futuristic, Minimal, Hacker, Retro, XP — the first
light one) change fonts, surfaces, corners and effects. Five **accents**
change the colour. Neither can touch a colour that carries meaning: up, down
and money are the same in every look, and a test enforces it. The UI is
available in eight languages; legal documents and money messages stay in
English, on purpose, because they are the authoritative ones.

"My Layout" is called **Widgets** now. **Rewards** became **Guides**: one
plain-words guide per Hub tile. The reward check moved to the Robinhood Chain
and BNB wallet pages.

## Links, and what the app will and will not read

A **Links** widget embeds a token's X page, website or launchpad page in a
hardened frame (no node, no preload, https only, its own cookie jar), and token
pages list the links. From the rendered X page the app reads follower and like
counts; from t.me it reads a group's public member count; from the registry it
reads a domain's age. It looks these up only for tokens someone asked about,
never crawls, and never guesses traffic, which is not obtainable for free.
Scripts get all of it as variables, null until asked.

## Launch updates keep flowing for flagged runners

A script author reported runner events followed by silence: forty price ticks
and no launch update. A launch was fully tracked only during its evaluation
window (15 s by default), and runner flags come at 60 and 120 s. A launch now
keeps its flow and its launch updates while a position holds it, while it is a
flagged runner, or while a script has subscribed to it. `bot.subscribe(mint)`
is the supported way to keep updates on a runner you intend to act on.

The Hub's Automation card counted only followed wallets; it now says when a
script is running, paper or live.

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

## Hold 1,000,000 $KRYPTO and Krypt's fee is halved

Across any wallet in the app, on every chain, Krypt's 0.5% a side becomes
0.25% a side. It covers Krypt's own fee only — pump.fun's 1% and the network's
fees are not ours to reduce.

The threshold is a token count rather than a dollar value on purpose: a dollar
threshold on a memecoin moves under the holder, and it needs a price, which is a
second thing that can be unreadable. An unreadable holding is **charged at the
full rate**, never reduced, or breaking one request would be the cheapest way to
trade for less.

Every screen that names the fee reads the same answer, so the trade panel can
never say "incl. Krypt 0.5%" while the signer charges half. A **Scan** button
on the $KRYPTO card re-reads your holding on demand.

## Orders are faster, and never freeze the chart

Measured: the app's own code is about 165 ms of a 1,400 ms order; the rest is
the network landing it. Two real gaps closed — a blockhash prewarm that could
expire, and a sell that made a second round trip it did not need.

A reported "orders freeze the chart" was traced to the tape being recorded
after order evaluation on both rails, so an evaluation that stalled skipped the
chart's record for exactly the token with an order on it. The tape is recorded
first now, and the evaluation is fenced.

## Scripts say which coin they spend

`nativeFieldLabel` was written for this and never called, so a script on
Robinhood Chain described itself in SOL at every turn — including in the
confirmation shown as it was armed. Every money label now follows the script's
chain, and the Scripts page has a tab per chain so the chain is chosen before
there is a script to choose it on. A live script on a chain that cannot execute
now says so instead of showing a page with nothing wrong on it. Scripts also
receive the whole provider summary and a token's links as variables, and the
page was rebuilt with a top bar and the arm switch above the editor.

## Mayhem coins are a choice

Solana scanner: **All**, **No mayhem**, or **Mayhem only**, on the Execution
page beside the runner-alert tuning (window, buyer and SOL floors, supply band,
repeat dumpers). A mayhem coin trades against inflated virtual reserves, so it
is read free from the launch event with no extra request. A launch the app
cannot classify survives "No mayhem" and is refused by "Mayhem only" — both
readings put the unknown on the side that makes no claim the app cannot
support.

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

- **The Observatory's live ledger is the session's real fills**, not the
  scanner's own counters, and every "session" panel on Widgets reads the same
  numbers.
- **Runner rows** carry a Krypt score, a sparkline floor so a near-dead curve
  cannot show a huge move, an "on N SOL net" label, and a skip-mixed switch.
- **pump.fun Callouts** as a right-edge rail and a widget: the public global
  feed, intel only.
- **The Wire tab** shows each rail's health and labels paid placements. A
  headline feed was researched and deliberately not built: the licences
  forbid it.
- **Games** widget: Snake, Flappy Crypto, Dino, Tetris, 2048. Keys in a game
  never reach the trading hotkeys.
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
- The Warmer and the multi-wallet simultaneous buy were removed.
