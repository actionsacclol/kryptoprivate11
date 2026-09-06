# Product research swarm — 2026-08-16

## 1. Provenance

Twelve agents: **six finders** (competitive, user-demand, honest-intel, distribution,
readiness, monetization-trust) each followed by a **dedicated adversarial verifier** whose
posture was refutation — open the finder's own citations, re-read the finder's own code
line numbers, and try to kill each proposed feature. Run 2026-08-16. Market figures in §5
and §9 were additionally re-checked by the assembler against DefiLlama and CoinGecko on
2026-08-16 (see §5).

**The question.** Not "is there an edge" — six months of swarms answered that (no). The
question is: *what makes this desktop memecoin tool get many users?*

**Fixed decisions (not relitigated; fatal-flag only).**

1. **Form factor:** the existing Electron desktop app, not a Telegram bot.
2. **Execution model:** manual execution + honest intel. The user presses buy. No
   auto-trading of strategies the research proved negative.
3. **Goal:** many users. Success = adoption and retention, not personal alpha.

**Three fixed decisions took damage in verification and one is flagged.** Decision 1 is
expensive but survivable (§9). Decision 2 has no implementation — **there is no manual buy
button in the product** (§8, C2). Decision 3 is **unmeasurable as stated** — a tool that
promises "No telemetry" cannot observe adoption or retention, which is the same position
Trench.Tools is in with a dashboard reading 0 (§4.6).

Source files: six `section-*.md` and six `verify-*.md` in the swarm scratchpad. House style
per `docs/strat-swarm-2026-07-24.md`: hard numbers, negative results first, every figure
sourced, unverified marked **unverified**.

---

## 2. Bottom line

**Yes, the goal is achievable in this form factor — at thousands to low tens of thousands of
users, not hundreds of thousands — and only if a zero-install web surface does the
acquiring.** The honest ceiling on good execution is 1,500–6,000 cumulative installs at 6
months and 8,000–30,000 at 18 months (§9); the desktop binary has no discovery surface, no
store, no link-to-trade, and no referral loop, while 100% of the competitive set grows on
fee-funded referral programs paying 25–35% that a zero-fee product structurally cannot run.

**The single biggest risk is not the form factor. It is that the product's central thesis —
"users want honesty" — is asserted in four of the six sections and evidenced in none of
them.** Three independent verifiers flagged this without coordination. Every supporting data
point offered was refuted on re-check: Photon's collapse was caused by *rebates*, not
transparency (Axiom returns up to 43% of fees; Photon offered "zero mechanisms to claw any
fees back"); Rabby, the most honesty-branded wallet cited, went **0% → 0.25%** in July 2024
and kept its users; Untaxed's 130 users is a token-gated Chrome extension, not a
like-for-like pitch; and Trench.Tools' "0 traders" is an un-instrumented widget on a
self-hosted stack that structurally cannot count anyone. **Honesty survives as a
positioning and cost decision that is cheap and correct. It does not survive as a growth
strategy, and no marketing plan should rest on it.**

The desktop decision took real but survivable damage. The competitive section's headline
proof that desktop is dead — "the best-executed desktop clone has 3 GitHub stars" — is a
null measurement on a **23-day-old repo** (`created_at` 2026-07-24) and must not be repeated
to anyone. The honest version is weaker and still bad: ScreenerBot has been marketing since
2025-11-10 with 18 SEO posts and has no review coverage, no Reddit footprint and no published
user count. Meanwhile the honest-intel section's claim that desktop is an *asset* (a
seven-block pre-trade interstitial is unusable in Telegram) is backwards as an adoption
argument and was correctly refuted: the incumbent's advantage is being one tap inside an app
the user already has, and the proposal stacks a desktop install, a key import and a modal
between the user and the buy button they came to press.

Three features survived every attack and all three are boring: **the all-in cost
calculator, fee-inclusive PnL, and code signing**. All three work on day one for a stranger
with zero local tape, need no backend, and are honest without extrapolation. The two
features with the most research romance attached — realistic fill preview and creator base
rates — are precisely the two that cannot run on a new user's machine, and the creator
number failed to replicate at the value the feature wanted to display (22.85%, not 34.3%).

**The tree is not shippable today.** `autoSellOnExit` defaults **true** and market-dumps
every SPL token in the wallet on the ordinary Stop button; the signer validates who pays but
not where funds go, so the honest blast radius is the full balance; `metadata.ts` fetches
attacker-chosen URLs on every token launch, handing any token creator the IP and timestamp
of the entire live install base; "No telemetry" is already false in-tree via default-on
Discord Rich Presence and remote Google Fonts; and the README tells the public the app
"never holds keys, never signs" while `LIVE_EXECUTION_AVAILABLE = true` and ~100 mainnet
buys have landed.

---

## 3. Per-area findings

Verifier corrections are folded in inline and marked **[CORRECTED]**. Where a finder claim
was struck entirely it is marked **[REFUTED]**.

### 3.1 Competitive

**Live 30-day fee capture (DefiLlama, re-checked by assembler 2026-08-16).** SOL = **$75.36**
(CoinGecko, +0.26% 24h).

| Platform | Form factor | 30d fees | Status |
|---|---|---|---|
| Axiom | Web terminal | **$27,805,476** (24h $858,253; all-time $738.6M) | Leader |
| GMGN | Web + TG, 9 chains | **$24,854,868** (24h $713,946) | Co-leader, migrating off Solana |
| fomo | Mobile-first + web | $9.83M on $740,597,177 volume | Fastest growth |
| Terminal (ex-Padre) | Web + TG | $3.78M | Acquired by pump.fun 2025-10 |
| Trojan | TG + web | **$1,051,587 Solana-only** | Shrinking |
| Photon | Web terminal | $605,785 | Collapsed from $84.6M peak (Jan 2025) |
| Maestro | Telegram | **$259,064 Solana-only** (vs $1.18M all chains) | Legacy, multichain |
| BONKbot | Telegram | **$81,477** | ~98% down from $4.35M/mo |
| Banana Gun | TG (ETH-centric) | **$1,977 Solana-only** | Dead on Solana |
| BullX | TG + web | $281 | **Shut down 2026-06-01** ($203,026,260 all-time) |
| Nova | Telegram | $0 | Dead |

**[CORRECTED] The market is not $840M/yr.** The finder counted GMGN's full $24.85M as Solana
revenue. GMGN spans nine chains; on the verifier's latest-day breakdown BSC was 49%,
Robinhood Chain 31%, **Solana 15.3%**. Maestro is $259k Solana against $1.18M total, Banana
Gun $1,977 against $8k. Corrected Solana-only category: **~$55–62M/30d ≈ $660–745M/yr**,
overstated by 15–25%. Concentration survives: Axiom + GMGN = 75.2%, top four = 94.6%.
(GMGN's *precise* current Solana share is **unverified** — the assembler's own re-fetch
returned a paraphrase that disagreed with the verifier's explicit per-chain table; use
"15–60%, most recent day ~15%".)

**[REFUTED] "Axiom's implied take is 1.85%, so incumbents overcharge."** $27.81M / $1.50B =
1.85% against a published 0.95%→0.75%. Spot-only arithmetic gives ~$13.5M — half the
recorded fees. The residual is perps and non-swap revenue the DEX adapter misses. **Do not
build "incumbents secretly charge 2x" messaging on this.** It is the one claim most likely
to be publicly falsified, and falsifying it destroys the brand.

**[REFUTED] "ScreenerBot has 3 GitHub stars, proving desktop is unreachable."** `created_at`
2026-07-24 — a 23-day-old repo. Null measurement. Honest version: 9 months of SEO
(screenerbot.io blog from 2025-11-10, 18 posts) with no discoverable community.

**[REFUTED] "Zero terminals reclaim ATA rent; rentSweep.ts is genuinely unique."**
screenerbot.io/faq, verbatim: *"ScreenerBot has auto-cleanup that runs every 5 minutes to
close empty ATAs and reclaim rent."* That is a **superset** of KryptSniper's on-demand
`live:sweepRent`. ScreenerBot also ships "Wallet Copy" — so copytrade is 9 of 9, not 8 of 9,
and KryptSniper is alone rather than one of two in refusing it.

**[REFUTED] fee-table sourcing.** `solanatools.io/solana-trading-bot-fees` does **not**
mention fomo, does not mention any $0.95 flat minimum, and does not mention Maestro's
$200/month. The following remain **unverified**: fomo's "0.50% + $0.95/txn" mechanism
(fomo.biz serves a broken TLS cert for `varyon-hrmis.com`), the derived ~$115 average
ticket, **GMGN's 0.006 SOL default priority fee** (GMGN's fees docs 404 — this is the entire
basis of "priority-fee defaults destroy small traders", and it must not ship as a marketing
claim until confirmed in-product), and Maestro's $200/mo (the only cited proof that a
non-flow model works).

**What survived and is the strongest finding in the area.** fomo advertises the market's
cheapest headline rate and its users pay an effective **1.347%** ($9,975,289 / $740,597,177),
above GMGN's 0.98% — while being the fastest-growing platform in the category (fees $225k in
2025-07 → $7.4M in 2026-07, 33x). **Users do not price-shop. Free is not an adoption
advantage.** This is the best-evidenced conclusion in the entire swarm and it survived
independent re-derivation.

