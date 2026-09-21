# Scripts page layout, and the "orders freeze my chart" report (2026-09-20)

Two user messages in one: the Scripts page was "organized poorly" (the
turn-on-live switch under the whole editor, scripts and new scripts in one
column, the API / variable / AI-prompt material hanging off the code
editor), and a forwarded report that setting a buy or sell order "does
something to interfere with the tradeview window — the graph and tickers
all freeze and get stuck until I cancel it".

## The Scripts page

One top bar in the page header, three views (`src/pages/Scripts.tsx`):

- **My scripts** — the list on the left (chain tabs, the list, a "New rule
  or script" link, the kill switch), the editor on the right. The editor
  now opens with a **header card**: the name, what it is (rule / script ·
  chain · paper / live), the **arm switch**, Save and Delete — at the top,
  where the eye lands. Under it the settings card (kind, chain, mode,
  budget), then the rules or code editor, then the log. The switch still
  acts on the SAVED script and refuses while the draft is dirty; nothing
  about arming changed except where it sits.
- **New** — pick the chain first (a script sees and spends one chain's
  money), then "Start a rule" or "Start a script", or "Start from an
  example". The list column no longer creates scripts.
- **Reference** — four sections: the AI prompt (copy, with the explanation
  of what it carries), the bot API, the variable guide per chain (every
  field and when it is null, the new tg* / domain* / site* fields
  included), and the examples with a "Use it" that starts a code draft.
  The code editor keeps "Insert an example", "Copy AI prompt", and API /
  Variables buttons that jump to Reference.

Pinned from source in `test/scriptspage.test.mjs` (three views, arm
switch and Save above the settings/editor/log, New creates, Reference holds
the reading, the code editor has no side panels). Walked live in
`npm run test:scriptspage:e2e` (screenshots of each view; the header card's
DOM order with a rule draft).

## The order-freeze report

**Not reproduced.** `test/orderfreeze.e2e.mjs` opened an active PumpSwap
token, counted the chart ticks the page received for 40 s, armed a limit
buy that could never fire (1 % of the price), counted for 60 s, cancelled,
counted 40 s more. Ticks kept flowing at the same rate (2.85 → 2.20 → 1.57
per second, the token's own ebb), the renderer's round trip stayed at 1 ms,
main logged nothing. The same main-process path the token page's order
panel uses.

What was checked and ruled out: the 12 s order poller (priority summaries,
but cached per mint and the assembly is not priority); lightweight-charts
4.2.3 does NOT fold price lines into the autoscale (read from the library),
so a far-off stop cannot flatten the chart; the price-line effect is
signature-guarded; the order panel has no timers; `createOrder` does one
summary read at most.

What WAS wrong in shape, and is fixed: on both trade rails the terminal
tape (the chart's ticks and the trades list) was recorded AFTER the order /
alert / copy evaluation for that trade. Anything thrown or stalled in that
evaluation skipped the record on every trade of the mint — a chart frozen
for exactly the token with an order on it, until the order was cancelled,
which is the reported shape. Now (`electron/engine/engine.ts`): the tape is
recorded first, the evaluation is fenced in a try/catch, and a throw is a
Console line at most once a minute per mint (`noteEvalError`). The four
watcher rails already ticked the chart first; all six are pinned in
`test/tapefirst.test.mjs`.

To reproduce properly, ask the reporter: which page (the token page, or a
chart panel on My Layout), which order kind (stop / take-profit / trailing /
limit), paper or live, whether the scanner was running, and whether the
Console showed a red line at the time. With those the driver above can be
pointed at the same shape.
