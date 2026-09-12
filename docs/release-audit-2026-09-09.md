# Final release audit — 2026-09-09

Seven auditors over everything new since the 09-03 release audit: 208 changed
files, ~40 new modules, two new chains, a scripting sandbox, a new layout.

**18 P1s. One of them bricks the app permanently.** The build is otherwise
healthy — typecheck clean, `npm run build` exit 0, **94 suites pass in 179 s** —
and the defects are, almost without exception, things the type system and the
suites structurally cannot see.

The findings cluster into six themes. That clustering is the useful output: the
same mistake was made repeatedly in different modules, so the fixes are patterns
rather than patches.

---

## Theme 1 — Fail-open persistence (the release blocker lives here)

The house rule is *loading persisted state fails CLOSED — an unreadable file is
not an empty one*. Five modules had this bug in August; `ledger.ts` is the shape
to copy. It is back, in new code.

**P1 · `templateStore.ts:59` — a corrupt `order-templates.json` makes the app
unopenable, permanently.**

```ts
try { text = fs.readFileSync(filePath, 'utf8'); }
catch (e) { … cache = empty(); return; }

const parsed = parse(JSON.parse(text || '{}'));   // ← outside the try
```

The try wraps only the read. A malformed body throws a SyntaxError; `init()`
runs at `main.ts:407` inside `bootstrap()`; `main.ts:263` is
`app.whenReady().then(bootstrap)` with **no `.catch`**; `showMainWindow()` is
149 lines later. crashGuard sees `windowUp() === false` and calls
`app.exit(1)`. The error box says `Unexpected end of JSON input` and does not
name the file. Every relaunch repeats it.

**A user holding a live position cannot open the app to sell.** New since 09-03
(commit `a898fb5`). The fail-closed design is already there and correct —
`loadFailure` is set, built-ins keep working, `persist()` refuses to overwrite a
file it could not read. One line is out of reach of the try.

**P1 · `paperBook.ts:28-35`** — catch-all → empty book, no `failure()`, then an
unconditional `save()`. Against the real file: 2 open + 9 closed trades and
`realized = -0.389965599` become `0/0/0`, and the next paper buy rewrites
5538 B down to 449 B. Breaks fail-closed *and* honest-null — it manufactures a
hard zero in main, before the renderer could render a dash.

**P1 · `walletStore.ts:99-117`** — if *every* record fails `parseWallet`,
`parseFile` returns a valid empty file with no `loadFailure`, and the store
stays writable, so `generate()` overwrites the ciphertext. Narrow trigger,
unrecoverable outcome. Every other bad shape fails closed correctly, including
`version: 3` from a future build.

**P2 · same bug, smaller blast radius:** `alerts.json` (3 alerts destroyed,
proven); `watchlist.json` — worse, it overwrites with a hardcoded seed *inside
`init()`*; `helius-credits.json` silently resets the credit meter to 0 and
restarts the month; `randomLab.start()` has no `loadFailure` guard, so it spends
real SOL on bags it has already decided it cannot record; and
`programWatch.loadBaselines` fails open — an unreadable baseline silently
re-records and the redeploy watchdog goes quiet.

## Theme 2 — Exits that can be blocked, or sized wrong

*A fee, limit or breaker must never block an exit.* Ten findings violate it.

**Solana (P1):**
- A sell has **no receipt check**, so a diverted-proceeds sell passes every gate.
- **The `Transfer` destination is decoded and never checked** (`signPolicy.ts:467`).
  On a sell of the traded mint, a top-level `Transfer` of the whole bag passes to
  *any* destination. The source is checked; the comment says so; the destination
  is used only in refusal strings.
- The **0.02 SOL relayer-fee cap refuses any relayer-built exit above ~4 SOL**,
  and the "the local builder handles larger" justification is false for
  graduated tokens.
- **Three of four sell paths ignore the exit budget** the 09-05 stranding fix
  added.
- The **sell loss bound (0.01 SOL) is smaller than the 0.01501 SOL the app
  itself may spend on a sell.**
- Fan-out buys never reach the ledger and skip the exit reserve.

**Scripting (P1/P2):** a script's `sell 100%` empties the **whole wallet bag**,
not its own slice (`automation.ts:833` guards the mint, never the size, though
`rt.opened` carries `costSol` and `copyTrade.ts:817 walletPctFor` already
solves exactly this). And the daily loss cap blocks the script's own exits.

