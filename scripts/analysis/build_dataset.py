# Stage 3b: one row per (token, entry_time) with entry-observable features and
# outcomes under the current exit policy + oracle forward stats.
# Gates are then just boolean masks over this table (sweep_gates.py).

import numpy as np
import pandas as pd
from simulate_strategy import arr, bounds, buy_fill, sell_fill, tok, OVERHEAD_SOL, ENTRY_LATENCY_MS

DERIVED = r"D:\memedata\derived"
LAMPORTS = 1e9
SIZE = 0.05

# creator history, computed causally: launches/rugs BEFORE each token's create
t = tok.copy()
tokfull = pd.read_csv(f"{DERIVED}/tokens.csv")
tokfull = tokfull.sort_values("create_at").reset_index(drop=True)
tokfull["creator_prior_launches"] = tokfull.groupby("creator").cumcount()
# prior token by same creator where creator sold within 60s (a "farm" signature)
tokfull["was_fast_dump"] = ((tokfull.first_creator_sell_ms >= 0) & (tokfull.first_creator_sell_ms < 60_000)).astype(int)
tokfull["creator_prior_dumps"] = tokfull.groupby("creator").was_fast_dump.cumsum() - tokfull.was_fast_dump
chist = tokfull.set_index("mid")[["creator_prior_launches", "creator_prior_dumps", "complete_ms", "max_price_ms", "n_trades"]]


CLEAN = set(pd.read_csv(f"{DERIVED}/clean_mids.csv").mid)


def build(entry_ms, exits):
    rows = []
    for mid, (a, b) in bounds.items():
        if mid not in CLEAN:
            continue
        t_ms = arr["t_ms"][a:b]
        ei = np.searchsorted(t_ms, entry_ms + ENTRY_LATENCY_MS)
        if ei >= b - a:
            continue
        pre = slice(a, a + ei)
        is_buy = arr["is_buy"][pre]
        sol = arr["sol"][pre]
        is_cr = arr["is_creator"][pre]
        users = arr["user"][pre]
        buys = int(is_buy.sum())
        sells = int(ei - buys)
        buy_mask = is_buy == 1
        buy_vol = float(sol[buy_mask].sum()) if buys else 0.0
        sell_vol = float(sol[~buy_mask].sum()) if sells else 0.0
        uniq_buyers = len(set(users[buy_mask])) if buys else 0
        creator_sold = int((is_cr[~buy_mask] == 1).any()) if sells else 0
        dev_buy = float(sol[buy_mask & (is_cr == 1)].sum()) if buys else 0.0
        smart_pre = int(arr["is_smart"][pre].sum())
        top_share = 0.0
        if buys:
            bu = users[buy_mask]
            bs = sol[buy_mask]
            best = 0.0
            for u in set(bu):
                v = bs[bu == u].sum()
                if v > best:
                    best = v
            top_share = best / buy_vol if buy_vol > 0 else 0.0
        # last pre-entry trade recency (flow still alive at decision?)
        last_pre_gap_ms = int(entry_ms - t_ms[ei - 1]) if ei > 0 else -1

        ev_sol, ev_tok = arr["v_sol"][a + ei], arr["v_tok"][a + ei]
        entry_price = arr["price"][a + ei]
        if entry_price <= 0:
            continue
        curve_sol = ev_sol / LAMPORTS - 30.0
        curve_pct = curve_sol / 85.0 * 100.0

        tokens, _ = buy_fill(ev_sol, ev_tok, SIZE)

        # forward path arrays
        fp = arr["price"][a + ei + 1:b]
        ft = arr["t_ms"][a + ei + 1:b]
        fb = arr["is_buy"][a + ei + 1:b]
        fc = arr["is_creator"][a + ei + 1:b]
        n = len(fp)

        # oracle stats
        if n:
            rel = fp / entry_price
            dt = ft - arr["t_ms"][a + ei]
            m60 = rel[dt <= 60_000].max() if (dt <= 60_000).any() else 1.0
            m300 = rel[dt <= 300_000].max() if (dt <= 300_000).any() else 1.0
            up_i = np.argmax(rel >= 1 + exits["tp1"]) if (rel >= 1 + exits["tp1"]).any() else -1
            dn_i = np.argmax(rel <= 1 - exits["stop_loss"]) if (rel <= 1 - exits["stop_loss"]).any() else -1
            up_first = int(up_i >= 0 and (dn_i < 0 or up_i < dn_i))
            cs_mask = (fb == 0) & (fc == 1)
            cs_i = np.argmax(cs_mask) if cs_mask.any() else -1
        else:
            m60 = m300 = 1.0
            up_first = 0
            cs_i = -1

        # exit walk under current policy
        peak = entry_price
        tp1_hit = False
        exit_i = None
        reason = "eod"
        for j in range(n):
            p = fp[j]
            if p > peak:
                peak = p
            if exits.get("exit_on_creator_sell") and fb[j] == 0 and fc[j] == 1:
                exit_i, reason = j, "creator_sell"
                break
            if p <= entry_price * (1 - exits["stop_loss"]):
                exit_i, reason = j, "stop_loss"
                break
            if not tp1_hit and p >= entry_price * (1 + exits["tp1"]):
                tp1_hit = True
            if tp1_hit and p <= peak * (1 - exits["trail"]):
                exit_i, reason = j, "trailing"
                break
            if (ft[j] - arr["t_ms"][a + ei]) >= exits["time_stop_s"] * 1000 and p < entry_price * 1.10:
                exit_i, reason = j, "time_stop"
                break
        if exit_i is None:
            exit_i = n - 1
        if n:
            xj = a + ei + 1 + exit_i
            sol_out = sell_fill(arr["v_sol"][xj], arr["v_tok"][xj], tokens)
            hold_s = (arr["t_ms"][xj] - arr["t_ms"][a + ei]) / 1000
        else:
            sol_out = sell_fill(ev_sol, ev_tok, tokens)
            hold_s = 0.0
            reason = "no_fwd"
        pnl = sol_out - SIZE - OVERHEAD_SOL

        rows.append(dict(
            mid=mid, buys=buys, sells=sells, buy_vol=buy_vol, sell_vol=sell_vol,
            net_inflow=buy_vol - sell_vol, uniq_buyers=uniq_buyers,
            creator_sold=creator_sold, dev_buy=dev_buy, smart_pre=smart_pre,
            top_share=round(top_share, 4), last_pre_gap_ms=last_pre_gap_ms,
            curve_pct=round(curve_pct, 3), entry_price=entry_price,
            fwd_ticks=n, m60=round(float(m60), 4), m300=round(float(m300), 4),
            up_first=up_first, cs_after_ms=int(ft[cs_i] - arr["t_ms"][a + ei]) if cs_i >= 0 else -1,
            pnl=round(pnl, 6), reason=reason, hold_s=round(hold_s, 2),
        ))
    df = pd.DataFrame(rows).set_index("mid")
    return df.join(chist, how="left")


if __name__ == "__main__":
    EXITS = dict(stop_loss=0.35, tp1=0.6, trail=0.25, time_stop_s=90, exit_on_creator_sell=True)
    for T in (5_000, 15_000):
        df = build(T, EXITS)
        df.to_csv(f"{DERIVED}/dataset_{T//1000}s.csv")
        print(f"dataset_{T//1000}s.csv: {len(df)} rows, totPnL={df.pnl.sum():+.2f}")
