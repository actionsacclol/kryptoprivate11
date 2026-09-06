# Stage 4: exit-policy grid x entry-subset sweep on clean tokens.
# Fills are curve-exact (reserves), pump 1% fee each way, fixed overhead.

import numpy as np
import pandas as pd
from simulate_strategy import arr, bounds, buy_fill, sell_fill, OVERHEAD_SOL, ENTRY_LATENCY_MS

DERIVED = r"D:\memedata\derived"
SIZE = 0.05
ENTRY_MS = 5_000

ds = pd.read_csv(f"{DERIVED}/dataset_5s.csv").set_index("mid")
ds = ds[ds.fwd_ticks >= 1]

SUBSETS = {
    "all": ds,
    "flow12": ds[(ds.buys >= 12) & (ds.creator_sold == 0)],
    "flow12_smalldev": ds[(ds.buys >= 12) & (ds.creator_sold == 0) & (ds.dev_buy <= 2)],
    "flow18_distributed": ds[(ds.buys >= 18) & (ds.top_share <= 0.25)],
    "inflow6": ds[(ds.net_inflow >= 6) & (ds.creator_sold == 0) & (ds.dev_buy <= 2)],
    "hotgap": ds[(ds.uniq_buyers >= 15) & (ds.last_pre_gap_ms <= 400)],
    "burst_fresh": ds[(ds.buys >= 12) & (ds.creator_sold == 0) & (ds.dev_buy <= 2) & (ds.top_share <= 0.3) & (ds.curve_pct >= 8)],
}

POLICIES = {
    # scalps: hard take-profit
    "tp15_sl15_ts30":  dict(sl=0.15, tp=0.15, trail=None, arm=0, ts=30, ts_below=99),
    "tp20_sl15_ts45":  dict(sl=0.15, tp=0.20, trail=None, arm=0, ts=45, ts_below=99),
    "tp25_sl20_ts60":  dict(sl=0.20, tp=0.25, trail=None, arm=0, ts=60, ts_below=99),
    "tp30_sl15_ts60":  dict(sl=0.15, tp=0.30, trail=None, arm=0, ts=60, ts_below=99),
    "tp40_sl20_ts60":  dict(sl=0.20, tp=0.40, trail=None, arm=0, ts=60, ts_below=99),
    # trailing from entry
    "tr12_sl15_ts60":  dict(sl=0.15, tp=None, trail=0.12, arm=0, ts=60, ts_below=0.10),
    "tr15_sl20_ts60":  dict(sl=0.20, tp=None, trail=0.15, arm=0, ts=60, ts_below=0.10),
    "tr20_sl25_ts90":  dict(sl=0.25, tp=None, trail=0.20, arm=0, ts=90, ts_below=0.10),
    "tr30_sl20_ts120": dict(sl=0.20, tp=None, trail=0.30, arm=0, ts=120, ts_below=0.10),
    # armed trailing (current style)
    "arm60_tr25_sl35_ts90": dict(sl=0.35, tp=None, trail=0.25, arm=0.60, ts=90, ts_below=0.10),
    "arm20_tr12_sl15_ts60": dict(sl=0.15, tp=None, trail=0.12, arm=0.20, ts=60, ts_below=0.10),
    "arm30_tr15_sl20_ts60": dict(sl=0.20, tp=None, trail=0.15, arm=0.30, ts=60, ts_below=0.10),
    # flat time exits
    "hold30":          dict(sl=9.9, tp=None, trail=None, arm=0, ts=30, ts_below=99),
    "hold60":          dict(sl=9.9, tp=None, trail=None, arm=0, ts=60, ts_below=99),
}


def walk(mid, pol):
    a, b = bounds[mid]
    t_ms = arr["t_ms"][a:b]
    ei = np.searchsorted(t_ms, ENTRY_MS + ENTRY_LATENCY_MS)
    if ei >= b - a:
        return None
    j0 = a + ei
    ev_sol, ev_tok = arr["v_sol"][j0], arr["v_tok"][j0]
    entry_price = arr["price"][j0]
    if entry_price <= 0:
        return None
    tokens, _ = buy_fill(ev_sol, ev_tok, SIZE)
    peak = entry_price
    armed = pol["arm"] == 0
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
        if pol["tp"] is not None and p >= entry_price * (1 + pol["tp"]):
            exit_i, reason = j, "take_profit"
            break
        if not armed and p >= entry_price * (1 + pol["arm"]):
            armed = True
        if pol["trail"] is not None and armed and peak > entry_price and p <= peak * (1 - pol["trail"]):
            exit_i, reason = j, "trailing"
            break
        if (arr["t_ms"][j] - arr["t_ms"][j0]) >= pol["ts"] * 1000 and p < entry_price * (1 + pol["ts_below"]):
            exit_i, reason = j, "time_stop"
            break
    if exit_i is None:
        exit_i = b - 1
        if exit_i <= j0:
            return None
    sol_out = sell_fill(arr["v_sol"][exit_i], arr["v_tok"][exit_i], tokens)
    return sol_out - SIZE - OVERHEAD_SOL, reason


results = []
for sname, sub in SUBSETS.items():
    mids = [m for m in sub.index if m in bounds]
    for pname, pol in POLICIES.items():
        if sname == "all" and pname not in ("tp20_sl15_ts45", "tr12_sl15_ts60", "arm60_tr25_sl35_ts90", "hold30"):
            continue
        pnls = []
        reasons = {}
        for m in mids:
            r = walk(m, pol)
            if r is None:
                continue
            pnls.append(r[0])
            reasons[r[1]] = reasons.get(r[1], 0) + 1
        if not pnls:
            continue
        p = np.array(pnls)
        results.append(dict(subset=sname, policy=pname, n=len(p),
                            win=round((p > 0).mean() * 100, 1),
                            tot=round(p.sum(), 3), avg=round(p.mean(), 5),
                            per_day=round(p.sum() / 3, 3),
                            reasons=reasons))
        print(results[-1], flush=True)

res = pd.DataFrame(results)
res.to_csv(f"{DERIVED}/exit_sweep.csv", index=False)
print("\ntop by avg:")
print(res.sort_values("avg", ascending=False).head(15).to_string(index=False))