**EVM (P2 ×5, none firing today, each one config change away):** four.meme's
in-tx fee leg reverts the whole sell if the recipient is non-payable and the
code refuses rather than retrying fee-free (safe only because the treasury is an
EOA); the 1.5M gas and 50 gwei ceilings refuse sells — **Robinhood's gas subsidy
ends 2026-09-29**; venue is chosen by a **0.001-native buy probe** then used for
a sell of any size, and `EvmTradePanel.tsx:115-124` greys out the Sell button
with no override; turning a chain off in Settings refuses sells and hides the
positions.

## Theme 3 — The program allowlist inspects nothing

`signPolicy.ts:272` runs the ownATA-writable check **only for programs not on
the list**. An allowlisted program gets zero inspection: no discriminator, no
accounts, no writability. All 19 pass while holding our traded-mint ATA, our
WSOL ATA and a stranger's account writable.

Verified against two real mainnet pump `create_v2` transactions: refused only on
`needs 2 signers`; with the count forced to 1, **`ok: true`**. The signature
count is the only gate, and it is a coincidence of how launchpads mint.

Reachable, unintended and unchecked today: Jupiter v6's arbitrary
`destinationTokenAccount`; LP deposits and position-NFT mints on four venues
(value leaves as tokens, so the SOL-only loss guard sees nothing); creator-fee
reassignment on DBC and pump (zero lamports move); and via `TOK_HARMLESS`,
`MintTo` and `FreezeAccount`, whose "an authority that is not us" parentheticals
are assumptions.

**This is the instruction-discriminator rule, and it is no longer a
launcher-enabling nicety — it is the hole under the current build.**

## Theme 4 — A 200 with a missing field becomes a PASS

The "polite refusal" class from 09-09, still live in security-facing code.

- **P1 · Jupiter Shield says "Sellable — PASS" for every mint** when a 200 lacks
  a `warnings` key (`jupiter.ts:364` falls back to `{}`). Cached per mint.
- **P1 · RugCheck's insider-network gate scores PASS from an empty body**
  (`rugcheck.ts:130` → `[]`, not `null`), cached 5 min, rendered as "No transfer
  clusters detected among holders", sourced `rugcheck`, weight 10.
- **P2 · still open in `rpcClient.getTransactions`** (`:1014`): returns
  `ok:true, data:[null,null]`, does not park, and Helius is billed.

## Theme 5 — Wrong numbers presented as fact

- **P1 · Every Meteora DBC swap is taped twice.** `dbcDecoder.ts:166` and
  `:204` both emit `kind: 'dbc_swap'` (from `EvtSwap` and `EvtSwap2`), Meteora
  emits both per swap, and the watcher calls `onTick` for each. **Volume, trade
  counts and candles are exactly 2× on every DBC token.** Proven on four live
  transactions.
- **P1 · A non-SOL-quoted pool prices the live tape in the wrong currency.**
  `market.ts:2123/2126` hands the LaunchLab and DBC watchers DexScreener's
  highest-volume pair with no quote-mint check; both divide by 1e9. Feeds the
  chart, `rememberPrice` and `advOrders.onTick`. The app guards this exact trap
  in three other places (`dexscreener.ts:146`, `isSolQuoted`) and not here.
- **P1 · `Hub.tsx:62`** counts `positions.length` raw while `Positions.tsx:289`
  and `Dashboard.tsx:109` filter `state !== 'closed'`. The engine emits a closed
  `positionUpdate` on every close and the provider keeps the row, so "N open
  positions" grows all session. It is also the engine's *paper* book on the
  manual-trading card.
- **P2 · `Hub.tsx:45`** guards `copy.list()` with `Array.isArray`, but
  `ipc.ts:1778` returns a `CopySnapshot` **object**. Always false, so the card
  shows an em dash forever — the honest-null contract inverted: the dash means
  "read fine, guarded wrong".
- **P2 · `EvmPortfolioCard.tsx:85`** dashes "Gas + fees paid" only when *both*
  are null, so a known gas plus an unknown fee prints a definite total with the
  unknown counted as zero.
- **P2 · `engine.ts:2167`** renders `costSol` as **0**, not unknown, for a live
  position with no ledger basis.
- **P2 · `getBalance` reports 0 lamports** for an unreadable result.

## Theme 6 — Script budgets, and the packaged artifact

**P1 · `bot.order()`'s migration kinds bypass the per-script lock**
(`automation.ts:1246-1261`) — the `walls-1` race on the one path the fix did not
cover. Measured: **36 `buy_on_migration` orders armed, 1.80 SOL committed**
against a budget of 1 buy/day and 0.05 SOL. `bot.buy` on the same budget
correctly executed once.

**P1 · A paper script's `opened` set authorises live sells after a mode flip.**
Paper→live disarms but does not clear `opened`, so a script that only rehearsed
on paper can market-sell a real hand-bought bag on its first live action.

