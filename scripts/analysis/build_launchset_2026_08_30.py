r"""
Build the per-launch dataset `launches.parquet` from the raw firehose tape.

    python scripts/analysis/build_launchset_2026_08_30.py [--src E:\data] [--out E:\data\work\launchset-2026-08-30]
                                                          [--days 2026-07-25,2026-07-26,2026-07-27] [--max-lines N]

One streaming pass over the day files in chronological order (never loads a
file whole). Only `tape_create` / `tape_trade` / `tape_complete` /
`tape_metadata` rows are market truth; the engine's own `create`/`trade`
duplicates and `tape_amm` payloads are skipped by prefix before JSON parsing.

Row = one token whose `tape_create` fell on one of --days (UTC date of the
recorder's receive timestamp). Every later file in --src is streamed too so
labels for launches near a day boundary are not truncated; the coverage a
launch actually got is reported in `coverage_after_create_s`.

Feature windows are frozen at t+15/30/60/120 s using ONLY trades with
offset <= W. Labels use only trades AFTER the 60 s entry point (or are
outcome events). See README.md next to the output for every column.

Launch-mode tape (recorder mode 'launch', the default since 2026-08-30):
the recorder keeps every `tape_create`/`tape_complete`/`tape_metadata` but
only the first LAUNCH_WINDOW (30 min) of each mint's `tape_trade` rows, at
most LAUNCH_TRADE_CAP (3,000) per mint. The `engine_start` row carries
`mode: "launch"` and the exact `launch: {windowMs, maxTradesPerMint}` used.
This builder reads such files unchanged; it just treats the window/cap as a
coverage limit, so labels whose horizon lies beyond it are NULL (censored),
never 0. What survives: graduated (complete events are always kept),
dead_by_10m, mult_at_5m, peak_mult_10m, mult_at_30m (window edge), dev_sold
inside 30 min, every feature window. What is censored: peak_mult_60m,
peak_time_60m_s, n_trades_10m_to_60m, and (for a mint that hit the trade
cap) everything after the cap. `label_censored_at_s` says where; `tape_mode`
says why.
"""
import argparse
import bisect
import datetime as dt
import glob
import json
import os
import statistics
import sys
import time
from collections import defaultdict, deque

try:
    import orjson

    def loads(b):
        return orjson.loads(b)
except ImportError:  # pragma: no cover
    def loads(b):
        return json.loads(b)

# ── pump.fun bonding-curve constants (verified against the tape: the first
# buy of a fresh curve lands on vSol = 30 SOL + sol_in, vTok = 1.073e15 - tokens)
INIT_VSOL = 30_000_000_000          # lamports
INIT_VTOK = 1_073_000_000_000_000   # raw (6 decimals)
INIT_PRICE = (INIT_VSOL / 1e9) / (INIT_VTOK / 1e6)   # SOL per token
TOTAL_SUPPLY = 1_000_000_000.0      # UI tokens; share_of_supply = tokens / this
REAL_TOKEN_RESERVES = 793_100_000_000_000   # raw tokens the curve sells before it completes
VTOK_FLOOR = INIT_VTOK - REAL_TOKEN_RESERVES  # 279.9e12: vTok at completion (verified == tape_complete)
K_INIT = INIT_VSOL * INIT_VTOK      # constant product of a standard (v1) curve
SNIPER_WINDOW_SLOTS = 20            # shared/launchintel.ts: SNIPER_WINDOW_SLOTS
WINDOWS = (15, 30, 60, 120)
HOLD_MS = 3_600_000                 # keep a launch's trade list this long, then finalize
GAP_MS = 120_000                    # a jump in receive time above this is a recording gap
ENTRY_S = 60                        # labels are relative to price_at_60s
# launch-mode recorder defaults (electron/engine/launchRecorder.ts); the
# engine_start row overrides them when present
LAUNCH_WINDOW_MS = 30 * 60_000
LAUNCH_TRADE_CAP = 3_000