**The attack surface that holds.** Fee disclosure is genuinely bad (Axiom: "actual costs
often exceed stated slippage, bribe, and priority fees"). Unrealized PnL excludes fees across
the board. Copytrade is marketed by 9 of 9 while this project's own tape says watchlists are
anti-predictive. Custody and surveillance are live grievances: ZachXBT documented Axiom
employees using internal support tools to query user wallets and compile influencer wallet
lists, and Axiom confirmed it verbatim ("we are shocked and disappointed to learn that some
members of our team misused internal customer support tools…", Forbes 2026-02-26); BullX took
$203M in fees and stopped trading.

**Missed risk that matters most.** **The tape is four dense days, not six months, and
collection has stopped.** `E:\data` = 38 GB: 2026-07-25 (9.99 GB), 07-26 (11.06 GB), 07-27
(15.01 GB), 07-28 (3.75 GB partial), plus fragments 07-31 (0.138 GB) and 08-08 (0.381 GB).
Last dense day is **19 days old**. "Six months" describes research effort, not the data
window. Every tape-derived claim rests on one regime-week.

### 3.2 User demand

**Retention is structural, not product-driven.** Pump.fun active wallets 5,262,050 (May 2025)
→ 1,795,474 (Dec 2025) → 3,142,559 (Apr 2026). Median hold time ~100 seconds.

**The load-bearing distribution (CoinGecko Apr 2026, verified exact):**

| Bucket | Wallets | Share |
|---|---:|---:|
| Gain $1–$500 | 2,047,085 | 65.14% |
| Gain $500–$1K | 87,127 | 2.77% |
| Gain >$1K | 168,795 | 5.37% |
| Loss $1–$500 | 792,724 | 25.23% |
| Loss $500–$1K | 22,290 | 0.71% |
| Loss >$1K | 24,538 | 0.78% |

**91% of all wallets land inside ±$500.** This is an entertainment population with a small
stake, not an investment population. Honesty cannot retain them — their loss is too small to
hurt and returns are not their motivation. Honesty is for the **~6.2% (~194k wallets)
clearing >$1K**, for whom cost drag decides sign.

**Distribution beats everything, by ~4,800x.** fomo: **625,000+ users**, mobile-first social
feed, Apple Pay onboarding **68,000 first-time crypto buyers** for ~$25M volume, "Speed-First
vs Social-First" framing verbatim — and social-first won. **[CORRECTED and strengthened]**
fomo raised a **$75M Series B at $550M valuation (June 2026)** and earns $437k–474k/day. Free
+ honest is not competing against a cost structure; it is competing against a $75M
distribution budget.

**[CORRECTED] Axiom is not at a ceiling.** Not "~47k DAU peak" — Axiom went ~32,000 daily
active traders (early July 2026) → **47,000+ (early August 2026), +48%**, with volume share
rising to 57.33% in July. The fee-charging incumbent is *growing*.

**[REFUTED] "Photon collapsed because its cost schedule was legible and worse."** The
attributed cause in the sources is **rebates**: Axiom's fee-rebate program returns *up to
43%* of transaction fees to active traders; the review corpus frames Photon's problem as
offering "zero mechanisms to claw any fees back." The observed switching trigger is **getting
paid**, not being told the truth — and a zero-fee tool has no rebate to pay and no tier ladder
to climb. Photon is evidence for the rev-share thesis, not the honesty thesis.

**[REFUTED] "Untaxed and Trench prove the identical free+honest pitch fails."** Untaxed is a
Chrome-extension overlay injected into *other people's* terminals, and its "free" is
token-gated (Pro = hold 200,000 $UNTAXED, Ultra = 1,500,000, token launched on pump.fun
2026-03-02). "Asking traders to hold your pump.fun token doesn't sell" fits the 130 figure
equally well. Its "30 days" framing is suspect — the same page's timeline runs Feb 24 → June
2026. Trench.Tools' three zeroed counters are an un-instrumented widget on a self-hosted
stack with no telemetry channel. **Both data points struck.**

**[CORRECTED] "Kolscan was acquired by Pump.fun in 2026."** Announced **10 July 2025**, two
days before the Pump.fun ICO. Kolscan has been Pump.fun's integrated data layer for **13
months** — realtime transactions, token PnL, leaderboard performance — with the largest
launchpad's distribution. The wallet-performance surface is already owned.

**What survived.** RugCheck — free, no account, no wallet connect, ~20 on-chain signals —
became the de facto DD standard with no fee model. Nobody occupies the true-cost slot:
published cost analysis stops at 1.6–3.3%/trade on a **$500 ticket**, and fixed costs
(priority fee, Jito tip, ATA rent 0.00203928 SOL/mint) are ~invisible at $500 and lethal at
$5. The desktop reach tax is confirmed: **zero incumbents in the top cohort ship a native
desktop download.**

**The plausible failure mode, stated plainly.** If the tool greets a user with "your real cost
floor at this size is 16.9%, the wallet you're copying is 0.737x at 60s, and your -35% stop
fills at 0.525x," the rational response for the modal ±$500 user is to **stop trading** — i.e.
to stop opening the app. Incumbents monetize sessions; this project does not, but it still
needs them. The honest numbers must be *actionable*, not merely discouraging.

### 3.3 Honest intel

**The organizing insight of the whole swarm, and it holds.** Sort every measured finding by
what a fresh install knows on first launch:

- **(A) Protocol constant** — rent-exempt 0.00203928 SOL, base fee 5,000 lamports/sig, curve
  invariant, on-chain `FeeConfig`. Never decays without a program change.
- **(B) Live read** — priority-fee percentiles, Jito `tip_floor` (wired, `jitoTips.ts`),
  virtual reserves, migration age. Milliseconds on any free RPC.
- **(C) Shipped measured constant** — a tape number frozen with `{value, n, window, method}`.
  Available day one, **decays silently**.
- **(D) Local tape** — `creators.json`, recorded launches. **Empty on a fresh install.**
- **(E) Third-party enrichment** — RugCheck (**3 req/s documented, ~7.7M/mo**, better than
  the finder assumed), GeckoTerminal (30/min, **explicitly Beta and "subject to changes"**),
  Solana Tracker (2,500 requests; monthly framing **unverified**).

**The flagship number is entirely class A+B.** The cost floor is arithmetic over protocol
constants and live reads: zero tape, zero server, works on the first launch of a wallet that
has never touched this app. The moat findings that *are* class D — creator base rates above
all — are the smallest, slowest, most perishable part of the product.

**Shipping law that should be adopted verbatim:** every number in the UI carries a provenance
chip (`live` / `protocol` / `measured Jul-2026 n=419` / `your history n=12`). A number that
cannot carry one does not ship.

**Blocking bug, confirmed and worse than stated.** `electron/engine/curve.ts:19` —
`export const FEE_BPS = 100n;` (1%) while pump charges **1.25% total on curve** (0.300%
creator + 0.95% protocol, tiered by market cap down to 0.30% at ≥98,240 SOL mcap; flat 0.30%
on non-canonical PumpSwap pools). `txBuilder.ts:385` carries the comment acknowledging the
gap. **[CORRECTED] the fix is bigger than "read a field we already fetch":**
`addresses.ts:25` defines `PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'`
and `liveSigner.ts:31` references it, but **nothing in the tree decodes `FeeConfig`** — grep
for `FeeConfig|feeConfig` returns only the address constant. New account decoder + market-cap
tier table. And pump.fun has announced it will **replace Dynamic Fees V1 with a "market-driven
model" during 2026**, rates and date unpublished — so a hardcoded 1.25% would be wrong in a
second way within the year.

**[REFUTED] "$62 round trip on a flat trade is 12.4% of stake" — the reframed denominator
the finder called "the entire feature".** The $62.00 total includes an exit bot fee ($12.50 =
1% of a **$1,250** exit) and exit slippage ($25.00 = 2% of $1,250). On a flat trade the same
schedule gives $5.00 + $1.50 + $1.50 + $15.00 + $5.00 + $1.50 + $10.00 = **$39.50 = 7.9% of
stake**. The finder's number is inflated 57% by importing the winner's exit denominator into
the flat case — *the exact denominator error the feature exists to expose*. Ship 7.9% and
show the working.

**[REFUTED] "Migration sniping loses on every reachable cell on every day."**
`docs/migration-shadow-2026-07-27.md:44-51`, in a section titled *"What is day-robust and
addressable"*, lists two configurations positive on all three days: mid bucket (400ms–2s
lead) position 1 at +4.6%/+4.6%/+6.5%, and position 2 with a 5% slippage cap at
+0.150/+0.341/+0.112 median per fill, 63–77% fill rate. What is negative in 54 of 54 is
**reactive entry at +1/+5/+15s**, and **positions ≥3**. The family dies on tip-auction
economics against incumbents throwing 870 SOL, not on the arithmetic being negative
everywhere. The accurate warning copy is shippable; the marketing line built on top of it is
not.

**[REFUTED] "7–17% of stake" as the headline.** 16.9% is a **0.03 SOL** stake (~$6) on a
config that used a relayer and did not close ATAs. `strat-swarm-2026-07-24.md:164-169`: 0.03
→ 16.9%/9.2%/7.1%; 0.10 → 7.5%/4.5%/3.9%; 0.25 → 5.1%/3.3%/3.1%; 0.50 → 4.3%/2.9%/2.8%. And
`farming-swarm-2026-08-15.md:267`, dated **yesterday**: "Median **0.58%** vs the 07-24
registry's 16.9% at 0.03 SOL — a ~28x reduction"; line 268: "ATA rent is 0.00203 SOL =
**0.002% at 100 SOL** versus 6.77% at 0.03; the old killer is dead at this size"; line 429:
"The 07-24 floor bound because edge (+3%) and cost (16.9%) were the same order. **Neither is
true now.**" Marketing "7–17%" cites a superseded regime at a stake size no user trades — and
the live panel, computing from today's Jito p75 of 4.25e-6 SOL, **will visibly print a
different number on day one**. Lead with the calculator; let it print whatever today's number
is.

**MISSED RISK, and the most damaging thing in the swarm: MEV is entirely absent from a panel
branded "all-in".** `farming-swarm-2026-08-15.md:437` (X12): *"F3's and F4's quoted spot cost
floors are **understated by an unmeasured MEV term**, on top of X3."* Registry line 513:
`MEV / sandwich on the Solana spot leg | UNMEASURED | Absent from every model in F3, F4 and
F5. Sign is a debit.` A retail pump.fun buyer is the sandwiched party. A six-line panel that
calls itself "all-in" and omits the best-known cost in Solana retail trading is the exact
dishonesty the product exists to condemn, and it is the first thing a hostile reader finds.
**Minimum fix: an explicit "MEV / sandwich: unmeasured, sign negative" row with no number,
and rename the headline "modeled cost floor", never "all-in".**

**MISSED RISK: the impact model is wrong by 10–50x off-curve.**
`farming-swarm-2026-08-15.md:270-272`: "TVL-based impact models remain wrong by 10–50x (naive
CP predicts 4–22% where reality is 0.2–0.4%) because depth sits in HumidiFi/SolFi V2/ZeroFi/
Scorch/AlphaQ/Quantum." `≈2S/vSol` is correct **on the bonding curve only**. The panel is
proposed for post-migration tokens, where it would scare users out of a 0.4% trade with a 20%
estimate — dishonest in the other direction and falsifiable in one Jupiter quote. **The panel
must hard-branch curve vs AMM and refuse to print self-impact off-curve.**

**MISSED RISK: silent fallbacks defeat the provenance system on its first line.**
`jitoTips.ts:17` initialises `cached` to a hardcoded p75 of 100,000 lamports (0.0001 SOL) —
**23x today's real p75 of 4.25e-6 SOL** (Jito tip_floor live 2026-08-16T07:47Z: p50 3.075e-6,
p75 4.2505e-6, p95 1.882e-5). `refresh()` returns `cached` on any non-OK response or parse
miss; `ok:false` exists but nothing forces a consumer to check it. `feeEstimator` has the same
shape on RPC failure. **A hardcoded number under a `live` chip is worse than no chip.** The
chip system needs `stale`/`unavailable` states and the panel must refuse to render a line
rather than fall back.

**What survived unblemished.** The copy-trade refusal page. `wallet-identity-2026-07-25.md:29`
verified to the decimal: `500 ms | 60 s | ≥20 tr, top 10% | 2,268 | −4.87% | −30.98% | 22.1% |
−11.04`. All 24 follow configurations lose (−2.47% to −18.98%); follower win rate 15–22%
against the selected wallets' own 33%. The mechanism is structural — *the measured quantity IS
the price impact the follower pays* — so it survives magnitude decay. GMGN cannot reproduce it
without indicting its own headline feature. And the survivorship cohort:
`farming-swarm-2026-08-15.md:323-326` — of **874** tokens that migrated 2026-07-25, 22 days
later **0 with TVL >$50k, 0 with 24h volume >$100k**, 9 (1.03%) with volume >$1,000, 267
(30.5%) under $100 TVL; GeckoTerminal resolves 874/874 by address, refreshable for $0.

### 3.4 Distribution

**The Windows trust gauntlet is cheap and the received wisdom is obsolete.** Microsoft Learn
(ms.date 2026-04-20), verbatim and confirmed: *"That behavior was removed in 2024"* and
*"Paying the EV premium ($400+/year) solely to avoid SmartScreen warnings is no longer
justified."*

| Option | Cost | Day-1 SmartScreen | Blocker |
|---|---|---|---|
| Microsoft Store | Free | No warning ever | See below — hard for this project |
| Azure Artifact Signing (ex-Trusted Signing) | **$9.99/mo**, 5,000 sigs | Warning until reputation builds | Orgs US/CA/EU/UK; individuals US/CA — **[CORRECTED]** self-employed individuals *do* qualify |
| OV cert (DigiCert/Sectigo) | **$150–300/yr** + mandatory HSM token (CA/B Forum, June 2023) | Same | none |
| EV cert | $400+/yr | **Same as OV** | pointless since 2024 |
| SignPath Foundation (OSS) | Free, OV-level | Same | **requires an already-released project** |
| Unsigned | Free | "Windows protected your PC"; Smart App Control blocks | see correction |

**[CORRECTED] Signing does not remove the first-download warning.** MS: *"Valid Certificate
(OV/EV): ⚠️ Warning — app flagged as unrecognized until reputation accumulates; verified
publisher name is displayed."* What signing buys is (a) a real publisher name instead of
"Unknown publisher", (b) Smart App Control eligibility, and (c) *certificate* reputation
carrying to future releases. **[REFUTED] the finder's "signing removes the wall that stops
35–60% of warm downloaders and 75–90% of cold ones"** — he wrote in §1 *"there is no published
A/B number for SmartScreen. Do not let anyone quote one"* and then quoted his own unverified
assumption back as a benefit. Sign anyway; justify it correctly.

**[REFUTED] "unsigned is a cap at zero."** Unsigned is a wall ("must choose Run anyway"), not
a block. The hard block applies only under Smart App Control and enterprise policy, and Smart
App Control turns itself off on machines running unsigned/heterogeneous software — precisely
the gaming-PC demographic this product targets.