**P2 ·** orders a script armed survive the kill switch, the loss cap and
deletion (`NewOrderRequest` carries no `scriptId`), so "every script is off" is
false.

**P1 · An installer can ship with zero bytecode and nothing catches it.**
`release/Krypto Bot-Setup-1.1.0.exe` contains only nine `.js` files, six of them
71–77-byte bytenode stubs, and **zero `.jsc`** — an app with no main process.
Root cause reproduced: a concurrent `npm run build` (another auditor in the
shared tree) rewrote the `.jsc` mid-package. *That* part is an artefact of
running seven agents in one tree. The defect is that **electron-builder exited 0
and shipped a 113 MiB broken installer**: `apply-fuses.cjs` asserts the bytecode
*platform* and never its *presence*. Fix: an afterPack asar check — every stub
`X.js` must have an `X.jsc` > 1 KB.

---

## What is clean — the negative space matters for a release decision

**The script sandbox is airtight, and this is the strongest result in the
audit.** A local HTTP listener took **zero hits** from fetch, no-cors fetch,
XHR, `sendBeacon`, `<img>`, `<script src>`, `<iframe src>`, form submit,
EventSource, WebSocket, dns-prefetch/preconnect/prefetch/preload, CSS `@import`,
dynamic `import()`, remote and blob Workers, service workers, WebTransport,
`window.open`, anchor click and `location.href` — including the **`window[0]`
iframe-realm trick that beat the WebRTC CSP**. A Chromium net-log proved **zero
DNS resolutions** for the probe hostnames, closing the DNS-only channel.
`require`, `process`, `SharedArrayBuffer`, clipboard, localStorage, cookies and
mediaDevices are all unreachable.

**No decoder is drifting.** All five Solana rails verified against live mainnet:
pump TradeEvent, pAMM 465/417 B, LaunchLab 147 B, Boop 128 B, DBC 154/179 B —
every layout matches exactly.

**The graduated-Pons v4 sell path works** — the one
`docs/robinhood-chain-2026-09-08.md` records as never simulated. The app's own
`buildV4Sell` calldata, treasury fee leg included, against 4 live pools with
Permit2 storage overrides: **4/4 OK, 185,849–191,321 gas.**

**Treasury `0xDCBad4…483a` is verified** and the docs' "unverified on chain" is
stale: blob decodes, SHA-256 matches, EIP-55 valid, plain EOA on all four
chains, and **nonce 3 on Ethereum mainnet proves someone holds the key**.

**Prior fixes re-proved on chain:** the 1e9 quantum (every unfloored amount
reverts `GW`, every floored one succeeds, including 100%); the creator buy tax
(**4 of 8 live BNB curves still shortfall 0.98–2.88% vs `tryBuy`** — the fix is
doing real work); dust-pair routing (venue follows the quote now); publicnode
serving no receipts (403 confirmed).

**Terms acceptance cannot lock a user out** — the gate never compares stored
hashes, so they are evidence rather than enforcement.

**Settings validation is clean** — the whole `DEFAULT_SETTINGS` and all 22
blocks pass individually, all four 09-08 traps closed, and real settings from
revisions 2, 4 and 5 upgrade with zero unintended loss.

**`test-steps.json` integrity is proven**, in a clean room: all 119 generated
bundles and `test/.sandbox/` deleted, rebuilt from steps only, **94/94, same
count**. 94 steps ↔ 94 test files, no orphans either way. The stale-bundle
failure mode cannot recur.

**Secret sweep clean**: 0 hits for the user's email in source, docs, `dist`,
`dist-electron` or `win-unpacked`; no API keys, bot tokens, private keys or
tokenised RPC URLs in source or built output.

**Approvals are clean**: 13 crafted calldatas through the real EVM policy — the
zero-approval exception cannot grant a non-zero allowance to anyone.

**Also verified holding:** every `http.ts` park fix, `refusals.ts`, the
`PUBLIC_SUB_CAP` correction, `onchain.ts checked:true`, `merkl.ts`'s
`MerklAnswer` contract at every call site, no URL over IPC, `acceptCurrent`
being called with `hardPauseReason` cleared, the two program allowlists
(21 entries each, symmetric difference empty), no cross-chain bleed across the
three wallet tabs, and no value import from `electron/` in the renderer.

A *non*-finding worth recording: simulation **does** charge priority fees
(0 / 1.4M / 1.4B lamport deltas at 0 / 1e6 / 1e9 µL per CU), so ComputeBudget is
not a blind drain.

---

## Fix order

