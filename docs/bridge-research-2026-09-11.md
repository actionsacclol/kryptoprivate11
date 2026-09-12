# Cross-chain bridging — six-agent research swarm, 2026-09-11

Commissioned before writing any code, because the feature requires widening
`signPolicy.ts` — the file that decides whether the user's money can move — to
sign a transaction **built by a third party**. That has never been done here.

Six agents: signer attack surface · LI.FI as a dependency · accounting and
in-flight state · legal and disclosure · house-rule conformance · chain and
route risk. Every claim below is either cited to `file:line`, measured from a
live endpoint on 2026-09-11, or marked **UNVERIFIED**.

**Verdict: build it — native coins only, no platform fee, own switch off by
default, EVM legs verified, Solana legs honestly labelled trusted-not-verified,
and two routes refused.**

---

## 1. What was proposed, and why it was wrong

The design put to the swarm was: `intent: 'bridge'` with (a) exactly one
signer, (b) every top-level SOL destination must be an address the quote
named, (c) a simulation loss bound against the quoted amount.

- **(a) is already enforced** unconditionally at `signPolicy.ts:408` for every
  non-`launch` intent, and again at `wallet.ts:598`. It adds nothing.
- **(b) is worth approximately zero.** The quote and the transaction arrive
  over the same channel from the same host: it validates attacker-supplied
  bytes against attacker-supplied bytes.
- **(c) is blind to destination.** A transaction sending exactly the quoted
  amount to an attacker produces a byte-identical lamport delta and passes.

A detail that makes the point: what refuses today's bridge transaction is the
**0.000125 SOL integrator fee transfer** (`signPolicy.ts:591`), not the
instruction that hands over the money. Delete that one transfer and
`checkOutflow` returns `ok` on a transaction whose purpose is giving SOL to two
programs it has never heard of.

### 1.1 The CPI question, answered

`checkOutflow` iterates **top-level instructions only** (`signPolicy.ts:387`).
The unknown-program branch (`:505-516`) guards only *token accounts*; it never
checks whether the wallet's own system account — index 0, always writable,
always a signer — was handed to an unknown program. Such a program can CPI a
transfer out and the signer sees nothing.

The real defence is `liveSigner.ts:741` — a top-level program allowlist — and
**it exists only in `liveSigner`**. `swap.ts`, `fund.ts`, `sweep.ts`,
`rentSweep.ts` and `pumpFees.ts` all sign without it.

**Consequence for code already shipped:** `swap.ts` signs Jupiter-built bytes
with only a magnitude bound. The `dexes` restriction is a *request parameter*,
never verified against the transaction that returns. Same structural exposure
as the bridge. **Fix regardless of what the bridge becomes.**

### 1.2 The bounds that actually matter

Pin the programs as **build constants** (never a program id the quote supplies);
pin the **destination-chain recipient** to our own address; bound against **the
amount the user typed**, not the quote's. Route the integrator fee through the
existing per-address summing `feeAllowance` (`signPolicy.ts:559-568`) rather
than a bare destination list, which stops a second transfer to the same address.

Never add bridge programs to `KNOWN_TRADE_PROGRAMS`: that set feeds
`tradeProgramAccounts` (`:458`), which the sell-side destination rule consults
at `:738`. It would silently widen **every trade**. Separate set, the
`LAUNCHPAD_PROGRAMS` shape (`:185`).

---

## 2. The finding that reshapes the feature

**On Solana the destination cannot be verified. At all.**

Searching all 503 bytes of a real LI.FI Solana bridge transaction:

| value | present in the transaction? |
|---|---|
| `toAddress` (our EVM wallet) | **NO** |
| `toChainId` 4663 | **NO** |
| `toAmount` | **NO** |
| `toAmountMin` | **NO** |

The destination is bound only to an **opaque 32-byte Relay id — the field that
changes between two identical quotes**. What *is* verifiable: total lamports
out (125,000 fee + 49,875,000 bridged = exactly `fromAmount`) and the Relay
program id.

**On EVM the opposite holds.** `receiver`, `destinationChainId` and
`toAmountMin` sit at fixed word offsets and were **byte-identical across two
quotes**. A real verifier is buildable.

So §1.2's most important bound — pin the recipient — **is implementable on the
EVM legs and impossible on the Solana legs.** The safety story is not uniform.
A green checkmark that silently means less on one rail is exactly the
dishonesty the em-dash rule exists to prevent.

### 2.1 Determinism

The transaction is **not** deterministic. Solana: 71 of 503 bytes differ
between identical calls — blockhash, the 8-byte `transactionId`, the 32-byte
Relay id, and the ComputeBudget unit price (80,000 → 94,921 µlamports/CU).
EVM: 35 of 2020 calldata bytes — `transactionId`, two bytes in the swap blob,
one deadline byte. **Every economically meaningful field is stable.** A
verifier can assert the stable fields and tolerate the known-variable ones.

