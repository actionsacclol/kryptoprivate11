"""Grid-search dip forward trades on GROSS multiple (strip fixed overhead), with time-split stability."""
import json
from collections import defaultdict
from itertools import product

DERIVED = r"D:\memedata\derived"
signals, exits = [], []
for line in open(DERIVED + r"\dip_records.jsonl", encoding="utf-8"):
    r = json.loads(line)
    (signals if r["t"] == "dip_signal" else exits).append(r)
meta = {}
for line in open(DERIVED + r"\metadata.jsonl", encoding="utf-8"):
    meta[json.loads(line)["mint"]] = json.loads(line)

sig_by_mint = defaultdict(list)
for s in signals: sig_by_mint[s["mint"]].append(s)
for v in sig_by_mint.values(): v.sort(key=lambda s: s["at"])
pairs = []
for e in exits:
    c = [s for s in sig_by_mint[e["mint"]] if s["at"] <= e["at"]]
    if c: pairs.append((c[-1], e))
pairs.sort(key=lambda p: p[1]["at"])
mid_at = pairs[len(pairs)//2][1]["at"]

def stats(rows):
    n = len(rows)
    if not n: return 0, 0, 0, 0
    gm = sum(e["multiple"] for _, e in rows) / n
    win = sum(1 for _, e in rows if e["multiple"] > 1) / n * 100
    um = len(set(s["mint"] for s, _ in rows))
    return n, gm, win, um

results = []
OP = [(0, 200), (50, 70), (70, 200)]
BO = [(0, 200), (0, 25), (25, 200)]
AGE = [(45, 10**9), (45, 300), (300, 900), (900, 10**9)]
VS = [(32, 10**9), (32, 40), (40, 60), (60, 10**9)]
SOC = [None, True, False]
for (ol, oh), (bl, bh), (al, ah), (vl, vh), soc in product(OP, BO, AGE, VS, SOC):
    rows = [(s, e) for s, e in pairs
            if ol <= s["offPeakPct"] < oh and bl <= s["bounceOffLowPct"] < bh
            and al * 1000 <= s["ageMs"] < ah * 1000 and vl <= s["curveVSol"] < vh
            and (soc is None or (meta.get(s["mint"], {}).get("socialCount", 0) > 0) == soc)]
    n, gm, win, um = stats(rows)
    if n >= 150 and um >= 60:
        h1 = [(s, e) for s, e in rows if e["at"] <= mid_at]
        h2 = [(s, e) for s, e in rows if e["at"] > mid_at]
        _, g1, _, _ = stats(h1); _, g2, _, _ = stats(h2)
        results.append((gm, n, um, win, g1, g2, f"op[{ol},{oh}) bo[{bl},{bh}) age[{al}s,{ah}s) vSol[{vl},{vh}) soc={soc}"))
results.sort(reverse=True)
print(f"pairs={len(pairs)} midpoint split; configs with n>=150 & uniqueMints>=60: {len(results)}")
print(f"{'grossMult':>9s} {'n':>5s} {'mints':>5s} {'win%':>5s} {'h1':>7s} {'h2':>7s}  config")
for gm, n, um, win, g1, g2, desc in results[:20]:
    both = "OK" if g1 > 1 and g2 > 1 else "  "
    print(f"{gm:9.4f} {n:5d} {um:5d} {win:5.1f} {g1:7.4f} {g2:7.4f} {both} {desc}")
print("...bottom 3:")
for gm, n, um, win, g1, g2, desc in results[-3:]:
    print(f"{gm:9.4f} {n:5d} {um:5d} {win:5.1f} {g1:7.4f} {g2:7.4f}    {desc}")
