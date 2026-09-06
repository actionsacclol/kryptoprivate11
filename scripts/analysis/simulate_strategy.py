# Stage 3: full strategy simulation on the tape — entry gates x exit policies,
# with curve-exact fills (constant-product on the recorded virtual reserves),
# pump.fun 1% fee each way, and fixed per-trade overhead.
#
# Usage: python simulate_strategy.py
# Reads derived/ticks.csv + derived/tokens.csv.

import itertools
import numpy as np
import pandas as pd

DERIVED = r"D:\memedata\derived"
LAMPORTS = 1e9

FEE = 0.01              # pump.fun swap fee, each side
OVERHEAD_SOL = 0.0010   # priority fee + tip per round trip (Helius Sender swqos ~free, priority fee small)
ENTRY_LATENCY_MS = 400  # decision -> our buy lands this much later

tok = pd.read_csv(f"{DERIVED}/tokens.csv", usecols=["mid", "mint", "create_at", "creator"])
tk = pd.read_csv(
    f"{DERIVED}/ticks.csv",
    dtype={"mid": np.int32, "t_ms": np.int64, "price": np.float64, "is_buy": np.int8,
           "sol": np.float64, "v_sol": np.float64, "v_tok": np.float64,
           "is_creator": np.int8, "is_smart": np.int8, "user": np.int32},
)
tk = tk.sort_values(["mid", "t_ms"], kind="stable").reset_index(drop=True)

# pre-split tick arrays per token for fast walking
cols = ["t_ms", "price", "is_buy", "sol", "v_sol", "v_tok", "is_creator", "is_smart", "user"]
arr = {c: tk[c].to_numpy() for c in cols}
mids = tk["mid"].to_numpy()
bounds = {}
start = 0
for i in range(1, len(mids) + 1):
    if i == len(mids) or mids[i] != mids[i - 1]:
        bounds[mids[i - 1]] = (start, i)
        start = i


def buy_fill(v_sol, v_tok, spend_sol):
    """Buy spend_sol SOL against reserves; returns (tokens_raw, eff_price_sol_per_raw)."""
    s = spend_sol * LAMPORTS * (1 - FEE)
    k = v_sol * v_tok
    tokens = v_tok - k / (v_sol + s)
    return tokens, spend_sol / tokens


def sell_fill(v_sol, v_tok, tokens_raw):
    """Sell tokens_raw against reserves; returns SOL received after fee."""
    k = v_sol * v_tok
    out = (v_sol - k / (v_tok + tokens_raw)) / LAMPORTS
    return out * (1 - FEE)


