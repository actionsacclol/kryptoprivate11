# Stage 5: robustness of the inflow6 + trailing-stop edge.
#  - per-day PnL split, outlier concentration, latency sensitivity,
#  - refinement grid around trail 20 / SL 25 / ts 90,
#  - inflow threshold sweep, entry-time sweep.

import numpy as np
import pandas as pd
import simulate_strategy as S
from simulate_strategy import arr, bounds, buy_fill, sell_fill, OVERHEAD_SOL

DERIVED = r"D:\memedata\derived"
SIZE = 0.05

tok = pd.read_csv(f"{DERIVED}/tokens.csv", usecols=["mid", "create_at"]).set_index("mid")
ds = pd.read_csv(f"{DERIVED}/dataset_5s.csv").set_index("mid")
ds = ds[ds.fwd_ticks >= 1].join(tok)
ds["day"] = pd.to_datetime(ds.create_at, unit="ms").dt.date


def walk(mid, pol, entry_ms, latency_ms):
    a, b = bounds[mid]
    t_ms = arr["t_ms"][a:b]
    ei = np.searchsorted(t_ms, entry_ms + latency_ms)
    if ei >= b - a:
        return None
    j0 = a + ei
    entry_price = arr["price"][j0]
    if entry_price <= 0:
        return None
    tokens, _ = buy_fill(arr["v_sol"][j0], arr["v_tok"][j0], SIZE)
    peak = entry_price
    exit_i, reason = None, "eod"
    for j in range(j0 + 1, b):
        p = arr["price"][j]
        if p > peak:
            peak = p
        if arr["is_buy"][j] == 0 and arr["is_creator"][j] == 1:
            exit_i, reason = j, "creator_sell"
            break
        if p <= entry_price * (1 - pol["sl"]):
            exit_i, reason = j, "stop_loss"
            break
        if peak > entry_price and p <= peak * (1 - pol["trail"]):
            exit_i, reason = j, "trailing"
            break
        if (arr["t_ms"][j] - arr["t_ms"][j0]) >= pol["ts"] * 1000 and p < entry_price * 1.10:
            exit_i, reason = j, "time_stop"
            break
    if exit_i is None:
        exit_i = b - 1
        if exit_i <= j0:
            return None
    sol_out = sell_fill(arr["v_sol"][exit_i], arr["v_tok"][exit_i], tokens)
    return sol_out - SIZE - OVERHEAD_SOL, reason, arr["t_ms"][exit_i] - arr["t_ms"][j0]


def run(sub, pol, entry_ms=5000, latency=400):
    rows = []
    for m in sub.index:
        if m not in bounds:
            continue
        r = walk(m, pol, entry_ms, latency)
        if r:
            rows.append((m, r[0], r[1], r[2]))
    return pd.DataFrame(rows, columns=["mid", "pnl", "reason", "hold_ms"]).set_index("mid")


BASE = dict(sl=0.25, trail=0.20, ts=90)
sub6 = ds[(ds.net_inflow >= 6) & (ds.creator_sold == 0) & (ds.dev_buy <= 2)]

print("== base: inflow6 + tr20/sl25/ts90 ==")
r = run(sub6, BASE)
j = r.join(ds[["day"]])
print(f"n={len(r)} win={(r.pnl>0).mean()*100:.1f}% tot={r.pnl.sum():+.3f} avg={r.pnl.mean():+.5f}")
print("\nper-day:")
print(j.groupby("day").pnl.agg(["count", "sum", "mean"]).round(4).to_string())
srt = r.pnl.sort_values(ascending=False)
print(f"\ntop5 trades: {srt.head(5).round(4).tolist()}  (sum {srt.head(5).sum():+.3f} of {r.pnl.sum():+.3f})")
print(f"top20 share of gross profit: {srt.head(20).sum()/srt[srt>0].sum()*100:.0f}%")
print(f"pnl quantiles: {dict(r.pnl.quantile([.05,.25,.5,.75,.95]).round(4))}")

print("\n== latency sensitivity (entry fill delay) ==")
for lat in (200, 400, 800, 1500):
    r = run(sub6, BASE, latency=lat)
    print(f"  latency {lat:>4}ms: n={len(r)} tot={r.pnl.sum():+.3f} avg={r.pnl.mean():+.5f}")

print("\n== entry decision time sweep (latency 400) ==")
for T in (3000, 5000, 8000, 12000):
    dsT = pd.read_csv(f"{DERIVED}/dataset_5s.csv").set_index("mid")  # features still from 5s obs
    subT = sub6
    r = run(subT, BASE, entry_ms=T)
    print(f"  decide t+{T/1000:.0f}s: n={len(r)} tot={r.pnl.sum():+.3f} avg={r.pnl.mean():+.5f}")

print("\n== refinement grid ==")
for trail in (0.15, 0.18, 0.20, 0.22, 0.25):
    for sl in (0.20, 0.25, 0.30):
        r = run(sub6, dict(sl=sl, trail=trail, ts=90))
        print(f"  trail {trail:.2f} sl {sl:.2f}: n={len(r)} tot={r.pnl.sum():+.3f} avg={r.pnl.mean():+.5f} win={(r.pnl>0).mean()*100:.0f}%")

print("\n== inflow threshold sweep (trail .20 sl .25) ==")
for th in (3, 4, 6, 8, 10, 14):
    sub = ds[(ds.net_inflow >= th) & (ds.creator_sold == 0) & (ds.dev_buy <= 2)]
    r = run(sub, BASE)
    print(f"  inflow>={th:>2}: n={len(r)} ({len(r)/3:.0f}/day) tot={r.pnl.sum():+.3f} avg={r.pnl.mean():+.5f} win={(r.pnl>0).mean()*100:.0f}%")

print("\n== extra gate candidates on top of base ==")
cands = {
    "+buys>=12": sub6[sub6.buys >= 12],
    "+top_share<=0.5": sub6[sub6.top_share <= 0.5],
    "+uniq>=8": sub6[sub6.uniq_buyers >= 8],
    "+curve>=8pct": sub6[sub6.curve_pct >= 8],
    "+gap<=400ms": sub6[sub6.last_pre_gap_ms <= 400],
    "+prior_dumps<=1": sub6[sub6.creator_prior_dumps <= 1],
    "+prior_launch<=3": sub6[sub6.creator_prior_launches <= 3],
}
for name, sub in cands.items():
    r = run(sub, BASE)
    if len(r):
        print(f"  {name:<18} n={len(r):>5} tot={r.pnl.sum():+.3f} avg={r.pnl.mean():+.5f} win={(r.pnl>0).mean()*100:.0f}%")