**Tier 1 — before anything ships.** `templateStore` (one line, and it bricks the
app); `paperBook` and `walletStore` fail-open; the script whole-bag sell; the
`bot.order()` budget bypass; the paper→live `opened` carry-over; the afterPack
`.jsc` presence assert.

**Tier 2 — the honest-intel defects, because this product is sold on them.** The
DBC double-tape; Jupiter Shield and RugCheck passing on absence; the
wrong-quote-currency tape; the Hub count and the `copy.list` guard.

**Tier 3 — exits.** The `Transfer` destination check; the sell receipt check;
the relayer-fee cap; the three sell paths ignoring the exit budget; the sell
loss bound; EVM P2-1/2/3.

**Tier 4 — the allowlist.** The instruction-discriminator rule. No longer
optional: it is what closes Theme 3.

**Housekeeping:** `mints.json`, `v4mod.json`, `recover.tmp.json`,
`test/.sandbox/` and `contracts/build/` are all un-gitignored — a `git add -A`
commits them (contents checked: public chain data, no secrets). The ~40 new test
files and `test-steps.json` are uncommitted, so **CI has never run the EVM,
sandbox or automation suites**. And `react-grid-layout` is a dead dependency
whose only importer is the uncalled `PanelGrid.tsx`; it ships a Mach-O arm64
binary (`ip_fetcher`, source curls `ifconfig.me`) into `app.asar.unpacked` —
never executed, unreachable on Windows, and it should not be on users' disks.

**A product decision, not a code fix:** the Warmer is not a wash-trading engine
— it never takes both sides of a fill, and every leg hits a public pool — but
its only product is economically purposeless activity across wallets one person
controls, it inflates the exact metrics this app sells as honest intel,
`fanout.ts` documents concealing operator attribution as a feature, and the app
never says what warming is *for*. ToS §5 and §12 both prohibit market
manipulation.

---

## Fixed on 2026-09-09 (Tiers 1 and 2)

Verified after every change: **typecheck clean, 95 suites pass** (was 94),
`npm run build` exit 0.

**Tier 1 — the release blockers.**

| Fix | Where |
| --- | --- |
| `JSON.parse` moved inside the try; unreadable and unparseable are one event | `templateStore.ts` |
| A `.catch` on bootstrap that NAMES the failing step instead of exiting silently | `main.ts` (`bootstrapFailed`) |
| `loadFailure` + a `failure()` reader; `save()` refuses; a paper BUY is refused while the book is unreadable, a sell is not | `paperBook.ts` |
| A file that listed wallets and yielded none now fails closed | `walletStore.ts` |
| A script's sell is scaled to its share of the cost basis, floored at 1% so an exit is never blocked | `automation.ts sellOne` |
| `bot.order()`'s direct-place path moved onto the per-script chain | `automation.ts` (`chain`) |
| `opened` is cleared on any mode change, in both directions | `automation.ts upsert` |
| afterPack asserts every built `.jsc` is present in `app.asar` | `apply-fuses.cjs` |

The packaging assert was proven both ways: it accepts the good artefact
(6 `.jsc` present) and rejects a synthetic asar missing them. The budget race
was proven by making `chain` a passthrough — **12 orders armed, versus 1 with
it**.

**Tier 2 — the honest-intel defects.**

| Fix | Where |
| --- | --- |
| `EvtSwap`/`EvtSwap2` tagged with a `variant`; `dedupeSwaps` gives one tick per swap | `dbcDecoder.ts`, `dbcWatcher.ts` |
| A 200 with no `warnings` key is unknown, not "Sellable — PASS" | `providers/jupiter.ts` |
| A body that is neither an array nor `{networks}` is unknown, not a weight-10 pass | `providers/rugcheck.ts` |
| `TokenPool.quoteMint` + `poolQuoteMint` plumbed through; a non-SOL pool gets no tape rather than a tape priced in the wrong currency | `shared/market.ts`, `dexscreener.ts`, `data/market.ts` |
| Open positions filtered on `state !== 'closed'` | `Hub.tsx` |
| `copy.list()` read as a `CopySnapshot`, so the card can show a count at all | `Hub.tsx` |
| A route already listed in the current workspace no longer teleports you out of it — `extraRoutes` works as designed | `App.tsx` |
| "Gas + fees paid" dashes when EITHER half is unknown | `EvmPortfolioCard.tsx` |

**New tests.** `test/failclosed.test.mjs` (8 assertions, a new suite) pins the
fail-closed rule across all three stores. Four added to
`test/automation.test.mjs` for the sell share, the rounding floor, the mode
flip and the order race. Two added to `test/dbcdecoder.test.mjs` for the
variant tag and the dedupe.

