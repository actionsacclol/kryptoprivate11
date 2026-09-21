# Rewards → Guides, and the reward check on the wallet pages (2026-09-20)

Krypt's ask: change the Rewards page to a Guides page; move the reward
check button to the wallet section for BNB and Robinhood; give Guides a
simple guide for each section of the Hub.

## What moved

- The Rewards workspace and page are gone (`src/pages/Rewards.tsx`
  deleted; workspace id `rewards` → `guides`, route `rewards` →
  `guides`, nav label `nav.rewardPools` → `nav.guides` in all eight
  languages, Hub icon gift → book).
- The reward check — "Check my rewards", which asks Merkl what this wallet
  earned in reward campaigns on the chain, and only when pressed — is now
  `src/components/terminal/WalletRewards.tsx`, mounted under the panel on
  the Robinhood and BNB wallet pages (`EvmWalletPage`). A "Show reward
  pools" button folds the chain's live campaign table (APR, the diluted
  "with yours" column, rewards per day, TVL, ends) into the same card, so
  nothing the old page showed is lost. Every rule the old page kept still
  holds: no third-party link ever rendered, unknown is an em dash and never
  zero, nothing sent until the button.
- The privacy policy's Merkl line now says "the Robinhood Chain and BNB
  wallet pages" instead of "the Rewards page". Same host, same trigger, so
  no terms bump.

## The Guides page

`src/pages/Guides.tsx`: a "Start here" guide (make a wallet, fund it a
little, open a coin, buy small, sell to get out), then one guide per Hub
tile, keyed by workspace id — Terminal, Automation, Main Engine, Wallet
Utilities, Guides, Wallet Scout, Launch a Token, My Layout, Settings &
Legal. Each has three parts: **what it is** (one or two short sentences),
**Do this** (numbered steps, one action each), **Careful** (what loses
money or keys). Written for someone who has never used a trading app: short
sentences, no unexplained jargon, a dash is "the app does not know", Paper
is practice and Live is real money. A left list jumps to each section and
follows the scroll. The detailed guides (fees, exits, sandwiching, privacy,
the video) stay below as "More detail" — the existing `GuidePanel`.

## Pins

`test/workspaces.test.mjs`: the Guides workspace exists and Rewards does
not; Guides.tsx has a guide for EVERY workspace id (a tile added without a
guide fails); every step stays under 170 characters; the EVM wallet page
mounts WalletRewards; Rewards.tsx is gone; the reward block renders no link
and sends the address only from the button; the privacy policy names the
wallet pages.
