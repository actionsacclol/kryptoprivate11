# Airdrop farming: researched, and the answer is no — with one exception worth building

Six researchers, one question: is farming crypto airdrops worth doing, and can
it be automated? Same rule as the API swarm — never invent a number; every
figure carries a fetched primary source or is marked UNVERIFIED.

**The answer: do not build airdrop farming. Build the thing underneath it.**

---

## 1. The arithmetic does not close

Break-even needs a joint hit rate — the protocol drops AND you qualify AND you
sell near claim price:

| Scenario | Hit rate required |
| --- | --- |
| Your labour valued at zero | 44% |
| 24 hours priced at $25 | **130%** |
| Payout valued at today's price, not launch day | **171%** |

A required rate above 100% is not a bad bet, it is an impossible one: no rate of
success suffices because the winners do not pay enough to cover the attempts.
And the sixth researcher found this model is still **too generous** — it nets at
the sale price, while most jurisdictions with a rule tax the drop **on receipt
at that day's value**. A drop that lands at $4,000 and is sold at $80 can leave
a tax bill larger than the proceeds.

**The medians are not the headlines.** Claimer-weighted median across seven
modern farmable drops: **$703**. The most-farmed drop ever, LayerZero at 741,986
claimers: **$130**, the second-lowest of the set. The widely-quoted "$4,562
average median" is an average of medians dragged up by one outlier, and its
source's totals do not reconcile with its own printed rows.

**Survivorship bias, measured:** Hyperliquid's mean allocation was 2,915 tokens
against a **median of 64.5** — a 45× gap. The "$20,000 average" headline
described what roughly one recipient in seven reached.

## 2. You cannot aim at the target

Of eight dated distributions checked with sources, the full eligibility rule was
publishable **in advance in exactly one**. The other six were fixed to an
already-past block. Both advance-announced cases then moved the goalposts — one
cut ~71% by a later vote, the other rewritten at least four times in sixteen
months with discretion explicitly reserved.

Farming is therefore not the execution of a plan. It is a bet on a guess about
a rule that does not exist yet.

## 3. Two of our three chains are out of scope

| Chain | Reachable for a self-custody desktop app |
| --- | --- |
| Solana | The only real one — and Jupiter now restricts to fee-paying activity, so farming costs real money in fees and spread |
| BNB Smart Chain | The airdrop layer is Binance's, not the chain's: off-chain, KYC-gated, jurisdiction-gated. **Not addressable at all** |
| Robinhood Chain | No chain token, and structural reasons to expect none — gas is already ETH (`shared/evm.ts:59`), the operator is a Nasdaq-listed broker-dealer, economics flow up to Arbitrum as a revenue share |

## 4. The multi-wallet version is the named exclusion, and our signer forbids it

Published filters describe the Wallet Lab exactly: clusters sharing a funder,
transfers of similar amounts inside a time window, repetitive actions at similar
intervals. One chain removed ~40% of claimants (516,960 of 1,297,203). Another
identified 803,093 addresses. One protocol's terms name *"splitting activity
across multiple accounts"* and *"activity primarily designed to farm points"* as
ineligible conduct outright.

Multi-wallet participation is generally **not contractually prohibited** — it is
unaddressed and unilaterally punished at distribution. An eligibility list is a
gift, not a promise.

**And our own signer already refuses the core action.** Verified in the repo:

- `electron/system/signPolicy.ts:406` — `Approve / ApproveChecked / SetAuthority   never (a delegate drains later)`
- `electron/evm/policy.ts:15` — refuses `approve()` to any spender but Permit2 or the router, because *"an approval is a standing drain and is the classic phishing payload on EVM chains"*

EVM farming is substantially about granting approvals to arbitrary third-party
contracts. Automating it means punching a hole in the most protective rule the
EVM policy has, for contracts nobody here has reviewed. That is not an allowlist
missing entries.

Also: pump.fun, LaunchLab, four.meme and Pons run **no points programmes**. The
multi-wallet capability we already have points at a surface with nothing to farm.

## 5. We have been here before, and we wrote the rule down

`farming-pivot-killed` (2026-08-15), after eleven agents killed fifteen candidates:

> **The cost floor collapsed 28–560x and it bought nothing.** Both families
> stopped being prohibited by cost arithmetic and started being prohibited by
> absence of alpha. **Do not propose a strategy on the grounds that costs no
> longer bind.**

Gas is now **0.8%** of a farming season's cost. That collapse is exactly what
let the farmer population explode and dragged medians from Arbitrum's $1,787 to
LayerZero's $130. Same failure, same shape, and our own August rule covers it.

