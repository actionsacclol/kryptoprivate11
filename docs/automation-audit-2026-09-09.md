# Scripting and automation audit (2026-09-09)

A six-dimension adversarial swarm over everything that can spend money without
a human at the button: user scripts (rules and code), the script sandbox,
advanced orders, copy trading, the Wallet Lab, and the renderer that arms all
of them. Same recipe as `beta-audit-2026-08-28` and `release-audit-2026-09-03`:
six auditors in parallel, then a skeptic per dimension told to refute each
finding, with every P1 re-proved independently against its own harness.

Dimensions and their prefixes:

| Prefix | Scope |
| --- | --- |
| `walls` | The budget walls in `automation.ts` — what a script may spend, sell and do |
| `sbx` | The script sandbox: isolation, the watchdog, the preload, the build |
| `ord` | Advanced orders: arming, triggering, exactly-once, persistence |
| `copy` | Copy trading: the watcher, the mirror, the record |
| `lab` | Wallet Lab: warmer, funder, the realised-loss cap |
| `aui` | The renderer and IPC that arm all of the above |

Nothing was spent. Every probe ran against a fake host or a purpose-built
Electron harness in a scratch directory.

## What the audit was worth

The findings are grouped below by what they cost the user, not by module,
because the same mistake showed up in five places at once.

### Fail-open persistence — five modules, one bug

`advOrders`, `copyTrade`, `automation`, `randomLab` and the copy store all
treated an unreadable state file as an empty one, and the next save then
overwrote it. `ledger.ts` had the correct shape all along: ENOENT means a fresh
start, anything else sets a load-failure flag, refuses to persist, and tells
the user. All five now follow it. This is house rule *loading persisted state
fails closed* — unreadable is not absent.

### A script could sell bags it never opened (`walls-3`, P1)

`sell_all` was "sell 100% of every position in the wallet". The shipped "Daily
housekeeping" example, which the Scripts page offers as the default action the
moment a user picks the schedule trigger, would at 23:55 market-sell every bag
in the wallet — including hand-bought long-term holds — and report "closed 4 of
4 positions". Four separate strings in the product already promised the
opposite ("Sell everything **this script holds**", "Held by **this script**").

Now: a script may only sell what it opened, `held` means held by this script, a
position rule never fires on a foreign bag, and `bot.positions()` lists only
the script's own. The three tests that pinned the wrong behaviour were
rewritten so the script buys first.

### The budget walls had no lock (`walls-1`, `walls-2`, `walls-5`, P1)

`act()` was fire-and-forget from a synchronous engine event, so N events in one
tick each read the same pre-buy counters. Actions now run one at a time per
script. The kill switch is re-read after every await and before the buy, so
"every script is off" is true the moment it returns. The order path lost the
same guards and got them back.

### Copy trading mirrored the wrong bag (`copy-2`, `copy-3`, `copy-13`, P1)

A leader trimming 40% of *their* holding sold 40% of *our whole* position,
including size the user bought by hand and size an order ladder was holding.
Rows are now governed by the mode they were opened in, so a paper row can never
cause a broadcast, and the sell is scaled by this config's share of our basis.
The mirrored sell was also dead on the pump rail: the curve log feed delivered
the trade first without a fraction, and the signature dedupe then discarded the
watcher's later, fraction-bearing copy. A known signature is now let through
exactly once when it upgrades an unknown share to a known one.

### The Warmer's loss cap could be blind (`lab-1`, P1)

The cap counted only reconciled fills, and *pending* is the normal state of
every fresh lab fill; reconciliation only happens when the portfolio page is
built, which a user watching the Warmer never triggers. Measured: ground truth
−0.066 SOL, reported 0.000, run continues. Unknown is now a stop reason and
renders as an em dash, per the honest-null rule.

### The sandbox was not as sealed as advertised (`sbx-11`, `sbx-1`, P1/P2)

WebRTC was reachable inside the sandbox: a data-channel peer connection needs
no permission, is not covered by `default-src 'none'`, and never passes through
the request filter, so a STUN server address was a DNS and UDP exfiltration
channel out of a page that the test suite certified as having no network. A
control run against Google's STUN server returned a `srflx` candidate carrying
this machine's public IP — the channel was real, not theoretical.

The obvious fix does not work. CSP3's `webrtc 'block'` is unimplemented in
Electron 43's Chromium: nine host candidates gathered with the directive set,
as a meta tag or as a header. `disableBlinkFeatures` did nothing either, and
deleting `RTCPeerConnection` from the page realm is defeated by `window[0]`,
which hands back a fresh realm. What works is
`setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` on the sandbox
webContents, which is renderer-wide and so covers every realm the page can
make, plus `setProxy({ mode: 'direct' })` on the partition so a user's system
SOCKS proxy cannot become the proxied-UDP carrier that policy still allows.
Zero candidates, in the page realm and in a child iframe. The CSP directive
stays, documented as inert, for the day Chromium implements it.

Separately, the bytecode hardening step compiled the sandbox preload, and a
sandboxed preload has no Node `require`, so the bytenode stub threw on line 1
and **every code script was dead in a packaged build**. No test saw it because
the live test bundles the preload from source rather than reading the hardened
artefact.

### The 3-second watchdog could be disarmed by the page (`sbx-3`, P2)

The preload's `on` is a plain additive listener and the dispatch id travels in
the message body, so page code could register a second listener, echo a
well-formed `done`, and keep running: measured, a handler was still alive six
seconds after its call resolved `ok`. It could not trade past its walls — every
spend still goes through the budget gates — but the wall and the honest status
were gone. `unresponsive` is not usable here (Chromium's hang monitor is
input-driven and the window is hidden, so it never fires), so a `done` now
settles the caller and starts an independent liveness probe, and only the
renderer's own answer clears the deadline.

### Advanced orders over-sold a ladder (`ord-1`, `ord-3`, P1)

Two rungs of a take-profit ladder both sized off the same build-time balance
and both landed: a 40/50 ladder sold 90% where it meant to sell 70%. Orders
also carried no wallet, so disarm → switch wallet → re-arm pointed a stop at a
different wallet's position, and on a wallet that did not hold the token the
order was destroyed permanently rather than paused.

## Files

`electron/engine/automation.ts`, `advOrders.ts`, `copyTrade.ts`,
`walletSwap.ts`, `randomLab.ts`, `ledger.ts`, `engine.ts`,
`electron/system/scriptSandbox.ts`, `electron/ipc.ts`, `electron/main.ts`,
`shared/automation.ts`, `shared/scriptProtocol.ts`, `shared/orders.ts`,
`shared/copytrade.ts`, `shared/lab.ts`, `shared/fanout.ts`,
`scripts/compile-bytecode.cjs`, `scripts/harden-bytecode.mjs`,
`src/pages/Scripts.tsx`, `src/pages/Orders.tsx`, `src/pages/Wallets.tsx`,
`src/pages/lab/*`, `src/components/AutomationBar.tsx`,
`src/components/terminal/OrdersPanel.tsx`, `src/components/terminal/TradePanel.tsx`.
