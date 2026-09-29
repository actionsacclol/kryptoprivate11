# Can the runner-confirm strategy break even? — swarm 3, 2026-09-28

Five agents, one question, asked after the script lost 0.34 SOL overnight: **is
there an entry filter, a confirm rule, an exit rule, a fake-volume / rug screen,
a size or a time window under which the runner-confirm strategy nets ≥ 0 per trade
after the real cost floor?** Agents: **selection** (flag-time facts, 4,954 classic
flags over five days), **execution** (every real fill since 09-19), **wash**
(wallet-level trade features on four tape days, 801 flags / 85 confirms),
**confirm** (confirm-rule × exit grid on 1-minute candles; interim), **review**
(adversarial re-derivation of every headline number in its own scripts). Reports
and scripts: the session scratchpad `swarm3/<agent>/REPORT.md`; brief in
`swarm3/BRIEF.md`.

## The answer

**No.** Nothing in five days of flags, four days of wallet-level tape, 428 real
fills or 12,324 filter sets has a held-out mean ≥ 0 at any size, for the owner
(Krypt fee 0) or a user. The least-bad configuration is −10 % per trade at 0.5 SOL.
The reason is not the fees, although they doubled the damage: **the confirm entry
loses at the swap level, before any cost**, and no fact available at the flag or
at the confirm separates the coins that run from the ones that fall.

| what | number | who |
|---|---|---|
| Overnight strategy result, swap level (no fees, no Krypt) | **−21.4 %** of SOL deployed | execution, review |
| Same, all-in as run at 0.015 SOL | −52 % | execution |
| Confirm entry, gross, +30 min (85 confirms, four tape days) | mean −27.9 %, median −46.7 % | wash |
| Coins at 1.5–2× / 2–3× / 3–5× the flag at +5 min: median path to +30 | −59 % / −75 % / −77 % | selection, review |
| Best held-out cell anywhere (flag buy, `mc0<$5k & site not false & 00–06Z`), 0.5 SOL owner | −10.2 %, n=45, CI [−15.8, −3.4] | review |
| Best confirm-entry exit (1.3× TP / −30 % stop / 10 min), 0.5 SOL owner, held out | −21 % (double-counted premium) / ≈ −6 % at the measured premium | wash, review |
| Oracle: drop every coin that rugs, keep the rest | still −29.4 % | wash |
| Oracle: keep only coins that go on to hit 1.5× before 0.5× | −13.1 % (−10 % with a 1.5× TP) | wash |
| Flag-time filter sets tried, ≤ 3 conditions | 12,324; 0 positive held out; the best sits inside a within-day shuffle | selection, review |
| Wallet-level rug screens, held-out AUC | 0.24–0.49 (flip sign between days) | wash |

## Why the money goes, in order

Execution decomposed the overnight −52 % of deployed SOL: **network-fee floors
−25 pts**, stop slippage −11 (stops filled at 0.53× entry on average, one in seven
at ≤ 0.3× because the rug was done before the order landed), price move to the
exit levels −13, tips −5, pump fee −2, entry premium −1. Two beliefs died:

- **The "1.19× entry premium" was never a price.** The SOL that reached the curve
  bought at 1.007× the confirm quote (n=35, CI 0.995–1.018). The 1.19 was the
  fixed fees on a 0.015 SOL bag. Both earlier swarms and the wash agent modelled it
  as a multiplier, which double-counts about 7 points at 0.05 SOL; corrected, every
  result is still negative.
- **The overnight dead zone was one bad night.** Five-day 2× rates by hour are
  flat (2.99 % vs 2.62 % in and out of 12Z–18Z); the run's 0-for-28 is the
  second-best of twelve six-hour windows and does not survive Bonferroni.

Three mechanical facts to keep:

- **Sizing quirk.** `txBuilder.ts:1486` asks for `tokensOut × (1 − slippage)` at a
  max cost of the request, so an unmoved price deploys 88 % of the request while
  the fee floors are charged on all of it.
- **Rent** is 1,513,840 lamports per first buy (the code comments say 2,039,280),
  refunded on a 100 % sell.
- **A "< 0.3×" rug cannot exist on a classic curve below ~29 % fill** (price
  cannot fall under the start price), which is why churn, holders and serial
  wallets ever read as "anti-predictive": they predict the curve level, not the rug.

## The floor, by size (zero move, owner / user)

| size | round trip | break-even gross move |
|---|---|---|
| 0.03 SOL | 14.6 % / 15.7 % | +14.6 % / +15.7 % |
| 0.05 | 9.6 % / 10.6 % | +9.9 % / +10.9 % |
| 0.1 | 6.4 % / 7.4 % | +6.4 % / +7.4 % |
| 0.25 | 4.6 % / 5.6 % | +4.6 % / +5.6 % |
| 0.5 | 4.3 % / 5.3 % | +4.5 % / +5.6 % |

pump 1.25 %/side (0.95 protocol + 0.30 creator), priority floors 0.001/0.002 SOL,
measured tips (sells mean 0.00044 SOL), curve impact from constant product at a
$25k classic curve (negligible under 0.25 SOL). Size only helps through the fixed
fees; it cannot turn a −21 % swap into a gain.

## What was tried and did not survive a held-out day

- Every flag-time fact: buyers, curve %, mc0, odds, age, links, creator launches /
  graduations / 24-h launches and their source, hour, day, flags-per-hour. Each
  fact that raises the 2× rate raises the rug rate as fast (mc0 15–25k: 34 % reach
  2×, 75 % go under 0.3×). First-time creators are the recurring positive-mean
  theme and a variance marker (2× 5.5 % vs 2.7 %, rug 18 % vs 11 %, median −19 to
  −46 %).