Quotes carry **no expiry field**. `toAmountMin` drifted **0.052%** across three
identical calls seconds apart. Re-quote immediately before signing.

---

## 3. LI.FI as a dependency

**Rate limit, measured:** `/v1/quote` is **75 calls per 7200 s** (2 h),
per IP, and the bucket was already at 67 on the first call (shared NAT).
Exhausting it is a **two-hour outage** — which this swarm did. LI.FI's docs say
never ship an API key client-side; for a desktop app with no server that means
**no key at all** without building a proxy. Quotes must be cached and never
fetched on a timer, and the lockout must be a first-class UI state.

**Four traps, each of which would have shipped as a bug:**

1. **`action.slippage` is echoed but not applied.** Sent 0.5 %, 5 % and 30 %;
   the enforced minimum stayed pinned at 0.995 every time. Only
   `estimate.toAmountMin` from the *returned* step is real. Worse: a 200 does
   not mean a requested floor was honoured — a transaction came back with an
   enforced minimum *below* what was asked.
2. **`/v1/status` can be spoofed.** Querying by `transactionId` returned a
   populated `DONE` for a real, unrelated Arbitrum transaction — the id is
   caller-chosen and not unique, and Solana's is only **8 bytes**. Poll by the
   broadcast txHash and assert `sending.txHash` matches.
3. **`DONE` is not success.** `PARTIAL` is a terminal DONE substatus in which
   the user receives **a different token**.
4. **There is no canonical contract address.** 30 distinct `diamondAddress`
   values across chains; Robinhood's is unique to it. The contract we send
   value to is *told to us by the API* — a trust boundary, not a local check.

Also: `GET /v1/chains` is EVM-only by default — Solana is absent unless
`chainTypes=EVM,SVM` is passed. And LI.FI takes **0.25 % of input on every
quote** even with no integrator configured.

**Incidents.** Two exploits, same root-cause class, 28 months apart: ~$600K
(Mar 2022, fully reimbursed in ~18 h) and **$11.6M / 153 wallets (16 Jul
2024)**. Both were **infinite-approval drains**. Audits: 104 PDFs, but **95 of
104 by one individual researcher**. The free endpoints have **no terms at all**
(the commercial terms are enterprise-only). Bug bounty excludes
"self-crafted calldata" — i.e. exactly what we would be doing.

**This is why the feature is native-coin-only.** Bridging a native coin grants
**no standing approval**, so the vector behind both incidents does not exist
for it. Token bridging is a separate, later, separately-disclosed decision.

---

## 4. Chains and routes — measured

Sizing at SOL $99.3868 / BNB $712.90 / ETH $2465.45 (LI.FI `/v1/token`,
cross-checked CoinGecko ±0.1 %). Cost = (`fromAmountUSD` − `toAmountUSD`) +
`gasCosts`; LI.FI does **not** deduct source gas from `toAmountUSD`.

### Round-trip cost, % of original

| Pair | $1 | $5 | $25 | $100 | $1000 |
|---|---|---|---|---|---|
| SOL↔BNB | 16.37 % | 2.68 % | **1.16 %** | 0.67 % | 0.56 % |
| SOL↔RH | 21.89 % | 5.71 % | 2.48 % | 1.63 % | 1.45 % |
| BNB↔RH | 24.74 % | 6.34 % | 2.45 % | UNVERIFIED | UNVERIFIED |

### Verdicts

| Route | Tool | Verdict | Reason |
|---|---|---|---|
| SOL→BNB | mayan ($2+), relay ($1) | **SHIP** ≥$25 | Cheapest pair; Mayan has a real deadline refund |
| BNB→SOL | mayan ($2+), relay ($1) | **SHIP** ≥$25 | Best measured cost of all six |
| BNB→RH | relay (≤$5), across ($10+) | **SHIP** ≥$25 | Two tools; cheapest RH leg |
| SOL→RH | relaydepository only | **CONDITIONAL** ≥$50 | Sole tool; ~1 % floor it never beats |
| RH→SOL | relaydepository only | **CONDITIONAL** ≥$50 | Same monoculture + $0.11 RH source gas |
| RH→BNB | relaydepository | **REFUSE** <$100 | Worst measured; unverified above $25 |

**Refused outright: gasZipBridge on every route** — `maxOutbound = 0` to
Solana (measured: it cannot deliver there at all), and zero verified trust,
audit or refund data. **Hard floor $5 everywhere**: below that Relay silently
sends no refund when the refund is worth less than its gas.

### Failure recovery, per tool

