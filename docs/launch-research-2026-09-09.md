# Launching coins from inside the app: researched, and not built

Five researchers on: can we wire token creation on all three chains as a whole
section. Composition, create mechanics, build feasibility, outcomes, legal.

**Verdict: do not build it as a whole section.** Two of the five dimensions say
yes-and-here-is-how; the other three say the section as scoped is the wrong
shape. What ships instead is the thing the swarm de-risked on its way past: the
Solana instruction-discriminator rule, blocked since the LP swarm and now
answerable with measurements.

If a launcher is later wanted as a *utility* rather than as a way for a user to
make money, §7 names the only version of it the evidence supports.

---

## 1. The finding that decides it

The app's own shipped code condemns the only launch volume that could pay.

`shared/launchintel.ts:425` `creatorVerdict()` returns **fail — "Launch
factory"** at `launchesInBusiestDay >= 10`, and **fail** again at
`launches >= 8 && graduated === 0`. Rug rule R5 hides creators with ≥30
launches and no graduations.

Against that, the measured economics: EV of one launch with no audience is
**$1–3**, and **$0** on the 44% of current pump launches that are cashback
coins (they permanently redirect 100% of the creator fee to traders). The
hurdle bar this project applies to every strategy is $766–$1,531/yr on a
50–100 SOL bankroll. Clearing it at $1–3 a launch needs **250–1,500 launches a
year**.

> There is no launch volume that is both profitable and not condemned by code
> we already ship.

That is the same shape that killed LP farming, swing trading and airdrop
farming: **it fails on the ceiling, not the sign.** See
`docs/farming-swarm-2026-08-15.md`, `docs/lp-research-2026-09-09.md`,
`docs/airdrop-research-2026-09-09.md`.

And a launch button manufactures precisely the wallets `creatorVerdict` and R5
exist to hide. Shipping it at any scale pressures us to soften the most
reliable negative signal in the corpus. That is the conflict, stated plainly.

## 2. The base rate, from our own corpus

Held out on 07-27 over 73,890 launches:

| | |
| --- | --- |
| Never receive a single trade | **14.3%** |
| Dead by 10 minutes | **82.5%** |
| Dead or dumped | **86.2%** |
| Creator sells inside 60 s | **56.7%** |
| Graduate (raw) | **2.9%** |
| Graduate, stripping the 33% that complete within 1 s of create | **1.9–2.2%** |

Then the part that matters most, from `farming-swarm-2026-08-15`: of **874
tokens that migrated on 2026-07-25**, twenty-two days later **0 had volume
> $100k** and **9 (1.03%) had volume > $1,000**.

Compounded: **~1 in 5,000 launches becomes a token with a durable fee stream.**

Cross-checked live 2026-09-09 — pump API ~910 graduations/day against 30–44k
launches/day (2.1–3.0%) — and cross-venue against Pons, measured 2026-09-08:
12 graduations per ~800 launches (**1.5%**).

**What a success is worth to the creator: $26.** A pump graduation absorbs
85.005 SOL and the curve-side creator take is 0.300%, so the entire curve-side
income of a *successful* launch is **0.255 SOL** at SOL $102.09. Graduation
itself pays the creator nothing; it costs 0.015 SOL.

The one genuinely pro-creator fact found anywhere in this swarm: on PumpSwap
the creator fee peaks at **0.950% against pump's own 0.05%** in the $85k–$2M
band — a 19:1 split in the creator's favour. It applies to the 1-in-5,000 case.
Meanwhile LaunchLab moved the other way in a single month: platform fee cap
100→500 bps (2026-08-26) and the creator's locked-LP Fee Key reassigned to the
platform (2026-08-17).

## 3. Our own numbers refuse the obvious safety argument

The intuition is that a bundled, dev-heavy, sniped launch predicts a rug. Our
corpus says otherwise. `docs/rug-filter-2026-08-30.md` line 71:

> Every supply-share flag has lift < 1. Launches with a big dev position, a
> bundle, snipers or concentrated top buyers are **less** likely to be dead
> than average.

`bundle_share` has no signal at all (AUC 0.42–0.55). **This project cannot
honestly claim bundling predicts a rug**, and the Krypt Score already reflects
that: `shared/market.ts` renders `dev-holding`, `top10`, `top20`, `bundled` and
`sniper` at `weight: 0, kind: 'fact'` (lines 1303–1351). They are displayed,
not scored — so a launch bundled through our own fan-out would show its
concentration and leave the score untouched.

The honest objection to undisclosed concentration is not that the token will
die. It is that it transfers value from later buyers, which is true whichever
way the token goes.

