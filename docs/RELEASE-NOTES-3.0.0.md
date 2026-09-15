# Krypto Bot 3.0.0

Everything a script does now says which chain it does it on, the custom layout
became a workspace you can actually live in, and two trading ideas were
measured and closed rather than carried forward as maybes.

---

## Scripts run on all three chains

Automation → Scripts was Solana in everything but name: `UserScript` had no
chain, every host call went to the Solana pipeline, and every rule field came
from the pump launch feed. Both kinds — the no-code rule builder and the
sandboxed JS — now pick a chain, and execution goes out on that rail.

**The part that matters most is a refusal.** The two EVM rails do not measure
what pump measures: 20 of the 51 rule fields have no counterpart there (the
Krypt score, risk flags, holder and creator history, smart-money counts), and
advanced orders and alerts have no EVM implementation at all. House rule 4 says
an unknown fact never satisfies a rule — so a Solana rule moved to BNB would
look armed, cost nothing, and never once fire. That is the worst failure this
feature could have, because it is invisible. It is now impossible at four
layers: the editor does not offer what the chain cannot answer, switching a
script's chain drops what no longer applies rather than carrying it over dead,
`validateScript` refuses at save with the field named, and the dispatcher
refuses again at runtime — a code script picks its action then and never saw
the first check.

Four of the nine triggers (`runner`, `tick`, `order`, `alert`) never fire on an
EVM rail and are gone from the picker there. Each chain gets its own starter
rule, built only from what its scanner measures, so the first rule a user sees
is one that can fire.

Paper works on both EVM rails: the fill is modelled from the chain's quoted
price with the same 1.5 % a side a real buy pays, and refuses rather than
inventing a price when none is known.

Code scripts get `bot.chain` and `bot.nativeSymbol` — properties, not calls,
readable before the first event. `bot.mode` is deliberately **not** exposed,
and a test asserts it stays that way: a script that behaves differently on
paper is not a rehearsal of the live one.

### Three bugs of the same class, found and fixed on the way

All three were a script acting on another chain's money:

- the paper book was keyed on the token address alone, and the same `0x…` is a
  different token on Robinhood and BNB — so closing one position deleted the
  other beside it;
- `scriptPositions` ignored chain entirely, so an EVM script's "sell
  everything" enumerated **Solana** bags;
- `wallet()` returned the Solana balance on every chain, so a rule like
  `walletSol > 1` gated a BNB trade on an unrelated number.

---

## The custom layout became a workspace

**Thirteen panels**, all on by default for a fresh install: engine, wallet,
session PnL, open positions, live launches, runner alerts, chart, observatory,
open orders, recent fills, scripts, copy trading, alerts. An existing
arrangement is untouched.

- **Pop out any panel** into its own frameless window — no title bar, the shell
  is the drag surface, close on hover or Escape. Same preload, sandbox, CSP and
  navigation guards as the main window. They reopen where you left them, and a
  remembered position is discarded if it no longer lands on a screen that
  exists.
- **A chain picker** on every chain-based panel: all / Solana / Robinhood /
  BNB, per panel, because the point of a custom layout is Solana launches next
  to BNB ones rather than one switch choosing between them.
- **Every token row opens its coin**, in the grid and from a popped-out window.
- **A chart panel** that follows whatever token you opened last — including
  across windows, so a popped-out chart tracks what you click in the main one.
- **The backdrop shows through the widgets**, which is one animated field per
  window rather than one per panel.

**Open positions was reading the wrong book.** It showed the autonomous
engine's simulated positions — empty by design on a manual-execution product —
rather than the wallet's. It now reads the real portfolio on all three chains.

---

## The Leaderboard says who you could not have copied

Measured over 9.3M curve trades across two day-pairs six weeks apart: the
median profitable pump wallet holds **six seconds**. Its edge is latency, and a
copy cannot take it — the trade is over before a follower's buy lands. Ranking
wallets by their own profit therefore surfaced precisely the wallets a user
cannot copy, and the page said nothing about it.

Wallets whose trips mostly finish inside a minute are flagged "too fast to
copy", the Hold column shows the median rather than an average that one long
position drags by orders of magnitude, and a banner appears when much of the
visible top ten is unreachable.

It is a warning, never a score. The same measurements found longer holds are
**not** more profitable to follow, so nothing here calls a slow wallet good.

---

## Farming is arithmetically possible again

The Farming page priced a round trip with guessed fees. Measured, the pool fee
is 0.30 %/side on a settled pool and ~1.20 % on a fresh one — the guess was
wrong by two orders of magnitude in the direction that makes a feature look
viable when it is not.

