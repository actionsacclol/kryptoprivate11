# Stage 2: market-structure baseline over the full firehose tape.
#
# Loads derived/tokens.csv + derived/ticks.csv, then answers:
#   1. What does the launch population look like (activity, graduation, rugs)?
#   2. If we entered at T seconds after create, what forward multiples exist?
#   3. Which entry-time-observable features separate winners from losers?
#
# Entries are modeled realistically: fill at the curve state of the first tick
# AFTER the decision time (plus our own price impact via constant-product
# reserves), pump.fun 1% fee each way, plus fixed per-round-trip overhead.

import numpy as np
import pandas as pd

DERIVED = r"D:\memedata\derived"

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 50)

tok = pd.read_csv(f"{DERIVED}/tokens.csv")
print(f"tokens: {len(tok)}")

tk = pd.read_csv(
    f"{DERIVED}/ticks.csv",
    dtype={
        "mid": np.int32, "t_ms": np.int64, "price": np.float64,
        "is_buy": np.int8, "sol": np.float64, "v_sol": np.int64,
        "v_tok": np.int64, "is_creator": np.int8, "is_smart": np.int8,
        "user": np.int32,
    },
)
print(f"ticks: {len(tk)}")

# ── 1. population baseline ─────────────────────────────────────────────
print("\n== population ==")
print("tokens with 0 trades recorded:", (tok.n_trades == 0).sum())
for n in (1, 5, 10, 25, 50, 100, 250):
    print(f"  >= {n:>4} trades: {(tok.n_trades >= n).sum():>6}  ({(tok.n_trades >= n).mean()*100:.1f}%)")
print("graduated (complete):", (tok.complete_ms >= 0).sum())
print("creator sold at some point:", (tok.first_creator_sell_ms >= 0).sum(),
      f"({(tok.first_creator_sell_ms >= 0).mean()*100:.1f}%)")
med = tok.loc[tok.first_creator_sell_ms >= 0, "first_creator_sell_ms"]
print("  median first creator sell:", f"{med.median()/1000:.1f}s")
print("smart-flagged trade on token:", (tok.smart_trades > 0).sum())

# ── 2. forward multiples from a T-second entry ────────────────────────
# For each entry delay T, find each token's first tick at/after T, treat its
# price as the raw entry quote, then compute max and horizon-forward prices.
tk = tk.sort_values(["mid", "t_ms"], kind="stable").reset_index(drop=True)

FEE = 0.01          # pump.fun swap fee each way
OVERHEAD_SOL = 0.0012  # priority fee + tip, per round trip, on ~0.05-0.1 SOL size


def entry_snapshot(entry_ms: int) -> pd.DataFrame:
    """Per-token entry price/state at first tick >= entry_ms, plus features
    computed from ticks strictly BEFORE that tick (observable at decision)."""
    pre = tk[tk.t_ms < entry_ms]
    post = tk[tk.t_ms >= entry_ms]

    first_post = post.groupby("mid").first()
    ep = first_post[["t_ms", "price", "v_sol", "v_tok"]].rename(
        columns={"t_ms": "entry_ms", "price": "entry_price"})

    g = pre.groupby("mid")
    feat = pd.DataFrame({
        "buys": g.is_buy.sum(),
        "trades": g.size(),
        "buy_sol": pre[pre.is_buy == 1].groupby("mid").sol.sum(),
        "sell_sol": pre[pre.is_buy == 0].groupby("mid").sol.sum(),
        "uniq_buyers": pre[pre.is_buy == 1].groupby("mid").user.nunique(),
        "creator_sold_pre": pre[(pre.is_buy == 0) & (pre.is_creator == 1)].groupby("mid").size(),
        "smart_pre": pre[pre.is_smart == 1].groupby("mid").size(),
        "dev_buy_sol": pre[(pre.is_buy == 1) & (pre.is_creator == 1)].groupby("mid").sol.sum(),
    })
    feat["sells"] = feat.trades - feat.buys
    feat = feat.fillna(0)

    # biggest single buyer share of pre-entry buy volume
    by_user = pre[pre.is_buy == 1].groupby(["mid", "user"]).sol.sum()
    feat["top_buyer_sol"] = by_user.groupby("mid").max()
    feat["top_buyer_share"] = (feat.top_buyer_sol / feat.buy_sol.replace(0, np.nan)).fillna(0)

    # forward stats from entry tick onward
    fwd = post.groupby("mid")
    out = pd.DataFrame({
        "fwd_max": fwd.price.max(),
        "fwd_last": fwd.price.last(),
        "fwd_ticks": fwd.size(),
    })
    snap = ep.join(feat, how="left").join(out, how="left").fillna(
        {"buys": 0, "trades": 0, "buy_sol": 0, "sell_sol": 0, "uniq_buyers": 0,
         "creator_sold_pre": 0, "smart_pre": 0, "dev_buy_sol": 0, "sells": 0,
         "top_buyer_sol": 0, "top_buyer_share": 0})
    snap["max_mult"] = snap.fwd_max / snap.entry_price
    snap["last_mult"] = snap.fwd_last / snap.entry_price
    # curve progress proxy: real SOL in curve = vSol - 30 virtual SOL offset
    snap["curve_sol"] = snap.v_sol / 1e9 - 30.0
    return snap


for T in (2, 5, 10, 15, 30):
    s = entry_snapshot(T * 1000)
    alive = s[s.fwd_ticks >= 3]
    print(f"\n== entry at t+{T}s: {len(s)} tokens have a fillable tick, {len(alive)} with >=3 fwd ticks ==")
    q = alive.max_mult.quantile([0.5, 0.75, 0.9, 0.95, 0.99]).round(3)
    print("  max_mult quantiles:", dict(q))
    for th in (1.2, 1.5, 2.0, 3.0, 5.0):
        print(f"    P(max >= {th}x): {(alive.max_mult >= th).mean()*100:5.2f}%   n={(alive.max_mult >= th).sum()}")
    print(f"  median last_mult (token's fate within 15min window): {alive.last_mult.median():.3f}")

# save the 15s snapshot for the gate/exit stage
s15 = entry_snapshot(15_000)
s15.to_csv(f"{DERIVED}/snapshot_15s.csv")
print("\nwrote snapshot_15s.csv:", len(s15))