## 4. What the app already is, one instruction short

There is no token-creation code in the repo today — one grep hit, and it is
`InitializeMint2` in `signPolicy.ts`'s tolerated-instruction set. Adding step 0
completes an otherwise finished chain:

    create -> fund.ts funds 20 wallets in 2 transactions
           -> planFanout has them buy one mint
           -> randomLab.ts (the Warmer) prints activity
           -> collectToActive sweeps it back

`fanoutBuy`'s jitter exists, per its own source comment, *"so the buys are not
identical round numbers that obviously came from one operator."* Two things
must be said alongside that: the composition already works today on somebody
else's token, and **Krypt takes 0.5%/side on every leg of it.**

**The signer does not stop a create.** `PUMP_PROGRAM` is in
`KNOWN_TRADE_PROGRAMS` (`electron/system/signPolicy.ts:48`) and the
program-granular check at `signPolicy.ts:272` constrains only programs *not* on
that list. A real mainnet `create_v2` payload was run against the shipped
`checkOutflowForTest` and **passed, with or without a dev buy.** The
`CreateAccount` and `SetAuthority` refusals never fire, because in all three
real creates decoded they are CPIs from inside the pump program, not top-level.

The only thing refusing a launch today is `numRequiredSignatures !== 1`
(`electron/system/wallet.ts:561`, `electron/engine/liveSigner.ts:733`).

> The app does not refuse to launch a token. It refuses to co-sign, and
> launchpads happen to need a second signature. That is a coincidence of how
> pump, LaunchLab and DBC mint, not a decision the policy made — a venue with a
> PDA mint would walk straight through today.

Measured signer counts on mainnet: pump **2**, LaunchLab **2**, Meteora DBC
**3** (payer + config + mint).

Also quantifiably wrong rather than merely absent: the loss guard. A bare DBC
create costs the creator 0.0307 SOL against a `bound` of 0.01, so it is
refused. Pump create+buy costs 0.1138 — passes at 10% slippage, refused at 1%.
Intermittent, unexplainable failures are the worst kind.

## 5. Create mechanics — established for all six venues

Every discriminator, selector, fee and limit below is sourced to an IDL, a
verified ABI, a decoded real transaction, or a read-only simulation. Nothing
was signed or sent.

| Venue | Create call | Metadata | Bare create | Integrable |
| --- | --- | --- | --- | --- |
| pump.fun | `create_v2` `d6904cec5f8b31b4`, 16 accounts | any HTTPS URI | 0.0065–0.0069 SOL | **yes** |
| LaunchLab | `initialize_v2` `4399af27da102620` (3 variants) | any URI, unvalidated | 0.0114 / 0.0232 SOL | **yes** |
| Meteora DBC | `create_config` + `initialize_virtual_pool_*` | any URI | 0.0103 / 0.0232 SOL | **yes** |
| Pons V2 | `launchAndBuy` `0xf85f8e41` | **entirely on chain** | 0.00104 ETH | **yes** |
| Boop | `create_token_fallback` `fdb87ec7ebe8aca2` | any URI | 0.0213 SOL | no — dead venue |
| four.meme | `createToken(bytes,bytes)` `0x519ebb10` | four.meme's DB | $0.034 | **no — backend gated** |

- **Creation is simulatable everywhere it matters**, proven not assumed: an
  unsigned pump `create_v2` for a fresh mint returned `err: null` at 94,902 CU,
  and a 33-character name surfaced `NameTooLong (6043)` *before* signing. The
  app's existing `rpcClient.simulateTransaction` call shape is byte-for-byte
  the one that works.
- **four.meme cannot be integrated at all.** The manager verifies an ECDSA
  signature from `signer() 0x6f3f71e8…` over a backend-issued single-use
  `requestId` with a ~90 s deadline — proven by three distinct on-chain
  reverts. That is a hard dependency on another company's API, and there is no
  message-signing path anywhere in this repo. It also **geo-blocks**: the site
  returns 403, *"Due to your current location, access to our services is
  restricted."* We gate nothing.
- **Boop is the ironic case** — the easiest create instruction of the six, on
  the only dead venue: 2 transactions in 24 h, zero launches in 30 days, and
  `graduate` needs an operator who stopped signing ~10 months ago.
- **Metadata is the real integration cost**, and only Pons avoids it: it stores
  logo, description and five socials as constructor args on chain. Every other
  venue takes a `uri` and leaves us owning "where does the JSON live and who
  keeps it alive" — a host, a privacy-policy line, a terms re-acceptance. No
  venue requires its own upload API (real pump launches point at j7tracker and
  uxento CDNs; LaunchLab accepted a fabricated URI in simulation).

