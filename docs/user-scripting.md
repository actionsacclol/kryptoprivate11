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
| Five errors in a row disable a code script; a handler past 3 s is killed | `automation.ts` + `scriptSandbox.ts` watchdog |
| Kill switch: everything off, nothing enables until lifted | `setKillSwitch` |
| Code cannot reach keys, files, Node or the network | sandboxed renderer, own session partition, every request cancelled |

The sandbox is a hidden `BrowserWindow` with `sandbox: true`, `contextIsolation`,
no Node, `devTools: false`, on the `script-sandbox` partition whose
`webRequest.onBeforeRequest` cancels everything but the page's own `data:`
load. Its preload (`electron/scriptPreload.ts`, built as its own entry) exposes
one channel. Main attributes each message to the window it came from, never to
anything the message says, and `parseFromSandbox` drops anything malformed.
`npm run test:sandbox` proves all of this in a real Electron process.

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
run one at a time. Three examples ship in the editor (buy strong launches,
trailing exit, runner alert to watchlist).

## Files

`shared/automation.ts` (model, rule engine, validation, examples, API doc),
`shared/scriptProtocol.ts` (wire + harness page), `electron/scriptPreload.ts`,
`electron/system/scriptSandbox.ts`, `electron/engine/automation.ts` (registry,
budgets, dispatch), engine host wiring in `engine.ts`, IPC `automation:*`,
`src/pages/Scripts.tsx`. Tests: `test/automation.test.mjs` (29),
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

## Not done yet

- Live positions for scripts are priced from what the engine already knows
  (feed row, last-known, tape) — a holding the engine never saw priced reads as
  unknown, and a rule on it does not fire.
- No script-level backtest; paper mode against the live feed is the test.
