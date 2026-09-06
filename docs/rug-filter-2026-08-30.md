# Rug filter — what identifies dead / dumped pump.fun launches at t+30/60/120 s

Dataset `E:\data\work\launchset-2026-08-30\launches.parquet` (73,890 launches, 2026-07-25/26/27).
Scripts: `rug/rug_analysis.py` (all tables -> `rug/results.md`), `rug/final_rules_check.py` (-> `rug/final_rules_check.txt`).
Protocol: thresholds and rule sets chosen on **07-25 + 07-26 (train)**, evaluated **once on 07-27 (test)**. Test numbers are quoted unless marked.

Caveats inherited from the dataset README: the feed under-counts events by 10–20 % (all counts are floors); labels that could not be resolved are null and are excluded from every denominator (never 0); `curve_progress` is token-side; nothing post-graduation exists in the data.

## 1. Definitions

| name | exact definition | notes |
|---|---|---|
| `dead_by_10m` | no curve trade with offset in (300 s, 600 s]; null if coverage < 600 s | README column |
| `dumped` | `mult_at_5m <= 0.5` **or** `mult_at_30m <= 0.3 x peak_mult_10m` | `peak_mult_10m` is floored at 1.0, so the second clause also catches "-70 % by 30 min with no peak". Null only when both inputs are null |
| `bad` | (`dead_by_10m` or `dumped`) **and not** `graduated` | 65 % of graduated tokens are "dead on the curve" because curve trading stops at graduation; they are never counted as bad |
| `good` | `graduated` or `peak_mult_10m >= 3` | the false-positive currency; graduations are the budget |
| `creator_sold_fast` | `dev_sold_s <= 60` | outcome; the flag form is `creator_sold_{W}` |
| `bundled_and_dumped` | `bundle_share_15s >= 0.10` and `dumped` | |
| population at t+W | label resolved, `n_trades_W >= 1`, not graduated by W | zero-trade rows (n = 10,233; 99.6 % bad; 0 graduations) are excluded — "no trade seen" is an unknown (10 % of dev buys were missed by the feed), not a flag |

## 2. Base rates

| day | launches | zero-trade | dead_by_10m | dumped | bad | creator sold <=60 s | bundled >=10 % & dumped | graduated | 3x in 10 min |
|---|---|---|---|---|---|---|---|---|---|
| 07-25 | 20,089 | 12.9 % | 79.9 % | 13.2 % | 85.1 % | 57.8 % | 3.2 % | 3.3 % | 2.2 % |
| 07-26 | 20,648 | 13.7 % | 79.6 % | 9.9 % | 83.4 % | 57.9 % | 2.8 % | 3.1 % | 1.8 % |
| 07-27 | 33,153 | 14.3 % | 82.5 % | 9.3 % | 86.2 % | 56.7 % | 2.3 % | 2.9 % | 1.8 % |

Decision population at t+60 s: train n = 34,575 (bad 83.0 %, 768 graduations), test n = 27,937 (bad 85.1 %, 591 graduations, 2.2 % 3x runners).

**Consequence for every number below:** with an 85 % base rate, *any* flag has >= 65 % "precision". Precision is not the discriminating number. What matters is the lift over 85 %, the share of graduations the flag hides, and P(good | flagged).

## 3. Candidate flags — 2x2 at t+60 s, test day (07-27)

Full tables for 30/60/120 s, train and test: `results.md` section "Candidate flags". `P(bad|not)` = bad rate among un-flagged launches.