## 6. Legal — no hard blocker, one product constraint, one open question

**The gap in our documents is real.** The words *create, creator, launch,
issue, issuer, mint, deploy, distribute* appear nowhere in any of the three
documents in a user-as-originator sense — a case-insensitive grep for
`creator|issuer|mint your|launch your` over `shared/legal/documents.ts` returns
**zero**. §4 "no advice", §5 third-party rules and §6 "risk of loss" are all
written in the grammar of a buyer. And ToS §12 currently asserts *"We do not
host user-submitted content"* (`documents.ts:156`) — a sentence that becomes
misleading the day the app publishes user-chosen names and images to a chain.

**The US position moved in our favour this year.** The 2019 SEC Framework was
withdrawn, superseded by a **Commission-level** interpretation (Release
33-11412, 91 FR 13714, 23 Mar 2026) holding that "digital collectibles … are
not themselves securities", defining the category to include "digital
representations or references to internet memes", and giving **WIF as a worked
example**. That is far stronger than the Feb 2025 staff statement, which the
SEC now footnotes as having "no legal force or effect". *Regulation Crypto
Assets* (33-11434, 21 Aug 2026) is **proposed only**; comments close
20 Oct 2026. UK: Cryptoassets Regulations 2026 passed 4 Feb 2026, the
admissions-and-disclosures regime bites 25 Oct 2027.

**The tool-maker question is genuinely unsettled, and our fee is what unsettles
it.** FinCEN FIN-2019-G001 protects tool-makers well — §5.2.2: a DApp developer
is not a money transmitter "even if the purpose of the DApp is to issue a CVC"
— and *Van Loon* (5th Cir. 2024) held immutable code is not sanctionable
property. But that is money-transmission and sanctions law. Searching both
current SEC crypto documents for `software developer`, `non-custodial` and
`front-end` returns **zero hits**. Meanwhile *Aguilar v. Baton Corp* has
**Solana Labs and Jito Labs on the caption** for third parties' launches — Jito
named as a tooling vendor because it **takes a cut** — and Roman Storm was
convicted on one count. No merits ruling in Aguilar.

**The one question for an actual lawyer:** can the publisher of non-custodial
desktop software be a statutory seller under Securities Act §12(a)(1) for a
user's unregistered offering **where the publisher takes a percentage fee on
the transaction that creates the token**? Our 0.5%/side is the fact that breaks
the analogy to every protective authority found: FinCEN's exemption is for
persons "engaged in trade", *Van Loon* is about code nobody charges for, and
*Pinter v. Dahl*'s "motivated at least in part by a desire to serve his own
financial interests" is the exact shape of it.

**The constraint drafting cannot fix:** MiCA Art. 4(1)(a) requires an offeror
to be a legal person, no Art. 4(2) exemption disapplies it, and the
"offered for free" escape is lost the moment the offeror takes fees. Only a
geo-gate on the launch feature, or a deliberate decision to accept it.

**And the thing that would become a blocker:** any feature that promotes users'
tokens to other users — a launches feed, promoted slots, a creator
leaderboard, a paid boost. That converts the app from a tool into a
distribution channel, toward MiCA's "placing of crypto-assets" and squarely
into the UK promotions regime.

> A launcher that deploys and gets out of the way is a very different legal
> object from one that helps a token find buyers.

Which lands on the same sentence the economics researcher arrived at
independently: **we can build the coin in four seconds, we cannot bring the
people, and nothing in this app will.**

Corrections to the record while there: the app is **not** code-signed
(`documents.ts:399`, `STATUS.md` in three places, no certificate config in
`package.json`), and Microsoft's published criteria have **no category for
token creation** — signing is content-neutral, so the launcher changes nothing
about distribution.

## 7. If it ships anyway — the only shape the evidence supports

Not as a "whole section", and **not Solana first**, because Solana's first line
is "relax the app's strongest invariant."

1. **Pons on Robinhood Chain, tier 1, 3–4 weeks.** Metadata is on chain, so
   there is no host to own. The app already self-indexes `TokenLaunched`, so
   the token appears in Discover in the same block. Simulation returns the
   CREATE2 address and the exact fill before signing. There is no dev
   allocation and no mint function, so we cannot hand users rug tooling.
   `checkEvmTx` is already selector-granular, so permitting a create is an
   `AllowEntry` — a rule stated, not a rule weakened. Pons's launch router is
   already in `chain.ts:45`.