**[REFUTED] SignPath Foundation as the launch signing identity — circular dependency.** Terms
require **"already released software"**. SignPath cannot sign the first release. It also
requires *"binary artifacts must be built from source in a verifiable way"* — reproducible
Electron + NSIS is weeks-to-never, not days — and named Author/Reviewer/Approver roles whose
solo-dev collapsibility is **unverified**. Good news: **no crypto/financial/wallet exclusion
exists** in the terms. SignPath is a **month-6 cost optimization**, not a launch dependency.

**[REFUTED] Store Policy citation, and the real policy is worse.** 10.8.7 is about *pricing*.
The controlling policies are **10.2.6** (crypto wallets and trading platforms "must be
distributed by a Company account") and, more damagingly, **10.8.3**: *"Products from
individual accounts cannot require financial information for primary functionality. Financial
information includes … initiating cryptocurrency transactions, … **private keys**, or recovery
phrases."* Plus **10.14**: a Company account requires identity/business verification **and a
publicly displayed customer support contact**. Incompatible with pseudonymity. (Counter-point
in the project's favour that the finder also missed: **10.2.9** permits a plain HTTPS .exe/.msi
download link with no MSIX sandbox — but the binary must still be signed to a Microsoft
Trusted Root chain, *"silent install is required"* which the current
`nsis: { oneClick: false }` violates, and 10.5.1 requires a privacy policy.)

**[REFUTED] open source as impersonation defence.** The cited SlowMist case
(`solana-pumpfun-bot`, account `zldp2002`) **was an open-source GitHub repo with inflated
stars that exfiltrated private keys** — open source as the *attack vector and credibility
laundering mechanism*, not the defence. MIT explicitly permits redistribution under a modified
name. What actually defends: a consistent signing certificate, one canonical download URL,
published SHA-256s.

**[REFUTED] "users will read the code."** Hard proxy from the finder's own dataset, which he
collected and did not read. Bisq v1.10.4 — non-custodial, privacy-maximalist P2P Bitcoin
exchange, plausibly the most security-conscious desktop crypto userbase that exists — ships
detached PGP signatures next to every binary: `Bisq-64bit-1.10.4.exe` **8,623** downloads,
`.exe.asc` **1,904**. **~78% of its Windows users do not download the signature file**, let
alone read source. Keep open-sourcing for update-feed hosting, a canonical artifact, SEO and
eventual free signing — drop the "only credible answer" framing.

**The real cap.** The competitive set's growth loop is uniform and fee-funded, verified exact
against CoinCodeCap (updated 2026-04-14): **Sui Sniper up to 35% multi-level, Sol Trading Bot
30% flat, BONKbot 30%/20%/10% tiered, GMGN 25%, Maestro 25%, MEVx 25% + 5-level, Trojan 10% +
5-level.** KryptSniper charges nothing → no fee pool → no referral commission → no influencer
payout → no paid acquisition. **This constrains reach far more than the .exe does.**

**Auto-update is the highest-blast-radius decision.** `electron-updater` has a documented
signature-validation bypass — GHSA-9jxc-qjr9-vjxq = **CVE-2024-39698**, High/CVSS 7.5,
affected ≤ 6.3.0-alpha.5, patched ≥ 6.3.0-alpha.6, mechanism confirmed (signature check runs
PowerShell via `cmd.exe` with `shell: true`; cmd.exe expands environment variables, letting an
attacker redirect which file's signature is validated). A compromised update channel on a
key-holding app is a simultaneous total-loss event for every user. **[CORRECTED]** the cited
Doyensec SafeUpdater (2026-02-16) self-describes as *"not intended for production use"* — a
design reference, not a dependency.

**[REFUTED] "the update ping is the first compromise of No telemetry."** It is the third. See
§8, gate items 3 and 4.

### 3.5 Readiness

**The live path is real, not scaffolded — it has signed and landed ~100 mainnet buys**
(`strat-swarm-2026-07-24.md:67-68`). Build quality of the execution core is genuinely high.
The gaps are in *ownership of state after a failure*, *signer-side revalidation*, and *the
desktop security envelope*.

**PHASE2 invariants, verified:**

| # | Invariant | Verdict |
|---|---|---|
| 1 | One intent → one economic position | Paper enforced (`orders.ts:27`); live enforced only by in-memory `liveMints` cleared on restart |
| 2 | No signing against stale state | **Absent on live path.** `policy.ts:38`'s 3s `dataAgeMs` check never reached from `liveSigner`; blockhash cached 20s (`txBuilder.ts:52`) |
| 3 | Fail closed on unknown layouts | Implemented for discovery (`engine.ts:305`, `:1268`); advisory for signing (`liveSigner.ts:24-27`). `disarm` does not clear `liveEnabled`, so `manualSell`/`sweepRent` keep signing after a disarm |
| 4 | Chain is source of truth after crash | **Absent as specified.** `recoverAfterCrash` (`engine.ts:873`) only liquidates if `autoSellOnExit` is on |
| 5 | A timed-out RPC never means failure | **Violated.** `broadcast.ts:233` returns `{landed:false}` on timeout; `engine.ts:641-643` gates `liveMints.add` on `res.ok` |
| 6 | Every tx decoded and validated before signing | **Absent.** `wallet.ts:211-241` checks exactly: derived pubkey matches, `staticAccountKeys[0]` is us, `numRequiredSignatures === 1`. No instruction decode, no program check, no lamport cap, no destination check |
| 7 | Exits outrank discovery | Implemented in spirit (`engine.ts:577` serializes), never prioritized |
| 8 | Integer-only money math | Implemented (`bigint` in `curve.ts`/`positions.ts`); two float exceptions are bounds, not book entries |

**[CORRECTED] "risk.ts is not surfaced at all / the highest-value unshipped code."** `checkMint`
**is** called at `engine.ts:1339`, merged into `cur.row.riskFlags` at `:1343`, rendered at
`src/pages/Launches.tsx:64-66` and `src/components/TokenDrawer.tsx:167-171`. The real defect is
the inverse: hard-rejected tokens are `this.reject(...)`ed at `engine.ts:1346` and **never
pushed to the Launches list**, so the user never sees "this launch has a transfer hook, here is
why we killed it." Cheaper fix, different fix.

**[CORRECTED, and this is the largest finding in the area] There is no manual buy button.**
`src/global.d.ts:62-65` enumerates the entire live IPC surface: `testTrade`, `sellToken`,
`sellAll`, `sweepRent`. `live.testTrade` is invoked in exactly one place —
`src/pages/Wallet.tsx:57`, behind a field labelled "Manual test trade / Prove the pipeline with
one small buy" requiring a pasted mint address. Nothing on Launches, Positions or TokenDrawer
buys. **The decided product ("the user presses buy") has no buy surface at all.** Every
preflight, cost panel and interstitial in this entire swarm hangs off a button that does not
exist.

**[CORRECTED] "manual sells strand 0.00203 SOL."** Rent is **deferred, not destroyed**.
`rentSweep.ts:38-77` closes zero-balance ATAs in batches of 10 (`CLOSES_PER_TX = 10`) for both
token programs, reachable from `Positions.tsx:97` and automatically after every `sellAllHeld`
(`engine.ts:836-839`). Batched recovery is *cheaper* than closing inline. Defensible statement:
"leaks until swept, and nothing prompts the user to sweep." One-line fix: `await
sweepAtaRent(...)` after `manualSell`.

**[CORRECTED] "a timed-out buy silently strands funds."** `engine.ts:773-785 holdings()` reads
`getTokenAccountsByOwner` — chain truth — and feeds `Positions.tsx`, the sellAll button and
`recoverAfterCrash`. The orphan *appears in the UI* and is one click from liquidation. Honest
restatement: **the automatic exit engine never fires for that mint; the user must notice the
row.** Real bug, real invariant-5 violation, not silent fund loss.

**[CORRECTED] "autoLive is a five-line deletion."** `autoLive`/`autoLiveActive`/`autoLiveBuy`/
`autoLiveSell` appear at `engine.ts:191, 374, 448, 472, 487, 584, 586, 603, 623, 698,
1608-1609`, `positions.ts:153`, `shared/types.ts:188, 299, 626`, `src/pages/Wallet.tsx:68,
82-83`. Ten call sites across three files. Small, not five lines — and being wrong by 5x on the
easiest item is a signal about the rest of the estimates.

**MISSED RISK, now the #1 release blocker.** `shared/types.ts:632` — **`autoSellOnExit: true`**.
`engine.ts:336-337` fires `sellAllHeld('engine_stopped')` on the ordinary **Stop** button.
`sellAllHeld` sells **every SPL token `holdings()` returns**, filtered only by `mint !==
WSOL_MINT` (`engine.ts:812`) — not only this session's, not only this app's — at
`Math.max(liveSlippagePct, 15)`% slippage through the 0.5% relayer. Also fires on quit
(`main.ts:178`) and on boot (`engine.ts:875`). **A default-ON, one-click, whole-wallet dump in
a product whose premise is manual control** — strictly worse than the default-OFF `autoLive`
toggle, and absent from the finder's gate list.

**MISSED RISK.** `shared/types.ts:622` — **`localTxBuild: true`** while its own docstring at
`shared/types.ts:178-183` reads *"EXPERIMENTAL — default off."* The file with **zero tests**,
which decides which accounts a signed instruction touches and self-invalidates to the relayer
on any pre-broadcast failure with only a log line, is the shipped default builder for every
user. `package.json:19` runs tests for decoder, ammdecoder, curve, **sender** (a shadow module
nothing live calls), addresses, feedhealth, dipshadow, stratlab, migshadow, metadata, broadcast,
positions — and none for `txBuilder`, `liveSigner`, `risk`, `rentSweep`, `relayer`, `orders`,
`policy`, `sweep`, `rpcClient`.

**MISSED RISK.** `broadcast.ts:21-23` claims *"A wrong tip account cannot lose funds — the
lane's gateway rejects the tx and the RPC lane still carries it."* **False.** `injectTips` puts
tips *inside* the single signed transaction and `planTips` always seeds `lanes = ['rpc']`
(`:101`), so a stale tip address is paid on every landed trade. Ten Helius addresses (`:46-56`)
and eight Jito addresses (`:58-67`) are frozen in source with no refresh path, verified "against
docs 2026-07-24"; Jito ceiling 5,000,000 lamports (0.005 SOL) per sell. *(Whether any of those
18 addresses is currently stale is **unverified** — search budget exhausted.)*

**MISSED RISK.** `risk.ts checkToken2022Extensions` **fails open**: it switches on extension ids
1, 6, 9, 12, 14 and every other id hits `default: break`, treated as harmless. New dangerous
Token-2022 extensions ship as "clean" with no flag. Malformed TLV terminates the loop silently
and returns whatever was found so far.

**Two more orphan routes the finder missed.** `engine.ts:213` —
`if (p.exitReason === 'orphaned') this.liveMints.delete(p.mint)` with **no sell attempted**, on
reorgs. And `autoLiveSell` deletes from `liveMints` at `:700` **before** attempting the sell, so
a failed sell removes it permanently into `stuckMints`, which is `.clear()`ed at `:237` on
restart. Three distinct routes into the same un-exitable state.

**What is verified fixed.** Shadow-lab 66x optimistic fills (`positions.ts:63
FILL_LATENCY_MS = 800`, applied at `:235, :239, :243, :277, :283, :304-309`);
`maxSellVolumeSol` dead code (`engine.ts:1526`); `maxTopBuyerShare` phantom gate
(`engine.ts:1533`).

**Live-verified external.** PumpPortal charges **0.5% on each Local trade** (Lightning 1%), fee
computed before slippage (pumpportal.fun/fees, 2026-08-16). Helius Sender swqos-only minimum is
**5,000 lamports** and `broadcast.ts:38 HELIUS_SWQOS_TIP_LAMPORTS = 5_000` with `:34` correctly
appending `?swqos_only=true` — the pairing is load-bearing and currently correct. Free
rug-checkers are commoditized: defade.org ("100% free"), memecheck.co, Banana Gun honeypot
checks.

### 3.6 Monetization and trust

**The recommendation: take zero flow fee.** A 0.5% flow fee costs **1.0% of size per round
trip** — to the decimal, the exact saving `localTxBuild` was engineered and marketed to deliver
("turn localTxBuild ON — worth 1.0% of size per round trip"). Second-order: a flow fee makes
revenue a monotonic function of user trading volume while the product's honest advice reduces
volume. Every product decision then has a thumb on the scale.

**[CORRECTED] the achievable floor is 9.2%, not 7.1%.** `strat-swarm-2026-07-24.md` cost table
at 0.03 stake: local-build + ATA close = **9.2%** (config b). 7.1% is column b′, which
additionally assumes a *typical* fixed fee of 0.00137. The LAWS section defines the achievable
floor as (b). The conclusion strengthens: 1.0%/round-trip against 9.2% is 10.9% of floor at
0.03, and 15–22% of floor at the 0.05/0.10 sizes (6.5%/4.5%).

**[REFUTED] "Ship a `FEE_BPS = 0` constant asserted by a unit test."** `curve.ts:19` already
has `export const FEE_BPS = 100n;`. Shipping a second identically-named constant set to 0 into
one MIT repo hands every critic a one-line grep returning `FEE_BPS = 100n` from the project's
own source — **the exact screenshot attack the section was built to avoid, manufactured by the
fix.** Use a unique name (`KRYPT_FLOW_FEE_LAMPORTS = 0`) and rename the pump constant
`PUMP_PROTOCOL_FEE_BPS` in the same commit.

**[REFUTED] the bounded session wallet exists.** Every occurrence of `maxBalanceSol`:
`wallet.ts` declares it, defaults it to 2, persists it, echoes it in `info()`, validates
`0 < sol <= 100` in `setMaxBalance()` — **and nothing reads it for any decision**;
`src/pages/Wallet.tsx:259,374` computes `overCap` and renders "Above your N SOL cap — sweep
some out." That is the entire implementation. **And the strongest form cannot be built** —
nothing can stop inbound SOL to a Solana address, so "enforce on funding" is not implementable
as written. `maybeCashout` (`engine.ts:892`) is a **profit** sweep on an 8s poll against
`liveBaselineLamports`, never references the cap, and does nothing beyond a toast if
`homeAddress` is unset (`engine.ts:901`). **Therefore "worst case you lose your cap" would be a
false security claim published by an honesty-branded project.**

**[REFUTED] "zero fee, permanently and verifiably."** Not architecturally true.
`liveSigner.ts:95` — `const sources = p.local ? ['local','relayer'] : ['relayer'];` — falls back
to **PumpPortal** (`relayer.ts:10`, `https://pumpportal.fun/api/trade-local`) whenever the
learned template refuses (`txBuilder.ts:273` "samples disagree — layout in flux, refuse",
`:303`, `:372` "no learned template"). `relayer.ts` explains why: Pump's *"frequent (sometimes
unannounced) redeploys."* The codebase's own comment at `liveSigner.ts:67` prices that path at
**0.5% per side = 1.0% round trip = exact incumbent parity**, and it fires during correlated,
market-wide events — i.e. when the most users are trading and watching. **The flagship proof
panel renders the refutation**: on the fallback path it displays a 0.5% transfer to a
PumpPortal address under a heading saying nothing pays us. Good news: templates learn from
public chain data, not the project's tape, so this is a reliability problem, not a cold-start
problem.