That memory also says *"always compute the passive-yield comparison first — none
of the ten agents did, and it decides the question."* This time it was computed:
capital lockup priced at the 4.2% prevailing stablecoin yield is what makes the
break-even fail.

## 6. The harm surface is the dominant cost for a retail user

- **Tax on receipt**, in most places with a rule at all. See above.
- **Record-keeping:** ~4,000 events/year for a modest ten-wallet farm, each
  needing a fiat value captured at the time, under a US regime requiring
  **wallet-by-wallet** basis since 2025-01-01.
- **A single successful phish costs the whole wallet**, plus everything
  reachable through any approval it ever granted. Concentrated exactly at the
  moment someone clicks "claim".
- **Fake claim sites exist before the real airdrop does.** ScamSniffer's
  blacklist already holds 25 Pons-labelled and 31 Robinhood-labelled phishing
  domains. MetaMask's list covers **zero** of the Pons ones. The free feed is
  deliberately delayed seven days — structurally blind to the fresh domain that
  matters.

**The link can be correct and still drain you.** This is the part that settles
it. Legitimate front-ends get hijacked, and the attack is usually an approval:

| Incident | Date | Loss | Mechanism |
| --- | --- | --- | --- |
| BadgerDAO | 2021-12-02 | **$120.3M** | `increaseAllowance` injected via a stolen Cloudflare API key; ~12-day collection window |
| Curve DNS | 2022-08-09 | ~$612,724 | DNS hijack of the real domain |
| Ledger Connect Kit | 2023-12-14 | ~$610k | Supply-chain compromise; ~5h live, <2h draining |
| CoinMarketCap | 2025-06-20 | $43.3k | Compromised asset served from the real site |
| CoW Swap DNS | 2026-04-14 | $1.2M | DNS |
| Polymarket dependency | 2026-06-25 | ~$3.1M | Dependency compromise |

Note `eth.limo` (2026-04-18), where DNSSEC prevented all user impact — the
defence exists, it is just not something a listing feed can offer.

**Stale approvals are a standing, quantified loss.** revoke.cash's database
records **>$362M lost since 2020**, ~$21.3M across 8 incidents in 2026 to date;
a 2022 study found **60% of approvals (15.2M of 25.4M) are unlimited**. An
approval granted during farming keeps working long after the farming stops.

Regulators have noticed the airdrop vector specifically: FBI IC3 PSA
I-060325-PSA (2025-06-03) on NFT airdrops disguised as free rewards, and
I-030923-PSA (2023-03-09) on token-allowance revocation.

**Therefore: an app that holds keys must never render a clickable third-party
claim URL.** There is no feed trustworthy enough — verifying a domain does not
help when the correct domain is the one serving the drainer — and the failure
mode is the whole wallet.

## 7. Our own terms already say some of this

- ToS §5 / §6 put third-party rule-breaking on the user, which covers sybil
  disqualification cleanly. No change needed there.
- Software Terms §18 says *"We do not provide tax reporting and any figures the
  software shows you are not tax records."* A tax-grade ledger **contradicts
  that sentence.** Two honest exits: keep §18 and ship a **transaction log**
  that records and computes nothing, with the disclaimer inside the exported
  file; or amend §18 and re-prompt every user. Take the first.

---

## 8. The exception, and it is a good one

Every objection above is an objection to **speculative** airdrops: unknowable
criteria, moving rules, filters that catch fan-out, guessing dressed as
strategy. None of them touches a **published reward campaign** — a funded,
address-queryable rate running right now that can be verified before you act.

Those exist, at size, on our own rail. Verified with one keyless request to
`api.merkl.xyz/v4/opportunities?chainId=4663&status=LIVE`:

    Deposit USDe as collateral on USDe/USDG        $41,519/day
    [Robinhood Users Only] Steakhouse USDG vault   $35,878/day
    Kittenswap WETH-USDG                           $831/day
    UniswapV4 SPY-NVDA                             $682/day

    x-ratelimit-limit: 4200, 4200;w=60   (keyless)

And the one measured case where airdrops paid is the same shape: Hyperliquid's
**median** recipient — a perp trader doing what they already did — holds $5,355
today. Value accrues to people doing a thing for its own reasons who happen to
be eligible, never to people doing it for the eligibility.

**A trap to avoid if this is built:** Jupiter's claim-proof worker answers "not
eligible" with **HTTP 200, JSON content-type, `Content-Length: 0`**. That is the
refusal-as-success pattern the API swarm just spent a lane eliminating — except
here it would not degrade a chart, it would render as a factual claim about
whether a user has money waiting.