| flag | flagged | P(bad \| flag) | lift | recall of bad | P(bad \| not) | P(good \| flag) | grads hidden | 3x hidden |
|---|---|---|---|---|---|---|---|---|
| **baseline** | 100 % | 85.1 % | 1.00 | 100 % | — | 4.3 % | 591/591 | 100 % |
| *supply-share (what the terminal checks today)* | | | | | | | | |
| creator_share >= 10 % | 1.8 % | 70.8 % | 0.83 | 1.5 % | 85.4 % | 18.3 % | 50 (8.5 %) | 6.6 % |
| bundle_share >= 20 % | 6.6 % | 73.3 % | 0.86 | 5.7 % | 85.9 % | 6.9 % | 99 (16.8 %) | 4.4 % |
| sniper_share >= 25 % | 13.9 % | 69.8 % | 0.82 | 11.4 % | 87.6 % | 11.9 % | 256 (43.3 %) | 34.0 % |
| top3+creator >= 50 % | 0.6 % | 73.0 % | 0.86 | 0.5 % | 85.2 % | 27.0 % | 29 (4.9 %) | 2.3 % |
| gini(buy sizes) >= 0.7 | 7.1 % | 68.6 % | 0.83 | 5.9 % | 83.5 % | 7.4 % | 77 (14.0 %) | 4.6 % |
| *creator history (causal, tape-only memory)* | | | | | | | | |
| prior launches >= 3 | 73.2 % | 88.6 % | 1.04 | 76.1 % | 75.7 % | 4.1 % | 363 (61.4 %) | 77.2 % |
| prior >= 3 & 0 graduations | 46.7 % | 90.6 % | 1.06 | 49.7 % | 80.3 % | 2.4 % | 111 (18.8 %) | 32.2 % |
| prior >= 10 & 0 graduations | 34.7 % | 92.1 % | 1.08 | 37.5 % | 81.4 % | 1.9 % | 69 (11.7 %) | 19.0 % |
| prior >= 30 & 0 graduations | 21.9 % | 93.3 % | 1.10 | 24.0 % | 82.8 % | 1.5 % | 28 (4.7 %) | 9.7 % |
| prior fast dev-sells >= 3 | 59.5 % | 88.6 % | 1.04 | 62.0 % | 80.0 % | 4.1 % | 299 (50.6 %) | 64.0 % |
| *trade-shape (first 60 s)* | | | | | | | | |
| creator sold in window | 67.2 % | 87.3 % | 1.03 | 68.9 % | 80.6 % | 3.2 % | 302 (51.1 %) | 49.3 % |
| creator sold & <= 5 buyers | 30.7 % | 95.5 % | 1.12 | 34.5 % | 80.5 % | 1.1 % | 30 (5.1 %) | 11.0 % |
| sells/buys >= 1 | 39.7 % | 92.4 % | 1.09 | 43.1 % | 80.3 % | 2.1 % | 93 (15.7 %) | 23.8 % |
| sells/buys >= 1.5 | 7.0 % | 94.8 % | 1.11 | 7.8 % | 84.4 % | 1.8 % | 13 (2.2 %) | 3.6 % |
| largest buy >= 50 % of buy SOL | 47.1 % | 90.3 % | 1.06 | 49.7 % | 81.1 % | 0.5 % | 22 (4.0 %) | 7.1 % |
| largest buy >= 80 % of buy SOL | 35.5 % | 91.7 % | 1.07 | 38.1 % | 82.0 % | 0.2 % | 7 (1.3 %) | 1.8 % |
| wash: <= 2 buyers & >= 3 SOL bought | 3.4 % | 94.8 % | 1.11 | 3.8 % | 84.8 % | 0.4 % | 1 (0.2 %) | 0.5 % |
| unique buyers <= 1 | 26.9 % | 93.3 % | 1.10 | 29.5 % | 82.1 % | 0.1 % | 0 (0.0 %) | 1.0 % |
| unique buyers <= 3 | 46.5 % | 91.3 % | 1.07 | 49.8 % | 79.8 % | 1.6 % | 70 (11.8 %) | 22.0 % |
| net SOL <= 0.1 | 50.5 % | 92.1 % | 1.08 | 54.6 % | 78.0 % | 2.4 % | 154 (26.1 %) | 29.4 % |
| curve progress < 1 % | 49.8 % | 91.5 % | 1.08 | 53.6 % | 78.7 % | 1.8 % | 97 (16.4 %) | 25.6 % |
| *metadata* | | | | | | | | |
| no socials | 27.2 % | 83.8 % | 0.99 | 26.8 % | 85.6 % | 9.3 % | 296 (51.7 %) | 65.1 % |
| name <= 2 chars or blank | 2.9 % | 85.9 % | 1.01 | 2.9 % | 85.1 % | 6.0 % | 20 (3.4 %) | 4.6 % |
| metadata unresolved | 4.5 % | 85.4 % | 1.00 | 4.5 % | 85.1 % | 3.4 % | 18 (3.0 %) | 3.9 % |

Read-out:

* **Every supply-share flag has lift < 1.** Launches with a big dev position, a bundle, snipers or concentrated top buyers are *less* likely to be dead than average — those are the launches somebody paid attention to. They hide 5–43 % of graduations each. No threshold fixes this (the sweeps in `results.md` "Threshold sweeps" find no cut on any of them that beats the base rate at any budget).
* **"Creator sold within 60 s" alone is nearly useless** (87.3 % vs 85.1 % baseline) and hides half of all graduations, because serial *successful* creators also dump their dev buy instantly (creators with >= 4 prior graduations sell <= 60 s in 87 % of launches). It becomes sharp only combined with a "nobody else came" condition: creator sold & <= 5 buyers -> 95.5 % bad, 0.3 % graduated.
* **What predicts dead is the absence of real, distributed SOL**: one wallet's buy being most of the SOL, more sells than buys, nothing left in the curve. Lift 1.06–1.12, P(good|flag) <= 1 %, <= 5 % of graduations hidden.
* Metadata flags (socials, name, image) carry no dead/dumped signal; `no socials` hides 52 % of graduations.

## 4. The terminal's current thresholds, evaluated exactly as coded

`pctVerdict(v, good, bad)`: pass if `v <= good`, fail if `v >= bad`, else warn. dev = `creator_share_of_supply` (2/10); top10 ~ `top3_buyers + creator` (25/50; a lower bound for real top-10); bundled = `bundle_share` (5/20); sniper = `sniper_share` (8/25). The dataset holds *bought* shares; the code prefers *held* shares when balances are priced — held <= bought, so the live checks fire slightly less often than shown.

Test day, t+60 s (n = 27,937, 591 graduations):

| check | flagged | P(bad \| flag) | lift | recall of bad | P(good \| flag) | grads hidden | 3x hidden |
|---|---|---|---|---|---|---|---|
| dev FAIL (>= 10 %) | 1.8 % | 70.8 % | 0.83 | 1.5 % | 18.3 % | 50 (8.5 %) | 6.6 % |
| dev WARN+ (> 2 %) | 7.5 % | 69.8 % | 0.82 | 6.1 % | 11.4 % | 127 (21.5 %) | 18.2 % |
| top10 FAIL (>= 50 %) | 0.6 % | 73.0 % | 0.86 | 0.5 % | 27.0 % | 29 (4.9 %) | 2.3 % |
| top10 WARN+ (> 25 %) | 2.5 % | 72.3 % | 0.85 | 2.2 % | 23.3 % | 114 (19.3 %) | 8.5 % |
| bundled FAIL (>= 20 %) | 6.6 % | 73.3 % | 0.86 | 5.7 % | 6.9 % | 99 (16.8 %) | 4.4 % |
| bundled WARN+ (> 5 %) | 29.4 % | 80.6 % | 0.95 | 27.8 % | 3.7 % | 192 (32.5 %) | 18.7 % |
| sniper FAIL (>= 25 %) | 13.9 % | 69.8 % | 0.82 | 11.4 % | 11.9 % | 256 (43.3 %) | 34.0 % |
| sniper WARN+ (> 8 %) | 29.8 % | 77.8 % | 0.91 | 27.2 % | 8.6 % | 364 (61.6 %) | 57.5 % |
| **ANY FAIL** | 19.5 % | 71.9 % | 0.84 | 16.4 % | 10.6 % | **339 (57.4 %)** | 38.9 % |
| **ANY WARN+** | 48.3 % | 80.2 % | 0.94 | 45.5 % | 6.3 % | **455 (77.0 %)** | 65.5 % |

At t+120 s ANY FAIL hides 67 % of graduations; ANY WARN+ hides 85 %. Train numbers have the same shape (`results.md` "Current terminal thresholds").

**Re-tuning does not rescue them.** Choosing, on train, the best threshold for each of the four features at a 10 % graduation-hidden budget gives (test, t+60 s): dev >= 3.5 % -> 4.0 % recall, hides 16.2 %; top10 >= 37 % -> 0.8 % recall, hides 10.3 %; bundled >= 23 % -> 4.3 % recall, hides 14.9 %; sniper: no threshold stays inside a 20 % budget with > 3 % recall. The replacement is therefore not new numbers on the same features but the rule set in section 5, plus reframing these four as **dump-risk-once-alive** rows (section 6).

## 5. Rug filter — rule set (OR of <= 5 rules), chosen on train, evaluated once on test