**[REFUTED] Rabby proves fees are a liability.** Rabby's swap was **free** until it
**introduced** the 0.25% fee in July 2024 ("In the new version, we charge a 0.25% fee in our
built-in swap"). Trajectory 0% → 0.25%: a trust-branded, security-first wallet with far more
users than KryptSniper will have concluded it needed flow revenue, took it, and kept its users.
Cited honestly, Rabby says **zero-fee is hard to sustain** and this audience is less
fee-sensitive than assumed. (Also: Rabby is EVM-only, so weak evidence either way.)

**[CORRECTED] Azure eligibility, in the project's favour.** Not "US/CA/EU/UK businesses only" —
verified US/Canada/EU/UK businesses **and self-employed individuals**, with individual signup
via Entra Verified ID and a government photo ID. $9.99/mo Basic, 5,000 signatures. **Renamed
Azure Artifact Signing.** A solo dev can do this today.

**[UNCONFIRMED, load-bearing] TradeWiz's "$20/mo premium on top of 0.9% flow"** is the sole
cited precedent that a subscription is sellable in this market and it anchors the $19 price.
Reachable sources describe **$10–50/month tiers with a 0.85% platform fee** and no $20 tier.
Both quoted figures differ from the sources. Must be pulled from TradeWiz's own pricing page
before it appears anywhere.

**The honest blast radius is bigger than the DPAPI point.** `signVersionedTransaction`
(`wallet.ts:211`) is genuinely well-built — it re-derives the pubkey and refuses on mismatch
(`:220`), refuses if the fee payer is not this wallet (`:225-227`), refuses if
`numRequiredSignatures !== 1` (`:229`). **But it validates *who pays*, not *where funds go*.**
It will sign any single-signer transaction whose fee payer is the trading wallet — including a
full-balance `SystemProgram.transfer` to an attacker, which is exactly what `sweep.ts:25-32`
constructs on purpose. Combined with the non-existent cap and DPAPI's user-account binding,
**the real blast radius is the entire wallet balance.**

**What is genuinely better than the market and under-used.** In-app key generation
(`wallet.ts:112`), `safeStorage` encryption with a hard refusal when unavailable (`:109-111`,
`:131`), transient decrypt/`.fill(0)` scrub (`:124, :148, :198, :237`), secret never crossing
IPC (`preload.ts:47-57` exposes no getter). Against: Telegram bots generate and hold keys
server-side — Banana Gun, Sept 2024, a message-oracle flaw moved ETH out of **11 wallets
mid-trade, ~$3M**, reimbursed from treasury. Axiom uses Turnkey enclaves — the key is in
someone else's TEE, not on your device. **Device-local key + OS encryption beats every major
incumbent's custody model.** Say it — but never call DPAPI malware protection: it is scoped to
the OS user account, so any process running as that user decrypts `userData/wallet.json`
without a prompt, which is the same boundary Chrome cookie theft walks through daily. And
`backupToFile()` writes an **unencrypted 64-byte keypair JSON** — precisely the artifact
infostealers grep for — with no passphrase and no warning.

**Legal posture (practical, not advice).** FinCEN: non-custodial software is not money
transmission; the test is *total independent control*. Practical rule: never take custody,
never run a relayer that touches funds, never route through a project-controlled address. IRS
DeFi broker rule repealed 2025-04-10 by CRA (H.J.Res.25 / TD 10021) — no 1099-DA obligation
for a front-end today. **MiCA is where a flow fee bites**: distributing non-custodial software
is not CASP activity, but an *ongoing business relationship with users* pushes toward CASP
status, and a per-trade cut from every EU user's fill is exactly the fact pattern a regulator
points at. **A flat subscription is materially cleaner than a flow fee under MiCA** — an
independent argument for the same conclusion. UK FCA financial-promotions exposure remains
**unverified for 2026 specifics** and should stay flagged until any ad spend is contemplated.

**The 2026 threat pattern is release-pipeline compromise, not code bugs.** Bitwarden CLI
trojanized via the GitHub fork network + workflow permissions (Apr 2026); 18 `@injectivelabs`
npm packages backdoored to steal seed phrases (Jul 2026); a self-propagating npm worm (Apr
2026); 454,600 new malicious OSS packages in 2025, cumulative 1.23M.

---

## 4. Contradictions adjudicated

**4.1 — Is the market collapsing or recovering?** *Monetization* said pump.fun revenue fell
$130M+ (Jan) → $24.96M (Jul 2026), −80% in six months, traders −62%, memecoin mcap $85B →
$65B. *Competitive* said the category is down ~75% from peak. Both framed the trend as
ongoing.

**Ruling: the drawdown is real, the freefall is not current.** Assembler's own DefiLlama check
2026-08-16: pump.fun trailing-30d **fees $34,373,720**, **revenue $26,296,470**, **change_1m
+58.98%**, change_7d −0.04%, all-time fees $1,176,004,547, 1-year revenue $325,203,931. The
July figure was a local low; the most recent month is **up 59%** and the last week is flat.
Axiom DAU is *up* 48% July→August. **Plan against a market at ~25% of its January peak that is
currently stabilizing, not one in freefall.** Do not publish "the market is collapsing" — it is
falsifiable in one API call, which is the one class of error this brand cannot afford.

**4.2 — Rent sweep: best acquisition hook, or dead?** *User-demand* called it "the best
onboarding hook in the tree." *Honest-intel* called it "the strongest acquisition hook in the
entire corpus." *Competitive* called it "genuinely unique, demonstrable, quantifiable."

**Ruling: all three finders are wrong, unanimously and for compounding reasons; the verifiers
win.** (a) `rentSweep.ts:39` reads `wallet.publicKey()` — the **in-app-generated** wallet
(`wallet.ts: generate()`), which owns zero token accounts on a fresh install. It returns "no
empty token accounts" and 0 SOL for **100% of first runs**. (b) `engine.ts:849-850` gates it
further on `s.execution.liveEnabled`. (c) Making it fire requires importing a six-month main
wallet's private key into an unsigned Electron binary, into a slot `wallet.ts:128` restricts to
one wallet ever — the exact act the install-trust feature exists to prevent, and the opposite
of the app's own stated design at `wallet.ts:3` ("separate trading hot wallet"). (d) It is
commoditized: sol-incinerator.com is web, no install, non-custodial via browser signature, 2%
fee — leaving KryptSniper a **sub-$1 advantage on 100 ATAs**. (e) ScreenerBot auto-closes ATAs
every 5 minutes.

**What survives:** the **read-only paste-an-address scan**. `getTokenAccountsByOwner` needs no
key, so "you have 412 empty token accounts = 0.84 SOL reclaimable" works on any address, day
one, zero risk, genuinely pre-trust. The sweep is the conversion, not the hook. And report the
**observed lamport delta**, not `closed × 0.00203928` (`rentSweep.ts:28`) — an honesty brand
undercut by its own flagship counter is the worst available failure.

**4.3 — Creator base rates: highest defensibility, or cut?** *Honest-intel* ranked defensibility
**"Highest"**. *Competitive* and *user-demand* proposed shipping 34.3%/29.1% vs 2.66% on screen.

**Ruling: cut for v1, on four independent grounds, any one of which is sufficient.**
(i) **The number failed to replicate.** `docs/amm-decoder-2026-07-25.md:113-124` re-ran A7
point-in-time with no look-ahead: proven creators **93/407 = 22.85%**, everyone else
**515/19,166 = 2.69%**. The doc's own words: *"An 8.5× lift, independently reproduced on a
different day with a stricter protocol. The effect is real."* The **effect** replicates; the
**number** does not. Shipping the higher of two internal measurements when the stricter
protocol produced the lower one is exactly the overclaiming this brand exists to attack.
(ii) **It is not reachable by a human.** Same doc, entry-delay sweep over all 863 usable
graduations from an actually-fillable price: **0s (migration block) +0.9% median; 1s −3.2%;
5s −5.1%.** Doc's conclusion: *"the value is real and is taken inside the migration block."*
Decision 2 is manual execution. **Every human-reachable entry delay has a negative median.**
Displaying a graduation probability next to a buy button is an implicit buy recommendation for
a trade the tape says loses money at 1 second — *the same failure mode as copytrade, the thing
the project is proudly refusing to ship.*
(iii) **The baseline is irreconcilable.** 2.66% against RED-PUMP-2026's pooled **0.198%** over
832,941 launches (arXiv 2607.02823, Wilson CI [0.189%, 0.208%], 2026-05-08 → 06-10) — 13x
apart. Either 2.66% is a filtered subpopulation (almost certainly: the recorder's scoring
gates), in which case "34.3% vs 2.66%" is a within-filter statistic a badge would be misread
as a population rate; or the true lift is 173x and nobody should believe it.
(iv) **It cannot run on a fresh install.** `creators.ts:38-40` falls back to
`{version:1, creators:{}, blacklist:[]}` on any read failure; `creators.ts:10-16` defines
`completions` as *"launches that reached curve completion **while we watched**"* — so a
part-time user's base rates are biased in an **unquantified direction** and displayed
confidently. This also kills the finder's cheap half: the trap-warning's `launches` count is
equally empty.

**What survives:** the **trap as a static finding** — "has graduated before" alone selects
farms, **85% early-dumped** — plus "this edge is consumed inside the migration block; you
cannot reach it by hand." No per-user tape, no server, on-brand, and it is the only version
that is an anti-signal rather than copytrade wearing a lab coat.

**4.4 — Is the desktop form factor an asset or a tax?** *Honest-intel* argued it is an asset:
a seven-block pre-trade interstitial is structurally impossible in Telegram. *User-demand* and
*competitive* argued it is a ~10x reach tax.

**Ruling: it is a tax, and the "asset" argument is backwards.** The incumbents' advantage is
being one tap inside an app the user already has. The proposal stacks a desktop install, a
private-key import, and a modal between the user and the buy button they came to press. The
interstitial is a **conversion tax modeled nowhere in the swarm**. The genuine desktop
advantages are narrower and real: the key never leaves the machine (every Telegram bot custodies
server-side), no operator fee, and local tape/replay/backtest for a small power-user slice —
which is exactly the slice that evangelises. *(The interstitial does have a correct home:
onboarding and a rehearsal/simulate run, not the hot entry path — see §6, Zero-fee proof
panel.)*

**4.5 — All-in cost panel: days, or months?** *User-demand's* verifier found the cost path
verified present and **Electron-free** (`feeEstimator.ts` 112 lines importing only
`@shared/types`; `jitoTips.ts` 47 lines, plain fetch, zero Electron coupling) and called
extraction genuinely cheap. *Honest-intel's* verifier priced it **weeks-to-months** (new
`FeeConfig` decoder + tier table + curve/AMM branch + MEV row + interstitial + provenance
layer). *Competitive's* verifier said 1–2 weeks and noted `feeEstimator.ts` supplies **1 of 6
components** — compute-unit price percentiles only, via Helius `getPriorityFeeEstimate` with a
`getRecentPrioritizationFees` fallback; it computes no platform fee, no AMM fee, no slippage,
no ATA rent, no total.

