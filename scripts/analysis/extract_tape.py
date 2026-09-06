# Stage 1: stream the firehose JSONL tape into compact derived tables.
#
# Inputs:  D:\memedata\YYYY-MM-DD.jsonl  (tape_create / tape_trade / tape_complete + engine events)
# Outputs: D:\memedata\derived\
#   tokens.csv         one row per token created in-window (identity + full-life aggregates)
#   ticks.csv          per-token trade ticks, capped to first TICK_WINDOW_S seconds / TICK_CAP trades
#   engine_events.csv  the engine's own decisions / positions / live sends, for comparison
#
# Only tape_* events are used for market truth (engine "trade"/"create" duplicates are skipped).

import json
import glob
import os
import sys
import time

SRC_GLOB = r"D:\memedata\*.jsonl"
OUT_DIR = r"D:\memedata\derived"
TICK_WINDOW_S = 900          # keep ticks for first 15 minutes of each token's life
TICK_CAP = 3000              # and at most this many ticks per token
UNIQ_CAP = 512               # stop exact unique-trader counting past this

os.makedirs(OUT_DIR, exist_ok=True)

mints = {}                   # mint -> state dict
users = {}                   # wallet str -> int id

# Persistent cross-day wallet identity (2026-07-24 swarm build order #5):
# wallet -> id assignments load from and rewrite a shared map, so ids are
# STABLE across datasets/days and wallet behavior can be joined over time.
# Delete the file to reset the id space (invalidates older derived sets).
WALLET_MAP = r"D:\memedata\derived\wallets.csv"
if os.path.exists(WALLET_MAP):
    with open(WALLET_MAP, "r", encoding="utf-8") as _wf:
        next(_wf, None)
        for _ln in _wf:
            _w, _i = _ln.rstrip("\n").split(",")
            users[_w] = int(_i)
    print(f"wallet map: preloaded {len(users)} ids")


def uid(w):
    i = users.get(w)
    if i is None:
        i = len(users)
        users[w] = i
    return i


tick_f = open(os.path.join(OUT_DIR, "ticks.csv"), "w", buffering=1 << 22)
tick_f.write("mid,t_ms,price,is_buy,sol,v_sol,v_tok,is_creator,is_smart,user\n")
eng_f = open(os.path.join(OUT_DIR, "engine_events.csv"), "w", buffering=1 << 20)
eng_f.write("at,type,mint,detail\n")

ENGINE_TYPES = {
    "decision", "position_open", "position_close", "live_buy", "live_sell",
    "shadow_send", "order_intent", "order_state", "smart_buy", "risk",
    "engine_start", "engine_stop", "armed", "feed_health",
    "dip_signal", "dip_exit", "live_blocked", "live_trade",
}
# tape_metadata is handled inline (enriches the tokens table), not as an
# engine event, so it is intentionally absent from ENGINE_TYPES.

n_lines = 0
n_trades_kept = 0
t0 = time.time()

