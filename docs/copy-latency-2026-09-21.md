# Copy latency: the telemetry, and where the code says to look — 2026-09-21

A tester watched a leader's wallet and their copy wallet side by side and timed
**~5–6 s** from the leader's transaction to theirs landing. On the low-cap
launches they were testing, that is enough for the entry to move a long way.
They could not tell from outside how much was hearing about the trade and how
much was placing ours, and asked for `detected → decoded → submitted → landed`.

That is now measured, on every copy, paper and live.

## What is measured

Each copy carries a `CopyTiming` and logs one line:

```
copy timing live whale1 BONKFA: 3.70s their fill → ours via logs:
heard 900ms · read 740ms (2 tries) · decode 3ms ·
checks 620ms [token facts 590ms] · order 1.40s [build 210ms, land 1.05s]
```

| Stage | What it is |
|---|---|
| `heard` | Their block time → the notification reaching us. The chain and the RPC, not us. |
| `read` | Reading the transaction back by signature. Absent on `transactionSubscribe`. |
| `decode` | Pulling the swap out of the wallet's own balance deltas. |
| `checks` | Every filter, with the token-facts lookup named separately inside it. |
| `your delay` | The config's own `delayMs`. Shown only when set, because it is a choice, not a cost. |
| `order` | Handing the order over until the broadcast returned, split into build and land by the signer's own `TradeTiming`. |

Three rules the numbers obey, each pinned in `test/copylatency.test.mjs`:

- **A stage that did not happen is absent, never zero.** Paper has no order. The
  `tx` transport has no read-back. An undated leader transaction has no total,
  and the line says `timing:` instead of claiming `0.00s`.
- **A recovered transaction is not timed at all.** One the watcher fetched after
  a socket gap can be minutes old through no fault of the delivery path;
  averaging those in would make the feed look far worse than it is.
- **The summary is a median, not a mean.** One copy that waited out a parked
  endpoint would drag an average somewhere no copy ever was.

The read-back clock starts *before* the first attempt, so the sleeps between
retries are inside the number rather than hidden between the requests.

## Where to read it

- **Copy Trading page**, above Recent copies: the median per stage over this
  session, with a line splitting "hearing about it" from "placing yours". It
  says outright when fewer than five copies have been timed.
- **The Console and the exported logs**: one line per copy. This is the one to
  benchmark from, since it keeps every individual sample.
- **`copy_timing`** in the recorder, for anyone wanting the raw series.

The summary is in memory only. It measures *this* session's endpoint,
transport and machine, and carrying it across a restart would average away the
thing being measured.

## Where the code says the time goes

Not measured yet on a live run — that is what the tester is for — but reading
the path, there are exactly three places worth suspecting, and the telemetry
names all three separately for that reason.

**1. The read-back, on the `logs` transport.** A signature arrives; the
transaction is then fetched by signature, with up to six attempts (the gaps
between them were 700 ms doubling until this was fixed, below). A just-confirmed
transaction often is not readable on the first ask, so the gap before the
second attempt is paid on most copies. `transactionSubscribe` removes this
stage completely —
the transaction arrives with the notification — and the watcher already prefers
it on a keyed socket, falling back only when the host refuses the method.

**2. The token-facts lookup, inside the checks.** `tokenFacts` reads the market
summary, cached if it can be and a full round trip otherwise. For a mint a
leader has just bought it is never cached, so this is a network call in the hot
path, through a provider queue that throttles. Broken out as `factsMs` so it
cannot hide inside the filter total.

**3. `confirmed` commitment on both subscriptions.** `FEED_COMMITMENT` is
`confirmed` on `logsSubscribe` and `transactionSubscribe` alike. The module's
own note says `processed` is worth roughly 400 ms and carries a phantom-signal
risk — a processed push can describe a transaction that never lands, and a copy
must not fire on one. That comment ends "belongs behind a measurement, not a
default", which is exactly why nothing here changed it.

The order itself was measured on 2026-09-18: about 1,400 ms end to end, of
which app code was ~165 ms and the rest was landing. That half is already about
as short as it gets without a different lane.

## What was made faster, without waiting for the benchmark

Two of the three suspects had a fix with **no correctness cost at all**, so
they did not need to wait behind a measurement. Both are pinned in
`test/copylatency.test.mjs`.

**1. The read-back asks again quickly.** The retry schedule was 700 ms
doubling: 700, 1400, 2800, 5600, 8000. The patience at the tail is the point
and is why six attempts exist — a leader's *exit* that goes unread reads to the
user as a position that sold late, which is the 2026-09-15 report. But the
700 ms at the **front** was never about patience. A transaction the socket has
just told us about is already confirmed; the node has simply not indexed it,
which takes tens of milliseconds. The schedule is now `[120, 300, 800, 2000,
5000]`: short where the answer is about to arrive, longer than before at the
tail. Six attempts either way, and a parked host is still waited out inside the
call by `rpcClient` rather than by these sleeps.

On the common case — first ask misses, second succeeds — that is **~580 ms off
every copy** on the `logs` transport.

**2. The token lookup is skipped when nothing reads it.** `tokenFacts` is a
provider round trip whenever the mint is not cached, and a mint a leader has
just bought never is. It was paid on every copy whether or not a single filter
looked at the answer. It now runs only when the config actually sets one of the
filters that reads it.

The reach of that one is honest but limited: the shipped default config carries
a $5,000 liquidity floor, so most followers do need the lookup. It is free for
anyone who has cleared their filters, and it costs nothing to have. Every
filter that reads a fact must be named in `needsFacts` — they all fail closed,
so one left out would refuse every copy — and the test derives the list from
the filter block itself rather than trusting the two to stay in step.

## What was deliberately not changed

**The commitment.** `FEED_COMMITMENT` stays `confirmed`. `processed` is worth
roughly 400 ms and can describe a transaction that never lands, and a copy must
not fire on one. The module's own note says it "belongs behind a measurement,
not a default", and that is still true.

**The transport.** Nothing to change: `transactionSubscribe` removes the
read-back stage entirely and the watcher already prefers it on a keyed socket,
falling back to `logs` only when the host refuses the method. If the tester's
line says `via logs`, the single biggest win available to them is a key on a
plan that serves it — no code involved.

**The market summary's fan-out.** A cold `buildSummary` waits on six providers
in a `Promise.all`, and a copy that only needs liquidity pays for the pump.fun
identity leg too. Splitting that is a real win and a real risk — the identity
leg is what answers `isPumpfun` and `creator`, and those filters fail closed —
so it goes behind the measurement with `processed`.