Atoms chosen greedily on train from ~60 candidates (`results.md` "Rule set"), then hand-collapsed (nested thresholds merged). Every rule fires only on a known value — an unknown never trips a rule.

| rule | plain English | needs |
|---|---|---|
| R1 | `largest_buy_sol / buy_sol >= 0.5` — one wallet's single buy is at least half of all SOL bought so far | trade list |
| R2 | `sells / buys >= 1.5` | trade list |
| R3 | creator has sold **and** `curve_progress < 2 %` | trade list + curve account |
| R4 | `unique_buyers <= 2` **and** `buy_sol >= 3` (wash) | trade list |
| R5 | creator has >= 30 prior launches and 0 graduations | creator endpoint |

Held-out (07-27) results, cumulative (`final_rules_check.txt`):

| window | rules | flagged | P(bad \| flag) | bad removed | **dead removed** | dumped removed | grads hidden | 3x hidden | P(grad \| flag) | P(bad \| not flagged) |
|---|---|---|---|---|---|---|---|---|---|---|
| t+30 s | R1+R2 | 50.6 % | 89.8 % | 53.5 % | 57.1 % | 13.8 % | 57/618 (9.2 %) | 16.6 % | 0.4 % | 80.1 % |
| t+30 s | R1–R4 | 58.3 % | 90.0 % | 61.7 % | 65.6 % | 19.1 % | 75/618 (12.1 %) | 21.7 % | 0.5 % | 78.1 % |
| t+30 s | R1–R5 | 64.2 % | 89.6 % | 67.7 % | 71.7 % | 25.4 % | 102/618 (16.5 %) | 28.9 % | 0.6 % | 76.7 % |
| **t+60 s** | R1+R2 | 49.3 % | 90.5 % | 52.4 % | 56.3 % | 7.8 % | 30/591 (5.1 %) | 9.5 % | 0.2 % | 79.9 % |
| **t+60 s** | **R1–R4** | 62.3 % | 90.1 % | 66.0 % | **70.5 %** | 14.8 % | **57/591 (9.6 %)** | 18.7 % | 0.3 % | 76.9 % |
| **t+60 s** | R1–R5 | 67.3 % | 89.7 % | 71.0 % | 75.4 % | 21.1 % | 81/591 (13.7 %) | 25.8 % | 0.4 % | 75.7 % |
| t+120 s | R1+R2 | 48.9 % | 90.8 % | 52.1 % | 56.1 % | 5.0 % | 20/529 (3.8 %) | 3.6 % | 0.1 % | 80.0 % |
| t+120 s | R1–R4 | 69.1 % | 90.3 % | 73.1 % | 77.7 % | 25.6 % | 41/529 (7.8 %) | 16.1 % | 0.2 % | 74.2 % |
| t+120 s | R1–R5 | 73.4 % | 89.9 % | 77.3 % | 81.8 % | 31.2 % | 63/529 (11.9 %) | 24.0 % | 0.3 % | 72.7 % |

Trade-off curve (t+60 s, test) by graduation-hidden budget:

| budget | rules | dead launches removed | grads actually hidden | 3x runners hidden |
|---|---|---|---|---|
| 5 % | R1+R2 | 56 % | 5.1 % | 9.5 % |
| 10 % | R1–R4 | 70 % | 9.6 % | 18.7 % |
| 20 % | R1–R5 | 75 % | 13.7 % | 25.8 % |

Beyond ~10 % the curve is flat: no 5-rule set found on train spends a 20 % budget usefully (the greedy search returned the same set for 10 % and 20 %), because the dead launches that remain look, at 60 s, like live ones. Train-vs-test drift is small (train R1–R4 at 60 s: 67.7 % bad removed, 9.8 % hidden).

The **un-flagged** feed is still 77 % bad. The filter removes the launches nobody bought; it does not make the feed safe. What separates the rest is section 6.

A variant with count-based atoms (`unique_buyers <= 1` instead of R1; `creator sold & <= 5 buyers` instead of R3) reaches 57.5 % bad / 61.5 % dead removed at 8.0 % hidden — slightly worse and cheaper to defeat (section 8). Prefer the SOL-based set above.

## 6. Stage 2 — launches that are alive at t+60 s: what predicts *dumped*

