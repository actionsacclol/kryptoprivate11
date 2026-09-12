# Testing the BNB and Robinhood Chain rails

Three tiers. **Tier 0 and 1 cost nothing and need no funds** — that is most of
the coverage. Only tier 2 spends money, and it exists to test the two things
simulation cannot: a real broadcast and a real receipt.

---

## The safety property that makes tier 0 and 1 free

`electron/evm/rail.ts:291` and `:298`:

```ts
const sim = simulateOnly || !live[chain].armed;
```

**A disarmed chain simulates every trade.** There is no path from a disarmed
rail to a broadcast. The IPC layer defaults the same way — `ipc.ts:916` passes
`simulateOnly !== false`, so an omitted argument means simulate.

And `trade.ts:249` + `:736` override the wallet balance on a simulated buy:

```ts
const override = owner === null || req.simulateOnly;
```

So **a simulated buy works on an empty wallet.** You can exercise the whole
quote → plan → policy → gas → simulate path on both chains with zero balance.

Arming is per chain (`rail.ts:76`) and requires the chain enabled in Settings
plus an EVM wallet to exist. Arming BNB leaves Robinhood in paper.

---

## Tier 0 — automated, ~2 minutes, no wallet, no funds

```
npm test                 # full suite, includes the offline evm*.test.mjs units
npm run test:evm         # LIVE smoke against both chains
```

`npm run test:evm` bundles `electron/evm/rail.ts` and runs
`test/evmrail.live.mjs`. It makes a temp userData dir, generates a throwaway
wallet, hits the real chains read-only, and asserts shape rather than values.

To run one chain (bundle first, then pass the name):

```
npm run test:evm                        # bundles + runs both
node test/evmrail.live.mjs bnb
node test/evmrail.live.mjs robinhood
```

**What it already proves**, so you don't retest it by hand:

| Assertion | Line |
| --- | --- |
| Discover's New column has rows, all tagged with the right chain | 65–66 |
| Graduating is sorted by curve progress | 68 |
| Curve venue resolves (`pons-curve` / `fourmeme-curve`) | 75 |
| A graduated-pool quote returns a non-zero amount from the right venue | 89 |
| A simulated curve buy simulates and reports `stage === 'simulate'` | 101 |
| An empty-wallet sell is **refused honestly** ("Nothing to sell") | 104 |
| **A LIVE buy while disarmed never broadcasts** | 105–106 |
| Arming BNB leaves Robinhood in Paper | 185 |
| Switching wallets is refused while a chain is armed | 187 |
| A funded Pons curve sell **plans correctly for a real on-chain holder** — approval ordering included, simulated from that holder's state, nothing signed | 158–166 |

That last one is the important one: it proves the exit path against a real
funded position without you needing a funded position.

Known-good fixtures it uses: `CASHCAT` `0x020bfC65…18b4` on Robinhood,
`CAKE` `0x0E09FaBB…cE82` on BNB.

---

## Tier 1 — in the app, disarmed, still $0

Leave both chains in **Paper**. Nothing can broadcast.

1. **Switch chain** in the top bar. Confirm the whole app follows — Discover,
   Portfolio, the wallet tab, the native symbol (ETH vs BNB).
2. **Create a wallet** on each chain tab (Robinhood Wallet / BNB Wallet).
   Confirm each tab shows only its own chain's address and balance, and that
   nothing bleeds across a chain switch. This is where a stale cache key would
   show up.
3. **Discover → open a token** on each chain. Check one curve token and one
   graduated token per chain. Watch for: curve %, price, market cap, liquidity,
   age. **Anything unknown must render as an em dash, never 0.**
4. **Buy, disarmed.** It will simulate and tell you so. Read the quote, the
   venue, the gas, the fee line. Do this with an empty wallet — the balance
   override makes it work.
5. **Sell, disarmed.** With no position it must refuse with a plain message,
   not a zero.
6. **Pull the network.** Turn off wi-fi and revisit each screen. Every number
   should go to an em dash and nothing should render 0 or throw.

---

## Tier 2 — armed, real money

This is the only tier that tests a broadcast, a receipt, a confirmed fill, and
the on-chain PnL basis. Keep it small — the point is that it works, not how
much it makes.

**Funding.** BNB is a standard chain: withdraw BNB from any exchange to your
address. **Robinhood Chain (4663) is the one to confirm yourself** — the app
does not bridge, and I have not verified the deposit route, so don't take a
number from me here. Native currency is ETH, RPC
`https://rpc.mainnet.chain.robinhood.com`, explorer
`https://robinhoodchain.blockscout.com`.

Suggested amounts: enough for ~3 round trips plus gas. Blocks are 100 ms on
Robinhood and 450 ms on BNB, so confirmation is fast on both.

**The sequence, per chain:**

1. Enable the chain in Settings, create/select the wallet, **Arm**. The log
   line should name the chain and the address explicitly.
2. Buy the smallest amount the venue accepts on a **curve** token.
3. Verify the position appears, and that its cost basis is the **on-chain
   delta**, not what you asked to spend.
4. Sell 100%. Sells are given `Math.max(slippagePct, 15)` (`rail.ts:301`) so a
   thin curve cannot block the exit.
5. Check the ledger row, the fee, and the realised PnL against the explorer.
6. Repeat on a **graduated** token (Uniswap v3 on Robinhood, PancakeSwap on
   BNB) — it is a different code path from the curve.
7. **Disarm.** Confirm it returns to Paper and says so.

---

## What to watch for specifically — the bugs prior audits already found here

These were fixed; tier 2 is where you'd notice a regression.

**BNB** (`docs/bnb-audit-2026-09-09.md`):
- **Dust-pair routing that actually filled** — a near-empty v2 pair winning the
  venue probe. Check the venue chosen on a graduated token looks sane.
- **publicnode serves no receipts at any depth.** If a fill says "not
  confirmed" but the explorer shows it landed, that is this.
- **A hidden creator buy tax** on four.meme tokens — compare tokens received
  against the quote.
- **four.meme's 1e9 sell quantum** — sell a non-round amount and confirm the
  remainder is handled, not silently dropped.

**Robinhood** (`docs/evm-audit-2026-09-09.md`):
- **Curve sells were impossible** (approval ordering — the curve pulls the
  tokens). If a sell reverts, check the approval leg went first.
- **The wallet lived only in memory.** Restart the app and confirm the wallet
  and its history are still there.
- The treasury `0xDCBad4…483a` was set 09-08 and recorded as unverified on
  chain. Confirm a real fee actually lands there.

**Both:** the per-capability endpoint map splits receipts / state / logs /
simulate / broadcast / ws because **no single free BNB endpoint does
everything** (28 were probed on 09-09). If something works on one chain and not
the other, suspect a capability, not the code.
