# Runner odds at t+30 s / t+60 s / t+120 s — launchset-2026-08-30

Dataset: `E:\data\work\launchset-2026-08-30\launches.parquet` (73,890 pump.fun launches, 2026-07-25/26/27). Scripts and every intermediate table: `E:\data\work\launchset-2026-08-30\runner\` (`common.py`, `01_base_rates.py`, `02_lift_tables.py`, `03_model.py`, `04_robustness.py`; outputs `01_base_rates.md`, `02_feature_auc_summary.md/.csv`, `02_lift_tables_full.md`, `03_model_results.md/.csv`, `03_coefs.json`, `03_selection_log.json`, `03_test_predictions.parquet`, `04_robustness.md/.csv`, `04_score_buckets.csv`).

**Short answer.** Yes for ranking; only partly for "odds". A 4–6 feature logistic model fit on 07-25+07-26 and scored once on 07-27 gives AUC 0.87–0.94 on the held-out day, with train-day and test-day AUC within ±0.01 (no visible overfit). Top 5 % by score at t+60 s: **17 % graduate vs 2.1 % base (8×, n = 1,397)**; **24 % reach 3× from the 60 s price vs 3.4 % (7×, n = 1,365)**. The ranking survives removing every count-based feature (AUC drop ≤ 0.01), holds inside both curve regimes and for first-time vs repeat creators. Two things are **not** fine: (1) "2× by 5 min" is barely rankable at t+30/60 s (best bucket 6–8 %, 4×, and over-predicted); (2) the peak-multiple labels are driven substantially by the `mixed` curve regime (10.6 % vs 1.5 % base) — on classic v1 curves the top-5 % rate for ≥3× is 10 %, not 24 %. Odds must be shown as bucketed observed rates next to the base rate, split by regime, never as a per-token probability, and re-measured on every new tape day.

No sklearn available: logistic regression is Newton/IRLS in numpy (L2 = 1); AUC/AUPRC/precision@k computed directly.

## 1. Protocol and universe

* Fit + feature selection on 07-25 + 07-26 only (selection used cross-day validation inside train: fit 25→score 26 and 26→25). 07-27 scored once.
* Universe at W: `label_window_60m_complete`, ≥ 1 recorded trade by W, and **not already graduated by W**. Peak/5-min labels stay null when coverage is short (never 0).
* Features use only `_Ws` columns + static/causal columns. `curve_kind_120s` is not used (frozen after 120 s); regime comes from `k_consistent_Ws` (trades ≤ W only).

| W | day | total | window incomplete | zero trades by W | already graduated by W | kept |
|---|---|---|---|---|---|---|
| 30 | 07-25 | 20,089 | 1,041 | 2,599 | 213 | 16,236 |
| 30 | 07-26 | 20,648 | 563 | 2,839 | 257 | 16,989 |
| 30 | 07-27 | 33,153 | 0 | 4,883 | 356 | **27,914** |
| 60 | 07-25 | 20,089 | 1,041 | 2,534 | 226 | 16,288 |
| 60 | 07-26 | 20,648 | 563 | 2,803 | 271 | 17,011 |
| 60 | 07-27 | 33,153 | 0 | 4,833 | 383 | **27,937** |
| 120 | 07-25 | 20,089 | 1,041 | 2,507 | 267 | 16,274 |
| 120 | 07-26 | 20,648 | 563 | 2,788 | 286 | 17,011 |
| 120 | 07-27 | 33,153 | 0 | 4,795 | 445 | **27,913** |

Peak/5-min labels are additionally null for 334 / 375 / 642 rows (short coverage) and for every `nonstd` curve.

**Leakage checks passed:** `dev_sold_s ≤ W` == `creator_sold_Ws` on 100 %; `creator_prior_launches_in_tape` recomputed from create order agrees 99.97 %; `creator_prior_graduations` recomputed causally agrees 100 %; `n_trades_30s ≤ 60s ≤ 120s` 100 %; `curve_progress_120s < 1` for every launch graduating after 120 s. Caveat found: **741 of 2,216 graduations (33 %) complete within 1 s of create** (README says ≈ 5 %); excluded from every universe.

## 2. Base rates (inside each window's universe)

| W | day | n | graduate | peak ≥ 3× | peak ≥ 5× | 2× by 5 min |
|---|---|---|---|---|---|---|
| 30 | 07-25 | 16,236 | 2.60 % | 4.00 % | 1.84 % | 1.74 % |
| 30 | 07-26 | 16,989 | 2.06 % | 3.36 % | 1.51 % | 1.52 % |
| 30 | 07-27 | 27,914 | **2.21 %** | **3.38 %** | **1.60 %** | **1.54 %** |
| 60 | 07-25 | 16,288 | 2.51 % | 3.99 % | 1.83 % | 1.73 % |
| 60 | 07-26 | 17,011 | 1.98 % | 3.35 % | 1.51 % | 1.51 % |
| 60 | 07-27 | 27,937 | **2.12 %** | **3.37 %** | **1.59 %** | **1.54 %** |
| 120 | 07-25 | 16,274 | 2.26 % | 3.93 % | 1.79 % | 1.66 % |
| 120 | 07-26 | 17,011 | 1.89 % | 3.32 % | 1.48 % | 1.47 % |
| 120 | 07-27 | 27,913 | **1.90 %** | **3.33 %** | **1.57 %** | **1.48 %** |

Curve regime is a base-rate driver on its own (knowable at W via `k_consistent_Ws == false`, stable across all three days):

| at W=60 | n | graduate | peak ≥ 3× | peak ≥ 5× | 2× by 5 min |
|---|---|---|---|---|---|
| classic v1 | 46,795 | 1.2 % | 1.6 % | 0.6 % | 1.0 % |
| mixed / nonstd | 14,441 | 5.4 % | 10.6 % | 5.5 % | 3.8 % |

## 3. Single-feature lift (before any model)

AUC at W = 60 (train with per-day values / test 07-27; < 0.5 = lower is better):

| feature | grad train(d25/d26) | grad test | peak3 train | peak3 test | peak5 train | peak5 test | m5m2 train | m5m2 test |
|---|---|---|---|---|---|---|---|---|
| trades_per_second_last_10s | 0.88 (0.89/0.88) | 0.88 | 0.84 (0.84/0.83) | 0.84 | 0.83 (0.84/0.81) | 0.83 | 0.82 (0.83/0.82) | 0.82 |
| n_buys | 0.86 (0.85/0.87) | 0.87 | 0.81 (0.81/0.81) | 0.82 | 0.80 (0.80/0.79) | 0.81 | 0.80 (0.79/0.80) | 0.80 |
| top3_buyers_share_of_supply | 0.82 (0.81/0.83) | 0.80 | 0.75 (0.76/0.74) | 0.74 | 0.73 (0.75/0.70) | 0.72 | 0.73 (0.74/0.72) | 0.72 |
| unique_buyer_growth_rate | 0.82 (0.81/0.83) | 0.82 | 0.75 (0.75/0.76) | 0.75 | 0.73 (0.73/0.73) | 0.73 | 0.76 (0.76/0.76) | 0.74 |
| largest_buy_frac | 0.17 (0.18/0.17) | 0.16 | 0.22 (0.22/0.22) | 0.20 | 0.23 (0.22/0.24) | 0.20 | 0.23 (0.23/0.23) | 0.22 |
| curve_progress | 0.81 (0.79/0.83) | 0.79 | 0.71 (0.70/0.71) | 0.73 | 0.66 (0.68/0.64) | 0.70 | 0.72 (0.71/0.74) | 0.74 |
| sniper_share | 0.78 (0.78/0.78) | 0.76 | 0.72 (0.74/0.71) | 0.73 | 0.73 (0.76/0.70) | 0.73 | 0.69 (0.68/0.69) | 0.69 |
| unique_buyers | 0.75 (0.74/0.77) | 0.76 | 0.69 (0.70/0.68) | 0.69 | 0.66 (0.67/0.64) | 0.67 | 0.70 (0.71/0.70) | 0.71 |
| curve_mixed_by_W | 0.68 (0.69/0.65) | 0.67 | 0.73 (0.73/0.72) | 0.72 | 0.78 (0.79/0.77) | 0.75 | 0.66 (0.67/0.65) | 0.65 |
| net_sol | 0.73 (0.71/0.75) | 0.72 | 0.67 (0.67/0.66) | 0.68 | 0.62 (0.63/0.60) | 0.65 | 0.71 (0.71/0.70) | 0.71 |
| creator_share_of_supply | 0.64 (0.65/0.62) | 0.68 | 0.64 (0.63/0.65) | 0.67 | 0.65 (0.64/0.66) | 0.68 | 0.60 (0.61/0.59) | 0.63 |
| gini_buy_sol | 0.65 (0.64/0.65) | 0.66 | 0.60 | 0.57 | 0.57 | 0.55 | 0.59 | 0.58 |
| has_socials | 0.39 (0.37/0.41) | 0.37 | 0.34 | 0.33 | 0.31 | 0.31 | 0.40 | 0.39 |
| median_buy_sol | 0.41 | 0.40 | 0.38 | 0.40 | 0.35 | 0.39 | 0.42 | 0.44 |
| buy_sol_per_trade | 0.46 | 0.45 | 0.41 | 0.41 | 0.37 | 0.39 | 0.44 | 0.45 |
| dev_sold_by_W | 0.42 | 0.42 | 0.43 | 0.42 | 0.41 | 0.40 | 0.46 | 0.45 |
| creator_prior_graduations | 0.59 (0.60/0.58) | 0.61 | 0.57 | 0.59 | 0.58 | 0.60 | 0.55 | 0.57 |
| largest_buy_sol | 0.58 | 0.57 | 0.52 | 0.51 | 0.47 | 0.48 | 0.55 | 0.56 |
| bundle_share | 0.54 (0.51/0.57) | 0.53 | 0.47 | 0.48 | 0.42 | 0.45 | 0.54 | 0.54 |
| sells_to_buys_ratio | 0.47 | 0.45 | 0.48 | 0.48 | 0.52 | 0.50 | 0.47 | 0.46 |
| creator_prior_launches_in_tape | 0.44 | 0.41 | 0.49 | 0.45 | 0.51 | 0.46 | 0.48 | 0.45 |
| creator_prior_dev_sells_within_60s | 0.45 | 0.43 | 0.48 | 0.46 | 0.50 | 0.47 | 0.48 | 0.47 |
| name_len | 0.44 | 0.41 | 0.41 | 0.41 | 0.41 | 0.40 | 0.43 | 0.42 |
| symbol_len | 0.52 | 0.50 | 0.51 | 0.49 | 0.52 | 0.48 | 0.51 | 0.53 |
| dev_buy_sol | 0.46 | 0.49 | 0.44 | 0.48 | 0.41 | 0.46 | 0.50 | 0.53 |

No signal here: `bundle_share`, `sells_to_buys_ratio`, `symbol_len`, `dev_buy_sol`, `creator_prior_launches`, `creator_prior_dev_sells` (AUC 0.42–0.55, non-monotone). `buy_sol_per_trade` ("capital efficiency") is *inverted*: big average buys = dev-only launch. `has_socials` is inverted too (with socials 1.4 % graduate vs 4.1 % without — launch farms fill in socials).

### The 10 most useful lift tables (W = 60, graduation unless noted; train | test, own quantile edges; base 2.24 % | 2.12 %)

**trades_per_second_last_10s**

| train bin | n | rate | lift | test bin | n | rate | lift |
|---|---|---|---|---|---|---|---|
| ≤ 0.1 | 25,535 | 0.30 % | 0.13 | ≤ 0.1 | 22,389 | 0.38 % | 0.18 |
| 0.1–0.3 | 1,725 | 3.6 % | 1.6 | 0.1–1.0 | 2,880 | 5.2 % | 2.5 |
| 0.3–1.3 | 2,869 | 6.7 % | 3.0 | 1.0–27 | 2,668 | 13.3 % | 6.3 |
| 1.3–38 | 3,170 | 13.1 % | 5.9 | | | | |

**n_buys** (label peak ≥ 3×; base 3.66 % | 3.37 %)

| train bin | n | rate | lift | test bin | n | rate | lift |
|---|---|---|---|---|---|---|---|
| 1–2 | 10,158 | 0.13 % | 0.03 | 1–2 | 9,172 | 0.15 % | 0.05 |
| 3–5 | 4,097 | 1.0 % | 0.27 | 3–4 | 2,146 | 0.5 % | 0.15 |
| 6–7 | 2,249 | 0.9 % | 0.24 | 5–7 | 2,901 | 1.5 % | 0.45 |
| 8–12 | 3,482 | 2.2 % | 0.61 | 8–10 | 2,272 | 1.9 % | 0.56 |
| 13–20 | 3,021 | 4.0 % | 1.1 | 11–17 | 2,721 | 2.9 % | 0.86 |
| 21–36 | 3,118 | 5.8 % | 1.6 | 18–30 | 2,624 | 5.3 % | 1.6 |
| 37–68 | 3,253 | 12.6 % | 3.5 | 31–61 | 2,757 | 10.2 % | 3.0 |
| 69–736 | 3,212 | 10.2 % | 2.8 | 62–962 | 2,702 | 11.4 % | 3.4 |

**largest_buy_frac** (largest single buy / total buy SOL; 1.0 = only the dev bought)

| train bin | n | rate | lift | test bin | n | rate | lift |
|---|---|---|---|---|---|---|---|
| 0.01–0.09 | 3,259 | 9.0 % | 4.0 | 0.01–0.10 | 2,730 | 9.2 % | 4.3 |
| 0.09–0.15 | 3,259 | 5.8 % | 2.6 | 0.10–0.16 | 2,729 | 4.7 % | 2.2 |
| 0.15–0.23 | 3,259 | 3.7 % | 1.6 | 0.16–0.24 | 2,730 | 2.6 % | 1.2 |
| 0.23–0.32 | 3,259 | 1.6 % | 0.7 | 0.24–0.33 | 2,729 | 1.3 % | 0.6 |
| 0.32–0.44 | 3,259 | 0.9 % | 0.4 | 0.33–0.45 | 2,730 | 1.2 % | 0.6 |
| 0.44–0.62 | 3,259 | 0.9 % | 0.4 | 0.45–0.67 | 2,729 | 0.8 % | 0.4 |
| 0.62–0.89 | 3,259 | 0.3 % | 0.1 | 0.67–0.95 | 2,732 | 0.4 % | 0.2 |
| 0.89–1.0 | 9,777 | 0.09 % | 0.04 | 0.95–1.0 | 8,186 | 0.01 % | 0.01 |

**top3_buyers_share_of_supply**

| train bin | n | rate | lift | test bin | n | rate | lift |
|---|---|---|---|---|---|---|---|
| ≈ 0 | 13,359 | 0.25 % | 0.11 | ≈ 0 | 11,175 | 0.32 % | 0.15 |
| –0.0033 | 3,291 | 1.1 % | 0.49 | –0.0035 | 2,794 | 1.5 % | 0.71 |
| –0.012 | 3,329 | 1.5 % | 0.68 | –0.018 | 2,793 | 2.4 % | 1.1 |
| –0.026 | 3,356 | 1.5 % | 0.67 | –0.026 | 2,796 | 0.9 % | 0.42 |
| –0.042 | 3,304 | 1.8 % | 0.80 | –0.037 | 2,791 | 0.7 % | 0.34 |
| –0.090 | 3,330 | 5.3 % | 2.4 | –0.088 | 2,794 | 4.2 % | 2.0 |
| 0.09–1.29 | 3,330 | 10.2 % | 4.6 | 0.088–1.24 | 2,794 | 10.2 % | 4.8 |

**curve_progress** (token-side; dip at 0.02–0.035 = "one ~1 SOL dev buy, nothing else")

| train bin | n | rate | lift | test bin | n | rate | lift |
|---|---|---|---|---|---|---|---|
| ≈ 0 | 10,416 | 0.44 % | 0.20 | ≈ 0 | 8,593 | 0.54 % | 0.25 |
| –0.002 | 2,904 | 0.45 % | 0.20 | –0.0017 | 2,582 | 0.43 % | 0.20 |
| –0.008 | 3,330 | 1.0 % | 0.46 | –0.010 | 2,794 | 1.5 % | 0.73 |
| –0.022 | 3,329 | 1.5 % | 0.67 | –0.027 | 2,793 | 2.0 % | 0.93 |
| –0.035 | 3,330 | 0.9 % | 0.42 | –0.033 | 2,832 | 0.35 % | 0.17 |
| –0.060 | 3,330 | 1.8 % | 0.81 | –0.053 | 2,755 | 0.9 % | 0.41 |
| –0.21 | 3,330 | 4.7 % | 2.1 | –0.19 | 2,795 | 3.1 % | 1.5 |
| 0.21–1.0 | 3,330 | 10.7 % | 4.8 | 0.19–1.0 | 2,793 | 11.3 % | 5.3 |

**sniper_share** (first buy 1–20 slots after create) — *positively* associated; not a warning sign in this data

| train bin | n | rate | lift | test bin | n | rate | lift |
|---|---|---|---|---|---|---|---|
| ≈ 0 | 13,320 | 0.24 % | 0.11 | ≈ 0 | 11,175 | 0.17 % | 0.08 |
| –0.011 | 3,330 | 1.8 % | 0.81 | –0.011 | 2,794 | 2.5 % | 1.2 |
| –0.033 | 3,329 | 2.0 % | 0.89 | –0.034 | 2,793 | 2.8 % | 1.3 |
| –0.077 | 3,330 | 2.7 % | 1.2 | –0.079 | 2,794 | 2.2 % | 1.0 |
| –0.16 | 3,330 | 2.7 % | 1.2 | –0.16 | 2,793 | 2.2 % | 1.1 |
| –0.34 | 3,330 | 3.6 % | 1.6 | –0.33 | 2,794 | 3.4 % | 1.6 |
| 0.34–3.4 | 3,330 | 8.7 % | 3.9 | 0.33–2.9 | 2,794 | 7.4 % | 3.5 |

**net_sol** (non-monotone; the 0.3–1 SOL band is the dev-buy-only band)

| train bin | n | rate | lift | test bin | n | rate | lift |
|---|---|---|---|---|---|---|---|
| ≤ 0 | 3,392 | 0.56 % | 0.25 | ≤ 0 | 3,103 | 1.4 % | 0.64 |
| ≈ 0 (dust) | 6,649 | 0.05 % | 0.03 | ≈ 0 (dust) | 5,732 | 0.07 % | 0.03 |
| –0.013 | 3,279 | 0.64 % | 0.29 | –0.010 | 2,364 | 0.59 % | 0.28 |
| –0.084 | 3,330 | 3.7 % | 1.6 | –0.099 | 2,771 | 3.3 % | 1.6 |
| –0.25 | 3,331 | 3.3 % | 1.5 | –0.38 | 2,792 | 3.1 % | 1.5 |
| –0.56 | 3,328 | 2.6 % | 1.2 | –0.74 | 2,794 | 1.3 % | 0.61 |
| –0.99 | 3,330 | 1.2 % | 0.55 | –0.97 | 2,793 | 0.64 % | 0.30 |
| –3.6 | 3,330 | 1.8 % | 0.79 | –3.0 | 2,802 | 1.3 % | 0.62 |
| 3.6–84 | 3,330 | 8.5 % | 3.8 | 3.0–81 | 2,786 | 9.4 % | 4.4 |

**curve_mixed_by_W** (`k_consistent_60s == false`; label peak ≥ 3×)

| value | n train | rate | lift | n test | rate | lift |
|---|---|---|---|---|---|---|
| 0 (classic v1) | 24,948 | 1.5 % | 0.42 | 21,847 | 1.6 % | 0.46 |
| 1 (mixed/nonstd) | 7,642 | 10.6 % | 2.9 | 5,448 | 10.6 % | 3.2 |

**creator_share_of_supply**

| train bin | n | rate | lift | test bin | n | rate | lift |
|---|---|---|---|---|---|---|---|
| 0 (sold out / never held) | 23,495 | 1.4 % | 0.64 | 0 | 17,149 | 1.2 % | 0.58 |
| dust–0.002 | 3,362 | 3.1 % | 1.4 | dust–0.0016 | 5,200 | 0.9 % | 0.42 |
| 0.002–0.011 | 3,167 | 5.1 % | 2.3 | 0.0016–0.011 | 2,794 | 6.7 % | 3.2 |
| 0.011–0.88 | 3,275 | 4.5 % | 2.0 | 0.011–1.57 | 2,794 | 5.3 % | 2.5 |

**Binary features**

| feature | value | n train | rate | lift | n test | rate | lift |
|---|---|---|---|---|---|---|---|
| has_socials | null | 1,531 | 2.3 % | 1.0 | 1,254 | 1.4 % | 0.68 |
| has_socials | false | 10,368 | 3.7 % | 1.7 | 7,252 | 4.1 % | 1.9 |
| has_socials | true | 21,400 | 1.5 % | 0.68 | 19,431 | 1.4 % | 0.67 |
| dev sold by 60 s | false | 10,675 | 3.3 % | 1.5 | 9,175 | 3.2 % | 1.5 |
| dev sold by 60 s | true | 22,624 | 1.8 % | 0.78 | 18,762 | 1.6 % | 0.76 |
| creator_prior_graduations | 0–1 | 30,009 | 2.0 % | 0.87 | 23,435 | 1.7 % | 0.80 |
| creator_prior_graduations | ≥ 2 | 3,290 | 4.8 % | 2.2 | 4,502 | 4.3 % | 2.0 |

Every table has the same shape on both train days and on 07-27.

## 4. Models

Logistic regression on train-percentile-rank inputs (null → 0.5 + missing flag), ≤ 10 features by greedy forward selection with cross-day validation inside train (stop when gain < 0.002 AUC). Variants: **full**, **nocount** (no `n_trades/n_buys/n_sells/unique_*/tps/growth_rate`), single-feature baselines. All on 07-27 unless marked.

| W | label | variant | feats | AUC 25 | AUC 26 | **AUC 27** | AUPRC | P@1 % | R@1 % | **P@5 %** | R@5 % | P@10 % | R@10 % | base | pos |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 30 | grad | full | 6 | 0.884 | 0.890 | **0.896** | 0.124 | 15.4 % | 7 % | **13.8 %** | 31 % | 12.4 % | 56 % | 2.21 % | 618 |
| 30 | grad | nocount | 6 | 0.875 | 0.885 | 0.889 | 0.117 | 14.3 % | 7 % | 12.9 % | 29 % | 11.7 % | 53 % | | |
| 30 | grad | curve_progress alone | 1 | 0.722 | 0.748 | 0.745 | 0.162 | **35.1 %** | 16 % | 16.0 % | 36 % | 9.9 % | 45 % | | |
| 30 | grad | unique_buyers alone | 1 | 0.702 | 0.736 | 0.725 | 0.077 | 20.1 % | 9 % | 10.2 % | 23 % | 7.2 % | 33 % | | |
| 30 | grad | tps_last10 alone | 1 | 0.834 | 0.855 | 0.851 | 0.103 | 17.9 % | 8 % | 11.5 % | 26 % | 9.8 % | 44 % | | |
| 30 | peak ≥ 3× | full | 5 | 0.863 | 0.863 | **0.871** | 0.175 | 26.4 % | 8 % | **21.0 %** | 31 % | 16.9 % | 50 % | 3.38 % | 921 |
| 30 | peak ≥ 3× | nocount | 5 | 0.858 | 0.859 | 0.872 | 0.170 | 20.9 % | 6 % | 20.4 % | 30 % | 17.4 % | 52 % | | |
| 30 | peak ≥ 5× | full | 4 | 0.878 | 0.857 | **0.870** | 0.089 | 13.2 % | 8 % | **11.0 %** | 35 % | 8.6 % | 54 % | 1.60 % | 435 |
| 30 | 2× by 5 m | full | 4 | 0.834 | 0.837 | **0.832** | 0.057 | 5.9 % | 4 % | **6.6 %** | 21 % | 6.1 % | 39 % | 1.54 % | 420 |
| 60 | grad | full | 4 | 0.908 | 0.911 | **0.915** | 0.145 | 15.4 % | 7 % | **17.0 %** | 40 % | 13.9 % | 66 % | 2.12 % | 591 |
| 60 | grad | nocount | 9 | 0.908 | 0.918 | 0.916 | 0.154 | 17.6 % | 8 % | 17.0 % | 40 % | 14.0 % | 66 % | | |
| 60 | grad | curve_progress alone | 1 | 0.789 | 0.826 | 0.790 | 0.214 | **40.5 %** | 19 % | 17.5 % | 42 % | 11.3 % | 53 % | | |
| 60 | grad | unique_buyers alone | 1 | 0.742 | 0.767 | 0.755 | 0.088 | 21.1 % | 10 % | 10.7 % | 25 % | 7.9 % | 37 % | | |
| 60 | grad | tps_last10 alone | 1 | 0.886 | 0.882 | 0.878 | 0.144 | 24.0 % | 11 % | 15.3 % | 36 % | 13.2 % | 62 % | | |
| 60 | peak ≥ 3× | full | 6 | 0.892 | 0.895 | **0.895** | 0.208 | 30.4 % | 9 % | **24.1 %** | 36 % | 19.6 % | 58 % | 3.37 % | 921 |
| 60 | peak ≥ 3× | nocount | 5 | 0.884 | 0.887 | 0.892 | 0.200 | 28.2 % | 8 % | 23.7 % | 35 % | 20.3 % | 60 % | | |
| 60 | peak ≥ 5× | full | 5 | 0.900 | 0.886 | **0.890** | 0.112 | 16.5 % | 10 % | **12.7 %** | 40 % | 10.1 % | 63 % | 1.59 % | 435 |
| 60 | 2× by 5 m | full | 6 | 0.870 | 0.867 | **0.867** | 0.070 | 6.6 % | 4 % | **6.9 %** | 22 % | 7.7 % | 50 % | 1.54 % | 420 |
| 120 | grad | full | 4 | 0.927 | 0.941 | **0.940** | 0.209 | 28.0 % | 15 % | **21.3 %** | 56 % | 15.3 % | 81 % | 1.90 % | 529 |
| 120 | grad | curve_progress alone | 1 | 0.826 | 0.882 | 0.856 | 0.268 | **41.2 %** | 22 % | 19.7 % | 52 % | 12.8 % | 68 % | | |
| 120 | peak ≥ 3× | full | 6 | 0.926 | 0.932 | **0.926** | 0.335 | 52.7 % | 16 % | **32.1 %** | 48 % | 24.8 % | 74 % | 3.33 % | 908 |
| 120 | peak ≥ 5× | full | 4 | 0.930 | 0.926 | **0.925** | 0.206 | 31.1 % | 20 % | **17.9 %** | 57 % | 12.1 % | 77 % | 1.57 % | 429 |
| 120 | 2× by 5 m | full | 6 | 0.928 | 0.916 | **0.925** | 0.174 | 27.1 % | 18 % | **16.0 %** | 54 % | 11.0 % | 74 % | 1.48 % | 403 |

Reading: train-day (in-sample) and held-out AUC agree to ±0.01 everywhere — nothing is overfit. `unique_buyers` alone is a poor ranker (0.65–0.78). `curve_progress` alone is a poor *ranker* but has the best *top-1 %* graduation precision at every window (35–41 %). The model wins everywhere below the top 1 %.

**Caution on W = 120 for the multiple labels:** they are measured from `price_at_60s`, so at t+120 s the first 60 s of the outcome is already visible. Re-based to `price_at_120s`: 2×-by-5-min base 1.02 %, AUC 0.90, top-5 % 8.6 % (8×); ≥3× base 2.0 %, AUC 0.91, top-5 % 19.6 % (10×). At W = 30, re-based over `price_at_30s`: AUC 0.856 / top-5 % 18.5 % for ≥3×, AUC 0.845 / 10.0 % for 2×-by-5-min.

### Selected features and coefficients (full model, rank-scaled inputs)

| W | label | selection order (cross-day val AUC after adding) | coefficients |
|---|---|---|---|
| 30 | grad | tps_last10 (0.844); creator_sold (0.869); n_buys (0.873); meta_twitter (0.878); net_over_buy (0.882); curve_mixed (0.885) | tps +2.95, creator_sold −0.68, n_buys +3.75, twitter −0.31, net/buy +2.48, mixed +0.92 |
| 30 | peak ≥ 3× | tps_last10 (0.799); curve_mixed (0.839); net_over_buy (0.855); n_buys (0.859); creator_prior_dev_sells_60s (0.862) | tps +2.27, mixed +1.90, net/buy +2.45, n_buys +2.08, prior_dev_sells −0.79 |
| 60 | grad | tps_last10 (0.884); creator_share (0.898); n_buys (0.903); unique_sellers (0.908) | tps +4.43, creator_share +1.38, n_buys +5.18, unique_sellers −2.05 |
| 60 | peak ≥ 3× | tps_last10 (0.838); curve_mixed (0.870); net_sol (0.885); dev_buy_share (0.887); n_buys (0.890); creator_share (0.893) | tps +2.28, mixed +1.58, net_sol +2.18, dev_buy_share −1.30, n_buys +2.10, creator_share +0.81 |
| 60 | peak ≥ 5× | tps_last10 (0.824); curve_mixed (0.876); net_sol (0.885); n_buys (0.888); creator_sold (0.892) | tps +2.22, mixed +2.08, net_sol +1.16, n_buys +2.15, creator_sold −0.59 |
| 60 | 2× by 5 m | tps_last10 (0.824); curve_mixed (0.845); net_sol (0.858); buy_sol_per_buyer (0.863); n_buys (0.865); sniper_share (0.868) | tps +2.23, mixed +1.54, net_sol +2.90, sol/buyer −1.18, n_buys +2.08, sniper −0.93 |
| 120 | grad | tps_last10 (0.892); n_buys (0.918); creator_sold (0.928); meta_twitter (0.933) | tps +4.09, n_buys +5.26, creator_sold −0.84, twitter −0.74 |
| 120 | peak ≥ 3× | n_buys (0.857); unique_sellers (0.902); tps_last10 (0.917); top3_share (0.919); curve_mixed (0.923); net_over_buy (0.928) | n_buys +4.61, unique_sellers −0.97, tps +1.96, top3 +1.53, mixed +1.98, net/buy +3.71 |

No-count models pick `largest_buy_frac` (−), `creator_share_of_supply` (+), `top3_buyers_share` (+), `median_buy_sol` (−), `net_sol` (+), `curve_progress` (+), `curve_mixed` (+).

### Calibration on 07-27 (full model; predicted-probability bucket → observed)

| W=60 graduate | n | pred | **obs** | | W=60 peak ≥ 3× | n | pred | **obs** |
|---|---|---|---|---|---|---|---|---|
| 0–1 % | 21,042 | 0.2 % | 0.2 % | | 0–1 % | 17,957 | 0.4 % | 0.3 % |
| 1–2 % | 951 | 1.5 % | 1.2 % | | 1–2 % | 2,454 | 1.4 % | 1.8 % |
| 2–5 % | 1,927 | 3.4 % | 3.1 % | | 2–5 % | 2,200 | 3.3 % | 4.6 % |
| 5–10 % | 2,173 | 7.3 % | 8.0 % | | 5–10 % | 2,060 | 7.2 % | 10.1 % |
| 10–20 % | 1,432 | 13.8 % | 16.5 % | | 10–20 % | 1,438 | 14.2 % | 15.7 % |
| 20–35 % | 385 | 24.1 % | **16.1 %** | | 20–35 % | 955 | 26.3 % | 23.6 % |
| 35–50 % | 27 | 38.9 % | **11.1 %** | | 35–50 % | 213 | 40.6 % | 30.1 % |
| | | | | | 50–100 % | 18 | 53.2 % | 27.8 % |

| W=120 graduate | n | pred | **obs** | | W=120 peak ≥ 3× | n | pred | **obs** |
|---|---|---|---|---|---|---|---|---|
| 0–1 % | 22,636 | 0.2 % | 0.1 % | | 0–1 % | 20,211 | 0.3 % | 0.3 % |
| 1–2 % | 1,082 | 1.4 % | 1.8 % | | 1–2 % | 1,843 | 1.4 % | 2.1 % |
| 2–5 % | 945 | 3.4 % | 2.4 % | | 2–5 % | 1,562 | 3.2 % | 4.4 % |
| 5–10 % | 1,460 | 7.4 % | 7.1 % | | 5–10 % | 945 | 7.4 % | 7.7 % |
| 10–20 % | 1,334 | 13.7 % | 16.6 % | | 10–20 % | 1,462 | 14.4 % | 18.1 % |
| 20–35 % | 373 | 26.1 % | 28.2 % | | 20–35 % | 767 | 27.6 % | 26.5 % |
| 35–50 % | 83 | 38.9 % | 28.9 % | | 35–50 % | 417 | 40.8 % | 39.3 % |
| | | | | | 50–100 % | 70 | 54.0 % | 62.9 % |

Calibration is good up to ~20 % predicted and **over-confident above 20 % at W = 30/60** (small n). At W = 120 the top buckets calibrate. This is the main reason to display bucketed observed rates rather than the model's probability.

## 5. Robustness and gameability (07-27, model fixed from train days)

**Removing count features** (all inflatable by a sniper ring): AUC changes −0.01 to +0.001. Signal is carried equally by SOL-weighted (`net_sol`, `largest_buy_frac`, `median_buy_sol`) and supply-share features. A ring can fake trade counts cheaply; faking `net_sol` and `top3_buyers_share` costs real SOL left in the curve.

**Subsets at W = 60 (full model):**

| label | subset | n | base | AUC | top-5 % within | lift | n above global top-5 % cut | rate above cut |
|---|---|---|---|---|---|---|---|---|
| grad | all | 27,937 | 2.1 % | 0.915 | 17.0 % | 8.1× | 1,397 | 17.0 % |
| grad | curve v1 | 21,806 | 1.2 % | 0.945 | 14.0 % | 11.7× | 309 | 18.4 % |
| grad | curve mixed | 5,489 | 5.2 % | 0.806 | 14.2 % | 2.7× | 996 | 16.3 % |
| grad | first-time creator | 4,958 | 3.2 % | 0.884 | 19.0 % | 6.0× | 282 | 19.1 % |
| grad | creator ≥ 1 prior launch | 22,979 | 1.9 % | 0.923 | 16.2 % | 8.6× | 1,115 | 16.5 % |
| grad | unique_buyers ≤ 3 | 12,979 | 0.5 % | 0.941 | 7.6 % | 14× | 74 | 8.1 % |
| grad | unique_buyers ≥ 10 | 8,077 | 4.3 % | 0.859 | 20.5 % | 4.7× | 686 | 20.1 % |
| peak ≥ 3× | all | 27,295 | 3.4 % | 0.895 | 24.1 % | 7.1× | 1,365 | 24.1 % |
| peak ≥ 3× | **curve v1** | 21,806 | 1.5 % | 0.874 | **10.2 %** | 6.6× | **51** | 3.9 % |
| peak ≥ 3× | **curve mixed** | 5,489 | 10.7 % | 0.793 | 30.3 % | 2.8× | **1,314** | 24.9 % |
| peak ≥ 5× | curve v1 | 21,806 | 0.6 % | 0.865 | 3.1 % | 5.2× | **0** | — |
| peak ≥ 5× | curve mixed | 5,489 | 5.5 % | 0.771 | 16.4 % | 3.0× | 1,365 | 12.7 % |
| 2× by 5 m | curve v1 | 21,806 | 0.9 % | 0.896 | 8.5 % | 9.0× | 219 | 6.8 % |
| 2× by 5 m | curve mixed | 5,489 | 3.9 % | 0.712 | 8.0 % | 2.1× | 1,146 | 6.9 % |

* **Graduation** ranking is robust: lift 5–12× in every subset.
* **Peak-multiple** ranking is dominated by the curve regime: the global top-5 % for ≥3× is 96 % mixed-curve launches; the ≥5× top-5 % contains **zero** v1 launches. Whether the mixed regime is a pump.fun mechanism or a feed artefact is not settled by this dataset; either way it is the most important thing to display honestly.
* **Day-robustness of bucket rates:** top-5 % precision by day (25/26/27) for the W = 60 full model — graduation 19.2 / 14.2 / 17.0 %; ≥3× 24.9 / 24.4 / 24.1 %; ≥5× 14.2 / 11.4 / 12.7 %; 2×-by-5-min 7.9 / 6.0 / 6.9 %. Day-to-day spread ±3 points absolute — the honest error bar, on three days of one week.

## 6. What the top bucket is worth (07-27)

| W | label | top 1 % | 1–5 % | 5–10 % | 10–25 % | 25–50 % | bottom 50 % | base |
|---|---|---|---|---|---|---|---|---|
| 30 | graduate | 15.4 % (7×) | 13.3 % (6×) | 11.2 % (5×) | 5.3 % (2.4×) | 0.6 % | 0.05 % | 2.2 % |
| 30 | peak ≥ 3× | 26.5 % (8×) | 19.7 % (6×) | 12.8 % (4×) | 8.0 % (2.4×) | 1.4 % | 0.3 % | 3.4 % |
| 30 | 2× by 5 min | 5.9 % (4×) | 6.8 % (4×) | 5.5 % (4×) | 4.4 % (2.8×) | 0.8 % | 0.2 % | 1.5 % |
| 60 | graduate | 15.4 % (7×) | 17.5 % (8×) | 10.7 % (5×) | 3.9 % (1.8×) | 0.5 % | 0.04 % | 2.1 % |
| 60 | peak ≥ 3× | 30.5 % (9×) | 22.5 % (7×) | 15.1 % (4.5×) | 7.2 % (2.1×) | 1.0 % | 0.2 % | 3.4 % |
| 60 | peak ≥ 5× | 16.5 % (10×) | 11.7 % (7×) | 7.6 % (5×) | 2.5 % (1.6×) | 0.7 % | 0.07 % | 1.6 % |
| 60 | 2× by 5 min | 6.6 % (4×) | 7.0 % (4.5×) | 8.4 % (5.5×) | 3.8 % (2.5×) | 0.6 % | 0.1 % | 1.5 % |
| 120 | graduate | 28.0 % (15×) | 19.7 % (10×) | 9.2 % (5×) | 1.9 % (1.0×) | 0.3 % | 0.03 % | 1.9 % |
| 120 | peak ≥ 3× † | 52.9 % (16×) | 27.0 % (8×) | 17.5 % (5×) | 4.3 % (1.3×) | 0.5 % | 0.15 % | 3.3 % |
| 120 | peak ≥ 5× † | 31.3 % (20×) | 14.6 % (9×) | 6.4 % (4×) | 1.7 % (1.1×) | 0.2 % | 0.1 % | 1.6 % |

† measured from the 60 s price, partly realised by 120 s; re-based numbers in §4.

The bottom half by score is dead: < 0.3 % on every label at every window. The negative call is the most reliable thing here.

## 7. What to tell a user

1. Show **observed rates from the reference day-set, per bucket, with n, beside the base rate** — not the model probability, not a per-token number.
2. Show the **curve regime** as its own line; for multiple labels show v1 and mixed rates separately.
3. Label the window; numbers change materially between +30/+60/+120 s.
4. Unknown inputs → score null → "—", never base rate, never 0. Zero recorded trades → not scored.
5. Re-measure on every new tape day (±3 points day-to-day). Ship as a dated, signed static table.

Exact wording at **+60 s** (07-27 rates):

| bucket | graduation line | 3× line (classic / mixed) | 5× line (classic / mixed) |
|---|---|---|---|
| Top 1 % | "About 15 in 100 launches like this graduated (n = 279). Base: 2 in 100." | "31 in 100 hit 3× within the hour; base 3 in 100. Classic curve ~10 · Mixed ~25–30" | "17 in 100 hit 5×; base 1.6. Classic ~3 · Mixed ~13" |
| Top 1–5 % | "About 17 in 100 graduated (n = 1,117). Base 2." | "23 in 100 (classic ~10 · mixed ~25)" | "12 in 100 (classic ~3 · mixed ~13)" |
| Top 5–10 % | "About 11 in 100 graduated (n = 1,397). Base 2." | "15 in 100" | "8 in 100" |
| 10–25 % | "About 4 in 100 graduated (n = 4,191). Base 2." | "7 in 100" | "2–3 in 100" |
| 25–50 % | "About 1 in 200 graduated. Base 2 in 100." | "1 in 100" | "under 1 in 100" |
| Bottom 50 % | "Fewer than 1 in 1,000 graduated (n = 13,969)." | "1 in 500" | "under 1 in 1,000" |

Panel footer, verbatim: *"Rates measured on pump.fun launches 2026-07-27 (27,937 launches with at least one trade, not yet graduated at +60 s), from a feed that misses 10–20 % of trades. Model fitted on 07-25/26; day-to-day spread about ±3 points on the top bucket. Past rates, not a prediction for this token."*

Do not show a "2× in 5 minutes" line at +30/60 s. Do not show any line when score inputs are unknown.

## 8. Features that must be computed live

| feature | definition (trades with offset ≤ W only) | used by |
|---|---|---|
| `trades_per_second_last_10s_W` | trades with offset in (W−10 s, W] ÷ 10 | all full models |
| `n_buys_W` | buy events by W | all full models |
| `unique_sellers_W` | distinct selling wallets by W | grad@60, peak3@120 |
| `net_sol_W` | Σ buy SOL − Σ sell SOL (event SOL, fees excluded) | peak/5-min models, no-count |
| `net_over_buy_W` | `net_sol_W / buy_sol_W` (null if no buys) | grad@30, peak3@30/120, no-count |
| `creator_share_of_supply_W` | creator net position (floored 0) ÷ 1e9 | grad@60, peak3@60, no-count |
| `creator_sold_W` | creator has ≥ 1 sell by W | grad@30/120, peak5@60 |
| `curve_mixed_by_W` | `k_consistent_W == false`: any trade ≤ W with `vSol·vTok` off 30e9·1.073e15 by > 0.5 % | peak/5-min models |
| `top3_buyers_share_of_supply_W` | sum of 3 largest non-creator net positions ÷ 1e9 | peak3@120, no-count |
| `largest_buy_frac_W` | `largest_buy_sol_W / buy_sol_W` | peak5@120, all no-count |
| `median_buy_sol_W` | median buy size (SOL) | no-count |
| `curve_progress_W` | `(1.073e9 − vTok_last) / 793.1e6`, token-side, clipped 0–1 | eye-rule, no-count, top-1 % graduation flag |
| `dev_buy_share_of_supply` | creator tokens bought in the create slot ÷ 1e9 | peak3@60 |
| `meta_twitter` | twitter field non-empty; **null until metadata fetch resolves** | grad@30/120 |
| `sniper_share_W`, `buy_sol_per_buyer_W` | first buy 1–20 slots after create; `buy_sol_W / unique_buyers_W` | 5-min@60 |
| `creator_prior_dev_sells_within_60s` | causal count over local tape; **null on a fresh install** | peak3@30 only |

All need the per-mint trade stream from create with `vSol/vTok` pre/post state and the creator wallet — already in the tape schema. Feed loss makes every count/volume an undercount by 10–20 %, so the live score must be trained on the same feed. The rank transform (train percentiles per feature) must ship with the coefficients — the model takes ranks, not raw values.

## 9. Bottom line

* Ranking works and is day-robust (AUC 0.87–0.94 held out, ±0.01 vs train; bucket rates ±3 points across days).
* Graduation odds at +60/+120 s are honest enough to show as bucketed observed rates with n and base rate.
* Multiple-of-entry odds must be split by curve regime or they mislead classic-curve buyers by 2–3×.
* "2× in 5 minutes" at +30/60 s is a null result for odds display.
* Three days of one week is the whole evidence base; the tables need re-measurement before shipping and periodically after.