`FARM_FEE_BPS = 5` sits beside the ordinary fee, clamped so it can only ever
reduce. Friction is now **measured** by a two-quote probe rather than modelled,
and an unmeasured cost renders as an em dash, never a zero. At 100 SOL a round
trip on SOL/USDC a user needs a programme paying **> 0.055 %** of volume, where
before they needed > 1.01 %.

Gas inverted the design: it is fixed per transaction, so the default round trip
moved from 0.25 SOL on a memecoin — the worst configuration available on both
axes — to 10 SOL on the deepest pair.

---

## Two ideas measured and closed

Both are written up in full rather than left as maybes.

**No round-trip edge clears the cost floor.** Six setup families over the 85 GB
tape, fit on July and tested on September: zero survived. Three found real,
replicating, correctly-signed signals — order-flow imbalance lifts the 60 s win
rate 50.9 % → 87.4 % across deciles — and none is big enough. That is an
arithmetic failure, not a prediction failure.

**Blue chips fail their floor too**, and the study that was scoped as a
two-month recording project was answered in an afternoon from free history and
42 quotes. The median best exit available anywhere in the next 30 minutes —
with perfect foresight — covers 43–74 % of the round-trip cost.

Both findings point the same way: our own fee is 63–85 % of what a user has to
clear on a blue chip.

---

## Also

- Auto-sell is off by default, pinned from every direction.
- The backdrop reaches every page, and lifts at the edges without touching the
  centre where the numbers are.
- Toasts clear the top bar instead of landing on the balance and wallet.
- Renderer errors reach the app log. A crash card used to leave no trace on
  disk at all, which is what made one bug in this cycle unfindable without
  DevTools open at the moment it happened.

---

## Upgrading

`appId` is unchanged at `cc.krypt.terminal` — wallets, positions, the ledger,
orders and the paper book carry over. `TERMS_VERSION` stays `2026-09-11.1`:
nothing in this release adds an outbound host or changes what leaves the
machine, so the terms gate will not re-prompt.

Scripts saved before this release keep working and read as Solana — `chain` is
absent on them and absent means Solana, the same rule copy trading uses.

---

## Pre-release verification, 2026-09-14

Against `docs/release-checklist-v2.md` §5.

**Passed**

- `npm run typecheck` — clean on both configs (`tsconfig.node.json` covers
  `electron/`; the renderer config alone does not, which is worth knowing
  because checking with the wrong one reports clean while main-process errors
  sit there).
- `npm test` — 120 suites. The checklist's "expect 114" is stale.
- `npm run build` — 6 chunks to V8 bytecode, preloads left as plain JS,
  `bytecode target: win32 x64` so the other platforms must come from CI.
- `npx electron-builder` — exit 0, and the afterPack hook asserted all 6 `.jsc`
  are inside `app.asar`.
- Artifact: 9,859 asar entries, **0** sourcemaps, **0** forward-slash paths,
  `undici` (157) / `ws` (72) / `bytenode` (5) present, fuses applied
  (RunAsNode / inspect / NODE_OPTIONS off, asar-only on). Installer 122 MB
  against 118 MB for 1.1.0 — no `dist-electron` chunk bloat.
- Smoke boot to a **window**, `packaged=true`, on the real profile: the legacy
  folder was picked up, both EVM scanners restored their pending outcomes and
  re-verified them against the chain, taskbar identity `cc.krypt.terminal`.
- **Install over an existing profile** — confirmed by the user.
- Terms gate does not re-prompt: `TERMS_VERSION` stays `2026-09-11.1` because
  nothing in this release adds an outbound host.

**Still to run**

- Corrupt `order-templates.json` and launch — the 09-09 blocker. Not run here:
  overwriting a file in a live profile is refused by the sandbox, which is the
  right call. Steps are below.
- One small buy and sell per chain, confirming the fill reaches the ledger with
  the on-chain delta as basis.
- Arm and disarm each chain, confirming arming one leaves the others in Paper.

### The templates test, by hand

```powershell
$dir = "$env:APPDATA\Krypt Terminal"
Copy-Item "$dir\order-templates.json" "$dir\order-templates.json.bak" -Force
Set-Content "$dir\order-templates.json" '{ "version": 1, "templates": [ { "id": "x", "nam' -NoNewline
# launch the app
#   PASS: it starts, names order-templates.json in the log and on screen,
#         and the rest of the app keeps working.
#   FAIL: it will not start, or starts with the file silently replaced.
Copy-Item "$dir\order-templates.json.bak" "$dir\order-templates.json" -Force
```
