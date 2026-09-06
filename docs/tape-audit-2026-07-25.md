# Tape audit — 2026-07-25

> Follow-up: the decoder recommended below was built the same day —
> see `amm-decoder-2026-07-25.md`. Recommendations 2 and 3 are done.

Single-analyst pass over `E:\data\2026-07-25.jsonl` (9.01 GB, 12,185,289
records, 18h: 07-24 22:00 → 07-25 16:00). Scripts in
`…09f319f8…\scratchpad\` (`profile`, `extract`, `counterfactual`, `exitbt`,
`latency`, `slipcap`, `features`, `ammlayout`). Working set extracted to
`E:\data\work\*.jsonl` (89 MB) + `candidates.json`.

## Bottom line

**The 9 GB is not a strategy dataset — it is 88.8% raw undecoded pump-amm
payloads, captured on purpose as build item #5 of the 07-24 swarm.** The
labelled, analysable portion is 89 MB (0.97%). A strategy swarm over this
file would re-run the 07-24 dead-ends registry; an independent pass here
reproduced three of its entries without being primed on them, which is
evidence the registry is sound, not evidence of new edge.

The unlock is a **pump-amm event decoder**, and this tape is sufficient to
build one.

## Composition

| type | count | size | share |
|---|---|---|---|
| `tape_amm` | 9,712,610 | 8,187 MB | **88.8%** |
| `tape_trade` | 2,161,077 | 941 MB | 10.2% |
| `trade` | 187,692 | 54 MB | 0.6% |
| `decision` | 19,540 | 6.0 MB | 0.1% |
| `dip_exit` | 17,900 | 4.3 MB | 0.0% |
| `strat_exit` / `strat_signal` | 543 / 557 | 0.3 MB | 0.0% |
| `position_open` / `position_close` | 25 / 25 | <0.01 MB | 0.0% |

Funnel: 19,573 creates → 8,451 reject (97.0% "creator sold during
evaluation") → 11,083 pass → **25 enter** (0.13%).

## Verified against the 07-24 swarm

Everything below was found independently on 07-25 data, then checked
against `strat-swarm-2026-07-24.md`. All four are **confirmations**, not
new findings.

1. **Live P&L is the strategy's EV.** 25 closes, **−0.110 SOL**, 8W/17L.
   17/25 exits were `flow_reversal`, 6 `creator_sell` — i.e. 92% of exits
   came from the two reactive protective exits the swarm proved
   value-destroying at 800 ms. Matches the predicted ~−0.08 SOL/day.
2. **Buyer-acceleration is monotonic in-sample and still worthless.**
   +60s mean by bucket: 0 → −5.6%, 1–2 → +11.6%, 2–4 → +23.3%, 4–8 →
   +47.5% (n=5,983). This is the cleanest-looking feature in the file and
   it is already in the dead-ends registry (A6: −0.005 to −0.009/trade
   net). In-sample monotonicity is not edge.
3. **Exit retuning looks great and is an artifact.** A 7-policy grid on
   the 25 real entries makes every alternative beat live, best
   `no-TP/trail15/sl25/60s` at +17.2% vs +14.1%. This is the *same*
   broken-optimistic shadow accounting A8 measured at 66× rosy: the sim
   charges 1.5% exit cost where the real floor at 0.10 SOL is 4.5–7.5%.
   Subtract the true floor and the grid goes flat-to-negative. **Do not
   act on it.**
4. **Gates are not too tight.** Near-miss cohorts (score ≥58 with ≤3
   failing gates, n=144; score ≥70, n=78) are flat-to-negative under every
   exit policy tested. Loosening entry gates adds no edge — consistent
   with 28/28 OAT variants negative.

## One genuinely new measurement

**Entry slippage is ~26% and instantaneous, not latency-scaled.** Fill
price vs the price the signal evaluated at, for the 25 entries:

| fill delay | slip vs signal px | avg ret (best exit) |
|---|---|---|
| 0 ms (signal px) | 0.00% | +17.2% |
| 100 ms | **26.39%** | +4.9% |
| 500 ms | 26.56% | +3.4% |
| 1000 ms | 22.76% | +3.7% |
| 5000 ms | 26.71% | −1.7% |

The very first print after the signal is already +26%. Cutting fill
latency from 1,300 ms to 100 ms buys ~1 pp — nothing. Median peak lands
**2.8 s after the decision** (p25 = 0.0 s) at only +27.5%, so the trigger
fires when the move is already ~26% gone and ~3 s from over.

This *sharpens* rather than contradicts A3's "gross drift is negative at
the entry": the drift is negative because the 15 s confirmation window
guarantees you buy after the pop. It also independently kills entry
slippage caps as a lever — a 3%/5%/8% cap changes total P&L by noise
(±0.05 SOL on n=25) because the cap either rejects the fill or admits an
already-26%-up print.

Corollary for build item #1 (`localTxBuild`, now ON in settings): speed
work is capped in value. There is no latency budget that recovers a 26%
instantaneous gap.

## Status of the 07-24 build order

| # | item | status |
|---|---|---|
| 1 | `localTxBuild` ON | **done** — `settings.json: localTxBuild: true` |
| 2 | closeAccount + ATA sweep | **done** — `engine/rentSweep.ts`, `txBuilder.ts:484` |
| 3 | v1 shadow-only, fix dead knobs | **done** — `liveEnabled: false`; `maxTopBuyerShare` now gated at `engine.ts:1456` (was phantom) |
| 4 | honest 800 ms shadow fills | **partial** — `exitLatencyModeledMs: 800` is recorded on every `dip_exit`/`strat_exit`, but `position_close` still books the optimistic number (−0.110 over 25 vs the 800 ms-replay figure). The lab is honest; the engine's own P&L line is not. |
| 5 | PumpSwap tape + persistent wallet ids | **in progress — this file is it** |

## The decoder is tractable

`engine.ts:975` states the design: *"No decoding here — the pump-amm event
layout is learned offline against real samples; the tape is the asset."*
Probe of 400k `tape_amm` records (606k payloads, 917 discriminators):

| discriminator | share | length | reading |
|---|---|---|---|
| `3e2f370aa503dc2a` | 42.1% | 417 B | swap-like; u64 @8 = unix ts |
| `67f4521f2cf57777` | 35.5% | 465/480 B | swap-like; u64 @8 = unix ts |
| `929fbdac925838f4` | 3.9% | 80 B | 32-byte pubkey @8–40, ts @40 — **pool-create/migration shape**, n=23,903 |
| `5632504802 0X0000` | ~9% | 8 B | markers, not events |

Two discriminators cover **77.6%** of all payloads, and `u64 @ offset 8`
decodes to the correct wall-clock unix second in both — the field grid is
aligned and anchored. In `67f4521f2cf57777`: off24 and off40 both read
`10000000` (exactly 0.01 SOL), off16 `47.75 SOL`, off56 `45.71 SOL`,
off32/off48 token-scale — consistent with `{reserves, amount_in,
amount_out, reserves'}` on a 0.01 SOL swap.

Why it matters — this is the only thing on the 07-24 list that can change
the answer:
- 25 `strat_exit` records are `unresolved: true` ("migrated to AMM still
  holding"), concentrated in `secondleg_grad_probe` (22/175 = 12.6%).
  Graduations are exactly the right tail, and they are currently dropped
  from every P&L total — every shadow strategy is scored on its losers.
- A7's one durable effect (proven&not-dumper creators graduate at
  34.3%/29.1% vs 2.66% baseline) was shelved because *"value lives
  post-migration"*. Post-migration price is precisely what these two
  discriminators contain.

## Recommendation

1. **No strategy swarm.** The 07-24 registry stands and this pass
   re-derived three of its entries independently.
2. **Build the pump-amm decoder** against the two dominant discriminators
   (77.6% coverage). Validate by reconciling decoded reserves against
   `tape_trade` prices for mints that graduated mid-tape — the overlap
   window is the ground truth.
3. **Then** resolve the 25 unresolved graduations and re-score
   `secondleg_grad_probe` / the proven-creator tag with the right tail
   included. That is the first honest read anyone will have had on this.
4. Fix the `position_close` P&L line to use the 800 ms replay number
   (item #4's remaining half) so the engine and the lab stop disagreeing.

## Housekeeping

`recordFirehose: true` writes 8.2 GB/day of `tape_amm` plus 941 MB/day of
`tape_trade`. E: has 1.85 TB free — fine for now, ~7 GB/day net. Keep it
on until the decoder is validated, since the layout work needs volume;
revisit after.