for path in sorted(glob.glob(SRC_GLOB)):
    print("reading", path, flush=True)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            n_lines += 1
            if n_lines % 1000000 == 0:
                print(f"  {n_lines} lines, {len(mints)} mints, {n_trades_kept} ticks kept, {time.time()-t0:.0f}s", flush=True)
            try:
                r = json.loads(line)
            except Exception:
                continue
            t = r.get("t")

            if t == "tape_trade":
                m = mints.get(r.get("mint"))
                if m is None:
                    continue  # created before recording window
                at = r["at"]
                off = at - m["createAt"]
                price = r.get("price") or r.get("priceSol") or 0.0
                sol = r.get("sol") or 0.0
                is_buy = 1 if r.get("isBuy") else 0
                user = r.get("user") or ""
                is_creator = 1 if user == m["creator"] else 0

                # full-life aggregates (never capped)
                m["n_trades"] += 1
                if is_buy:
                    m["n_buys"] += 1
                    m["buy_sol"] += sol
                else:
                    m["sell_sol"] += sol
                    if is_creator:
                        m["creator_sells"] += 1
                        m["creator_sell_sol"] += sol
                        if m["first_creator_sell_ms"] < 0:
                            m["first_creator_sell_ms"] = off
                if price > m["max_price"]:
                    m["max_price"] = price
                    m["max_price_ms"] = off
                m["last_price"] = price
                m["last_ms"] = off
                if r.get("isSmart"):
                    m["smart_trades"] += 1
                    if m["first_smart_ms"] < 0:
                        m["first_smart_ms"] = off
                u = m["uniq"]
                if u is not None:
                    u.add(user)
                    if len(u) >= UNIQ_CAP:
                        m["uniq_n"] = len(u)
                        m["uniq"] = None
                        m["uniq_capped"] = 1

                # capped tick stream for path/exit simulation
                if m["ticks"] < TICK_CAP and off <= TICK_WINDOW_S * 1000:
                    m["ticks"] += 1
                    n_trades_kept += 1
                    tick_f.write(
                        f'{m["id"]},{off},{price:.6g},{is_buy},{sol:.9f},'
                        f'{r.get("vSol","0")},{r.get("vTok","0")},{is_creator},'
                        f'{1 if r.get("isSmart") else 0},{uid(user)}\n'
                    )

            elif t == "tape_create":
                mint = r.get("mint")
                if mint and mint not in mints:
                    mints[mint] = {
                        "id": len(mints),
                        "createAt": r["at"],
                        "creator": r.get("creator") or "",
                        "name": "".join(c if c.isprintable() and c != "," else " " for c in (r.get("name") or ""))[:48],
                        "symbol": "".join(c if c.isprintable() and c != "," else " " for c in (r.get("symbol") or ""))[:24],
                        "slot": r.get("slot") or 0,
                        "n_trades": 0, "n_buys": 0, "buy_sol": 0.0, "sell_sol": 0.0,
                        "creator_sells": 0, "creator_sell_sol": 0.0, "first_creator_sell_ms": -1,
                        "max_price": 0.0, "max_price_ms": -1, "last_price": 0.0, "last_ms": -1,
                        "smart_trades": 0, "first_smart_ms": -1,
                        "uniq": set(), "uniq_n": 0, "uniq_capped": 0,
                        "complete_ms": -1, "ticks": 0,
                        # social metadata (filled by tape_metadata, -1 = unseen)
                        "meta_resolved": -1, "social_count": -1,
                        "twitter": 0, "telegram": 0, "website": 0, "has_image": 0,
                    }

            elif t == "tape_metadata":
                m = mints.get(r.get("mint"))
                if m is not None:
                    m["meta_resolved"] = 1 if r.get("resolved") else 0
                    m["social_count"] = r.get("socialCount", 0) if r.get("resolved") else 0
                    m["twitter"] = 1 if r.get("twitter") else 0
                    m["telegram"] = 1 if r.get("telegram") else 0
                    m["website"] = 1 if r.get("website") else 0
                    m["has_image"] = 1 if r.get("hasImage") else 0

            elif t == "tape_complete":
                m = mints.get(r.get("mint"))
                if m is not None and m["complete_ms"] < 0:
                    m["complete_ms"] = r["at"] - m["createAt"]

            elif t in ENGINE_TYPES:
                mint = r.get("mint") or ""
                detail = {k: v for k, v in r.items() if k not in ("t", "at", "mint", "receivedAt")}
                eng_f.write(f'{r.get("at",0)},{t},{mint},"{json.dumps(detail).replace(chr(34), chr(39))}"\n')

tick_f.close()
eng_f.close()

print(f"done reading: {n_lines} lines, {len(mints)} mints, {n_trades_kept} ticks, {time.time()-t0:.0f}s", flush=True)

with open(os.path.join(OUT_DIR, "tokens.csv"), "w", buffering=1 << 22, encoding="utf-8", errors="replace") as tf:
    tf.write("mid,mint,create_at,creator,name,symbol,slot,n_trades,n_buys,buy_sol,sell_sol,"
             "creator_sells,creator_sell_sol,first_creator_sell_ms,max_price,max_price_ms,"
             "last_price,last_ms,smart_trades,first_smart_ms,uniq_n,uniq_capped,complete_ms,ticks,"
             "meta_resolved,social_count,twitter,telegram,website,has_image\n")
    for mint, m in mints.items():
        un = m["uniq_n"] if m["uniq"] is None else len(m["uniq"])
        tf.write(f'{m["id"]},{mint},{m["createAt"]},{m["creator"]},{m["name"]},{m["symbol"]},{m["slot"]},'
                 f'{m["n_trades"]},{m["n_buys"]},{m["buy_sol"]:.6f},{m["sell_sol"]:.6f},'
                 f'{m["creator_sells"]},{m["creator_sell_sol"]:.6f},{m["first_creator_sell_ms"]},'
                 f'{m["max_price"]:.6g},{m["max_price_ms"]},{m["last_price"]:.6g},{m["last_ms"]},'
                 f'{m["smart_trades"]},{m["first_smart_ms"]},{un},{m["uniq_capped"]},{m["complete_ms"]},{m["ticks"]},'
                 f'{m["meta_resolved"]},{m["social_count"]},{m["twitter"]},{m["telegram"]},{m["website"]},{m["has_image"]}\n')

print("wrote tokens.csv with", len(mints), "tokens")
print("unique wallets:", len(users))

with open(WALLET_MAP, "w", encoding="utf-8", buffering=1 << 22) as _wf:
    _wf.write("wallet,id\n")
    for _w, _i in users.items():
        _wf.write(f"{_w},{_i}\n")
print("wallet map: persisted", len(users), "ids to", WALLET_MAP)
