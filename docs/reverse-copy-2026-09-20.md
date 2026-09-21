# Reverse copying (2026-09-20)

## What it is

A copy config now has a **direction**: `copy` (buy when they buy, mirror
their sells — everything that existed) or `reverse`:

- their **SELL** is our entry — sized, filtered, delayed and staleness-
  checked exactly like a copied buy, and recorded the same way;
- their **BUY** of the same coin is our exit — a 100 % mirrored sell, the
  thesis being wrong;
- and because a leader rarely buys the same coin back, a reverse position
  closes on its own **take-profit** (default +25 %), **stop-loss** (−20 %)
  or **max hold** (30 min), judged on every price tick the engine already
  delivers to `markToMarket` (the tape for taped mints, the 12 s orders
  poll for the rest).

It is the contrarian read of the followability finding
(`wallet-convergence-2026-09-14.md`): leaders' edge is latency and their
exits come early; fading an exit is a bet that the coin keeps going after
they leave. Nothing has measured that bet. So it starts on paper, switched
off, like everything else, and the UI says it is a bet in every place it
appears.

## Where it lives

- `shared/copytrade.ts`: `CopyDirection`, `direction?` on the config and
  on each row, `exitTakeProfitPct` / `exitStopLossPct` / `exitMaxHoldMin`
  (absent = the defaults on a reverse, never "off"; renamed from
  `reverse*` the same day when FOMO copying made them every direction's,
  see `fomo-copy-2026-09-20.md`), `directionOf`, `ownExitsOf` (was
  `reverseExitOf`), validation bounds (1–1000 %, 1–95 %, 1–1440 min,
  binding on every direction), `describeConfig` wording,
  `defaultConfig(wallet, label, chain, direction)`.
- `electron/engine/copyTrade.ts`: `onWalletTrade` branches per config
  direction; the entry reuses `evaluateBuy` with the sell re-labelled as a
  buy signal (their proceeds size a proportional copy); the buy-back exit
  and the three own exits are SYNTHETIC `WalletTrade`s carrying a `note`
  that becomes the exit slice's reason; `checkOwnExits` (was
  `checkReverseExits`) runs inside `markToMarket` with a per-config/mint
  in-flight guard so a second tick cannot fire it twice; `queueExit` returns its chain. Wording that said
  "sold" for the cancelling leg now says "bought back" on a reverse.
- `electron/ipc.ts` `copy:save` carries the four new fields (the IPC
  contract test pins that every `CopyConfig` field is read there).
- `src/pages/Wallets.tsx`: a Direction control in the editor with the
  three exit fields under it, "Copy their sells" relabelled "Exit when
  they buy back" on a reverse, an amber `reverse` badge on the card, and
  the live-arm confirmation naming the sell as the trigger and the bet.
- Scout drawer: "Reverse on paper" beside "Follow on paper".
- Guides: one line in plain words.

## Rules kept from the copier

Paused configs neither enter nor exit (a paused copy holds through a
leader's sell too). A paper reverse pays both sides of both fees. Live
entries refuse over the cap, refuse when the leader bought back before the
buy went out, and toast "Reversed …" rather than "Copied …". The exit
goes through the same mirrored-sell pipeline, so the quantity, settlement
and leftover-sweep rules apply unchanged.

## Verified

`test/copytrade.test.mjs` 127/127 (+7): their sell opens at the price
after the delay and their buy alone opens nothing; the same sell delivered
twice opens once; their buy-back closes in full with the reason on the
slice and the PnL net of both sides; take-profit at +26 % not +24 %,
stop-loss at a configured −10 %, max hold at 31 not 29 minutes, none
firing twice; a paused config holds; live entries buy through the host and
live exits sell 100 % through it; validation, defaults, description.
`test/ipccontract.test.mjs` 21/21. Both typechecks clean.

## Not built

- A reverse figure on the Copy score. The Scout's follower model could
  measure "enter at the first print after their sell, out at +25/−20/30
  min" from the same prints; the copier ships first, the measurement can
  follow once there is a reason to trust the exits.
- Reverse on the leader's *partial* sells: any sell of the mint is an entry
  signal, sized by what they sold for. A "only on full exits" switch is a
  small follow-up if wanted.
