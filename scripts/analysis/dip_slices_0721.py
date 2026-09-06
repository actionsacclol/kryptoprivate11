"""Slice dip-shadow forward trades by entry features to find profitable sub-regions."""
import json
from collections import defaultdict

DERIVED = r"D:\memedata\derived"
signals, exits = [], []
for line in open(DERIVED + r"\dip_records.jsonl", encoding="utf-8"):
    r = json.loads(line)
    (signals if r["t"] == "dip_signal" else exits).append(r)
meta = {}
for line in open(DERIVED + r"\metadata.jsonl", encoding="utf-8"):
    r = json.loads(line)
    meta[r["mint"]] = r

# pair each exit with the latest signal for that mint at/before exit time
sig_by_mint = defaultdict(list)
for s in signals:
    sig_by_mint[s["mint"]].append(s)
for v in sig_by_mint.values():
    v.sort(key=lambda s: s["at"])

pairs = []
for e in exits:
    cands = [s for s in sig_by_mint.get(e["mint"], []) if s["at"] <= e["at"]]
    if cands:
        pairs.append((cands[-1], e))
print(f"paired {len(pairs)}/{len(exits)} exits; unique mints signaled={len(sig_by_mint)}; signals/mint={len(signals)/len(sig_by_mint):.2f}")
resig = sum(1 for v in sig_by_mint.values() if len(v) > 1)
print(f"mints with >1 signal (re-entry): {resig}")

GROSS = True  # also show multiple-based stats (strip the 0.001 fixed overhead)

def report(name, rows):
    if not rows: return
    n = len(rows)
    pnl = sum(e["pnlSol"] for _, e in rows)
    mult = sum(e["multiple"] for _, e in rows) / n
    win = sum(1 for _, e in rows if e["pnlSol"] > 0) / n * 100
    print(f"  {name:28s} n={n:5d} pnl={pnl:+8.3f} avg={pnl/n:+.5f} meanMult={mult:.4f} win={win:.1f}%")

def bucket(field, edges):
    print(f"-- by {field} --")
    buckets = defaultdict(list)
    for s, e in pairs:
        v = s.get(field)
        if v is None: continue
        lab = None
        for i, edge in enumerate(edges):
            if v < edge:
                lab = f"<{edge}"; break
        if lab is None: lab = f">={edges[-1]}"
        buckets[(edges.index(edge) if lab.startswith('<') else len(edges), lab)].append((s, e))
    for (_, lab), rows in sorted(buckets.items()):
        report(lab, rows)

bucket("offPeakPct", [55, 60, 70, 80])
bucket("bounceOffLowPct", [20, 30, 50, 80])
bucket("ageMs", [60_000, 120_000, 300_000, 900_000])
bucket("curveVSol", [34, 38, 45, 60])

print("-- by exit reason x offPeak>=70 --")
report("deep(>=70) all", [(s, e) for s, e in pairs if s["offPeakPct"] >= 70])
report("shallow(<70) all", [(s, e) for s, e in pairs if s["offPeakPct"] < 70])

print("-- socials x curveVSol --")
for social in (True, False):
    for hi in (True, False):
        rows = [(s, e) for s, e in pairs
                if ((meta.get(s["mint"], {}).get("socialCount", 0) > 0) == social)
                and ((s["curveVSol"] >= 40) == hi)]
        report(f"social={social} vSol>=40={hi}", rows)

print("-- best single combos (grid over 2 features) --")
best = []
for op_lo in (50, 55, 60, 70):
    for age_lo in (45_000, 120_000, 300_000):
        for vs_lo in (32, 40, 50):
            for soc in (None, True):
                rows = [(s, e) for s, e in pairs
                        if s["offPeakPct"] >= op_lo and s["ageMs"] >= age_lo and s["curveVSol"] >= vs_lo
                        and (soc is None or meta.get(s["mint"], {}).get("socialCount", 0) > 0)]
                if len(rows) >= 100:
                    n = len(rows)
                    avg = sum(e["pnlSol"] for _, e in rows) / n
                    best.append((avg, n, f"offPeak>={op_lo} age>={age_lo//1000}s vSol>={vs_lo} social={soc}"))
best.sort(reverse=True)
for avg, n, desc in best[:12]:
    print(f"  avg={avg:+.5f} n={n:5d}  {desc}")