def gini(xs):
    n = len(xs)
    if n == 0:
        return None
    s = sorted(xs)
    tot = sum(s)
    if tot <= 0:
        return None
    cum = 0.0
    for i, x in enumerate(s, 1):
        cum += i * x
    return (2.0 * cum) / (n * tot) - (n + 1.0) / n


def spot(vsol, vtok):
    return (vsol / 1e9) / (vtok / 1e6) if vtok > 0 else None


class Launch:
    __slots__ = (
        "mint", "create_at", "slot", "creator", "name", "symbol", "uri", "day",
        "trades", "finalized", "row",
        # running post-window state (never freed)
        "n_trades_total", "last_off", "complete_off", "curve_full_off",
        "dev_sold_off", "dev_sold_tokens", "dev_net_before_sell", "creator_net",
        "meta", "prior", "cap_off",
    )

    def __init__(self, r, day, prior):
        self.mint = r["mint"]
        self.create_at = r["at"]
        self.slot = r.get("slot") or 0
        self.creator = r.get("creator") or r.get("user") or ""
        self.name = r.get("name") or ""
        self.symbol = r.get("symbol") or ""
        self.uri = r.get("uri") or ""
        self.day = day
        self.trades = []          # (off_ms, slot_off, is_buy, sol, tokens, vsol, vtok, user)
        self.finalized = False
        self.row = None
        self.n_trades_total = 0
        self.last_off = None
        self.complete_off = None
        self.curve_full_off = None
        self.dev_sold_off = None
        self.dev_sold_tokens = None
        self.dev_net_before_sell = None
        self.creator_net = 0.0
        self.meta = None
        self.prior = prior
        self.cap_off = None        # offset of the trade that hit the launch-mode cap


def window_features(tr, W, creator, create_slot):
    """tr = trades sorted by (slot, off) with off <= W*1000. Returns dict."""
    n = len(tr)
    out = {}
    buys = [t for t in tr if t[2]]
    sells = [t for t in tr if not t[2]]
    out["n_trades"] = n
    out["n_buys"] = len(buys)
    out["n_sells"] = len(sells)
    out["unique_buyers"] = len({t[7] for t in buys})
    out["unique_sellers"] = len({t[7] for t in sells})
    buy_sol = sum(t[3] for t in buys)
    sell_sol = sum(t[3] for t in sells)
    out["buy_sol"] = buy_sol
    out["sell_sol"] = sell_sol
    out["net_sol"] = buy_sol - sell_sol
    if n:
        last = tr[-1]
        out["curve_progress"] = min(1.0, max(0.0, (INIT_VTOK - last[6]) / REAL_TOKEN_RESERVES))
        out["price"] = spot(last[5], last[6])
        out["k_consistent"] = all(abs(t[5] * t[6] / K_INIT - 1.0) < 0.005 for t in tr)
    else:
        out["curve_progress"] = 0.0
        out["price"] = INIT_PRICE
        out["k_consistent"] = None
    bsz = [t[3] for t in buys]
    out["largest_buy_sol"] = max(bsz) if bsz else None
    out["median_buy_sol"] = statistics.median(bsz) if bsz else None
    out["gini_buy_sol"] = gini(bsz) if len(bsz) >= 2 else None

    # per-wallet net position + cohort by FIRST buy slot (launchintel definitions)
    net = defaultdict(float)
    first_slot = {}
    gross_buy = defaultdict(float)
    for t in tr:
        u = t[7]
        if t[2]:
            net[u] += t[4]
            gross_buy[u] += t[4]
            if u not in first_slot:
                first_slot[u] = t[1]
        else:
            net[u] -= t[4]
    creator_net = net.get(creator, 0.0)
    out["creator_share_of_supply"] = max(0.0, creator_net) / TOTAL_SUPPLY
    others = sorted((max(0.0, v) for u, v in net.items() if u != creator), reverse=True)
    out["top3_buyers_share_of_supply"] = sum(others[:3]) / TOTAL_SUPPLY
    bundle = 0.0
    sniper = 0.0
    for u, s in first_slot.items():
        if u == creator:
            continue
        so = s
        if so <= 0:
            bundle += gross_buy[u]
        elif so <= SNIPER_WINDOW_SLOTS:
            sniper += gross_buy[u]
    out["bundle_share"] = bundle / TOTAL_SUPPLY
    out["sniper_share"] = sniper / TOTAL_SUPPLY
    lo = (W - 10) * 1000
    out["trades_per_second_last_10s"] = sum(1 for t in tr if t[0] > lo) / 10.0
    out["sells_to_buys_ratio"] = (len(sells) / len(buys)) if buys else None
    half = W * 500
    ub_half = len({t[7] for t in buys if t[0] <= half})
    out["unique_buyer_growth_rate"] = (out["unique_buyers"] - ub_half) / (W / 2.0)
    out["creator_sold"] = any(t[7] == creator for t in sells)
    # continuity proxy: does each trade's pre-state equal the previous post-state?
    breaks = 0
    prev_vtok = INIT_VTOK
    for t in tr:
        raw = round(t[4] * 1e6)
        pre = t[6] + raw if t[2] else t[6] - raw
        if abs(pre - prev_vtok) > 2_000:
            breaks += 1
        prev_vtok = t[6]
    out["continuity_breaks"] = breaks
    return out