2. **The strongest guardrails are not in our client.** Pons charges a **99%
   snipe tax, per recipient, decaying over seconds** — verified on chain by
   this project on 2026-09-08 via `currentSnipeTaxBps` — and Meteora DBC ships
   a Rate Limiter, Time Scheduler and Alpha Vault. pump.fun, four.meme,
   LaunchLab, Boop and Bags document **none** (Boop lets a creator take 50% of
   supply at creation; four.meme markets the atomic dev buy). A curve-level tax
   is the only guardrail a determined user cannot route around, and it is
   another reason to start on Pons.
3. **Do not wire launch to the fan-out.** That is the pump-and-dump composition
   in one button, and it is also the attribute that put Jito on the Aguilar
   caption.
4. **No promotion surface, ever** — see §6.
5. **Metadata: CID-only if it ships at all.** Accepting user-typed URLs makes
   this app a *producer* of the hostile input `metadata.ts` was hardened
   against.
6. **Terms: nine additions as one `TERMS_VERSION` bump.** The acceptance record
   hashes full document text, so any change at all changes the hash — ship them
   together. New §22 "Assets you create"; new §23 "What you must not create or
   distribute" (drafted as pump.fun §21's *prohibition* — "any capital raise,
   pooled investment scheme, profit-sharing arrangement" — not as an assertion
   that tokens are not securities); indemnity extension plus a role disclaimer
   naming issuer / offeror / underwriter / placement agent. Fix §12's
   "we do not host user-submitted content" in the same bump.
7. **Show the plain-language paragraph before the button**, whose load-bearing
   sentence is the one in §6.

Tier 2 (pump + DBC + LaunchLab) is 12–16 weeks total. Tier 3 (fan-out wiring)
is +4–6 and is the one to refuse: `broadcast.ts:40` is `bundleOnly=true` with
no `sendBundle`, and rebuilding that to launch-and-bundle is building the
machine §3 says we cannot honestly defend.

Also note there is **no devnet support anywhere in this repo**, so a "test
launch" costs real mainnet SOL.

## 8. What this swarm actually returned — build these

**1. The Solana instruction-discriminator rule (1.5–2 weeks). Now de-risked.**

It has been blocked since the LP swarm because getting the allowlist wrong
blocks an exit, and **a limit never blocks an exit**. The objection is now
answerable with measurements rather than argument:

- **18 of 25** sampled Jupiter routes were `route_v2` /
  `shared_accounts_route_v2` — an IDL-derived list would have blocked them.
  That is exactly the failure mode feared, now with a known shape.
- **0 of 25** top-level instructions were CLMM. So the CLMM, Whirlpool and
  DLMM allowlists can start **empty** and block nothing on day one, which is
  what makes the rule shippable incrementally.
- Live pump emits `buy_v2` (`b817ee61…`) while our own builder still emits
  `buy` (`66063d12…`). Worth knowing on its own.

This is the item worth building on its own merits today, launcher or no
launcher. It is also what makes §4's "a PDA-mint venue walks straight through"
stop being true.

**2. Three read-side decoder bugs.** `launchLabDecoder.ts:93–102` gates on
exact `CPI_LEN`/`LOG_LEN` then exact `BODY_LEN`; `boopDecoder.ts:68` is
`payload.length !== LOG_LEN`. Both silently discard the create events their
rails emit.

**3. Two code comments are now false.** "LaunchLab == letsbonk"
(`launchLabDecoder.ts:1`, `market.ts:2089`) — 14 of 14 recent creates were
StonkFun, and the rail has moved to Token-2022 with live transfer fees. And
four.meme "graduates into a PancakeSwap v2 pair" — only ~20% of its launches
are BNB-quoted. Also `dbcAccounts.ts` says DBC thresholds span five orders of
magnitude; measured across 2,000 configs it is **thirteen**.

**4. A standing tension, older than this question.** The Warmer generates
activity across wallets one person controls, and our own ToS §5 prohibits wash
trading. That is true today, before any launcher.

## 9. Added to the dead-ends registry — do not respend

Launching as a *strategy* (any volume, any chain) · a launcher wired to the
fan-out or to Jito bundles · four.meme create integration (backend ECDSA gate,
and it geo-blocks us) · Boop create integration (dead rail, no operator) · any
in-app promotion of user-created tokens (feed, leaderboard, promoted slots,
paid boost) · Krypt-hosted token metadata.

Still open and deliberately not decided here: a Pons-only tier 1 launcher as a
**utility**, on the seven constraints in §7. The evidence does not forbid it.
It does forbid pretending it makes the user money.

---

Raw reports: `scratchpad/launch/{composition,mechanics,build,outcomes,legal}.md`