def simulate(entry_ms, gates, exits, size_sol):
    """Walk every token; gate on features observable before entry; simulate exits.
    Returns per-trade DataFrame."""
    rows = []
    for mid, (a, b) in bounds.items():
        t_ms = arr["t_ms"][a:b]
        # entry index: first tick at/after decision+latency
        ei = np.searchsorted(t_ms, entry_ms + ENTRY_LATENCY_MS)
        if ei >= b - a:
            continue
        pre = slice(a, a + ei)
        n_pre = ei
        is_buy = arr["is_buy"][pre]
        sol = arr["sol"][pre]
        is_cr = arr["is_creator"][pre]
        users = arr["user"][pre]

        buys = int(is_buy.sum())
        sells = n_pre - buys
        sell_vol = float(sol[is_buy == 0].sum()) if sells else 0.0
        buy_vol = float(sol[is_buy == 1].sum()) if buys else 0.0
        net_inflow = buy_vol - sell_vol
        uniq_buyers = len(set(users[is_buy == 1])) if buys else 0
        creator_sold = bool((is_cr[is_buy == 0] == 1).any()) if sells else False
        smart_pre = int(arr["is_smart"][pre].sum())
        # curve progress at entry from the last pre tick (or entry tick)
        v_sol_last = arr["v_sol"][a + ei]
        curve_sol = v_sol_last / LAMPORTS - 30.0

        f = dict(buys=buys, sells=sells, sell_vol=sell_vol, buy_vol=buy_vol,
                 net_inflow=net_inflow, uniq_buyers=uniq_buyers,
                 creator_sold=creator_sold, smart_pre=smart_pre, curve_sol=curve_sol)
        if not gates(f):
            continue

        # ── enter on the entry tick's reserves ──
        ev_sol, ev_tok = arr["v_sol"][a + ei], arr["v_tok"][a + ei]
        tokens, eff_entry = buy_fill(ev_sol, ev_tok, size_sol)
        entry_price = arr["price"][a + ei]

        # ── walk forward ──
        peak = entry_price
        tp1_hit = False
        exit_i = None
        exit_reason = "eod"
        for j in range(a + ei + 1, b):
            p = arr["price"][j]
            dt = arr["t_ms"][j] - arr["t_ms"][a + ei]
            if p > peak:
                peak = p
            if exits.get("exit_on_creator_sell") and arr["is_buy"][j] == 0 and arr["is_creator"][j] == 1:
                exit_i, exit_reason = j, "creator_sell"
                break
            if p <= entry_price * (1 - exits["stop_loss"]):
                exit_i, exit_reason = j, "stop_loss"
                break
            if not tp1_hit and p >= entry_price * (1 + exits["tp1"]):
                tp1_hit = True
            if tp1_hit and p <= peak * (1 - exits["trail"]):
                exit_i, exit_reason = j, "trailing"
                break
            if dt >= exits["time_stop_s"] * 1000 and p < entry_price * (1 + exits.get("time_stop_min_gain", 0.10)):
                exit_i, exit_reason = j, "time_stop"
                break
        if exit_i is None:
            exit_i = b - 1
            if exit_i <= a + ei:
                exit_i = a + ei  # no forward tick: exit on entry tick (worst case)

        xv_sol, xv_tok = arr["v_sol"][exit_i], arr["v_tok"][exit_i]
        sol_out = sell_fill(xv_sol, xv_tok, tokens)
        pnl = sol_out - size_sol - OVERHEAD_SOL
        rows.append(dict(mid=mid, entry_ms=int(arr["t_ms"][a + ei]), pnl=pnl,
                         mult=arr["price"][exit_i] / entry_price, reason=exit_reason,
                         hold_s=(arr["t_ms"][exit_i] - arr["t_ms"][a + ei]) / 1000,
                         **f))
    return pd.DataFrame(rows)


def report(name, df):
    if len(df) == 0:
        print(f"{name:<44} n=0")
        return
    wins = (df.pnl > 0).mean() * 100
    print(f"{name:<44} n={len(df):>5}  win%={wins:5.1f}  totPnL={df.pnl.sum():+9.3f}  "
          f"avg={df.pnl.mean():+8.5f}  med={df.pnl.median():+8.5f}")
    by = df.groupby("reason").pnl.agg(["count", "sum"])
    print("   ", {r: (int(c), round(s, 3)) for r, (c, s) in by.iterrows()})


if __name__ == "__main__":
    CURRENT_EXITS = dict(stop_loss=0.35, tp1=0.6, trail=0.25, time_stop_s=90, exit_on_creator_sell=True)

    def current_gates(f):
        return (f["sells"] == 0 and f["sell_vol"] <= 0.4 and f["uniq_buyers"] >= 5 and
                f["uniq_buyers"] <= 11 and 1 <= f["net_inflow"] <= 18 and not f["creator_sold"])

    def no_gates(f):
        return f["buys"] >= 1

    print("== baseline: everything with >=1 pre-entry buy ==")
    report("no gates", simulate(15_000, no_gates, CURRENT_EXITS, 0.05))
    print("\n== current engine gates ==")
    report("current gates", simulate(15_000, current_gates, CURRENT_EXITS, 0.05))