- Confirm variants: minutes since flag, mc floor, max x-from-flag, drawdown cap,
  rising closes. Interim on 09-24/25 → 09-26: best train mean +57 % with the top 3
  coins dropped −8 %, held out on 3 coins −68 %.
- Exits from the confirm entry: take-profits 1.3–3×, stops −20 to −50 %, trailing,
  time 3–60 min, the ladder as run (no rung ever filled on 45 held-out confirms).
- Wallet-level screens at the flag and the confirm: unique buyers, buys per buyer,
  top-buyer shares, churn, duplicate-size share, bursts, sell/buy SOL, creator
  trades, serial wallets (not buildable anyway). None holds sign across days.
- Sizes 0.03–0.5 SOL, owner and user fee.

## What a break-even would need

At 0.5 SOL the floor is +4.5 %. The best held-out configuration is −10 %. So the
strategy needs a **+15-point** improvement in selection or exit that none of the
data supports, or a market in which flagged coins stop halving after their spike.
The one thing that would change the arithmetic is not tunable: the winners are a
2.7 % tail, and a 45-coin cell expects about one of them.

## Recommendation

- Do not run this rule with real money. Paper only, if the callout flow is wanted
  for its own sake; the callouts pay about four cents each (09-26 measurement).
- If it must run live, the guards built the same day (`docs/script-guards-2026-09-28.md`)
  bound a night to a tenth of the wallet; they do not make it positive.
- The only entry the earlier swarms found near zero — creators with 2–10 launches,
  curve < 10 % at the flag, 1.3–1.5× take-profit — was −8.8 / −2.6 / +3.5 % on
  three days at n = 11 / 51 / 17. Too thin to call, and negative on the day with
  the most data. It is the place to look next if anyone looks again, on paper.

## Could not measure

The confirm agent's full five-day candle grid was still fetching at write time
(1,033 of ~2,300 mints); its interim folds agree with the tape-based confirm
study. July tapes have no post-graduation leg. SOL/USD on the tape days was
assumed at 118. Feed drop 10–20 %: every count is a floor.

## Addendum, later the same night: timing, earlier confirms, pullbacks, graduation

Two more agents answered the user's follow-up ("test confirming earlier, look at
what we bought, think of timing"): **confirm** on five days of 1-minute candles
(4,954 classic flags; 1,520 new candle series fetched) and **timing** on the
tick-level tapes with real fill latency (801 flags, 336 graduations on 09-16).
Both used the corrected entry (quote × 1.008 plus 0.0035 SOL fixed) and pump's
1.25 % curve fee. Held-out means per trade at **0.5 SOL, owner** (0.05 SOL in
brackets):

| Idea | candles (confirm) | ticks (timing) |
|---|---|---|
| As run (confirm at 10 min, ladder, −40 % stop, 15–30 min) | −28 % (−35 %) n=80 | — |
| Our confirm entry, best exit found: sell within 3 min | −13 % (−19 %) n=80 | — |
| Confirm earlier: minute 3, rising, take 1.3× within 2 min | −7 to −11 % (−13 %) n=57–98 | flag+180 s, rising, sell at 180 s: −5.1 % (−10.1 %) n=103, CI [−13.1, +3.6] |
| Buy the pullback: ≥ 30 % off the high, first 5 % reclaim, sell at 1 min | −10.1 % (−14.5 %) n=364 | −4.3 % (−8.7 %) n=100 |
| Buy the graduation, take 1.3× within 3 min | **−5.0 %** (−10.2 %) n=193, CI [−9.9, −0.8] | all graduations, TP 1.1× / 300 s: −1.4 % in-sample n=332, CI [−3.5, +0.5]; flagged graduates: +1.0 % on 20 held-out coins, top-3 dropped −3.0 % |
| Buy the graduation, hold 5 min | +3.5 % on one fold, −8.0 % on the other | −2.4 % (−8.0 %) |

Replay of the 29 coins we actually bought that have candles: no single change
makes the night ≥ 0. "Take 1.2× within 2 minutes" halves the loss (−0.086 vs
−0.187 SOL) and reads −2.7 % at 0.05 SOL owner on those 29, but held out across
every confirm the same family is −9 % at 0.5 SOL: the 29 are the coins that
survived long enough to have candles.

Latency at the graduation costs 0.4–1 point per second (the pool's first print is
a bundled sniper buy 1 ms after the migration; a fill 1.2 s later is already
1.14× the seed price). Two data corrections from the tick study, to carry forward:
September PumpSwap pools carry a **virtual 17.594 SOL quote reserve** (67.406 real
+ 17.594 = 85.0), so constant product on the events' reported reserves overstates
a fresh pool's tokens by 20–30 %; and the pool fee is **1.25 % / 1.2 % / 1.0 % per
side by pool size at every age**, never 0.3 %. The 09-14 volume-edge memo's fee
schedule was wrong on these pools; the app's PumpSwap quote should be checked
against the virtual term.

### Where that leaves it

Nothing in six studies, seven data days, 12,324 flag filters, 2,304 confirm
variants, 2,310 exits, three entry-timing families and wallet-level screens has a
held-out mean ≥ 0 at any size. The nearest is buying the graduation and selling
into the pool's first minutes: −1 to −5 % at 0.5 SOL for the owner, a real
mechanism (the post-migration drift), sensitive to a second of latency, and never
positive with n ≥ 30 and the top three coins dropped. It is the only candidate
worth a paper trial with real latency; nothing here is worth live money.