**Housekeeping done:** `mints.json`, `v4mod.json`, `recover.tmp.json`,
`test/.sandbox/` and `contracts/build/` are now gitignored.

### Tier 3 — exits (2026-09-10)

| Fix | Where |
| --- | --- |
| A sell's `Transfer` destination must be an account a VENUE in the same transaction touches (or one of ours). Infrastructure programs — Token, ATA, System, ComputeBudget, Memo — are excluded from that evidence, or a Transfer would vouch for itself | `signPolicy.ts` |
| The loss bound now includes the tips we injected, so a max Jito tip on an exit no longer trips the guard | `liveSigner.ts` |
| The relayer sell fee cap scales with the caller's proceeds estimate, floored at the old flat 0.02 SOL — a bigger exit is no longer refused by its own fee cap | `liveSigner.ts` |
| `exitParams` takes the balance that will actually pay, and both unbudgeted sell paths use it — sell-all on the active wallet, `labSell` on the lab wallet's own balance | `engine.ts` |
| A sell is bounded by total gas COST (`gas × maxFeePerGas`, 0.02 native) rather than by two independent ceilings that refused exits when the network got expensive. Buys keep the tight ceilings | `evm/policy.ts`, `evm/trade.ts` |
| A four.meme sell whose in-tx fee leg reverts is retried fee-free instead of refused — the Solana interlock's rule, applied on BNB | `evm/trade.ts` |
| `untradable` (a verdict from a 0.001-native BUY probe) no longer greys out the Sell button; it shows as a warning | `EvmTradePanel.tsx` |

The signPolicy fix found a trap worth recording: **`KNOWN_TRADE_PROGRAMS` is
not a list of venues.** It also contains Token, ATA, System, ComputeBudget and
Memo, so the first version of the destination check could never fire — the
Transfer's own instruction added its own destination to the evidence set. Proven
by probe before and after.

**Tests added:** two in `walletpolicy.test.mjs` (the venue-touched rule, and
that a lone Transfer cannot be its own evidence), two in `evmpolicy.test.mjs`
(the gas-cost bound, and that buys keep the tight ceilings).

### Tier 3 completion and Tier 4 (2026-09-10)

| Fix | Where |
| --- | --- |
| **The sell receipt check.** The loss guard bounds what we SPEND, so a sell whose proceeds were routed elsewhere spent only the fees and passed. When the caller's proceeds estimate is ≥ 0.02 SOL, the wallet's simulated balance must RISE. Dust, an unknown estimate and a worthless token are below the floor and untested — a sell yielding nothing is exactly the exit that must proceed | `liveSigner.ts` |
| Fan-out buys reach the ledger. They were invisible to cost basis, realised PnL, trade history and the live loss breakers — and the exit reserve is computed from the ledger, so an unrecorded fan-out could spend the SOL its own exits relied on | `engine.ts` |
| **MintTo and FreezeAccount are refused at top level.** They sat in `TOK_HARMLESS` excused as "needs an authority that is not us" — but a top-level Token instruction's authority must SIGN, and a second signer is already refused, so the only reachable version is the one where WE are the authority. `ThawAccount` stays: on a default-frozen mint whose freeze authority is ours, thawing is what makes a sell possible | `signPolicy.ts` |
| **Routing venues cannot be called directly on a buy.** Raydium CLMM, Orca Whirlpool and Meteora DLMM are allowlisted because Jupiter routes *through* them; a top-level call is the shape an LP deposit takes. Measured 0 of 25 real routes at top level. Buys refuse, **sells warn and sign** | `signPolicy.ts` |
| `react-grid-layout` moved to devDependencies, where every other renderer-only package already lives. It stops shipping — including the Mach-O arm64 `ip_fetcher` binary it carries into `app.asar.unpacked`. `PanelGrid.tsx` is kept: it is untracked, unwired, and the multi-panel work it belongs to is not finished | `package.json` |

**On the discriminator rule as originally specified:** enumerating pump's
legitimate trade discriminators is *not* safe. `txBuilder.ts` documents four
concurrent buy variants measured in one sampling window, pump ships breaking
changes quarterly, and the template learner discovers variants dynamically — a
static list would break buys within a quarter. The two rules above take the
same ground the rule was aimed at (a `create`, an LP deposit, a mint, a freeze
dressed as a trade) using facts that do not rot.

**Tests added:** two in `walletpolicy.test.mjs` — MintTo/FreezeAccount refused
with ThawAccount still signing, and routing venues refused on a buy while never
blocking a sell.

**Still open:** committing the new tests so CI runs them, and the Warmer
product decision.

---

Raw reports: `scratchpad/release/{evm,scripting,solana,ui,data,persistence,build}.md`
