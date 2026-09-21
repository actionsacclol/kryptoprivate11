# Copy Simple (2026-09-20)

## What it is

A second way into copy trading, beside the full page, for someone who
wants to follow a wallet without reading twenty-nine fields. The user
asked for exactly this shape: "copy simple … a really easy way to copy,
then copy trading main is super advanced".

The page asks three things and has one button:

- **Whose wallet.** Paste an address. Its shape picks the chain: base58
  is Solana, `0x` is an EVM wallet and shows two pills, Robinhood Chain
  or BNB Smart Chain, defaulting to the top bar's chain when that is one
  of them. Anything else is refused in plain words. A line under the box
  points to the Wallet Scout, which ranks wallets by Copy score.
- **How much per trade.** Four sizes (0.05 / 0.1 / 0.25 / 0.5) or a
  number, in the chain's native coin, up to 5 per trade; more needs the
  full page.
- **Follow on paper.** The only button. A sentence above it says what
  will happen in words: spend X each time they buy, mirror their sells,
  stop for the day after losing 10X.

Below it, "Your follows" lists every config with its record (realised
PnL, trades, win rate, open count), a Paper | Live switch, a Following |
Paused toggle, Edit (opens Copy Trading) and Remove.

## How it stays honest

- **Paper is the only first button.** The research in this repo says
  following leaders loses money on average, and the page says so in one
  sentence. Live is a switch on the card, it disarms on the way over, and
  arming runs the same confirmation text as the full page.
- **Same config, same store, same engine.** `simpleConfig(wallet, label,
  chain, perTrade)` in `shared/copytrade.ts` derives the whole config from
  the three answers: fixed sizing, cap equal to the size, daily loss
  limit of ten trades, paper, switched on, everything else
  `defaultConfig`. It is saved through `copy:save` like any other, so
  the full page shows it and can change anything about it.
- **No new model.** A follow made here and one made on Copy Trading are
  the same row.

## Where it lives

- `shared/copytrade.ts`: `SIMPLE_SIZES`, `SIMPLE_MAX_SOL`,
  `SIMPLE_LOSS_MULTIPLE`, `chainForAddress`, `simpleConfig`.
- `src/pages/CopySimple.tsx`: the page; props `onOpenAdvanced` and
  `onOpenScout` from the app shell, since pages navigate through props.
- The four route touches: `RouteId` + row in `Sidebar.tsx` (listed
  before Copy Trading, whose hint now says "every control"),
  `routeLoaders.ts`, `App.tsx`, and `workspaces.ts` where Copy Simple is
  the first route of Automation and so its landing page.
- Guides: two lines, Copy Simple first.

## Verified

`test/copytrade.test.mjs` 138/138 (+2): the address shape picks the
chain and nothing else passes; every offered size makes a valid, paper,
switched-on config with the cap equal to the size and ten trades of
daily loss; clamps (40 → 5, NaN and negatives → 0.1, 0.0001 → 0.001)
still validate; every unasked field is the default.
`test/copysimple.test.mjs`: the four route touches, Automation lands on
it, the page saves through the shared derivation and `copy:save`, never
constructs a live config, disarms on the live switch, and runs the same
arm confirmation. `test/workspaces.test.mjs` 16/16.
`test/copysimple.e2e.mjs` (`npm run test:copysimple:e2e`) against the
dev app: Automation lands on Copy Simple, the sidebar order, the button
disabled until an address is valid, Solana recognised, the derived
sentence moves with the size, a 0x address shows the two chain pills;
the box is cleared and nothing is saved.

## Not built

- A "pick from the Scout" picker inside the page. The Scout already has
  "Follow on paper" per wallet, and the page links to it.
- Reverse and FOMO on the simple page. Both are bets the full page warns
  about, and a beginner should meet a plain copy first.
