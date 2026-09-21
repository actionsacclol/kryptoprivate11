# User scripting: rules and code (2026-09-08)

Automation → **Scripts**. A user writes their own automation two ways:

- **Rules** — no code. *When* (a trigger) *and all of these hold* (conditions
  over the same facts the app shows) *then* (buy, sell, watch, notify, log).
- **Code** — a few lines of JavaScript against a small `bot` API, run in a
  sandbox.

Both are the same thing to the app: a source of *asks*, each checked against
the script's own budget, executed through the same pipeline as a hand-placed
order, and recorded on the script's log with its reason when refused.

## The safety model

| Wall | Where it is enforced |
| --- | --- |
| Paper by default; live is a separate confirmed switch | `automation.ts` `upsert` / `setEnabled`; saving as live disarms |
| A live script never comes back armed after a restart | `automation.init` |
| Every buy/sell is the engine's own path (fees injected, signer policy, breakers, loss guard) | engine host: paper = `testTrade(simulate)` → paper book; live = `testTrade` / `manualSell` |
| Max SOL per trade: over the cap is **refused**, never shrunk | `act()` |
| Buys per day, open positions, actions per minute | `act()` |
| Daily realised loss past the cap **disables** the script | `act()` after every sell (paper exact; live from the position's PnL at the moment of the sell — an estimate, and it counts) |
| A live buy is also capped by `execution.maxLiveSol` and blocked by the same reasons as an order | `act()` via `liveBlockedReason` / `buyBlockedReason` |
| An unknown fact never satisfies a rule | `conditionHolds` |
| A start that STALLS is retried 3 times with backoff, not disarmed; a script whose body throws is disarmed at once | `automation.ts` `startCode` |
| Five errors in a row disable a code script; a handler past 3 s is killed | `automation.ts` + `scriptSandbox.ts` watchdog — the deadline is cleared by the RENDERER answering a liveness probe, never by a `done` the page could forge |
| Kill switch: everything off, nothing enables until lifted | `setKillSwitch`, re-read after every await and again before the buy |
| A script may only sell what IT opened; `held` and `bot.positions()` mean this script's positions | `act()` sell / sell_all / order, `ctxFor`, `pollPositions` |
| One action at a time per script, so N events in a tick cannot each read the same pre-buy counters | `act()` per-script chain |
| A per-mint cooldown survives a restart | persisted with `firedMints` |
| Code cannot reach keys, files, Node or the network — WebRTC included | sandboxed renderer, own session partition, every request cancelled, and the renderer pinned to `disable_non_proxied_udp` with the partition's proxy forced direct, so no ICE candidate, STUN lookup or data channel can leave |

The sandbox is a hidden `BrowserWindow` with `sandbox: true`, `contextIsolation`,
no Node, `devTools: false`, on the `script-sandbox` partition whose
`webRequest.onBeforeRequest` cancels everything but the page's own `data:`
load. Its preload (`electron/scriptPreload.ts`, built as its own entry) exposes
one channel. Main attributes each message to the window it came from, never to
anything the message says, and `parseFromSandbox` drops anything malformed.
`npm run test:sandbox` proves all of this in a real Electron process (20 checks,
including `rtcBlocked`, a forged `done` that is still killed on time, an
11 s top-level `await` that starts anyway, and a missing preload reported as a
broken install rather than a bare timeout).
CSP3's `webrtc 'block'` is in the page CSP and Chromium 43 ignores it —
measured: nine host candidates with the directive set, zero once the IP
handling policy is applied. Deleting `RTCPeerConnection` from the page realm is
not a fix either, since `window[0]` hands back a fresh one. The
preload is deliberately EXCLUDED from the V8 bytecode step: a sandboxed preload
has no Node `require`, so a bytenode stub throws on its first line and every
code script dies with nothing but a start timeout. `scripts/harden-bytecode.mjs`
asserts it.

## Rules

Triggers: **New launch**, **Launch update**, **Runner flagged**, **Open
position** (checked every 5 s over what the script holds, and on every fill),
**Price tick** (a token the script holds, watched or subscribed to; at most one a
second per token), **Followed wallet traded** (the Copy Trading watcher's feed),
**Order changed** (an advanced order triggered / filled / failed / cancelled /
expired / paused, diffed from order snapshots), **Alert fired** (diffed from
`lastFiredAt`), **Daily at a time** (HH:MM local).
Fields (the variable guide, `RULE_FIELDS`): launch-feed facts (age, score,
price, curve %, buyers, buys/sells, volumes, acceleration, sellers, holder
shares, creator flags and history, smart buyers, risk flags, hard risk, phase,
symbol, name), cached market facts (market cap, liquidity, holders, USD price,
launchpad), position facts (held, PnL %, PnL SOL, held minutes, drawdown from
peak, cost), runner odds, followed-wallet facts (wallet, label, side, SOL, sold
%), order facts (kind, state, amount), alert facts (kind, threshold), and
globals (wallet SOL, local hour / minute / weekday). `SCOPES_FOR_TRIGGER` says
which scopes a trigger can see; the editor only offers those. Operators fit the
field's kind. Actions: buy, sell, sell everything, place stop loss / take
profit / trailing stop / limit buy / limit sell, cancel orders, apply an order
template, create an alert, watch / unwatch, notify, log, turn itself off. A
position rule cannot buy; a schedule has no token so it may only sell
everything, notify, log or disable. Advanced orders execute for real, so a
PAPER script records them on its log without placing them. Once-per-token and
a cooldown are per rule. Messages take `{symbol}`, `{mint}`, `{score}` and any
other field.

## Code

```js
bot.on(event, handler)   // launch, launchUpdate, runner, position, tick, leaderTrade, order, alert, fill, schedule, interval
bot.every(seconds, handler) / bot.at('HH:MM', handler)
await bot.buy / sell / sellAll / order / cancelOrders / applyTemplate / alert / watch / unwatch / notify
await bot.subscribe / unsubscribe(mint)      // ticks without pinning
await bot.price / token / market / positions / orders / runners / leaders / wallet / templates
await bot.getState() / bot.setState(obj) / bot.disable(reason)
bot.log(...) / bot.warn(...) / bot.now()
```

The full table is `SCRIPT_API` in `shared/automation.ts`; the editor renders it,
and **Copy AI prompt** copies `aiPromptPack()`, a self-contained prompt (the
rules of the sandbox, the money rules, every event, every method, every
variable with its unit and when it is null, five examples) to paste into any
assistant before describing the script. The **Variables** panel is
`fieldGuideText()` from the same table. A test pins that the pack names every
field, event and sandbox method and nothing else.

`launchUpdate` reaches a script at most once per 2 s per token; the event
queue is capped at 50 with launch chatter dropped first. Events for one script
run one at a time. A launch is fully tracked (flow, launch updates) while the
strategy evaluates it — 15 s by default — and after that only while something
still needs it: a position holds it, the scanner flagged it as a runner (15 min
from the flag), or a tape subscription exists (the terminal chart, or the
script's `bot.subscribe(mint)` / `bot.watch(mint)`). Before 2026-09-20 the
decision ended the updates outright, so a script subscribed to a flagged
runner saw price ticks and never another `launchUpdate` (user report). The
score is fixed at decision time; the flow fields move. `bot.token(mint)` reads
the same row. Three examples ship in the editor (buy strong launches,
trailing exit, runner alert to watchlist).

## Files

`shared/automation.ts` (model, rule engine, validation, examples, API doc),
`shared/scriptProtocol.ts` (wire + harness page), `electron/scriptPreload.ts`,
`electron/system/scriptSandbox.ts`, `electron/engine/automation.ts` (registry,
budgets, dispatch), engine host wiring in `engine.ts`, IPC `automation:*`,
`src/pages/Scripts.tsx`. Tests: `test/automation.test.mjs` (37),
`test/scriptprotocol.test.mjs` (5), `test/scriptsandbox.live.mjs` (real Electron).

## Verified end to end (2026-09-08)

Clicked through in `npm run dev`, and driven by `npm run test:scripts:e2e` against
the running app (start it with `KRYPT_DEBUG_PORT=9333 npm run dev`): a paper code
script saw launches, launch updates and its 5 s timer (wallet and positions
reads answered); a paper rule fired on launch updates and booked two 0.005 SOL
paper positions through the simulated-fill path, then refused the third on the
daily cap; a script sold 50 % of one through `bot.sell` and disabled itself;
no script errors; cleanup removed everything. Three things that run surfaced
were fixed the same day: a refused trade now ends the firing (the "log bought"
after it no longer runs), tiny prices print with precision in messages, and a
sandbox stopped by the script's own `disable` is not counted as an error.

## Starting a code script, and the eight-second timeout

Users hit `DISABLED — could not start: no ready within 8000 ms`. The sandbox
signals twice now, so the two causes behind that one message are separable:

- **`alive`** is the harness's first statement, sent before the user's code is
  compiled. Missing it means the preload never installed the bridge, i.e. a
  broken install, not a problem with the script. `preload-error` is subscribed
  too, so the real reason reaches the script log; nothing listened to it
  before, which is why every preload failure looked identical. Budget: 4 s.
- **`ready`** is sent after the script's top-level code finishes. Top-level
  `await` is allowed, so that budget belongs to the USER's code: one
  `await bot.market(...)` behind a parked provider can outlast 8 s. On that
  deadline the renderer is probed for liveness — the same probe the handler
  watchdog uses — and a renderer that answers is given more time, up to 30 s
  total. One that does not answer is a synchronous runaway and is killed at
  once, whatever the clock says.

A stalled start is retried three times (2 s, 5 s, 15 s) and the script stays
armed while it retries. A script whose body throws is not retried: it would
throw identically every time, so it disarms immediately with the error.
Disarming, the kill switch, or a newer start all cancel a pending retry.

## Not done yet

- Live positions for scripts are priced from what the engine already knows
  (feed row, last-known, tape) — a holding the engine never saw priced reads as
  unknown, and a rule on it does not fire.
- No script-level backtest; paper mode against the live feed is the test.

## Links, security, creator and the AI opinion (2026-09-20)

A user screening runners asked how a script could check the project's X
account or website. The honest answer was that the terminal never reads
either — it classifies the link, spots the same account behind several
launches, and hands the AI public chain facts plus which socials exist —
and that none of it reached Scripts. Now it does, on the rule that any data
the app has, a script may have.

**Variables** (scope `market`, Solana only — the EVM host answers cap and
liquidity and nothing else, and an absent field stays null): the rest of the
provider summary — `kryptScore`, `bondingCurvePct`, `devHoldingPct`,
`top10Pct`, `insiderPct`, `bundledPct`, `sniperPct`, `smartHolders`,
`volume5mUsd`, `buys5m`, `sells5m`, `priceChange5mPct` — and the links:
`hasTwitter`, `hasWebsite`, `hasTelegram`, `dexPaid`, the URLs `twitter`,
`website`, `telegram` (never visited by the app), `xLinkKind` (profile · post
· community · search · other-x · not-x · none), `xHandle`, and `xReuseCount`
(other launches in view on the same account or post — a farm from outside;
null when not counted, never 0). "No provider answered for socials" leaves
every link field null; a provider that answered with no links is a real
"none" (false / null). `marketFactsFromSummary` in shared/automation.ts is
the one mapping, so the cached read and the fetched read agree.

**Methods**: `bot.links(mint)` (free — cached facts, the launchpad page and
the X classification with reuse counts; null until something is cached),
`bot.security(mint)` (the token page's security report; a round trip, costs
an action), `bot.creator(mint)` (the creator wallet's pump.fun record; a
round trip, costs an action), `bot.analyze(mint)` (the AI second opinion;
spends the user's own key on an uncached call, so: an action, 20 per hour per
script, cached 10 minutes per token, the slot taken before the await so a
burst cannot all spend, refused with the reason when AI is off). All four
are Solana-only; on an EVM script they answer null / reject.

Later the same day, the off-chain face got its numbers — each from a
source a person could check, none fetched by crawling (see
docs/links-panel-2026-09-20.md): `xFollowers`, `xFollowing`,
`xVerified`, `xLikes`, `xReposts`, `xReplies`, `xViews`,
`xStatsAgeSec` (read off the X page in the Links panel when a person
opened it there); `tgMembers`, `tgOnline`, `tgKind` (Telegram's public
preview at t.me, fetched by main when a person or a script asks about the
token — a private invite shows no count); `domainAgeDays`,
`domainHostedOn` (the website domain's registry record over RDAP, or the
shared platform the site sits on); `siteNamesContract`, `siteLinksX`,
`siteOutboundHosts`, `siteMentionsConnectWallet` (what the website says
about itself, read off the page in the Links panel). `bot.links(mint)`
carries the same as `x.stats`, `telegramStats`, `domain` and `site`.
Every one is null until looked up or read — a script that wants them for a
coin nobody opened calls `bot.links(mint)` once, which starts the Telegram
and domain lookups (60 an hour each), and reads them on a later tick.

What is deliberately NOT there: the site's traffic (no free source
publishes it; a number would be a guess) and any verdict — the variables
are what the pages say, and the judgement is the script's.

Pinned in test/automation.test.mjs: the fields and their Solana-only scope,
the summary→facts mapping with X classification, `bot.links` from a summary,
links free vs security/creator charged vs analyze capped at 20 with the host
asked exactly 20 times, an AI refusal reaching the script as a reason, and
the four methods in SCRIPT_METHODS and the API table (the prompt-pack parity
test covers the docs).

## The page's shape (2026-09-20)

One top bar, three views — My scripts, New, Reference — with the arm switch,
Save and Delete in a header card above the editor, New on its own view, and
the AI prompt / bot API / variable guide / examples under Reference. See
docs/scripts-page-2026-09-20.md.