**Ruling: both are right about different products. Split it.**
- **The web calculator** — arithmetic over published fee schedules plus live Jito tip floor and
  priority-fee percentiles, sized to a user-entered ticket. Days. No `FeeConfig`, no per-mint
  reserves, no Electron. **This is the acquisition asset.**
- **The in-app per-token panel** — on-chain `FeeConfig` decode, live reserves, curve/AMM
  branch, MEV disclosure row, provenance chips with stale states. **Weeks.** Gated on the
  manual buy surface existing at all.

**4.6 — "No telemetry" versus measuring success.** Decision 3 is "Success = adoption and
retention." *Competitive's* verifier: a tool with no telemetry can observe neither, and lands
in exactly Trench.Tools' position — a possibly-real user base and a dashboard reading 0.
*Distribution:* staged rollout and "did the release break" both require a callback; "No
telemetry" and "auto-update" are not simultaneously true.

**Ruling: this is a strategy contradiction, not a detail, and it needs a decision before
launch.** The honest resolution: publish exactly what the update check sends (version + OS +
nothing else), make it opt-out in Settings, and restate the promise as **"No ads. No analytics.
No account. No tracking. One update check, and here is its payload."** But — and this is the
sequencing correction the distribution finder got wrong — **the promise is already false in-tree
before any ping is added** (§8 items 3–4). Clean that up first, or the restated promise is
refutable with `grep` on day one.

**4.7 — Does anyone actually want honesty?** Asserted as the product thesis in *competitive*,
*user-demand*, *honest-intel* and *monetization*. Flagged as unevidenced by **three separate
verifiers independently**.

**Ruling: unproven, and every offered proof was refuted (§2, §3.2, §3.6).** The nearest
observable counter-evidence is Rabby: added a fee, kept its users. The nearest supporting
evidence is RugCheck — free, no account, no wallet connect, became the de facto DD standard by
telling people their token is bad — but RugCheck is a *free read-only web tool with no install
and no custody*, which is an argument for the web surface, not for the desktop app. **Ship
honesty because it is cheap, correct, and the only thing a fee-taking incumbent structurally
cannot copy. Do not forecast adoption from it. And treat any marketing plan whose first line is
"users want honesty" as unfunded.**

**4.8 — Which readiness item ranks first?** *Readiness finder:* `autoLive` is "the single
largest brand risk in the tree." *Verifier:* `autoLive` defaults **false** and needs two
switches plus arming; `autoSellOnExit` defaults **true** and dumps the wallet on one click.

**Ruling: the verifier wins on probability × blast radius.** `autoSellOnExit` first,
`autoLive` third. Both ship.

---

## 5. The competitive picture

### 5.1 Feature matrix (corrected)

