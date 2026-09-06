"""Export the runner-odds model (docs/runner-odds-2026-08-30.md) as the dated
static artefact shared/odds-model.json that shared/odds.ts scores against.

What goes in, per model (60|grad, 120|grad, 60|peak3, 60|peak5 — the `full`
variants; the `nocount` twins need gini_buy_sol / largest_buy_sol which the
terminal's OddsFeatures does not carry, so they are NOT exported):

  * the feature list in coefficient order, each with its intercept-free
    coefficient, its `__null` coefficient (null when train had no nulls —
    such a feature is REQUIRED at score time), and, for rank features, a
    201-point grid of train-universe quantiles (q = 0, 0.005, …, 1) so the
    TypeScript side reproduces common.RankTransformer's mid-rank percentile
    within ±0.01. Binary features (creator_sold, curve_mixed, meta_twitter)
    are passed through as 0/1 exactly like RankTransformer does.
  * the bucket table from 04_score_buckets.csv (bucket, score_min, n,
    observed, base, lift) plus the per-bucket observed rate split by curve
    regime (v1 vs mixed+nonstd, from 03_test_predictions.parquet);
  * the per-regime top-5 % rates from 04_robustness.csv;
  * the base rate, the §7 footer, measuredOn / fittedOn;
  * 25 golden rows from 03_test_predictions.parquet joined back to the raw
    features, with the python probability and bucket, for test/odds.test.mjs.

Run:  python scripts/analysis/export_odds_model_2026_08_30.py
Needs the runner outputs in E:\\data\\work\\launchset-2026-08-30\\runner.
"""
import json
import os
import sys

import numpy as np
import pandas as pd

RUNNER = r"E:\data\work\launchset-2026-08-30\runner"
sys.path.insert(0, RUNNER)
from common import (DATA, OUT, TEST_DAY, TRAIN_DAYS, RankTransformer, add_features,  # noqa: E402
                    add_labels, load, logit_predict, universe)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEST = os.path.join(REPO, "shared", "odds-model.json")

MODELS = [(60, "grad"), (120, "grad"), (60, "peak3"), (60, "peak5")]
GRID_POINTS = 201
GOLDEN_PER_BUCKET = {"top1": 4, "top1_5": 5, "top5_10": 4, "top10_25": 4, "top25_50": 4, "bottom50": 4}

BUCKET_IDS = [("top 1%", "top1"), ("1–5%", "top1_5"), ("5–10%", "top5_10"),
              ("10–25%", "top10_25"), ("25–50%", "top25_50"), ("bottom 50%", "bottom50")]

# dataset column (at window W) -> OddsFeatures key. Binary ones are passed through.
def feature_key(col, W):
    s = f"_{W}s"
    table = {
        f"trades_per_second_last_10s{s}": ("tradesPerSecondLast10s", "rank"),
        f"n_buys{s}": ("nBuys", "rank"),
        f"unique_sellers{s}": ("uniqueSellers", "rank"),
        f"net_sol{s}": ("netSol", "rank"),
        f"net_over_buy{s}": ("netOverBuy", "rank"),
        f"creator_share_of_supply{s}": ("creatorShareOfSupply", "rank"),
        f"creator_sold{s}": ("creatorSold", "binary"),
        f"curve_mixed_by{s}": ("curveMixed", "binary"),
        f"top3_buyers_share_of_supply{s}": ("top3BuyersShare", "rank"),
        f"largest_buy_frac{s}": ("largestBuyFrac", "rank"),
        f"median_buy_sol{s}": ("medianBuySol", "rank"),
        f"curve_progress{s}": ("curveProgress", "rank"),
        "dev_buy_share_of_supply": ("devBuyShareOfSupply", "rank"),
        "meta_twitter": ("metaTwitter", "binary"),
        f"sniper_share{s}": ("sniperShare", "rank"),
        f"buy_sol_per_buyer{s}": ("buySolPerBuyer", "rank"),
    }
    return table[col]


def all_feature_columns(W):
    s = f"_{W}s"
    return {
        "tradesPerSecondLast10s": f"trades_per_second_last_10s{s}",
        "nBuys": f"n_buys{s}",
        "uniqueSellers": f"unique_sellers{s}",
        "netSol": f"net_sol{s}",
        "netOverBuy": f"net_over_buy{s}",
        "creatorShareOfSupply": f"creator_share_of_supply{s}",
        "creatorSold": f"creator_sold{s}",
        "curveMixed": f"curve_mixed_by{s}",
        "top3BuyersShare": f"top3_buyers_share_of_supply{s}",
        "largestBuyFrac": f"largest_buy_frac{s}",
        "medianBuySol": f"median_buy_sol{s}",
        "curveProgress": f"curve_progress{s}",
        "devBuyShareOfSupply": "dev_buy_share_of_supply",
        "metaTwitter": "meta_twitter",
        "sniperShare": f"sniper_share{s}",
        "buySolPerBuyer": f"buy_sol_per_buyer{s}",
    }