def finalize(L, coverage_ms, launch=None):
    """Compute the frozen feature windows + the <=60m labels. Called once the
    stream is >= 60 min past the create (or at EOF).

    `launch` = (window_ms, cap) when the tape was recorded in launch mode: the
    recorder stopped keeping this mint's trades at the window edge (or at the
    cap, if it was hit first), so the label coverage is clipped there — a
    label with a longer horizon is null, never 0."""
    censored_ms = None
    if launch is not None:
        censored_ms = launch[0]
        if L.cap_off is not None:
            censored_ms = min(censored_ms, L.cap_off)
        coverage_ms = min(coverage_ms, censored_ms)
    tr = sorted(L.trades, key=lambda t: (t[1], t[0]))
    offs = [t[0] for t in tr]
    row = {
        "mint": L.mint,
        "day": L.day,
        "create_ts_ms": L.create_at,
        "create_iso": dt.datetime.fromtimestamp(L.create_at / 1000, dt.UTC).isoformat(timespec="milliseconds"),
        "create_slot": L.slot,
        "creator": L.creator,
        "name_len": len(L.name),
        "symbol_len": len(L.symbol),
        "name_blank": not any(c.isalnum() for c in L.name),
        "uri_is_ipfs": ("ipfs" in L.uri.lower()) if L.uri else None,
        "uri_host": (L.uri.split("/")[2] if L.uri.count("/") >= 2 else None),
        "token_program": None,  # not in the tape's create record; see README
    }
    # dev buy inside the create tx (slot offset 0, creator)
    row["dev_buy_sol"] = sum(t[3] for t in tr if t[2] and t[1] <= 0 and t[7] == L.creator)
    row["dev_buy_share_of_supply"] = sum(t[4] for t in tr if t[2] and t[1] <= 0 and t[7] == L.creator) / TOTAL_SUPPLY
    row["first_trade_s"] = (offs[0] / 1000.0) if offs else None
    if tr:
        t = tr[0]
        base = t[5] - round(t[3] * 1e9) if t[2] else t[5] + round(t[3] * 1e9)
        row["init_vsol_ok"] = abs(base - INIT_VSOL) < 20_000_000
        k120 = [abs(t[5] * t[6] / K_INIT - 1.0) < 0.005 for t in tr if t[0] <= 120_000]
        row["curve_kind_120s"] = ("nonstd" if not row["init_vsol_ok"] else "v1" if all(k120) else "mixed") if k120 else None
    else:
        row["init_vsol_ok"] = None
        row["curve_kind_120s"] = None
    row["coverage_after_create_s"] = coverage_ms / 1000.0
    row["tape_mode"] = "launch" if launch is not None else "firehose"
    row["label_censored_at_s"] = (censored_ms / 1000.0) if censored_ms is not None else None
    row["trade_cap_hit"] = L.cap_off is not None

    for W in WINDOWS:
        k = bisect.bisect_right(offs, W * 1000)
        f = window_features(tr[:k], W, L.creator, L.slot)
        for key, v in f.items():
            row[f"{key}_{W}s"] = v

    def price_at(s):
        k = bisect.bisect_right(offs, s * 1000)
        if k == 0:
            return INIT_PRICE, False
        t = tr[k - 1]
        return spot(t[5], t[6]), True

    for s in (30, 60, 120):
        p, from_trade = price_at(s)
        row[f"price_at_{s}s"] = p if coverage_ms >= s * 1000 else None
        row[f"price_at_{s}s_from_trade"] = from_trade if coverage_ms >= s * 1000 else None

    p60 = row["price_at_60s"]

    def peak(lo_s, hi_s):
        if coverage_ms < hi_s * 1000 or not p60:
            return None, None
        a = bisect.bisect_right(offs, lo_s * 1000)
        b = bisect.bisect_right(offs, hi_s * 1000)
        best, best_t = 1.0, None
        for t in tr[a:b]:
            p = spot(t[5], t[6])
            if p is not None and p / p60 > best:
                best, best_t = p / p60, t[0] / 1000.0
        return best, best_t

    row["peak_mult_10m"], row["peak_time_10m_s"] = peak(ENTRY_S, 600)
    row["peak_mult_60m"], row["peak_time_60m_s"] = peak(ENTRY_S, 3600)

    def mult_at(s):
        if coverage_ms < s * 1000 or not p60:
            return None
        p, _ = price_at(s)
        return p / p60

    row["mult_at_5m"] = mult_at(300)
    row["mult_at_30m"] = mult_at(1800)
    a = bisect.bisect_right(offs, 300_000)
    b = bisect.bisect_right(offs, 600_000)
    row["dead_by_10m"] = (b - a == 0) if coverage_ms >= 600_000 else None
    row["n_trades_60s_to_10m"] = (bisect.bisect_right(offs, 600_000) - bisect.bisect_right(offs, 60_000)) if coverage_ms >= 600_000 else None
    row["n_trades_10m_to_60m"] = (bisect.bisect_right(offs, 3_600_000) - bisect.bisect_right(offs, 600_000)) if coverage_ms >= 3_600_000 else None
    L.row = row
    L.trades = None
    L.finalized = True