Population: >= 10 unique buyers and >= 1 SOL net in the curve at 60 s, not yet graduated. Test n = 3,603: dumped 31.3 %, dead 37.1 %, graduated 7.4 % (266), 3x 3.6 %. This is the list a user is actually scrolling.

| flag (at 60 s) | flagged | P(dumped \| flag) | P(dumped \| not) | lift | P(dead \| flag) | **P(grad \| flag)** | P(grad \| not) | grads hidden |
|---|---|---|---|---|---|---|---|---|
| top3 buyers >= 25 % | 5.7 % | 74.9 % | 28.7 % | 2.39 | 22.7 % | 22.2 % | 6.5 % | 46/266 (17 %) |
| top3+creator >= 25 % | 8.3 % | 67.0 % | 28.1 % | 2.14 | 25.7 % | 23.7 % | 5.9 % | 71 (27 %) |
| bundle >= 40 % | 5.9 % | 63.2 % | 29.3 % | 2.02 | 19.8 % | 19.8 % | 6.6 % | 42 (16 %) |
| bundle >= 20 % | 25.0 % | 45.1 % | 26.7 % | 1.44 | 31.3 % | 10.9 % | 6.2 % | 98 (37 %) |
| sniper >= 50 % | 19.3 % | 45.3 % | 28.0 % | 1.45 | 22.9 % | 12.1 % | 6.3 % | 84 (32 %) |
| sniper >= 25 % | 46.1 % | 37.8 % | 25.8 % | 1.21 | 26.8 % | 8.9 % | 6.1 % | 148 (56 %) |
| creator holds >= 20 % | 1.9 % | 51.5 % | 30.9 % | 1.64 | 27.9 % | 25.0 % | 7.0 % | 17 (6 %) |
| no socials | 8.8 % | 57.2 % | 29.3 % | 1.80 | 32.7 % | 15.5 % | 6.7 % | 46 (18 %) |
| net SOL >= 20 | 23.8 % | 70.2 % | 19.1 % | 2.24 | 21.7 % | 22.0 % | 2.8 % | 189 (71 %) |
| curve progress >= 30 % | 47.4 % | 59.4 % | 6.0 % | 1.90 | 21.4 % | 13.9 % | 1.5 % | 237 (89 %) |
| sells/buys >= 1 | 18.4 % | 7.8 % | 36.6 % | 0.25 | 58.1 % | 1.7 % | 8.7 % | 11 (4 %) |
| net SOL <= 3 | 32.1 % | 8.9 % | 41.9 % | 0.28 | 60.9 % | 1.2 % | 10.3 % | 14 (5 %) |
| creator: prior >= 10 & 0 grads | 18.3 % | 29.2 % | 31.8 % | 0.93 | 43.9 % | 4.5 % | 8.0 % | 30 (11 %) |

