# Testing 2.0.0 by hand, with SOL on Phantom

Written 2026-09-11 against the packaged artifact
(`release/win-unpacked/Krypto Bot.exe`), which is the build that was smoke
booted and corrupt-state tested. Run that one, not `npm run dev` — the point
is to test what a user would install.

## Where you are starting from

Read off this machine on 2026-09-11:

| | |
|---|---|
| Wallet 1 (ACTIVE) | `2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce` — **0.058 SOL** |
| Wallet 2 | `AADEThg9TCf6zfNfjqabaH81ifZzUARfcXVE9o9gLg4y` — empty |
| Wallet 3 | `CPR7N9B5NTXBzPc96kjWzs8VVefHbf58HnC6ETDuA1BU` — empty |
| Wallet 4 | `C391EQXeB81TJKtMzLSLCinBAaUbwJCEqEwbSyjp4WJj` — empty |
| EVM wallet | `0x011F1bbac10Dcf1eFCe795C9e92391C40cbbDd0a` — 0 on both chains |
| Live execution | **OFF** · cap 0.05 SOL/trade · slippage 12 % |
| Launcher | **OFF**, no launch wallet chosen |

**The EVM chains need their own coin.** Robinhood Chain needs ETH on chain
4663 and BNB needs BNB. Since 09-11 the app's own **Bridge** page (Wallet
Utilities → Bridge, off by default, switch it on there) can move SOL to
Robinhood Chain through Relay — the route was measured and signs — so tier 2
of `docs/testing-evm.md` is reachable from Phantom SOL: see Step 6 below.
Solana→BNB is refused by design (the only route hides its destination in
lookup tables); BNB still needs an exchange. Everything else below is Solana
and is fully testable today.

---

## Step 0 — free, no money, ~10 minutes

Nothing here can spend anything. Do it first; it catches the dumb breakages
before real money is involved.

1. **Launch the packaged app.** `release\win-unpacked\Krypto Bot.exe`.
   Close any `npm run dev` instance first — one instance lock, and you want
   to be testing the artifact.
2. **About → Version.** Press **Check now**. Expect *"Could not check for
   updates: krypt.cc is not publishing a version document yet."*
   That is the CORRECT answer today — `krypt.cc/version.json` returns the
   site's HTML. It must never say "you are on the latest version".
   *To finish this feature*: publish `https://krypt.cc/version.json` serving
   `{"version":"2.0.0"}` with `content-type: application/json`. Then Check now
   should say you are current; bump it to `2.0.1` on the site and the sidebar
   should grow an update notice.
3. **The three Observatories.** Solana, Robinhood, BNB. Numbers must differ
   between the two EVM pages — any figure identical across both is a bug.
   Robinhood should show ~1,962 settled / 28 graduated; BNB should show an
   empty model and say so rather than showing 0 %.
4. **Runner filters** (on either EVM Observatory). Toggle *show flagged only*,
   move the bucket floor, turn *only when it beats base* off and on. The
   bucket table underneath must **not** change — the filter decides what
   interrupts you, never what was measured.
5. **Wallet Scout.** Check all three chains list wallets, and that none of
   your own four Solana addresses appear anywhere on the board.
6. **My Layout.** Add panels, drag, resize, close one, reload the app and
   confirm the arrangement survived.
7. **EVM tiers 0 and 1** — follow `docs/testing-evm.md`. Both cost nothing.

---

## Step 1 — the Solana money path, ~0.02 SOL at risk

This is the one that proves the signer, the fee, the ledger and the cost basis.

1. **Send 0.1 SOL from Phantom to Wallet 1**:
   `2NWQUKUgryz5fWenCntyxLadKNgVuFHfercV7wYSPSce`
   (it has 0.058 already; 0.15 total leaves comfortable headroom).
2. **Top bar → switch Paper to Live** (the Paper/Live switch owns this; there
   is no Settings toggle). Leave the cap at 0.05 in Settings → Execution Lab.
3. **Arm the engine** (the Arm control in the top bar / automation row).
4. **Discover → pick any live pump token** with recent trades. Open it.
5. **Buy 0.01 SOL.** Watch for:
   - a fill toast with a signature;
   - the position appearing on **Portfolio**;
   - the cost basis being the **on-chain lamport delta**, not 0.01 exactly —
     it should be slightly more, because it includes the fee and tip.
6. **Sell 100 %** of it from the position row.
   - the sell must not be refused by a slippage or budget cap;
   - realised PnL appears, and it will be slightly negative — that is
     correct for an instant round trip (0.5 % each side plus spread).
7. **Trades / History** should show both legs with their signatures.

If any of that fails, stop and tell me the exact message — every refusal in
this app is written to name its own cause.

---

## Step 2 — the launcher, the biggest never-run path

**Nothing in this app has ever created a real token.** Both instructions are
pinned byte-for-byte against real transactions, but pinned is not the same as
sent.

Read this before you start:

- A token exists forever and is publicly attributable to the wallet that made
  it. **Use a throwaway name and ticker.** This app's own creator check flags
  a wallet that launches ten times in a day as a launch factory.