def build(src, out_dir, days, max_lines=None, tape_mode="auto"):
    os.makedirs(out_dir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(src, "*.jsonl")))
    # stream every file from the first requested day onward (later files only
    # extend label coverage for launches near a boundary)
    last = (dt.date.fromisoformat(max(days)) + dt.timedelta(days=1)).isoformat()
    files = [f for f in files if min(days) <= os.path.basename(f)[:10] <= last]
    print("files:", [os.path.basename(f) for f in files], flush=True)

    launches = {}        # mint -> Launch (rows for --days only)
    hot = deque()        # Launch objects not yet finalized, in create order
    creator_hist = defaultdict(lambda: [0, 0, 0])   # launches, graduations, dev_sell<=60s
    stats = defaultdict(int)
    feed_loss = []
    drift = 0
    gaps = []            # (gap_start_at, gap_end_at)
    prev_at = None
    seen_sigs = set()    # (sig, user, isBuy, sol) dedupe, bounded by flushing per file
    n_lines = 0
    t0 = time.time()
    stream_end = None
    # launch-mode censoring: None = firehose, else (window_ms, cap)
    launch = (LAUNCH_WINDOW_MS, LAUNCH_TRADE_CAP) if tape_mode == "launch" else None
    engine_starts = 0

    def flush_hot(now):
        while hot and (now - hot[0].create_at) >= HOLD_MS:
            L = hot.popleft()
            cov = gap_after(L.create_at, HOLD_MS)
            finalize(L, coverage_ms=HOLD_MS if cov is None else cov, launch=launch)

    def gap_after(create_at, horizon):
        # coverage in ms after create until the first recording gap (or horizon)
        for gs, ge in gaps:
            if gs >= create_at and gs - create_at < horizon:
                return gs - create_at
        return None

    for path in files:
        print("reading", path, flush=True)
        seen_sigs = set()
        with open(path, "rb", buffering=1 << 24) as f:
            for line in f:
                n_lines += 1
                if max_lines and n_lines > max_lines:
                    break
                if n_lines % 2_000_000 == 0:
                    print(f"  {n_lines:,} lines, {len(launches):,} launches, {len(hot)} hot, "
                          f"{stats['trades']:,} trades, {time.time()-t0:.0f}s", flush=True)
                if not line.startswith(b'{"t":"tape_') and not line.startswith(b'{"t":"feed_health"') \
                        and not line.startswith(b'{"t":"decoder_drift"') and not line.startswith(b'{"t":"engine_start"'):
                    continue
                try:
                    r = loads(line)
                except Exception:
                    stats["json_fail"] += 1
                    continue
                t = r["t"]
                at = r.get("at")
                if at is None:
                    continue
                if prev_at is not None and at - prev_at > GAP_MS:
                    gaps.append((prev_at, at))
                    print(f"  gap: {(at-prev_at)/1000:.0f}s at {dt.datetime.fromtimestamp(prev_at/1000, dt.UTC)}", flush=True)
                if prev_at is None or at > prev_at:
                    prev_at = at
                stream_end = at if stream_end is None or at > stream_end else stream_end

                if t == "tape_trade":
                    stats["trades"] += 1
                    L = launches.get(r["mint"])
                    if L is None:
                        stats["trades_unknown_mint"] += 1
                        continue
                    key = hash((r.get("sig"), r.get("user"), r.get("isBuy"), r.get("sol")))
                    if key in seen_sigs:
                        stats["dupes"] += 1
                        continue
                    seen_sigs.add(key)
                    off = at - L.create_at
                    is_buy = bool(r.get("isBuy"))
                    sol = float(r.get("sol") or 0.0)
                    tokens = float(r.get("tokens") or 0.0)
                    try:
                        vsol = int(r.get("vSol") or 0)
                        vtok = int(r.get("vTok") or 0)
                    except Exception:
                        stats["bad_reserves"] += 1
                        continue
                    user = r.get("user") or ""
                    slot_off = (r.get("slot") or L.slot) - L.slot
                    L.n_trades_total += 1
                    L.last_off = off
                    if launch is not None and L.n_trades_total >= launch[1] and L.cap_off is None:
                        L.cap_off = off
                    if vtok <= VTOK_FLOOR + 1_000_000 and L.curve_full_off is None:
                        L.curve_full_off = off
                        creator_hist[L.creator][1] += 1 if L.complete_off is None else 0
                    if user == L.creator:
                        if is_buy:
                            L.creator_net += tokens
                        else:
                            if L.dev_sold_off is None:
                                L.dev_sold_off = off
                                L.dev_sold_tokens = tokens
                                L.dev_net_before_sell = L.creator_net
                                if off <= 60_000:
                                    creator_hist[L.creator][2] += 1
                            L.creator_net -= tokens
                    if not L.finalized:
                        L.trades.append((off, slot_off, is_buy, sol, tokens, vsol, vtok, user))
                    flush_hot(at)

                elif t == "tape_create":
                    mint = r.get("mint")
                    if not mint or mint in launches:
                        stats["dup_create"] += 1 if mint else 0
                        continue
                    day = dt.datetime.fromtimestamp(at / 1000, dt.UTC).strftime("%Y-%m-%d")
                    stats[f"creates_{day}"] += 1
                    if day not in days:
                        continue
                    creator = r.get("creator") or r.get("user") or ""
                    h = creator_hist[creator]
                    L = Launch(r, day, tuple(h))
                    h[0] += 1
                    launches[mint] = L
                    hot.append(L)
                    flush_hot(at)

                elif t == "tape_complete":
                    L = launches.get(r.get("mint"))
                    if L is not None and L.complete_off is None:
                        L.complete_off = at - L.create_at
                        if L.curve_full_off is None:
                            creator_hist[L.creator][1] += 1

                elif t == "tape_metadata":
                    L = launches.get(r.get("mint"))
                    if L is not None and L.meta is None:
                        L.meta = r

                elif t == "feed_health":
                    lp = r.get("lossPct")
                    if lp is not None:
                        feed_loss.append(float(lp))
                elif t == "decoder_drift":
                    drift += 1
                elif t == "engine_start":
                    engine_starts += 1
                    if r.get("mode") == "launch" and tape_mode != "firehose":
                        cfg = r.get("launch") or {}
                        w = int(cfg.get("windowMs") or LAUNCH_WINDOW_MS)
                        c = int(cfg.get("maxTradesPerMint") or LAUNCH_TRADE_CAP)
                        if launch is None:
                            print(f"  launch-mode tape: window {w/60000:.0f} min, cap {c} trades/mint - "
                                  f"labels beyond that are censored (null)", flush=True)
                        # mixed launch/firehose days: keep the strictest censoring seen
                        launch = (w, c) if launch is None else (min(launch[0], w), min(launch[1], c))
        if max_lines and n_lines > max_lines:
            break

    # EOF: finalize whatever is still hot with the coverage it really got
    for L in hot:
        cov = gap_after(L.create_at, HOLD_MS)
        if cov is None:
            cov = min(HOLD_MS, stream_end - L.create_at)
        finalize(L, coverage_ms=cov, launch=launch)
    hot.clear()

    rows = []
    for L in launches.values():
        row = L.row
        row["n_trades_total"] = L.n_trades_total
        row["last_trade_s"] = (L.last_off / 1000.0) if L.last_off is not None else None
        row["complete_event_seen"] = L.complete_off is not None
        row["curve_full_seen"] = L.curve_full_off is not None
        cands = [x for x in (L.complete_off, L.curve_full_off) if x is not None]
        row["graduated"] = bool(cands)
        row["time_to_graduation_s"] = (min(cands) / 1000.0) if cands else None
        row["dev_sold_s"] = (L.dev_sold_off / 1000.0) if L.dev_sold_off is not None else None
        row["dev_sold_pct_of_supply"] = (L.dev_sold_tokens / TOTAL_SUPPLY * 100.0) if L.dev_sold_tokens is not None else None
        row["dev_holding_pct_before_first_sell"] = (max(0.0, L.dev_net_before_sell) / TOTAL_SUPPLY * 100.0) if L.dev_net_before_sell is not None else None
        m = L.meta
        if m is not None and m.get("resolved"):
            row["meta_resolved"] = True
            row["has_socials"] = (m.get("socialCount") or 0) > 0
            row["meta_twitter"] = bool(m.get("twitter"))
            row["meta_telegram"] = bool(m.get("telegram"))
            row["meta_website"] = bool(m.get("website"))
            row["meta_has_image"] = bool(m.get("hasImage"))
            row["meta_has_description"] = bool(m.get("hasDescription"))
        else:
            row["meta_resolved"] = False if m is not None else None
            for k in ("has_socials", "meta_twitter", "meta_telegram", "meta_website", "meta_has_image", "meta_has_description"):
                row[k] = None
        row["creator_prior_launches_in_tape"] = L.prior[0]
        row["creator_prior_graduations"] = L.prior[1]
        row["creator_prior_dev_sells_within_60s"] = L.prior[2]
        # labels past the 60m hold are only trustworthy inside coverage; flag it
        row["label_window_60m_complete"] = row["coverage_after_create_s"] >= 3600.0
        rows.append(row)

    print(f"done: {n_lines:,} lines in {time.time()-t0:.0f}s; launches={len(rows):,}", flush=True)

    import pandas as pd
    df = pd.DataFrame(rows)
    df = df.sort_values("create_ts_ms").reset_index(drop=True)
    pq = os.path.join(out_dir, "launches.parquet")
    df.to_parquet(pq, index=False)
    df.to_csv(os.path.join(out_dir, "launches.csv"), index=False)
    print("wrote", pq, df.shape, flush=True)

    # ── validation summary ──────────────────────────────────────────────
    summ = {
        "lines": n_lines,
        "stats": dict(stats),
        "decoder_drift_records": drift,
        "tape_mode": "launch" if launch is not None else "firehose",
        "launch_window_s": (launch[0] / 1000.0) if launch is not None else None,
        "launch_trade_cap": launch[1] if launch is not None else None,
        "engine_start_records": engine_starts,
        "feed_loss_pct": {
            "n": len(feed_loss),
            "median": statistics.median(feed_loss) if feed_loss else None,
            "p10": sorted(feed_loss)[len(feed_loss) // 10] if feed_loss else None,
            "p90": sorted(feed_loss)[len(feed_loss) * 9 // 10] if feed_loss else None,
        },
        "gaps": [(dt.datetime.fromtimestamp(a / 1000, dt.UTC).isoformat(), (b - a) / 1000) for a, b in gaps],
        "per_day": {},
    }
    for day, g in df.groupby("day"):
        summ["per_day"][day] = {
            "launches": int(len(g)),
            "graduated": int(g.graduated.sum()),
            "grad_rate_pct": round(float(g.graduated.mean() * 100), 3),
            "complete_event_only": int((g.complete_event_seen & ~g.curve_full_seen).sum()),
            "curve_full_only": int((~g.complete_event_seen & g.curve_full_seen).sum()),
            "dead_by_10m_rate_pct": round(float(g.dead_by_10m.dropna().astype(float).mean() * 100), 2),
            "dev_sold_rate_pct": round(float(g.dev_sold_s.notna().mean() * 100), 2),
            "dev_sold_within_60s_pct": round(float((g.dev_sold_s <= 60).mean() * 100), 2),
            "meta_resolved_pct": round(float(g.meta_resolved.fillna(False).astype(bool).mean() * 100), 2),
            "trades_total_quantiles": {q: float(g.n_trades_total.quantile(q)) for q in (0.1, 0.25, 0.5, 0.75, 0.9, 0.99)},
            "zero_trade_launches": int((g.n_trades_total == 0).sum()),
            "label_window_60m_complete_pct": round(float(g.label_window_60m_complete.mean() * 100), 2),
            "trade_cap_hit": int(g.trade_cap_hit.sum()),
            "label_null_pct": {
                k: round(float(g[k].isna().mean() * 100), 2)
                for k in ("peak_mult_10m", "peak_mult_60m", "mult_at_5m", "mult_at_30m", "dead_by_10m", "n_trades_10m_to_60m")
            },
            "median_continuity_breaks_120s": float(g.continuity_breaks_120s.median()),
            "launches_with_any_break_120s_pct": round(float((g.continuity_breaks_120s > 0).mean() * 100), 2),
        }
    with open(os.path.join(out_dir, "build_summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summ, fh, indent=2, default=str)
    print(json.dumps(summ, indent=2, default=str), flush=True)
    return df


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=r"E:\data")
    ap.add_argument("--out", default=r"E:\data\work\launchset-2026-08-30")
    ap.add_argument("--days", default="2026-07-25,2026-07-26,2026-07-27")
    ap.add_argument("--max-lines", type=int, default=None, help="debug: stop after N lines")
    ap.add_argument("--tape-mode", default="auto", choices=("auto", "launch", "firehose"),
                    help="auto: read the engine_start row; launch: force 30-min/3000-trade censoring; firehose: ignore it")
    a = ap.parse_args()
    build(a.src, a.out, set(a.days.split(",")), a.max_lines, a.tape_mode)
