"""Forward-test analysis of 2026-07-21 tape: dip-buy shadow PnL, feed health, social-metadata lift."""
import json, sys, math
from collections import defaultdict

TAPE = r"D:\memedata\2026-07-21.jsonl"
DERIVED = r"D:\memedata\derived"

# ---------- 1. dip shadow forward test ----------
signals, exits = [], []
for line in open(DERIVED + r"\dip_records.jsonl", encoding="utf-8"):
    r = json.loads(line)
    (signals if r["t"] == "dip_signal" else exits).append(r)

sig_by_mint = {}
for s in signals:
    sig_by_mint.setdefault((s["mint"], s["at"]), s)

n = len(exits)
tot = sum(e["pnlSol"] for e in exits)
wins = sum(1 for e in exits if e["pnlSol"] > 0)
mults = sorted(e["multiple"] for e in exits)
print("=== DIP SHADOW FORWARD TEST (modeled exit latency in-record) ===")
print(f"signals={len(signals)} exits={n} openStill={len(signals)-n}")
print(f"totalPnL={tot:+.3f} SOL  perTrade={tot/n:+.5f}  winRate={wins/n*100:.1f}%")
print(f"multiple: p10={mults[int(n*.1)]:.3f} p50={mults[n//2]:.3f} p90={mults[int(n*.9)]:.3f} mean={sum(mults)/n:.4f}")
by_reason = defaultdict(lambda: [0, 0.0])
for e in exits:
    by_reason[e["reason"]][0] += 1
    by_reason[e["reason"]][1] += e["pnlSol"]
for r, (c, p) in sorted(by_reason.items(), key=lambda kv: -kv[1][0]):
    print(f"  {r:14s} n={c:5d} pnl={p:+9.3f} avg={p/c:+.5f}")
# hourly buckets
hourly = defaultdict(lambda: [0, 0.0])
for e in exits:
    h = (e["at"] // 3600000) % 24
    hourly[h][0] += 1; hourly[h][1] += e["pnlSol"]
print("hourly (UTC-ish bucket): " + " ".join(f"{h}:{p:+.2f}" for h, (c, p) in sorted(hourly.items())))
# latency sensitivity if field varies
lats = set(e.get("exitLatencyModeledMs") for e in exits)
print(f"exit latencies modeled: {lats}")

# ---------- 2. feed health ----------
fh = [json.loads(l) for l in open(DERIVED + r"\feed_health.jsonl", encoding="utf-8")]
print("\n=== FEED HEALTH (minutely, racing pool) ===")
losses = sorted(f["lossPct"] for f in fh)
m = len(losses)
print(f"minutes={m} loss p10={losses[int(m*.1)]:.1f}% p50={losses[m//2]:.1f}% p90={losses[int(m*.9)]:.1f}% mean={sum(losses)/m:.2f}%")
# thirds of the day
third = max(1, m // 3)
for i, name in [(0, "first"), (1, "mid"), (2, "last")]:
    seg = [f["lossPct"] for f in fh[i*third:(i+1)*third if i < 2 else m]]
    if seg: print(f"  {name} third: mean {sum(seg)/len(seg):.2f}%")
# socket win share
w = defaultdict(int)
for f in fh:
    for s in f["sockets"]:
        w[s["host"]] += s.get("wins", 0)
print("  race wins: " + ", ".join(f"{h}={c}" for h, c in sorted(w.items(), key=lambda kv: -kv[1])))

# ---------- 3. stream tape for per-mint outcomes ----------
print("\n... streaming tape for per-mint outcomes (this is the slow part) ...", flush=True)
mint_stat = {}
n_lines = 0
with open(TAPE, encoding="utf-8") as f:
    for line in f:
        n_lines += 1
        if '"t":"tape_trade"' not in line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        s = mint_stat.get(r["mint"])
        if s is None:
            s = mint_stat[r["mint"]] = {"n": 0, "buySol": 0.0, "maxCurve": 0.0, "first": r["at"], "last": r["at"]}
        s["n"] += 1
        if r.get("isBuy"): s["buySol"] += r.get("sol", 0.0)
        c = r.get("curvePct") or 0
        if c > s["maxCurve"]: s["maxCurve"] = c
        s["last"] = r["at"]
print(f"lines={n_lines} mints={len(mint_stat)}")

# ---------- 4. metadata join ----------
meta = {}
for line in open(DERIVED + r"\metadata.jsonl", encoding="utf-8"):
    r = json.loads(line)
    meta[r["mint"]] = r
print("\n=== SOCIAL METADATA vs OUTCOME (our own tape, first day of capture) ===")
groups = defaultdict(list)
for mint, mr in meta.items():
    s = mint_stat.get(mint)
    if not s: continue
    if not mr.get("resolved"):
        key = "unresolved"
    else:
        key = f"socials={min(mr.get('socialCount',0),3)}"
    groups[key].append(s)
def agg(rows):
    nn = len(rows)
    grad = sum(1 for r in rows if r["maxCurve"] >= 99) / nn * 100
    c50 = sum(1 for r in rows if r["maxCurve"] >= 50) / nn * 100
    med_trades = sorted(r["n"] for r in rows)[nn//2]
    mean_buy = sum(r["buySol"] for r in rows) / nn
    return nn, grad, c50, med_trades, mean_buy
print(f"{'group':12s} {'n':>6s} {'grad%':>6s} {'>=50%':>6s} {'medTrades':>9s} {'meanBuySol':>10s}")
for k in sorted(groups):
    nn, grad, c50, mt, mb = agg(groups[k])
    print(f"{k:12s} {nn:6d} {grad:6.2f} {c50:6.2f} {mt:9d} {mb:10.2f}")
# individual social types
for field in ("twitter", "telegram", "website", "hasImage"):
    yes = [mint_stat[m] for m, r in meta.items() if r.get(field) and m in mint_stat]
    no = [mint_stat[m] for m, r in meta.items() if r.get("resolved") and not r.get(field) and m in mint_stat]
    if yes and no:
        _, gy, cy, _, _ = agg(yes); _, gn, cn, _, _ = agg(no)
        print(f"{field:9s}: yes n={len(yes):5d} grad={gy:.2f}% >=50%={cy:.2f} | no n={len(no):5d} grad={gn:.2f}% >=50%={cn:.2f}  lift(grad)={gy/max(gn,1e-9):.1f}x")

# ---------- 5. dip trades x metadata ----------
print("\n=== DIP EXITS split by socials ===")
exit_by_mint = defaultdict(list)
for e in exits: exit_by_mint[e["mint"]].append(e)
buckets = defaultdict(lambda: [0, 0.0, 0])
for mint, es in exit_by_mint.items():
    mr = meta.get(mint)
    key = "no-meta" if mr is None else ("unresolved" if not mr.get("resolved") else ("has-social" if mr.get("socialCount", 0) > 0 else "no-social"))
    for e in es:
        buckets[key][0] += 1; buckets[key][1] += e["pnlSol"]
        if e["pnlSol"] > 0: buckets[key][2] += 1
for k, (c, p, wn) in sorted(buckets.items(), key=lambda kv: -kv[1][0]):
    print(f"  {k:10s} n={c:5d} pnl={p:+9.3f} avg={p/c:+.5f} win={wn/c*100:.1f}%")