- **Mayan** — best of the three. Automatic, no claim needed; deadline measured
  **416–439 s**. Refund fees fixed regardless of size ($0.0169 refund,
  $0.0037 cancel). **Trap: refunds return USDC, not SOL.**
- **Relay** — automatic origin-chain refund **only if `refundTo` is set**;
  without it auto-refund is *disabled*. Gas is deducted, and a refund worth
  less than gas is never sent. Fallback is a self-serve withdraw page (origin
  wallet must sign) then email, **no SLA**. Numeric TTL **UNVERIFIED**.
- **gasZipBridge** — **UNVERIFIED entirely.**

### Robinhood Chain, from the chain itself

Block 1 at **2026-04-30 16:52:11 UTC**; head 60,202,793 — the chain is
**4.4 months old**. Arbitrum Nitro `v3.11.4-rc.3` rollup on Ethereum blobs.
Block time 0.100 s measured. Finality measured: `safe` −12 m 42 s,
`finalized` −18 m 46 s. Single sequencer, FCFS; **the operator is not
identified anywhere — UNVERIFIED**. Canonical Arbitrum bridge exists
(~10 min deposits, **7-day withdrawal challenge period**). WETH supply
**41,244 ETH ≈ $101.7M** — liquidity is not the constraint.

### Both Solana intent programs are single-key upgradeable

Verified on-chain: Mayan's auction program authority `EU8z368k…` is a **plain
Ed25519 keypair** (System-owned, `dataLen = 0`, not executable) — not a Squads
multisig. Relay's Solana depository is the same shape. Relay advertises "no
upgrade path, no admin backdoor" (true of its **EVM** contract) and Mayan says
"no single party can freeze or move assets" (true of **custody**, not code).
On Solana the code governing custody is mutable by one signer in both cases.
Whether those keys sit behind MPC/HSM **cannot be determined from the chain**
and is the best question to put to both teams.

---

## 5. Accounting — a bridge is its own kind, and two guards are required

A naive "sell on one chain, buy on the other" breaks in two opposite ways:

- **Native SOL out** → the ledger's sign-clamps (`ledger.ts:374-383`) zero the
  amount and `portfolio.ts:154` drops the bucket. The money **silently
  evaporates** from the user's numbers.
- **A token they actually bought, out** → that mint has `spentSol > 0`, so the
  bridge "sell" books **a fabricated closed round trip** into win rate, profit
  factor, best trade and the equity curve (`portfolio.ts:152-190`).

And `Trades.tsx:105` renders a **PnL share card** on every closed row — which
`portfolio.ts:229` calls *"the one artefact of this app that gets screenshotted
and posted publicly."*

**The one that moves money unattended:** auto-cashout (`engine.ts:3306-3319`)
is bounded by `liveRealisedSol()` *specifically* because, per its own comment
at `:3312`, *"a deposit raises it just as a winning trade does, and sweeping a
deposit sends the user's own trading capital to their cold wallet with a toast
calling it profit."* A bridge-**in** is a deposit; a bridge-**out** booked as a
realised sell raises the ceiling. **The existing guard was written for exactly
this hazard and a naive bridge defeats it from both sides.**

Three silent failures: stops and take-profits lose their anchor and fall back
to a **spot-price** reference (`engine.ts:2572`, `:2690`); copy-trade mirrored
exits shrink or die (`copyTrade.ts:819`); scripts lose authority over a bag the
user still owns (`automation.ts:626`).

**Required, beyond not recording it as a trade:**

1. **Refuse to bridge a mint with live advanced orders, copy subscriptions or
   script authority.** Bridging a bag out from under its own stop-loss is the
   same class of harm as bridging away the SOL that pays for the exit.
2. **Auto-cashout must explicitly subtract known bridge-in arrivals.**
3. Add a `kind` column to the trade CSV (`portfolio.ts:207`) — the only export
   a bridge row could corrupt.

**In-flight state** follows the scanner's `pending` shape (`evm/scanner.ts`),
fixed earlier today for exactly this class of bug: persisted on entry, not only
on settle; restored on start; re-verified against the chain rather than trusted
from cache. `PHASE2.md:49` — *"After a crash, the chain, not local storage, is
the source of truth."* LI.FI's status is corroboration, never the record.

---

## 6. Legal

The Terms **do not cover this**. TOS §6 (`documents.ts:110`) enumerates
third parties — *"RPC providers, market-data APIs, launchpads, transaction
relayers, chat platforms"* — with **no bridge or aggregator**, and allocates
availability and accuracy, not *loss of funds someone else is holding*. The
Software Terms §6 risk list has no cross-chain, no in-flight, no
counterparty-performance risk.