def jsval(v, binary=False):
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if binary:
        return bool(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    return float(v)


def footer(W, population):
    return (f"Rates measured on pump.fun launches 2026-07-27 ({population:,} launches with at least one trade, "
            f"not yet graduated at +{W} s), from a feed that misses 10–20 % of trades. Model fitted on 07-25/26; "
            f"day-to-day spread about ±3 points on the top bucket. Past rates, not a prediction for this token.")


def grid_transform(grid, v):
    """The TypeScript rank transform, in numpy, to measure grid-vs-exact drift."""
    g = np.asarray(grid); m = len(g) - 1
    v = np.asarray(v, float)
    out = np.full(v.shape, np.nan)
    lo = np.searchsorted(g, v, side="left"); hi = np.searchsorted(g, v, side="right")
    tie = lo < hi
    out[tie] = (lo[tie] / m + np.minimum(hi[tie], m) / m) / 2.0
    between = ~tie & (lo > 0) & (lo <= m)
    i = lo[between]
    span = g[i] - g[i - 1]
    frac = np.where(span > 0, (v[between] - g[i - 1]) / np.where(span > 0, span, 1), 0.0)
    out[between] = (i - 1 + frac) / m
    out[~tie & (lo == 0)] = 0.0
    out[~tie & (lo > m)] = 1.0
    return out


def main():
    coefs = json.load(open(os.path.join(OUT, "03_coefs.json")))
    buckets = pd.read_csv(os.path.join(OUT, "04_score_buckets.csv"))
    robust = pd.read_csv(os.path.join(OUT, "04_robustness.csv"))
    preds = pd.read_parquet(os.path.join(OUT, "03_test_predictions.parquet"))

    df = add_labels(load())
    for W in sorted({w for w, _ in MODELS}):
        df = add_features(df, W)

    out = {
        "measuredOn": TEST_DAY,
        "fittedOn": TRAIN_DAYS,
        "source": "docs/runner-odds-2026-08-30.md; E:/data/work/launchset-2026-08-30/runner (03_coefs.json, 04_score_buckets.csv, 04_robustness.csv)",
        "supplyUnits": 1e9,
        "gridPoints": GRID_POINTS,
        "rankTransform": "mid-rank percentile against the train-universe grid: on a tie block (grid[lo..hi) == v) the mean of lo/(m-1) and hi/(m-1); between grid points linear; below/above the grid 0/1; null -> 0.5 plus the __null coefficient",
        "models": {},
    }
    agreement = {}

    for W, lab in MODELS:
        key = f"{W}|{lab}|full"
        c = coefs[key]
        cols = [k for k in c if k != "intercept" and not k.endswith("__null")]
        tr, _ = universe(df[df.day.isin(TRAIN_DAYS)], W)
        te, _ = universe(df[df.day == TEST_DAY], W)
        rt = RankTransformer(cols).fit(tr)
        Xte, names = rt.transform(te)
        w = np.array([c["intercept"]] + [c[n] for n in names])
        p_exact = logit_predict(w, Xte)

        # sanity: recomputed probabilities must equal 03_test_predictions
        pp = preds[(preds.W == W) & (preds.label == lab)].set_index("mint")
        p_ref = pp.loc[te.mint.values, "p"].values
        assert np.nanmax(np.abs(p_ref - p_exact)) < 1e-9, (key, np.nanmax(np.abs(p_ref - p_exact)))

        feats = []
        grid_cols = []
        for col in cols:
            fkey, kind = feature_key(col, W)
            srt = rt.q[col]
            binary = len(np.unique(srt)) <= 2
            if binary != (kind == "binary"):
                raise SystemExit(f"{key}: {col} kind mismatch (train uniques={len(np.unique(srt))})")
            grid = None
            if not binary:
                idx = np.round(np.linspace(0, 1, GRID_POINTS) * (len(srt) - 1)).astype(int)
                grid = [float(x) for x in srt[idx]]
                grid_cols.append((col, grid))
            feats.append({
                "key": fkey,
                "column": col,
                "kind": "binary" if binary else "rank",
                "coef": float(c[col]),
                "nullCoef": float(c[col + "__null"]) if (col + "__null") in c else None,
                "trainN": int(len(srt)),
                "grid": grid,
            })

        # grid-vs-exact drift over the whole test day
        Xg = []
        for col in cols:
            v = pd.to_numeric(te[col], errors="coerce").astype(float).values
            srt = rt.q[col]
            if len(np.unique(srt)) <= 2:
                r = v.copy()
            else:
                r = grid_transform(dict(grid_cols)[col], v)
            miss = np.isnan(v)
            Xg.append(np.where(miss, 0.5, r))
            if rt.has_null[col]:
                Xg.append(miss.astype(float))
        p_grid = logit_predict(w, np.column_stack(Xg))

        # buckets
        b = buckets[(buckets.W == W) & (buckets.label == lab)]
        base = float(b.base.iloc[0])
        population = int(b.n.sum())
        mints_in_bucket = {}
        d = pp[pp.y.notna()].sort_values("p", ascending=False)
        n_lab = len(d)
        edges = [(0, 0.01), (0.01, 0.05), (0.05, 0.10), (0.10, 0.25), (0.25, 0.50), (0.50, 1.0)]
        rank_bucket = {}
        for (lo, hi), (_, bid) in zip(edges, BUCKET_IDS):
            seg = d.iloc[int(lo * n_lab):int(hi * n_lab)]
            mints_in_bucket[bid] = seg
            for m in seg.index:
                rank_bucket[m] = bid
        bucket_rows = []
        for label_txt, bid in BUCKET_IDS:
            r = b[b.bucket == label_txt].iloc[0]
            seg = mints_in_bucket[bid]
            by = {}
            for reg, mask in (("classic", seg.curve_kind == "v1"), ("mixed", seg.curve_kind.isin(["mixed", "nonstd"]))):
                s = seg[mask]
                by[reg] = {"n": int(len(s)), "observed": float(s.y.mean()) if len(s) else None}
            bucket_rows.append({
                "bucket": bid, "label": label_txt, "scoreMin": float(r.score_min), "n": int(r.n),
                "observed": float(r.observed), "lift": float(r.lift), "predMean": float(r.pred_mean), "byRegime": by,
            })

        def thr_bucket(p):
            for row in bucket_rows:
                if p >= row["scoreMin"]:
                    return row["bucket"]
            return "bottom50"

        # threshold assignment must reproduce the rank assignment on the test day
        thr_b = np.array([thr_bucket(x) for x in d.p.values])
        rk_b = np.array([rank_bucket[m] for m in d.index])
        thr_agree = float((thr_b == rk_b).mean())
        # grid drift
        pg = pd.Series(p_grid, index=te.mint.values).loc[d.index].values
        grid_b = np.array([thr_bucket(x) for x in pg])
        agreement[key] = {
            "thresholdVsRankBucketAgreement": thr_agree,
            "gridVsExactBucketAgreement": float((grid_b == rk_b).mean()),
            "gridVsExactMaxAbsDp": float(np.max(np.abs(pg - d.p.values))),
            "gridVsExactP99AbsDp": float(np.quantile(np.abs(pg - d.p.values), 0.99)),
        }

        # per-regime top-5 % lines from 04_robustness
        rb = robust[(robust.W == W) & (robust.label == lab)]
        def reg_row(name):
            r = rb[rb.subset == name].iloc[0]
            return {
                "n": int(r.n), "base": jsval(r.base), "auc": jsval(r.auc),
                "top5WithinPct": jsval(r["p@5%_within"]) if jsval(r["p@5%_within"]) is None else float(r["p@5%_within"]) * 100,
                "nAboveCut": jsval(r["n_above_global_top5%_thr"]),
                "aboveCutPct": None if jsval(r["rate_above_thr"]) is None else float(r["rate_above_thr"]) * 100,
            }
        regime_top5 = {"classic": reg_row("curve v1"), "mixed": reg_row("curve mixed")}

        # golden rows: stratified by bucket, deterministic
        rng = np.random.default_rng(20260830)
        te_by_mint = te.set_index("mint")
        fcols = all_feature_columns(W)
        golden = []
        for bid, k in GOLDEN_PER_BUCKET.items():
            seg = mints_in_bucket[bid]
            pick = rng.choice(seg.index.values, size=min(k, len(seg)), replace=False)
            for m in pick:
                row = te_by_mint.loc[m]
                f = {"windowS": W}
                for fk, col in fcols.items():
                    f[fk] = jsval(row[col], binary=fk in ("creatorSold", "curveMixed", "metaTwitter"))
                f["tradesSeen"] = int(row[f"n_trades_{W}s"])
                golden.append({"mint": m, "features": f, "p": float(pp.loc[m, "p"]), "bucket": rank_bucket[m],
                               "pGrid": float(pd.Series(p_grid, index=te.mint.values).loc[m])})

        out["models"][f"{W}|{lab}"] = {
            "key": key,
            "windowS": W,
            "label": lab,
            "labelText": {"grad": "graduated", "peak3": "peak_mult_60m >= 3 (from price_at_60s)",
                          "peak5": "peak_mult_60m >= 5 (from price_at_60s)"}[lab],
            "intercept": float(c["intercept"]),
            "features": feats,
            "base": base,
            "population": population,
            "buckets": bucket_rows,
            "regimeTop5": regime_top5,
            "footer": footer(W, population),
            "golden": golden,
        }

    out["exportCheck"] = agreement
    txt = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    open(DEST, "w", encoding="utf-8").write(txt)
    print(f"wrote {DEST}: {len(txt.encode('utf-8'))/1024:.1f} KB")
    for k, v in agreement.items():
        print(k, json.dumps(v))


if __name__ == "__main__":
    main()
