# "Seven hours in paper, 1,770 updates, zero buys" (2026-09-21)

A user's report, and what it turned out to be. Worth writing down because
nothing was broken — the app behaved exactly as designed, and the design was
badly explained.

## The report

> after yesterday's update I ran the script in paper mode for another seven
> hours without a buy. Updates are now reaching watched coins. The latest
> session status shows 1,770 matched updates and 0 buy attempts.
>
> • 17:13:56 — 23 updates received; expired: "score must be >80 and <=100".
> • 17:13:10 — 11 updates received; expired: "creatorSold must be explicitly false".
> • 17:13:27 — "creatorPriorRugs must equal 0; confirmation reset".
>
> The app also displays "sandbox gone (renderer killed)". There's no timestamp.

Three questions: is the script using the API correctly, does the `creatorSold`
rejection mean a confirmed sale or an unknown, and could the renderer error
have interrupted it.

## 1. Those messages are not ours

Grepped the whole tree for "must be explicitly", "confirmation reset" and
"must be >80". None exist. The app's own rejection wording comes from
`conditionHolds` (shared/automation.ts) and reads like `Krypt score 47.4 not
greater than 80` or `Creator sold unknown`.

So the criteria, the "confirmation" step and the "expiry" are all the user's
own code-script logic. The API refused nothing.

## 2. The score never changes — the actual cause

`computeScore` is called in exactly one place (engine.ts:5596), inside the
block that runs when the entry gates pass **or** the evaluation window
expires, and `t.decided = true` follows immediately. A launch is scored once.

So a script that waits across 23 `launchUpdate` events for the score to climb
above 80 is waiting for a constant. Every one of those updates carried the
same number. The flow fields — buyers, net inflow, sells, curve % — do keep
moving; the score does not.

This WAS documented, at the tail of an eighty-word sentence in the events
reference: "…the score is fixed at decision time, the flow fields move". That
is a fair description and a bad piece of writing, and it cost a user seven
hours.

## 3. Above 80 is roughly 1 launch in 36 anyway

Measured live off the running app, 60 seconds of the pump feed, 36 scored
launches:

| | |
|---|---|
| min | 23.6 |
| median | **47.4** |
| 90th percentile | 62.9 |
| max | 80.8 |
| above 60 | 4 of 36 |
| above 70 | 1 of 36 |
| **above 80** | **1 of 36** |

The best one in the sample broke down as safety 20, creator 9, sellPressure
18, entryTiming 6.1, crowd 8, concentration 9.7, metadata 10 → 80.8.

There is a structural ceiling behind this. The creator component is 9/18 for a
first-time creator, which is most pump launches, so the realistic maximum is
about 91. And `safety` caps at **8** of 20 while the async mint check has not
landed (`mintChecked === false`, engine.ts:5203) — in that window the
arithmetic maximum is 79 and "> 80" is not merely rare, it is impossible.

A threshold of 60 would have matched 4 of 36.

## 4. `creatorSold`: an observed sale, not an unknown

On a launch-feed token `flow.creatorSold` is a strict `boolean` (types.ts:697),
initialised `false` (engine.ts:6104) and flipped to `true` only when the
creator's own sell is seen inside the window (engine.ts:5393). Measured live:
type `boolean` on every scored row, **6 of 36 (17 %) true**.

So the user's rejection means the app really did see the creator sell.

Two traps worth stating:

- **`false` means "no creator sell seen YET"**, not "they will not sell". It
  is the starting value.
- **Off the launch feed it is `null`.** `contextFromLaunch` only fills it when
  `row.flow` exists. A test written `creatorSold !== false` therefore rejects
  unknowns too. `creatorSold === true` is the safer shape for a rejection —
  and the same applies to `creatorPriorRugs`, where `> 0` beats requiring
  `=== 0`.

## 5. Yes, the renderer error interrupted it — and worse than it looks

"renderer killed" is `render-process-gone` with reason `killed`, and that is
almost always **our own watchdog**: any handler still running after
`EVENT_TIMEOUT_MS` (3 s) has its renderer crashed on purpose
(scriptSandbox.ts `dispatch`).

What that costs, beyond the one event:

- `rt.queue = []` on restart — every queued update is discarded.
- **All in-script memory is lost.** A confirmation counter held in a variable
  resets to zero. `bot.setState` (16 KB, survives restarts) is the only thing
  that does not.
- 5 restarts in a minute disables the script; 5 errors in a row also disables
  it.

With 1,770 matched updates and repeated kills, a confirmation window held in
memory may never have survived long enough to complete even if the criteria
had matched.

## 6. What was fixed

### The watchdog itself — this one was a real defect

The deadline exists to catch a WEDGED renderer, a handler in an infinite loop,
which nothing else can stop. It was also killing something entirely different:
a handler legitimately AWAITING one of our own calls. `bot.market()` is
documented as "slow — a second or more", so two of them inside one handler
spent the three seconds and the script was crashed for OUR latency, losing
every byte of its in-memory state.

The two cases are perfectly distinguishable, and the code already knew how: a
renderer stuck in a loop cannot answer an injected expression, one merely
awaiting can. `probeAlive` says so in its own comment and the READY path
already used it. The EVENT deadline did not — it just killed at 3 s.

Now, when the deadline fires, it ASKS. If the renderer answers it is not
wedged, so the handler is given another slice and a line is logged saying so.
If it does not answer, it is crashed exactly as before. Extensions stop at
`EVENT_HARD_MS` (30 s), because a watchdog that never bites is not one.

Cost: a wedged renderer now dies at about 4 s rather than 3, since we wait out
the probe to be sure. That second buys not crashing well-behaved scripts.

**A regression caught by the existing tests, worth recording.** The first
version guarded the deadline on `settled` — if the caller had been answered,
stand down. That is exactly the hole the suite's `forgedDoneStillKilled` case
exists for: the bridge's `on` is additive and the dispatch id rides in the
message, so page code can forge a `done` for an event it never finished and
then wedge the renderer. With the wrong guard it was never killed — `gone:
null, isRunning: true`. Only a PROVEN-ALIVE renderer may lift the deadline, so
the guard is a `cleared` flag that only the probe's success sets. `done` still
does not clear it.

### And three things that made the rest unknowable

1. **The score field now says it does not move.** Its hint leads with "fixed
   once when the launch is decided — it never moves afterwards, so do not wait
   for it to rise", and states the typical range and the 1-in-36 figure.
2. **`launchUpdate` leads with it too**, in capitals, at the front of the
   sentence instead of eighty words in, and names the flow fields as the ones
   that do move.
3. **`creatorSold` explains what `false` means** and that about one launch in
   six turns true.
4. **"sandbox gone (renderer killed)" now says which cause it was.** The box
   records who pulled the trigger before crashing the renderer, so a watchdog
   kill reads: *your "launchUpdate" handler was still running after 3s, so the
   script was restarted — anything it was holding in memory is gone (use
   bot.setState to keep it)*. A genuine crash still reads "the renderer
   stopped (crashed)".
5. **`lastError` carries a time.** It is a sticky field, so without one an
   error from six hours ago reads as one happening now — which is exactly what
   the user saw. `ScriptStats.lastErrorAt` feeds both places the Scripts page
   shows it.

Pinned by three cases in `test/automation.test.mjs` (65 total), so the wording
cannot drift away from the code that makes it true, and by a new
`slowHandlerSurvives` case in the live sandbox test (`npm run test:sandbox`,
21 checks in a real Electron): a handler that awaits for twice the deadline
finishes normally and its script keeps running, while `watchdogKilled` and
`forgedDoneStillKilled` prove a wedged one still dies.

## 7. What to tell the user

- Read `score` on the first update and decide; it will never change.
- Use about 60, not 80. Above 80 is ~1 launch in 36, and impossible at all
  while the mint check is outstanding.
- Reject on `creatorSold === true` rather than `!== false`, or an unknown
  rejects too. Same for `creatorPriorRugs > 0`.
- Keep handlers under 3 s — no `await bot.market()` or `bot.security()` inside
  a hot `launchUpdate` handler; `bot.token()` and `bot.price()` are the cheap
  reads.
- Hold confirmation state in `bot.setState`, not in a variable, or a sandbox
  restart wipes it.