Read-out: **among alive launches the concentration flags identify volatility, not rugs.** Top-3 >= 25 % is 75 % dumped *and* 22 % graduated (3x the population's graduation rate); bundle >= 40 % is 63 % dumped and 20 % graduated. They must never hide a launch — show them as a dump-risk row with both numbers side by side. Sniper share is the weakest of the group (lift 1.2 at the current 25 % fail line). Conversely `sells/buys >= 1` and `net SOL <= 3` mean "dying, not dumping" (58–61 % dead, 1–2 % graduate). Creator history stops mattering once a launch is alive (lift ~0.9). Train tables agree (`results.md` "Stage 2").

## 7. Creator reputation — lift table

`creator_prior_*` are causal (only events before this create). Tape memory starts 07-25 05:00 UTC, so on the test day a creator's history is up to two days deep; pump.fun's creator endpoint has the full history and would make these sharper. Test day, all launches with resolved labels (n = 33,153):

| creator state (as of this create) | share of launches | P(bad) | P(dead) | P(dev sells <= 60 s) | **P(graduated)** | grad lift | share of all graduations |
|---|---|---|---|---|---|---|---|
| first launch seen (prior = 0) | 22.3 % | 78.5 % | 77.0 % | 33.3 % | 5.9 % | 1.99 | 44.5 % |
| prior 1–2 | 11.5 % | 85.5 % | 82.7 % | 33.7 % | 2.4 % | 0.82 | 9.4 % |
| prior >= 3, 0 graduations (factory) | 43.5 % | 91.3 % | 88.4 % | 60.6 % | 0.9 % | 0.31 | 13.4 % |
| prior >= 8, 0 graduations (current `fail`) | 34.1 % | 92.3 % | 90.0 % | 63.0 % | 0.8 % | 0.27 | 9.3 % |
| prior >= 30, 0 graduations | 21.9 %* | 93.3 %* | 91.5 %* | — | 0.5 %* | ~0.2 | 4.7 %* |
| prior >= 3, >= 1 graduation | 22.7 % | 84.4 % | 76.8 % | 83.9 % | 4.2 % | 1.44 | 32.6 % |
| prior >= 3, graduation rate >= 20 % | 1.4 % | 61.1 % | 51.2 % | 45.1 % | **24.6 %** | **8.38** | 11.5 % |
| prior >= 3, sold <= 60 s in >= 80 % of them | 40.6 % | 88.7 % | 84.7 % | 97.2 % | 1.7 % | 0.56 | 22.8 % |
| prior >= 3, sold <= 60 s in <= 20 % of them | 15.7 % | 90.1 % | 87.1 % | 5.8 % | 1.8 % | 0.62 | 9.8 % |

\* t+60 s population. By prior-graduation count: 0 -> 2.4 % graduate; 1 -> 3.6 %; 2–3 -> 4.6 %; >= 4 -> 5.9 % (lift 2.0) — but those creators sell their own dev buy within 60 s in 77–87 % of launches, which is why "creator sold fast" is not a rug signal on its own.

Verdict on the existing `creatorVerdict()`:

* `launches >= 8 & 0 graduated -> fail` is confirmed (0.8 % graduate, 92 % bad). Extending it down to >= 3 loses little (0.9 %) and covers 43 % of the feed; >= 30 is the cleanest single rule (0.5 %, R5 above).
* `grad = 0 -> warn` for 2–7 launches is fine; prior 1–2 is at baseline.
* The sharpest **positive** signal is graduation *rate* >= 20 % with >= 3 launches (25 % graduate, 8x lift, 1.4 % of launches) — the current `rate >= 20 -> pass` line is right; it belongs to the runner analysis.
* "Prior fast dev-sell rate" adds nothing beyond the graduation count: >= 80 % and <= 20 % are both ~90 % bad. Not selling fast is mostly "never bought", not "diamond hands". Drop it as a flag; keep the count as a display fact.
* Reputation is **negative-only evidence**. A bad history is trustworthy (a wallet cannot un-launch); a clean history costs one fresh keypair. `prior = 0` carrying 45 % of graduations is partly real (new creators) and partly rotation.

## 8. Gameability

Test day, t+60 s population:

| what a ring can fake, and what it costs | condition | n | P(bad) | P(dead) | P(dumped) | P(grad) |
|---|---|---|---|---|---|---|
| buyer count (cheap: N keypairs, dust) | unique buyers >= 20 | 4,736 | 65.6 % | 49.2 % | 22.8 % | 5.3 % |
| ... but no SOL left behind | unique buyers >= 20 & net SOL <= 1 | 1,939 | 79.3 % | 76.8 % | 3.6 % | 0.6 % |
| trade count (cheap) | n_trades >= 50 | 6,478 | 71.0 % | 52.4 % | 34.3 % | 7.2 % |
| ... but no SOL left behind | n_trades >= 50 & net SOL <= 1 | 3,641 | 80.4 % | 68.8 % | 28.2 % | 5.6 % |
| SOL in the curve (costs SOL, at risk) | net SOL >= 10 | 1,563 | 65.9 % | 20.9 % | 62.6 % | 14.3 % |
| curve fill (costs SOL, at risk) | curve progress >= 20 % | 2,698 | 63.1 % | 31.1 % | 50.1 % | 11.5 % |

Flags ranked by cost to defeat:

| tier | flags | why |
|---|---|---|
| free | `unique_buyers`, `n_trades`, `trades_per_second`, `has_socials`, image, name — and **`creator_prior_* = 0`** (wallet rotation) | keypairs and metadata are free; counts are also the fields a lossy feed under-reports |
| cheap | `bundle_share`, `sniper_share` split (buy from more wallets across more slots) | changes the label, not the SOL |
| costs SOL | `net_sol`, `curve_progress`, `largest_buy / buy_sol` (must split SOL across wallets *and* leave it in), `sells/buys` (every sell is visible and moves price against them), `median_buy_sol` | capital sits in the curve, exposed to the other side selling into it |
| cannot be undone | a creator's prior launches / graduations (negative direction only) | on-chain history |

R1–R4 are in the "costs SOL" tier except R4's buyer count, which is guarded by its `buy_sol >= 3` half. The count-based variant (`unique_buyers <= 1`) is defeated by a second dust wallet.

## 9. What to show the user (measured on 07-27; population = traded by t+60 s, not graduated; n in brackets)

Hide (or collapse under "filtered") when any fires — each states its own number so the user can see why:

| flag wording | dead in 10 min | dead or dumped | graduated | n |
|---|---|---|---|---|
| "One wallet's buy is >= 50 % of all SOL bought so far" | 89 % | 90 % | 0.2 % (22 of 591) | 12,844 |
| "Only one buyer in the first 60 s" | 93 % | 93 % | 0.0 % (0 of 591) | 7,524 |
| "Sells outnumber buys 1.5 : 1" | 93 % | 95 % | 0.7 % | 1,946 |
| "Creator has sold and the curve is < 2 % filled" | 91 % | 93 % | 0.3 % | 9,163 |
| "<= 2 buyers but >= 3 SOL bought — looks like wash volume" | 94 % | 95 % | 0.1 % | 944 |
| "Creator: >= 30 launches, none graduated" | 92 % | 93 % | 0.5 % | 6,117 |
| "Creator: >= 10 launches, none graduated" | 90 % | 92 % | 0.7 % | 9,681 |

Show as a **warning with both numbers**, never hide:

| flag wording | note |
|---|---|
| "Creator sold within 60 s — 87 % of such launches died or dumped, but so did 85 % of all launches; 1.6 % graduated (n = 18,762)" | on its own this is baseline; only R3's combination is a hide |
| "Top-3 wallets hold >= 25 % — of launches still alive at 60 s, 75 % were dumped within 30 min and 22 % graduated (n = 207)" | volatility, both directions |
| ">= 40 % bought in the launch block — of alive launches, 63 % dumped, 20 % graduated (n = 212)" | same |
| ">= 25 % sniped in the first 20 slots — of alive launches, 38 % dumped vs 26 % otherwise; 9 % graduated (n = 1,662)" | weak; do not fail on it |
| "Creator holds >= 10 % — of alive launches 39 % dumped, 21 % graduated (n = 141)" | same |
| "No socials — no measurable effect on dying (84 % vs 85 %); hides half of graduations if used as a filter" | display fact only |

Do **not** show as red: dev-holding / top-10 / bundled / sniper `fail` verdicts based on share alone — each has P(bad) *below* the base rate and together they hide 57 % of graduations at 60 s.

### Where each input comes from today

| input | live trade feed needed? | computable cold from pump.fun API / RPC? |
|---|---|---|
| `largest_buy / buy_sol`, `sells/buys`, `unique_buyers`, `buy_sol`, creator-sold (first 60–120 s) | for a t+30 s decision on a launch the API has not indexed yet, yes | yes — `swap-api.pump.fun/v2/coins/{mint}/trades` seek to creation returns the first ~100 trades in one call (`shared/launchintel.ts` header); the API path has no feed loss |
| `curve_progress` | no | yes — bonding-curve account `real_token_reserves` via RPC (`(1.073e9 - vTok)/793.1e6`), or the coin endpoint |
| creator prior launches / graduations | no | yes — creator endpoint already used by `li.creatorHistory` |
| bundle / sniper / top-3 shares | no | yes — same trades page (`analyseLaunch`) |
| `net_sol` | no | yes — trades page, or the curve account's SOL reserve |

Feed-loss caveat for the live path: counts are floors (10–20 % of events missing), so `unique_buyers <= 1/2` and `n_trades` rules over-fire on a lossy install. R1/R2/R3 are ratios and survive loss better; when a rule fires from the live tape, show "from N trades seen" beside it, and re-check from the API path once it is indexed.

## 10. Files

* `E:\data\work\launchset-2026-08-30\rug\rug_analysis.py` — everything in sections 2–8 (`results.md` is its full output: all windows, train and test).
* `E:\data\work\launchset-2026-08-30\rug\final_rules_check.py` -> `final_rules_check.txt` — section 5 tables.
* This report: `rug\REPORT.md` and `KryptSniper\docs\rug-filter-2026-08-30.md`.