| | Axiom | GMGN | fomo | Terminal | Trojan | Photon | Maestro | ScreenerBot | **KryptSniper** |
|---|---|---|---|---|---|---|---|---|---|
| Form factor | Web | Web+TG | Mobile | Web+TG | TG+Web | Web | TG | Desktop | **Desktop** |
| Custody | Turnkey TEE | Custodial-ish | Self | Mixed | Custodial | Custodial | Custodial | Local keys | **Local keys, in-app generated** |
| Honest all-in cost display | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **gap to own** |
| Fee-inclusive PnL | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **gap to own** |
| Realistic fill preview | ✗ (est. only) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | gap, not shippable (§7) |
| Creator history / base rates | ✗ | partial | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | gap, not shippable (§7) |
| Copy-trade **refusal** with data | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **gap to own** |
| Rent / ATA reclaim | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓ auto, every 5 min** [CORRECTED] | ✓ manual (`rentSweep.ts`) |
| Wallet-quality warnings | ✗ | partial | ✗ | ✗ | ✗ | ✗ | ✗ | RugCheck | RugCheck-equivalent (`risk.ts`) |
| Limit orders | ✓ | ✓ | partial | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (`orders.ts`, paper-only) |
| Copytrade marketed | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** [CORRECTED] | ✗ (research says don't) |
| Referral loop | ✓ | 25% | ✓ | ✓ | 10%+5lvl | ✓ | 25% | ? | **✗ structurally** |
| Security incident on record | ✓ (wallet surveillance) | — | — | — | — | — | — | — | — |

**9 of 9 competitors ship copytrade. 0 of 9 ship honest all-in cost display, fee-inclusive PnL,
or a data-backed copy-trade refusal.** That is a clean gap. The rent-reclaim row is no longer a
gap against the nearest analogue.

### 5.2 The four gaps worth attacking, ranked by (defensibility × day-one feasibility)

1. **Fee-inclusive PnL with the cost-basis method named on screen.** Universal gap — not even
   ScreenerBot's docs mention it. Computable purely from the user's own on-chain history and
   local fill records: **zero tape dependency, works day one for a stranger**. Naming the
   accounting method on screen costs nothing and no competitor does it. Industry-wide the
   complaint is documented: *"Displayed PnL may use mark price, exclude fees, or update before
   funding and slippage are applied."*
2. **Modeled cost floor, sized to the user's ticket.** Genuinely undisclosed — published
   analysis stops at 1.6–3.3%/trade on a **$500** ticket, and the fixed-cost blowup at a $6
   ticket is invisible in every public source. A *model* over live feeds plus the user's stake,
   not a lookup over tape.
3. **The copy-trade refusal page.** Structurally uncopyable: GMGN's entire brand is smart-money
   tracking, and 8 of the other 9 sell copytrade. Numbers verified to the decimal, mechanism
   structural (the measured quantity IS the price impact the follower pays), so it survives
   magnitude decay. Zero dependencies beyond shipped constants and prose.
4. **Graduation ≠ success.** 874 tokens migrated 2026-07-25; 22 days later **0 above $50k TVL,
   0 above $100k 24h volume, 30.5% under $100 TVL.** The most user-legible number in the corpus,
   class-level, slow-decaying, and refreshable monthly from GeckoTerminal for **$0**.

**The incumbents' structural disincentive is the moat, not the technology.** All four are
copyable in a week. None will be copied, because a panel printing "this round trip costs 7.9% of
your stake" next to a 1% platform fee is commercial suicide for a business that earns the fee.
**One caveat the verifier landed:** that deterrent is thinner than claimed — Axiom already
competes on published fee levels (0.95% Wood → 0.75% Champion with SOL cashback), Bloom 0.9%,
and the honest cost arithmetic is already on the open web at solanatools.io. The moat is the
*measurement and the refusals*, not the arithmetic.

---

## 6. Feature verdicts

All 47 proposed features. Effort is the **corrected** estimate where a verifier disputed the
finder's.

### Ship (14)

| Feature | Area | User value | Effort | Note |
|---|---|---|---|---|
| Fee-inclusive PnL, cost-basis method named | competitive | Universal gap; zero tape; works day one | days | Strongest feature in the swarm. Lead with it |
| Modeled cost floor meter, sized to ticket | user-demand | Genuinely undisclosed below a $500 ticket | days (web) / weeks (in-app) | Never hardcode 16.9%; compute live |
| All-in cost calculator (web version) | competitive/distribution | Shareable, linkable, no install, no SmartScreen gate | days | Best top-of-funnel asset in the swarm |
| Copy-trade refusal page | honest-intel | Uncopyable; numbers exact; decay-proof | days | Shipped constants + prose |
| Provenance chips + recorder coverage heartbeat | honest-intel/readiness | Precondition for every other number | days | Must include `stale`/`unavailable` states (`jitoTips.ts:17`) |
| Graduation ≠ success cohort card | honest-intel | 874/874, most legible number in corpus | days | $0 monthly refresh via GeckoTerminal |
| Signer-side decode + revalidate (easy half) | readiness | Closes the wallet-drain chain | days | Lamport cap + `homeAddress`-only transfer dest |
| Signature-persisted broadcast + timeout reconcile | readiness | Closes invariant 5 | days | Scope must include `engine.ts:213` and `:700` |
| Golden fixture tests for `buildLocalTrade` | readiness | Untested code is the shipped default | days | **Raise to release-blocking** (`types.ts:622`) |
| CSP + self-hosted fonts + `sandbox: true` | readiness | Makes "No telemetry" literally true | ~1 day | Fold metadata SSRF into the same pass |
| Signed releases + build provenance | monetization/distribution | Publisher name, Smart App Control, cert reputation | days + verification lead time | Azure Artifact Signing $9.99/mo |
| Supply-chain hardening of the release pipeline | monetization | Defends the failure mode that ends the project | hours | Hardware 2FA, ignore-scripts, `npm ci`, protected tags |
| Published revenue disclosure page | monetization | Right place to disclose the PumpPortal fallback fee | hours | Drop the unverified infra rev-share line |
| Legal minimums bundle (ToS, risk, no-advice, SIMULATED, TRADEMARK.md) | monetization | Cheapest holes closed; only defence against a rebranded fork | hours | MiCA independently favours no flow fee |

### Needs rework (16)

| Feature | Area | Rework required | Effort |
|---|---|---|---|
| Verifiable trust layer | competitive | Ship signing + published SHA-256 + outbound-connection panel. **Do not advertise reproducibility** until it works | weeks (identity verification lead) |
| Inline rent sweep | competitive/honest-intel | Read-only paste-address scan as the hook; sweep as conversion; report observed lamport delta | days |
| Honest stop-loss labelling | competitive/user-demand | Show scope + n on screen, or a generic warning with no fake precision | days |
| Creator base-rate card | competitive/user-demand | Invert to the trap only (see Cut) | days |
| Wallet cost audit ("paste an address, get your receipt") | user-demand | Web-first, 30-day lookback to bound RPC cost, multi-venue decoders | **months**, not weeks |
| Install-trust package | user-demand | SmartScreen reputation is **not purchasable**; no `.git` exists; `"private": true`; drop "watch-only default" (zero `watchOnly` hits in `electron/`) | weeks |
| All-in cost panel + size curve (in-app) | honest-intel | Add MEV-unmeasured row; hard-branch curve vs AMM; decode `FeeConfig`; rename "modeled cost floor" | **weeks–months** |
| Rent reclaim + close-on-sell | honest-intel | Hook is inverted; close-on-sell already exists (`txBuilder.ts:484`); sweep UI already exists (`Positions.tsx:75`) | days |
| Migration-age warning | honest-intel | Copy must say "reactive entry at +1/+5/+15s negative in 54/54; positions ≥3 negative on all days" — not "loses everywhere" | days |
| GitHub MIT + SignPath application | distribution | Reorder **behind** paid signing; re-justify on update-feed/canonical-artifact grounds | days + month-6 gate |
| Signed Windows release pipeline | distribution | Drop "reproducible" from v1; resolve jurisdiction first; fix `build/installer.nsh`, `png-to-ico`+`jimp`, `private`/MIT | days + lead time |
| krypt.cc web surface | distribution | **Unbundle.** Ship the calculator; downgrade the creator lookup to a dated published table | days (calculator) |
| Pre-trade risk preflight | readiness | Premise refuted (`checkMint` already shipped); no buy button exists. Salvage: honest cost before confirm + show rejected launches with reasons | weeks (needs the buy surface) |
| Local-build + ATA-close on manual sell | readiness | Split: (a) one line, `sweepAtaRent` after `manualSell`; (b) on-demand reserve fetch, separately | (a) minutes, (b) days |
| Zero-fee proof panel | monetization | Unique constant name; render the PumpPortal fee explicitly and labelled; move to onboarding/rehearsal, not the hot path | 1–2 weeks |
| Bounded session wallet | monetization | The cap does not exist and cannot be enforced on funding. Build reactive sweep + honest disclosure of the real blast radius | days |

### Defer (6)

| Feature | Area | Why deferred | Unblocked by |
|---|---|---|---|
| Keyless web funnel | competitive | Nothing keyless to show yet — the two things it would display are unbuilt or wounded | cost calculator + fee-inclusive PnL + signing |
| Stop-reality band | honest-intel | 0.525x is grad-zone-scoped; 15s-age entries gap at 0.92–0.94; refresh pipeline has no owner, cadence or degradation policy | provenance layer + a written refresh policy |
| Hardened auto-update with opt-out ping | distribution | Strictly gated on a signing identity; premise wrong (it is the third telemetry compromise, not the first) | signing + the privacy truth pass |
| Outbound-only Telegram alert bridge | distribution | Mislabelled as growth — produces none. Asks users to paste a **second credential** into a memecoin sniper | nothing; it is a later convenience |
| macOS signed + notarized | distribution | Correct at month 3. ~20–30% incremental (StabilityMatrix 13,775 mac vs 45,060 Win) | Windows launch; budget days-to-a-week, not "a day" — the tape path `E:\data` is a drive letter, so this is a port |
| External signing for money-in/out | monetization | Built on a bounded session wallet that does not exist as an enforcement mechanism | the cap actually being enforced |
| Unconditional startup chain reconciliation | readiness | Aimed at the wrong hazard — with `autoSellOnExit: true`, boot already reads the chain and liquidates everything | fixing the `autoSellOnExit` default first |

### Cut (6) — with cause of death

| Feature | Area | Cause of death |
|---|---|---|
| **Realistic fill preview** | competitive | Needs 38 GB of tape that cannot ship in an installer; a new install has **zero** tape so it is blank on day one forever; the tape is 4 dense days, 19 days stale, no longer collected; serving it from a backend contradicts both "No telemetry" and the BYO-RPC near-zero-marginal-cost model. Keep the *insight* — Jupiter quotes are not fills, sub-10bp is not fillable — as a static warning inside the cost panel. Hours, not weeks |
| **Rent sweep as the onboarding hook** | user-demand | Inert by construction: `rentSweep.ts:39` sweeps the in-app-generated wallet, which owns zero token accounts on a fresh install → **0 SOL for 100% of first runs**. Making it fire needs the main-key import the trust plan exists to prevent. Commoditized by sol-incinerator.com (web, no install, 2% fee) leaving a sub-$1 advantage on 100 ATAs |
| **Wallet anti-predictivity score** | user-demand | Two unsolved data dependencies, not one: an archival indexer **plus** ~60s-resolution OHLCV for every mostly-dead token the wallet touched. "Weeks" is off by an order of magnitude. And 0.737x@60s is a **cohort-level prior**, not a per-wallet measurement — the feature as pitched cannot be delivered by the numbers justifying it. Surface already owned by Kolscan since July 2025 |
| **Creator class badge + base rates** | honest-intel | Four independent kills (§4.3). The classifier does not ship free either — `creators.ts` sources launches/dumps/completions from local observation only, so a fresh install returns "unknown" for every creator and the trap-warning's launch count is equally empty. Keep only the static trap finding and the "Unknown creator" refusal |
| **Token & wallet quality flags (positive-signed)** | honest-intel | Lowest defensibility, highest chance of shipping the trap it condemns. RED-PUMP's 17.4x social lift on a 0.198% base is **3.4% absolute** — a full social stack still fails to graduate 96.6% of the time. MemeTrans's window is Dec 2024–Mar 2025 (pre-collapse, pre-fee-overhaul) on migrated tokens, and its result is that an ML model over **122 features** cuts loss 56.1%, not that individual features are user-facing flags. RugCheck ships most of this free at 3 req/s |
| **Krypt Pro $19/mo data tier** | monetization | Sells historical memecoin tape into a market at ~25% of peak. The 4% conversion is unsourced and every dollar flows through it; at 2% the 10,000-install case is ~$30–60/mo, and the finder's own honest denominator (10,000 installs ≈ 300–600 actives) gives $60–120/mo — **below the cost of the hosted infrastructure the tier requires**. Plausibly cash-negative at every user count it will realistically see, and it is the one thing that breaks "No telemetry" |

---

## 7. The new-user cold-start problem

**This is the test that killed more features than any other, and only one of the six sections
ran it.** The question: *on the first launch of a fresh install, on a wallet that has never
touched this app, does this feature show anything true?*

### 7.1 Works on day one — no tape, no server, no key

| Feature | Why it works | Dependency |
|---|---|---|
| Modeled cost floor / all-in calculator | A **model** over live feeds + the user's stake, not a lookup over tape | `getRecentPrioritizationFees`, Jito `tip_floor`, protocol constants |
| Fee-inclusive PnL | Computed from the user's **own** on-chain history + local fill records | RPC only |
| Copy-trade refusal page | Shipped constants + prose + the structural mechanism | none |
| Graduation ≠ success cohort card | Shipped constant (874/874) + free per-token GeckoTerminal lookup | GeckoTerminal 30/min, **Beta, "subject to changes"** |
| The creator **trap** as a static finding | "Has graduated before" alone selects farms, 85% early-dumped — a fact, not a per-user computation | none |
| Migration-age warning (detection half) | `migShadow.ts` decodes migrations live | RPC only |
| Read-only ATA rent scan | `getTokenAccountsByOwner` needs **no key** | RPC only |
| `risk.ts` mint checks | One RPC read per mint, already shipped and rendered | RPC only |
| Recorder coverage heartbeat | Ships, but reads **0.0h / 24** on a new install — internal hygiene, not a user feature | none |

### 7.2 Blank, biased or fabricated on day one

| Feature | What a stranger actually sees | What it would take |
|---|---|---|
| Creator base rates | Every creator "unseen" — `creators.ts:38-40` falls back to `creators:{}` | A Krypt-hosted signed, dated, versioned seed snapshot downloaded at first run and refreshed. That is a **data-distribution problem** (hosting, freshness, decay) and a server dependency for a tool that markets having none |
| Realistic fill distribution | Nothing. 38 GB cannot ship in an installer | A backend serving fill distributions — re-introduces per-user marginal cost and the exact data-collection surface "No telemetry" forbids |
| Stop-reality band | A number from **this rig's** tape at ~800ms latency, 0.03 SOL tickets, pump.fun launches, one July window, presented as *their* fill distribution | Ship as a **prior with provenance visible**, recalibrate against the user's own closes at n≥20 |
| Wallet anti-predictivity | A cohort-level prior rendered as a per-wallet verdict — a fabrication | An archival indexer + 60s OHLCV archive. Order of magnitude more work than estimated |
| Wallet cost audit | Nothing — `history.ts` reads the app's **own** local JSONL; `getSignaturesForAddress` appears once, at `txBuilder.ts:221`, sampling the PUMP program | A paid archival indexer (per-use marginal cost on a free viral artifact) + decoders for Axiom/Photon/Trojan/GMGN/Jupiter/PumpSwap |
| Local-build on a manual sell | Silent relayer fallback — `localBuildParams` (`engine.ts:666-679`) returns `undefined` unless the mint was discovered **this session**, and manual sells are recovery sells of yesterday's bag | On-demand bonding-curve account fetch and reserve reconstruction |

### 7.3 The structural conclusion

**Every intel feature that carries research romance pulls toward a backend that breaks both the
brand and the business model.** The only three options are: (a) ship a large static dataset that
decays immediately and must be signed, dated and refreshed on a stated cadence by a named owner;
(b) run a server, which re-introduces per-user marginal cost in a zero-revenue product and
creates the exact data-collection surface "No telemetry" forbids; or (c) don't ship the number.

**The corpus's own recommended answer, and the right one:** ship the tape-derived findings as
**static, sourced, dated warnings and refusals** — which is what six months of negative results
actually produced — not as per-user live signals the install cannot compute. Realistic
maintenance cost for the class-C constants that *are* worth keeping (survivorship cohort
monthly, stop band quarterly, copy-trade follower returns semi-annually): **one maintainer-day
per quarter plus a running tape**, published as a signed dataset with the app update. Anything
that cannot be refreshed on that budget ships as a **mechanism statement with no number** —
durable, still differentiating, and impossible to falsify.

**One corollary nobody stated plainly:** the recorder heartbeat makes the developer's numbers
**auditable**, not **portable**. Whatever base rates the product shows on day one are the
*developer's* numbers shipped as data — a materially different product, and a materially
different liability, from `README.md:8-9`'s "your own data, not someone's Twitter thread."

---

## 8. Readiness gate list

Ordered by probability × blast radius, with file:line citations. This supersedes the finder's
ordering per §4.8.

### Blocks public release

1. **`autoSellOnExit: false` by default** — or scope `sellAllHeld` to mints this session
   opened. Currently `shared/types.ts:632` is `true`; `engine.ts:336-337` fires
   `sellAllHeld('engine_stopped')` on the ordinary **Stop** button and dumps every SPL token
   `holdings()` returns, filtered only by `mint !== WSOL_MINT` (`engine.ts:812`), at
   `max(slippage, 15)`% through the 0.5% relayer. Also fires on quit (`main.ts:178`) and boot
   (`engine.ts:875`).
2. **Signer outflow cap + `homeAddress`-only transfer destination.** `wallet.ts:211-241` checks
   only fee payer and signature count. Drain chain is real and short: `ipc.ts:66` (unvalidated
   `Partial<AppSettings>`) → `ipc.ts:163` (`wallet:setHome`, no confirmation) → `autoCashout` →
   `sweep.ts:25-32` (bare `SystemProgram.transfer` to arbitrary `dest`) → a signer that validates
   nothing but the fee payer. **This needs no program allowlist — a lamport cap plus a
   destination rule closes it.** Do not let the hard half block the easy half.
3. **Metadata SSRF.** `metadata.ts:69-83` returns any `http://` or `https://` string from the
   pump.fun create event verbatim as a fetch target; `fetchOne()` (~`:108-125`) uses bare `fetch`
   with no `redirect` option, no private-range check, no DNS-rebinding guard, and applies the
   64KB cap **after** `await res.arrayBuffer()`. Called from `engine.ts:1238` with the
   creator-chosen URI. **Launch one token pointing at your own server and every running install
   calls you within milliseconds** — IP + timestamp of the entire live user base, refreshable at
   will, yielding a census, a deanonymization vector and a targeting list of who runs a sniper.
   Fix: CID-only resolution, gateway allowlist, no `http://`, `redirect: 'error'` or a hop cap,
   stream with an early byte ceiling.
4. **Make "No telemetry" true.** `shared/types.ts:641` → `discordRpcEnabled: true`, and
   `main.ts:119-151` pushes `"Scanning Pump.fun launches · N seen"` / `"N open · +X.XXX SOL
   paper"` to Discord and the user's entire friends list. `index.html:8-13` loads
   `fonts.googleapis.com` / `fonts.gstatic.com` remotely on every launch, sending IP and timing
   to Google. Both against `README.md:4`. Default RPC to off; self-host the woff2 files.
   *(Also: `discord-rpc@4.0.1` is unmaintained — avoidable supply-chain surface in a project
   whose top risk is supply-chain perception.)*
5. **`localTxBuild` — default back to `false` per its own docstring, or land the golden fixtures
   first.** `shared/types.ts:622` is `true`; `shared/types.ts:178-183` says *"EXPERIMENTAL —
   default off."* Untested + default-on + decides which accounts a signed instruction touches +
   self-invalidates to the relayer on failure (`liveSigner.ts:137-143`) is the worst combination
   in the tree.
6. **Delete the `autoLive` toggle and both auto paths.** `src/pages/Wallet.tsx:81-86` renders a
   Switch labelled "Fire REAL buys + sells automatically on qualified launches." The strategy it
   fires is measured at **−0.110 SOL over 25 closes, 8W/17L, with 17/25 exits `flow_reversal` and
   6 `creator_sell` — 92% from the two reactive protective exits the swarm proved
   value-destroying at 800ms** (`tape-audit-2026-07-25.md:44-47`), on defaults
   `exitOnCreatorSell: true` / `exitOnFlowReversal: true` (`shared/types.ts:611-612`). ~10 call
   sites, not five lines.
7. **CSP + self-host fonts + `sandbox: true`.** `grep -rn "Content-Security-Policy|onHeadersReceived"`
   returns **zero** hits; `main.ts:63` sets `sandbox: false` while the renderer displays token
   names, symbols and social fields that memecoin creators control. Mitigations are otherwise
   correct (`contextIsolation: true`, `nodeIntegration: false`, `webSecurity.ts:8-22` blocks
   off-origin navigation, no `dangerouslySetInnerHTML` in `src/`), so there is no known path
   today — but publishing the source publishes the attack surface. Budget a day for the
   Tailwind/WebGL `style-src` negotiation and a `preload.ts` audit.
8. **Correct the five false doc strings.** `README.md:3` ("shadow-mode sniping engine"),
   `README.md:49` ("v1 never holds keys, never signs, never submits a transaction"),
   `wallet.ts:14-16` ("Signing is intentionally NOT implemented here yet") — in a file whose line
   211 is `export function signVersionedTransaction`, `engine.ts:944` ("no real transactions will
   be signed"), `shared/types.ts:643` `shadowMode: true` with `settings-store.ts:36` commenting
   "v1 invariant — not user-flippable". All co-resident with `LIVE_EXECUTION_AVAILABLE = true`
   (`shared/types.ts:24`) and ~100 landed mainnet buys. **A public document that understates key
   custody is the worst possible artifact for this brand**, and a security reviewer who finds the
   `wallet.ts` header contradicting its own line 211 will read it as concealment regardless of
   intent.
9. **Golden fixture tests for `buildLocalTrade`** against pinned mainnet fixtures, plus a test for
   `liveSigner`'s guard arithmetic. `test/harvest.fixtures.mjs` and `ammdecoder.test.mjs` already
   establish the pattern. Pin the fixtures **and** keep the on-chain consensus sampling
   (`txBuilder.ts:273, :303, :311`) as the live check.
10. **`sweepAtaRent` after `manualSell`.** One line (`engine.ts:749-768`); captures almost all of
    the value the "local-build manual sell" feature claimed.
11. **Enforce or delete `maxBalanceSol`; validate `settings:update` main-side; require
    confirmation for `wallet:setHome`.** `wallet.ts:169`, `settings-store.ts:57` (spreads
    `execution` wholesale with no numeric bounds), `ipc.ts:66`, `ipc.ts:163`. Users read "Refuse
    to hold more than this" (`shared/types.ts:34`) as an enforced cap; nothing enforces it.
12. **Fix `curve.ts:19` `FEE_BPS = 100n`** before any cost panel ships — a 0.25%/side
    understatement inside the exact arithmetic whose selling point is honesty. Rename to
    `PUMP_PROTOCOL_FEE_BPS` and decode `FeeConfig` from `pfeeUxB6…` rather than hardcoding.
13. **Buildability.** `build/installer.nsh` does not exist and `nsis.include` points at it, so
    `npm run dist` **throws** (`app-builder-lib` `platformPackager.js:486` raises
    `InvalidConfigurationError` on a missing explicit resource); `scripts/make-ico.mjs` imports
    `png-to-ico` and `jimp`, neither in `package.json`; `"private": true` sits alongside
    `"license": "MIT"` and a description claiming "open-source"; there is **no `.git` directory**.

### Blocks scale

14. Persist the signature **before** submission; on confirm-timeout poll `getSignatureStatuses`
    with `searchTransactionHistory: true` and reconcile. `broadcast.ts:233`, `engine.ts:640`.
    **Scope must include** `engine.ts:213` (reorg orphan, no sell attempted) and `engine.ts:700`
    (pre-emptive delete before the sell) — a signature store alone fixes neither.
15. Key `broadcastAndConfirm` on `lastValidBlockHeight`, not wall clock. `broadcast.ts:197,:219`
    uses `Date.now() + 55_000` while `sender.ts:16` documents `lastValidBlockHeight`; with
    `txBuilder.ts:52`'s 20s blockhash cache the last ~15s are provably dead resends, reported as
    "expired unconfirmed" with no distinction between "blockhash expired" and "never propagated".
16. `disarm` must also clear `liveEnabled`, or `manualSell`/`sweepRent` must respect the disarm
    reason. `engine.ts:952`.
17. Recorder coverage heartbeat (wall-clock hours-covered/24) + surface `recorder.droppedCount()`.
    `grep -rni "hoursCovered|heartbeat|coverage"` over `electron/ shared/ src/` returns only two
    unrelated comments in `Radar3D.tsx:391` and `Tome3D.tsx:9`; `recorder.ts:107 stats()` returns
    `{files, totalBytes}` only; `recorder.ts:66 droppedCount()` has **zero callers** while
    `recorder.ts:52-57` silently `buffer.shift()`s at a 100k cap.
    `farming-swarm-2026-08-15.md:435` calls this the one unconditional ship item — F5 proved the
    rig recorded **1.6 hours of 08-08 and reported 11.6**, with `ReserveContinuity` detecting it
    at 152/447,733 = **0.03%**.
18. Remove the false tip-safety comment at `broadcast.ts:21-23` and add a refresh path for the 18
    hardcoded tip addresses (`:46-67`).
19. Persist `orders.ts` state to disk and rehydrate. `orders.ts:14-15` is `new Map()` / `new Set()`
    with no `fs`, despite the header at `:3-4` claiming the intent "is created and persisted
    BEFORE any fill". Also `engine.ts:1597-1598` transitions the intent to `filled_paper` then
    `reconciled` **before** `autoLiveBuy` fires at `:1604` — the intent is closed before the real
    money moves.
20. Show hard-rejected launches **with reasons** instead of filtering them out at
    `engine.ts:1346`. The consumer-protection value is currently thrown away by filtering.
21. Fix `risk.ts checkToken2022Extensions` to fail **closed** on unknown extension ids and to
    flag malformed TLV rather than silently returning partial results.

### Nice to have

22. Freshness assertion on `localBuildParams` reserves. `engine.ts:666`.
23. Wallet-scoped single-instance lock, not process-scoped. `main.ts:25` — two installs on two
    machines sharing a backed-up keypair currently have no interlock.
24. `importSecret()` cross-check of an imported 64-byte keypair's embedded pubkey against the
    derived one — a malformed paste currently yields a wallet the user cannot access elsewhere,
    which is a funds-loss path.
25. Optional passphrase on `backupToFile()` (`wallet.ts:196`), or an enforced warning.
26. `npm audit` in CI; SLSA build attestation so a hash traces to a commit (free, and cheaper and
    more convincing than chasing bit-for-bit reproducible Electron builds).

**Not on either list, and the largest unbuilt thing in the product: there is no manual buy
surface.** Everything Decision 2 implies hangs off a button that does not exist.

---

## 9. Distribution reality

### 9.1 The honest ceiling

| | Cumulative installs | Monthly active | Conditions |
|---|---|---|---|
| **6 months** | **1,500 – 6,000** | 400 – 1,500 | Signed, on GitHub, Discord push, 1–2 YouTube mentions, cycle holds |
| **18 months** | **8,000 – 30,000** | 2,000 – 8,000 | Sustained content cadence, macOS shipped, one breakout post |
| Downside | <800 | <200 | Unsigned, closed-source, no content, cycle turns |
| Upside tail | 50k+ | 15k+ | One genuinely viral artifact (a cost calculator that gets quoted everywhere) |

**Reasoning, with the verifier's corrections applied.** The anchors are GitHub release download
counts, live 2026-08-16: StabilityMatrix v2.16.2 Windows **45,060**, Bisq v1.10.4 Windows
**8,623**, Sparrow v2.5.3 Windows 9,734 (v2.5.2 was 12,795). **[CORRECTED] the finder's anchor
selection was internally inconsistent** — he named StabilityMatrix as the demographic analogue
("the memecoin-sniper demographic is gaming-PC-shaped") and then anchored the sizing table on
Sparrow, which is 4.6x smaller. Neither transfers cleanly: StabilityMatrix has no key-custody
trust barrier and a much larger TAM; Sparrow is throttled by Bitcoin-wallet caution. **The
order of magnitude survives and is the right thing to state plainly.** Two methodological
cautions to state alongside it: GitHub `download_count` includes CI, mirrors, scrapers and
re-downloads, so it is an upper bound on humans; and per-release counts are not cumulative
installs, which is the unit the table reports.

**The hard cap is not the .exe. It is the absent referral loop** (§3.4): 100% of the
competitive set runs 25–35% fee-funded referral programs, and a zero-fee product has no fee
pool, no commission, no influencer payout, no paid acquisition. Windows share for this
demographic is ~71% (StabilityMatrix profile) against a StatCounter June 2026 baseline of
Windows ~62% / macOS ~15% / Linux ~3%.

### 9.2 The offsets worth taking

1. **A zero-install web surface at krypt.cc** — the honest-cost calculator, the copy-trade
   refusal, the survivorship cohort, published as free, linkable, shareable pages. **Biggest
   single multiplier; 10x plausible.** Decisive additional reason the finder missed: **the web
   has no SmartScreen gate**, and SmartScreen reputation is no longer purchasable now that
   Microsoft removed automatic EV reputation — *"all certificate types build SmartScreen
   reputation through real-world usage rather than validation level alone"* (SSL.com). A
   zero-user project cannot buy out of the warning, and the warning suppresses the volume that
   earns reputation. **The web surface is the acquisition strategy, not a supplement to it.**
2. **Publish the killed-strategy research.** The only genuinely defensible growth asset: zero
   marginal cost, already written, and structurally uncopyable by a fee-taking competitor.
   **Three caveats the finder never raised.** (a) **Funnel tension** — the content argues
   memecoin trading is a losing game, so the best-performing version converts readers *away*
   from installing a sniper. (b) **Unauditable numbers** — they come from a private tape no
   reader can inspect, which to an audience saturated in fabricated backtests reads as
   marketing; publish methodology and sample sizes or the credibility argument inverts.
   (c) **Decay** — all of it is one 2026 regime; date every claim.
3. **Sign the Windows build.** $9.99/mo (Azure Artifact Signing, and self-employed individuals
   qualify) or $150–300/yr OV + HSM. **Resolve jurisdiction first — that single fact selects
   between the two.** Justify it on Smart App Control eligibility, publisher name in the dialog,
   and certificate reputation carry-forward — never on a fabricated conversion delta.
4. **Open-source on GitHub** — for update-feed hosting, a canonical artifact, SEO/social proof
   and eventual free SignPath signing. **Not** for "users will read the code" (78% of Bisq's
   users don't download the signature file) and **not** as impersonation defence (the cited
   SlowMist case *was* an open-source repo).
5. **macOS at month 3** — ~20–30% incremental for $99 plus days-to-a-week (not "a day": the tape
   path `E:\data` is a Windows drive letter, so this is a port).
6. **Microsoft Store: probably not.** Policies 10.2.6 + 10.8.3 + 10.14 require a verified Company
   account with a publicly displayed support contact for a product whose primary functionality
   requires private keys.

### 9.3 The unresolved legal surface

**HIGH, and no section covered it.** The plan ships an unlicensed tool that signs and broadcasts
financial transactions to strangers in unknown jurisdictions with no ToS, no risk disclaimer, no
"not financial advice", and no jurisdiction gating. MIT's warranty disclaimer covers software
defects, not financial-services distribution. Store policy 10.14 surfaces the same gap from the
other side. This needs a deliberate answer **before** an install base exists.

---

## 10. Monetization posture

**Recommendation: take zero flow fee. Do not build a subscription. Budget the product as a brand
and lead asset for krypt.cc, with a stated review date.**

**Why zero flow fee — the corrected reason.** Not because it is an uncopyable moat: BullX took
$203M in flow fees and stopped trading; Rabby went 0% → 0.25% and kept its users; Axiom already
tiers 0.95% → 0.75% with cashback and a 10% referral discount. **The reason is that this project
has no way to collect a fee that is worth the collection.** At realistic active counts a 1% fee
on a shrinking base is small money, and it costs the one asset the project has. It also inverts
the incentive on every product decision the app makes, permanently and invisibly. And MiCA
independently favours a flat software charge over a per-trade cut from EU users' fills.

**What it earns, at the swarm's own numbers** (10 round trips/day × 0.05 SOL ≈ 30 SOL/mo
two-sided volume per active):

| Model | Per active/mo | 1,000 actives | 10,000 actives |
|---|---|---|---|
| 1.0% flow fee (incumbent parity) | 0.30 SOL | 300 SOL | 3,000 SOL |
| 0.5% flow fee | 0.15 SOL | 150 SOL | 1,500 SOL |
| Pro $19/mo @ 4% conversion (unsourced) | $0.76 | ~$760 | ~$7,600 |
| Pro $19/mo @ 2% conversion | $0.38 | ~$380 | ~$3,800 |
| Tip jar @ ~0.5% donate, $10 avg | $0.05 | ~$50 | ~$500 |

**Read the denominator honestly.** 10,000 *installs* is not 10,000 actives — expect 10–20% to
fund a wallet and 20–30% of those to trade in a month, so 10,000 installs ≈ **300–600 actives ≈
$60–120/mo** from a Pro tier. That is below the cost of the hosted infrastructure the tier
requires. **The subscription is plausibly cash-negative at every user count this product will
realistically see**, which is why it is cut rather than deferred. And against §9's ceiling —
1,500–6,000 installs at 6 months — a flow fee at those counts earns roughly 45–180 SOL/mo, i.e.
$3,400–13,600/mo at $75.36/SOL, which is real money but is not enough to change the strategic
picture and is enough to poison the brand.

**Three things to ship instead, all in the "ship" list:**
- **Zero-fee, honestly scoped.** Not "zero fee, permanently and verifiably" — that is
  architecturally false on the PumpPortal fallback path (§3.6). The honest claim is: *"zero fee
  on the local build path; when Pump redeploys and the learned template refuses, we fall back to
  PumpPortal, which charges 0.5% per side. Here is when that happened to you and what it cost."*
  Weaker, and true.
- **The revenue disclosure page.** Hours of work; the right place to publish the fallback-fee
  disclosure. **Drop the infra rev-share line** until terms exist — no Helius/QuickNode affiliate
  terms were found (**unverified**), and publishing it would itself be an unsourced revenue claim
  on an honesty page.
- **A tip jar framed off a saving.** Expect it to earn near nothing; keep it for the signal.

**If zero revenue is unacceptable,** the honest fallback is a **flat, disclosed, capped fee shown
in-app before every send** — not a percentage. It will cost the brand line, and the brand line is
currently the only thing the product has that the 1%-fee incumbents cannot buy.

---

## 11. Build order

Six items, ordered. Everything else in §6 waits.

**1. The truth pass on the tree.** *Effort: 2–3 days.*
Gate items 1, 3, 4, 5, 6, 8 in §8: default `autoSellOnExit` to false, allowlist the metadata
hosts, default Discord RPC to off, self-host the fonts, default `localTxBuild` back to false,
delete the `autoLive` toggle, and fix the five false doc strings. **Reason:** every single one is
a 60-second find for a hostile reader the day the repo goes public, and three of them are
fund-destroying or user-deanonymizing. Nothing about the brand is defensible until this lands,
and no restated "No telemetry" promise survives without it.

**2. The signer floor + the renderer→funds gap.** *Effort: 2–3 days.*
Gate items 2, 7, 11: lamport outflow cap plus a rule that any `SystemProgram.transfer`
destination equals the stored `homeAddress`; CSP + `sandbox: true`; main-side validation of
`settings:update` and a confirmation step on `wallet:setHome`. **Reason:** this is the shortest
path from a compromised renderer to an empty wallet, it needs no program allowlist, and one
credible drainer report ends a free tool with no treasury. There is no reimbursement option.

**3. The manual buy surface, with the modeled cost floor in the confirm step.** *Effort: 2–3
weeks.*
The product's largest hole: Decision 2 says the user presses buy and there is no buy button
outside a mint-paste field on the Wallet page. Build sizing, the confirm flow, one click from a
Launches row — and put the cost model in the confirm step, not in a blocking interstitial. Ship
it as **"modeled cost floor"** with an explicit **"MEV / sandwich: unmeasured, sign negative"**
row carrying no number, hard-branched curve vs AMM with no self-impact printed off-curve, and
`FeeConfig` decoded rather than hardcoded (fix `curve.ts:19` in the same pass). **Reason:**
nothing else in the intel plan can exist until the button does, and this is the one panel that
works day one for a stranger with no tape.

**4. The signed, buildable Windows release.** *Effort: days of work + weeks of identity-verification
lead time — start the lead time during step 1.*
Resolve jurisdiction, buy Azure Artifact Signing ($9.99/mo) or OV + HSM, add
`build/installer.nsh`, add `png-to-ico` + `jimp`, fix `"private": true` against the MIT claim,
publish SHA-256s, one canonical download URL. **Reason:** the identity-verification lead time is
the long pole and it runs in parallel with everything else. Reputation accrues from download
volume, so signing early is strictly better than signing later. Do not promise reproducible
builds; do not apply to SignPath yet (it requires an already-released project).

**5. krypt.cc: the honest-cost calculator and the published research.** *Effort: 1 week.*
Static pages, no server, no key material: the cost calculator sized to a user-entered ticket, the
copy-trade refusal with its exact numbers, the 874/874 survivorship cohort, the creator trap as a
static finding, and the killed-strategy write-ups with methodology and sample sizes attached and
every claim dated. **Reason:** this is the acquisition strategy. The desktop binary has no
discovery surface and no SmartScreen-free path to a cold visitor; the web does. Every one of these
pages works for a stranger with zero tape and zero install.

**6. Fee-inclusive PnL + provenance chips + the recorder heartbeat.** *Effort: 1 week.*
Fee-inclusive PnL with the cost-basis method named on screen (universal gap, zero tape, computed
from the user's own history); provenance chips on every displayed number **with mandatory
`stale`/`unavailable` states** so `jitoTips.ts:17`'s hardcoded 23x-too-high fallback can never
render under a `live` chip; and the wall-clock hours-covered/24 heartbeat plus
`recorder.droppedCount()` surfaced. **Reason:** fee-inclusive PnL is the strongest single feature
in the swarm and it is the retention half of the product, where the cost calculator is the
acquisition half. The chips and the heartbeat are the precondition that stops the whole intel
layer from becoming a lie eight weeks after it ships.

---

## 12. Open questions

| # | Question | Why it is unresolved | What would resolve it |
|---|---|---|---|
| 1 | **Do users actually choose a tool for honesty?** | Asserted in four sections, evidenced in none; every offered proof refuted (Photon = rebates; Rabby went 0%→0.25% and kept users; Untaxed is token-gated; Trench's counters are un-instrumented) | Ship the krypt.cc calculator, instrument **page** analytics (a website is not the app and is not covered by "No telemetry"), and measure calculator→download conversion. This is the cheapest real experiment available and it is step 5 of the build order |
| 2 | **What jurisdiction and legal entity is Krypt?** | Genuinely decision-forking and unanswered | It selects Azure Artifact Signing ($9.99/mo) vs OV + HSM ($150–300/yr + token shipping), determines whether the Microsoft Store is possible at all (10.2.6/10.14), and determines the ToS/disclaimer posture. **Answer this first — it gates everything paid** |
| 3 | **How does a "No telemetry" product measure adoption and retention?** | Decision 3's success criterion is unobservable under the brand promise (§4.6) | A deliberate written decision: opt-in ping, update-check as a lower bound, or public download counts only — each with its cost against the promise stated in the same document |
| 4 | **Is the tape being collected again, and who owns the refresh pipeline?** | Last dense day is 2026-07-28, 19 days ago; the two later files are 1–4% fragments. Every class-C constant decays without it | A named owner, a stated cadence (survivorship monthly, stop band quarterly, copy-trade semi-annual), and a written **degradation policy** for what the UI shows when a constant is past its refresh date |
| 5 | **Are the 18 hardcoded tip addresses (`broadcast.ts:46-67`) still current?** | **Unverified** — search budget exhausted in the readiness pass. Verified "against docs 2026-07-24"; a stale address is paid on every landed trade because `planTips` always seeds `lanes=['rpc']` | Re-fetch Helius and Jito tip-account lists; add a refresh path |
| 6 | **What is GMGN's actual current Solana share?** | Contested: the verifier's explicit per-chain table gave 15.3% on the latest day; the assembler's re-fetch returned a conflicting paraphrase. DefiLlama's own description notes Solana was historically 50–70% | Pull `api.llama.fi/summary/fees/gmgn` raw JSON and read `totalDataChartBreakdown` directly. **Material** — it decides whether the co-leader is actively abandoning Solana memecoins (§3.1 missed-risk M5) |
| 7 | **Does SignPath Foundation permit one person to hold Author/Reviewer/Approver?** | **Unverified**; the whole point of the role split is separation of duty | Ask SignPath directly at month 6. Not launch-blocking (it cannot sign a first release anyway) |
| 8 | **Can Electron + NSIS builds be made reproducible at all?** | **Unverified**, and a hard problem (timestamps, embedded paths, per-build ASAR ordering, the signature itself). It is a SignPath hard requirement | Attempt it once at month 6. **Until it demonstrably works, never advertise reproducibility** — promising it is itself an overclaim |
| 9 | **What does an archival indexer actually cost for the wallet cost audit?** | The single unknown gating the two highest-ambition features (cost audit, anti-predictivity score). A free viral artifact with per-use marginal cost is a denial-of-wallet bug | Get a real quote from Helius/Triton/Shyft for paginated `getSignaturesForAddress` + `getTransaction` over a 30-day lookback. Do this before either feature gets any more planning |
| 10 | **Is TradeWiz's $20/mo + 0.9% real?** | **Unconfirmed** — it was the sole cited precedent that a subscription is sellable in this exact market, and reachable sources say $10–50/mo with a 0.85% platform fee | Open TradeWiz's own pricing page. Moot if the Pro tier stays cut (§6) |
| 11 | **What is the true MEV/sandwich cost to a retail pump.fun buyer?** | `farming-swarm-2026-08-15.md` registry line 513 lists it **UNMEASURED, sign a debit**, and "on top of X3". It is the largest known hole in the cost model | A measurement pass over a fresh tape with the sandwich pattern decoded. Until then the panel ships the row with **no number**, which is honest and still differentiating |
| 12 | **What does an interstitial or confirm step cost in conversion?** | Modeled nowhere in the swarm; the honest-intel section reframed the friction as a moat rather than pricing it | A/B the confirm step once there is a buy surface and enough users to measure. Until then, keep the cost panel in the confirm step rather than as a blocking modal |