## 8b. The finding that outlived the question: approvals

The harm research turned up something more actionable than the airdrop answer,
including two corrections that make the picture *less* alarmist and one that
makes it worse.

**Corrections worth keeping, so nobody repeats the scarier version.** Approving
a junk token does **not** expose your other assets — EIP-20 scopes an allowance
to one token and one spender; the danger is the site it routes you to, not the
approval itself. And a Solana **transfer hook cannot sign away other assets**:
the sender's signer privileges do not extend to the hook program, so it can
block or tax a transfer and nothing more. The **permanent delegate**, by
contrast, has been abused exactly as feared — scammers have burned buyers'
tokens from inside their wallets. That is the one this app already flags.

**The real exposure is standing approvals, and it is measured.** LI.FI, 16 July
2024, **$11.6M**, reached wallets holding *infinite* approvals to its contract
across ~18–20 chains — and it had been exploited on the same surface in March
2022, so people who did not revoke after the first incident were drained **28
months later** by the second. Radiant Capital took $60M the same way. Roughly
$80M in 2024 and just over $6M across nine exploits in 2025. The only rigorous
prevalence figure is RAID 2022: **60% of approvals unlimited, 15.2M of 25.4M** —
with the caveat that the denominator is approval *transactions*, not wallets,
and the data ends July 2021 with no later measurement found.

**What that means for THIS app, stated accurately.** We do request unlimited
approvals — `electron/evm/uniswap.ts:379` grants ERC-20 `approve(spender,
MAX_UINT256)`. That is not a flaw in itself: the infinite grant goes to
**Permit2**, the audited singleton designed to hold it, and the actual spending
authority handed to the router at `:387` is `MAX_UINT160` **with an expiry**.
That is the recommended Uniswap pattern, not a mistake.

The gap is elsewhere: a user accumulates standing Permit2 approvals on every
token they have ever traded, and **there is no way to see or clear them inside
this app**.

**And the obvious fix — telling users to go and revoke — is actively
dangerous.** Drainers stand up fake revocation sites within hours of real
exploits: `revokes-drift[.]trade`, `revoke-kernelsdao[.]com`,
`revoke-zetachain[.]com`. Advice to "go revoke your approvals" creates exactly
the search those domains are bidding on. So §6's rule (ship no links) and this
one (help them revoke) only reconcile one way: **build it in-app or say
nothing.**

**Why this is not a redundant feature.** Revoke.cash covers 100+ EVM chains and
**no non-EVM chains — there is no mainstream revocation tool for Solana at
all.** For a Solana-first product that holds the keys and already has an
instruction allowlist, this is an unusually good fit. Note the attack differs by
chain: Solana's dominant payload is a **`SetAuthority` over the token-account
owner**, not an allowance, which is why `signPolicy.ts`'s allowlist is the right
defence there and why an EVM-style allowance inventory alone would miss it.

FBI/IC3's 2023 PSA recommends, in its own words, using *"a token allowance
checker… and revoke those permissions"* — i.e. the feature described here. No
regulator publishes a loss figure for it; IC3's annual reports contain zero
occurrences of "airdrop" or "drainer".

**Recommendation: an Approvals panel in Wallet Utilities** — inventory standing
approvals per chain, show which are unlimited, and revoke in-app with no
outbound link. Not part of Rewards; it belongs with the keys. Sized separately.

## 9. Recommendation

**Do not build airdrop farming, in any tier.** Not on legal grounds — it simply
does not work, and the automated version needs the signer's most protective rule
disabled.

**Do one of these two things with the Hub card:**

1. **Rebuild it as "Rewards" — a verification tool, not a hunt.** One new host
   (`api.merkl.xyz`), joined against the ledger and wallets we already hold, so
   the app answers "here is the published rate you are actually earning, and
   here is what you actually received" with **no address leaving the machine**
   for the derivation. Never a clickable claim link. Roughly the Tier 1 estimate
   of 1.5–3 weeks. Criteria stamped with source and `verifiedAt`, rendering as
   an em dash once stale.
2. **Remove the card.** Airdrop criteria have no on-chain change signal, so the
   `programWatch` + `decoderVerify` pattern does not transfer, and there is no
   forced-update channel. If nobody will own the upkeep, a stale eligibility
   claim about someone's money is worse than no feature.

Option 1 is worth building. Option 3 — shipping "Airdrop Hunter" as a farming
tool — is not on the table.

---

Raw reports: `scratchpad/airdrop/{economics,eligibility,sybil,data,build,user-risk,coordinator-checks}.md`.