- It is worth a couple of dollars. ~2 % of launches graduate. You are testing
  a code path, not starting a project.
- The 0.5 % on your own first buy goes to your own treasury, so it is not
  lost — it is the interlock proving the claim path is billed.

### 2a. Fund a separate launch wallet

The launcher refuses to sign from your active trading wallet, by design — a
bug in the launch path then cannot reach the keys holding your positions.

**Send 0.1 SOL from Phantom to Wallet 2**:
`AADEThg9TCf6zfNfjqabaH81ifZzUARfcXVE9o9gLg4y`

That covers the account rent pump charges a create, your first buy, and fees,
with margin. The exact create cost has never been measured by this project —
**write down what it actually costs and tell me**, so the number stops being
an estimate.

### 2b. Set it up

1. **Hub → Launch a token.**
2. Read the amber box. Turn **Allow launching from this install** → **On**.
3. Under **Launch wallet · Solana**, pick **Wallet 2**. Wallet 1 will be
   greyed out and say *"your trading wallet"* — that is the rule working.
4. Live execution must still be ON and the engine ARMED. If not, the page
   says *"Your own first buy runs through the normal trade path…"* and
   refuses. That check exists so you never create a token you then cannot buy.

### 2c. Fill it in

- **Name** and **Ticker** — throwaway.
- **Image** — click the square, pick any PNG. Then **Pin to IPFS**. It should
  say *"Image and details pinned to IPFS. Nothing has been created yet."*
  This uploads to IPFS via pump's public pinner and creates no token.
- **Your own first buy** — leave at the 0.01 minimum.
- Leave **Mayhem** and **Cashback** OFF. Cashback gives your entire creator
  fee away permanently and would make step 3 untestable.

### 2d. Send it

1. Press **Check it first.** This simulates the real signed transaction
   against the live chain and broadcasts nothing. Expect *"The chain accepts
   this launch."* **Launch stays disabled until this passes.**
2. Press **Launch**. Expect, in order:
   - the create confirming;
   - then your first buy going through the ordinary trade path;
   - a panel naming the new mint;
   - the position appearing on **Portfolio** like any other buy.
3. **Open the mint on pump.fun.** Confirm the name, ticker and image are what
   you typed — that proves the metadata URI was written correctly.

If the create lands but the buy does not, that is reported honestly: the token
still exists, and the message says the buy failed and why. That is deliberate
— telling you "the launch failed" would send you to create a second token you
already own.

---

## Step 3 — claiming creator fees

Only meaningful after step 2, and only once somebody trades your coin — which
for a throwaway may be only your own dev buy.

1. **Launch page → Creator fees.** It shows what would actually arrive (the
   vault's balance above its rent), or a dash if the balance cannot be read.
   A dash is not zero.
2. If it shows a real amount, press **Claim** and confirm the SOL lands in
   Wallet 2.
3. If it shows `0.000000`, that is honest — a coin nobody traded earned
   nothing. The claim button stays disabled. Worth re-checking a day later.

The vault is per **creator**, not per token, so this one button collects
everything that wallet ever launches.

---

## Step 4 — the upgrade path

The one that touches existing users' data.

1. Quit the app.
2. Run the installer: `release\Krypto Bot-Setup-2.0.0.exe`.
3. Launch the installed copy and confirm your wallets, positions, ledger,
   orders and paper book are all still there. The app keeps `cc.krypt.terminal`
   as its id across every rename — if that ever changes, wallets vanish.
4. Confirm the terms gate does **not** re-prompt.

---

## Step 1b — Swap (Wallet Utilities → Swap)

1. With Live on and the engine armed, **Swap 0.005 SOL → USDC**. Check it
   first, then Swap. The fee line must read a SOL amount (0.5 % of the leg),
   never "0.5 %" alone, and the route must name a DEX. A swap in Paper is
   refused, not pretended.
2. **Swap the USDC back to SOL.** The output shown is the quote's amount;
   the receipt check refuses a simulation that would deliver less than the
   quote's minimum.

## Step 6 — Bridge (Wallet Utilities → Bridge)

1. Switch bridging on ON THE PAGE (it is off by default). Solana → Robinhood
   Chain, 0.05 SOL. **Get a quote** — the amber "trusted" line is expected on
   a Solana source (the destination is not in the bytes). **Check it first**
   — must say the chain accepts it. Then **Send it**, or stop here for a
   check-only run.
2. A sent transfer shows under "In flight", then under "Ended" as Arrived (or
   Refunded / Failed) with a desktop notification. It never vanishes.
3. Only then is Robinhood Chain testable: arm it on its wallet page and run
   tier 2 of `docs/testing-evm.md`.

## What is still untestable today

- **BNB trading** — it needs BNB, and the Solana→BNB bridge route is refused
  by design. A Robinhood launch needs ETH there: bridge it (Step 6) first.
- **macOS and Linux** — there is no git remote, so CI has never built them.
- **Code signing** — SmartScreen will warn on the installer. Expected.