**Custody is unchanged and that matters**: established from code, the app never
takes custody (`relayer.ts:1-3`, `signPolicy.ts:4-7`, fee treasuries receive
only inside the user's own transaction). **The app still takes no custody; it
introduces a third party that does, briefly.** That distinction is the whole
disclosure.

`src/pages/Swap.tsx:47` shipped (until the Bridge page landed later the same day) *"Never between chains… a trust model
nothing else in this app asks you to accept"*. Reversing a published promise
while leaving the accepted documents untouched would be the worst of both.

**`TERMS_VERSION` must bump** (`2026-09-09.3` → new). The gate matches on the
version string alone (`acceptance.ts:86`), so editing documents without bumping
leaves users bound to text they never saw. It re-prompts **every** user, so
bundle every pending document change into one bump.

**No platform fee on the bridge leg.** MiCA treats "transfer services for
crypto-assets on behalf of clients" differently from swaps; *Aguilar v. Baton*
names Jito **precisely because it takes a cut**; and this repo's own earlier
swarm already concluded *"a per-trade cut from every EU user's fill is exactly
the fact pattern a regulator points at"*
(`docs/product-swarm-2026-08-16.md:604`). Independently, the user already pays
LI.FI 0.25 % plus ~0.9 % to the bridge. Cheapest risk reduction available.

---

## 7. House rules this must follow

`li.quest` goes in `http.ts` `HOSTS` the `merkl` way, and gets **no priority
lane** — `PHASE2.md:53`, exit processing outranks everything, and a status
poller must never contend with a sell. Amounts stay **integer** (`PHASE2.md:54`
— monetary calculations never use floating point); LI.FI returns decimal
strings, so they stay `bigint`. There is **no "mark as arrived" button** —
`decoderVerify.ts:13`, *"could not verify" is never "verified"*. A failed-closed
in-flight store must say **"could not read your in-flight transfers"**, never
*"none in flight"* (`wallet.ts:178` shape) — the highest-stakes instance of the
em-dash rule in the feature. Validate everything *before* the confirm modal: a
user who types CONFIRM and then gets a refusal is the failure
`FanoutPanel.tsx:88` names.

**One possible blocker, partly resolved.** `signPolicy.ts:395` calls "exactly
one required signature" the app's strongest invariant. Measured on the
SOL→Robinhood `relaydepository` route: **1 signature, ours**. No collision.
**UNVERIFIED:** the signature count of the SOL→BNB Mayan route, and whether
either transaction carries address lookup tables. If any route needs a second
signer that LI.FI chose, **refuse that route** — do not relax the invariant.
(LI.FI Solana routes do use ALTs; the tempting fix of relaxing
`signPolicy.ts:546`/`:470` would be the actual loss event.)

---

## 8. Open decisions for the product owner

1. **Does SOL↔RH ship at all?** 100 % of 18 quotes went through one tool, one
   solver EOA, `supportsExternalLiquidity: false`, and a Solana escrow program
   upgradeable by one plain keypair. It is also the route most asked for.
2. **Minimum amounts** — enforce $25/$50 floors, or warn and allow?
3. **Ask Relay and Mayan** whether their Solana upgrade authorities are behind
   MPC/HSM before shipping the Solana legs.

## 8b. Measured after the swarm: why solana->bnb stays off

The SOL->BNB route was the one measurement the swarm could not take, because
LI.FI's quote budget was exhausted. Taken 2026-09-11 once it refilled:

- tool **mayan**, $29.81 in -> $29.78 out
- **1 required signature**, ours. No collision with the app's strongest
  invariant, which was the feared blocker.
- programs: ComputeBudget, LI.FI's `3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br`,
  System, Mayan's `D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa`, and
  **Jupiter** — the route swaps before it bridges.
- **three address lookup tables**, and a System transfer of **750,000
  lamports whose destination lives inside one of them**.

That last line is the blocker, and it is the exact hazard §7 predicted:
`checkBridge` refuses lookup tables outright because an account the signer
cannot name is one it cannot judge — and here we would be signing a payment to
an address we cannot read. Relaxing that refusal to make the route work would
be the loss event, not the fix.

**So the route is off by decision, not by ignorance.** Turning it on means
resolving the tables before signing and passing the resolved keys into the
policy. `fetchAlt` in `broadcast.ts` already resolves tables for the transfer
injector, so the machinery exists; what does not exist yet is the policy shape
that accepts resolved keys. Real work, scoped, and not a redesign.

Five of six directions are live meanwhile.

## 9. Still UNVERIFIED

gasZip everything · RH→BNB cost above $25 · BNB↔RH round trip above $25 ·
Robinhood Chain's sequencer operator · Relay's refund TTL · whether the 2024
reimbursement completed (asserted only by BlockSec, not by LI.FI).
