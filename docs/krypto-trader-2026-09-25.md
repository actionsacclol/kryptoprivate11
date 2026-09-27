# Krypto Trader research + design (2026-09-25)

Swarm run wf_5c0fc338-282 (8 agents). Sections: design (synthesis), critic's corrections (APPLY THESE over the design), then the quant + selection reports the numbers come from. Scratch scripts/data were in the session scratchpad; the slow-climb test joined E:/data/work/runner-outcome-2026-09-11/labeler/forward_outcomes.parquet to flag-eval/flagged_all_days.parquet.


This is a synthesis of six research reports (codemap, quant, selection, competitors, ai, safety). I did not edit any repo files. The file:line references are copied from those reports; I did not re-read the files.

## 0. Decisions made up front, and why

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | A preset that raises the coin's market cap or volume | **None, and no disabled or teaser version either.** | This is manipulation on someone else's coin. Smithii and Gotbit sell exactly this profile, and the DOJ took a guilty plea in 2026 (competitors). |
| D2 | What goes in that slot instead | **The "Hold with a stop" baseline preset, plus a "vs just holding" line shown on every session.** | Quant found every preset loses on the median. The honest thing to offer is the comparison against holding. |
| D3 | Wallet model | **One existing wallet, picked by the user. The session trades only from it. No fresh wallet in phase 1.** | The user asked for "one wallet". There is no EVM wallet-to-wallet transfer. The wallet list is capped at 15, sessions at 50. Moving funds between the user's own wallets looks like a wash pattern. |
| D4 | How the session tracks what it owns | **Its own book, built from confirmed fills in base units.** Never from the difference in the wallet's balance. Tokens the wallet already held are excluded. | Codemap and safety K7/K8. |
| D5 | Budget vs the per-trade cap `maxLiveSol` | **`maxLiveSol` still applies to every trade. `capSol` is not passed through to widen it.** | Codemap wanted `capSol`; safety T11 says no. Unattended execution follows the order-safety rules. The page warns before Start when budget ÷ trades would hit the cap. |
| D6 | Pacing: settings or fixed | **Fixed minimums in `checkTraderIntent` that no one can lower.** Presets can only make them stricter. | Krypto Mode's "0 = off" is exactly how a bot churns. |
| D7 | Minimum price move between a sell and the next buy (and the reverse) | **Worked out per coin: max(2 × round-trip cost, 8% on a bonding curve / 5% on a graduated pool).** | The AI report's flat 4% is below selection's Rule C (grids under 8–10% on a curve lose money mechanically). |
| D8 | Trailing stop with re-entry | **Dropped.** | Quant: the worst preset (S30 median −23.1%, fees 7–14% of budget). Selection: a 60% stop actually filled at −63% to −97%. Protecting an existing bag stays with Advanced orders. |
| D9 | How the AI driver acts | **It proposes hold/buy/sell directly, inside the fixed envelope.** It does not choose between presets. | This reuses Krypto Mode's loop, and the envelope limits the damage if the model is taken over. |
| D10 | Engine code | **A new `botSession.ts` core, written with fixes K1–K10, used by Trader.** Krypto Mode moves onto it later (step 9). In the meantime Krypto Mode gets only the one-line K1/K3 fixes. | Rewriting Krypto Mode's working loop mid-feature is riskier than building Trader on a fresh core. |
| D11 | MCP tools | `get_trader_sessions`, `get_trader_session`, `trader_act`. Sessions are looked up by id and carry a version number (`expected_seq`). | Trader allows any coin, so two sessions could share a mint; a lookup by mint would be ambiguous. The version number stops a decision made on stale data from running. |
| D12 | Chains | **Solana first. BNB and Robinhood in phase 2.** | EVM needs the book stored as bigint strings (wei overflows a JavaScript number) and has no funding path. |
| D13 | Profit reuse | **Off by default:** `room = B − openCost − max(0, −realised)`. With "Reinvest profit" on, room can grow to at most 2B. | Safety K9: profit today silently grows the budget. |
| D14 | Unknown bonding-curve type | **Treated as not classic, so every preset is refused while the coin is on the curve.** For graduated coins the depth caps decide. | Selection: on a mixed curve R ≤ 0.2 SOL, so any position is too big. |

## 1. The page (route `trader`, Automation workspace)

The sidebar row is called "Krypto Trader". There is a one-line lead-in: "Trade one coin from one wallet with a preset or an AI. Paper first."

The layout is two columns on desktop and stacks on narrow screens.

**Left column: new session form**

1. **Coin.** Paste a mint, or arrive through "Open in Krypto Trader" from the Token and Runners pages. Chain is fixed to Solana in phase 1, with the switch disabled and labelled "Solana only for now".
2. **Fit check card** (§4). It loads when the coin is entered. It can refuse the coin, grey out presets, or clip the budget.
3. **Wallet.** A dropdown of the user's wallets showing each balance. The label reads "Trades only from this wallet. Coins it already holds are not the session's and are never sold by it." Wallets refused by the rules (M9, the claims check) are shown disabled with the reason.
4. **Budget.** Clipped to the depth cap, with the note "Clipped to X SOL: a full exit would move price more than 10%."
5. **Preset.** Four cards (§3). Each shows the rule in words, its parameters (editable under "Adjust"), and the honest-result line with n.
6. **Driver.** Preset rules / AI (your key) / MCP connection. AI shows the model, the estimated $/hour and $/day, and a daily spend cap.
7. **Envelope.** Max loss %, time limit, and "Reinvest profit" (off). The fixed minimums are listed read-only: "60 s between trades · max 6/hour · no rebuy within 10 min of a sell · sells ≥ 10% of the bag · each buy ≤ 1% of pool depth · session buys ≤ 3× budget per 24 h."
8. **Your thesis** (optional, up to 500 characters). Sent to the AI as the user's opinion, not an instruction.
9. **Cost line:** "Each round trip costs about C% (Krypt 0.5%/side + pool fee + your own price impact)."
10. **Start (paper).** This is the only start button. Going live is a separate, confirmed action on a running session.

**Right column: sessions list**

This is the parameterised `KryptoSessions` component with namespace `kryptoTrader`, `allowedGoals: []`, and the label "wallet" (not "launch wallet"). Each row shows:
- the coin, wallet, preset, driver, and paper/live;
- status and the reason for any pause;
- the book (tokens, SOL in, average cost, realised and unrealised);
- **fees paid vs gross P&L**;
- **vs just holding** (same money put in at the session start, then held);
- the next permitted trade time and the trade log, with the reason given for each trade.

Row buttons: Pause/Resume, Go live (confirm dialog), **Sell session bag** (works in every state), Edit envelope, Remove (only when stopped and empty).

**Honest-results strip** at the top of the page. The text is pinned by a test:

> "Nothing in this app predicts whether a coin climbs. In our tests every preset lost money on the typical coin; they change how much you keep, not whether you win. Runner flags were measured against graduation, not a climb. Of 1,741 flagged launches (07-25..27), none rose steadily over the next two hours. The median was 0.10× of the flag price at 2 hours."

## 2. Session model (`shared/kryptoTrader.ts`)

```ts
type TraderPreset = 'trim' | 'steps' | 'dips' | 'hold'
type TraderDriver = 'strategy' | 'ai' | 'mcp'
interface TraderOptions { chain:'sol'; mint; walletId; preset; params: TraderPresetParams;
  driver; budgetSol; maxLossPct; timeLimitH; reinvest:boolean; thesis:string;
  aiModel?; aiDailyUsdCap? }            // NO goal, NO live, NO price/mcap/volume field
interface TraderSession { id:`kt_${string}`; kind:'trader'; options; mode:'paper'|'live';
  status:'running'|'paused'|'stopped'; note; seq:number;
  book:{ tokensRaw:string; openCostSol; realisedSol; feesSol; lots; signatures:string[] };
  startTokensRaw:string; holdBaseline:{ priceSol; solIn };
  peakEquitySol; inFlight:{intentId;side;at}|null; lastTradeAt; lastBuyAt; lastSellAt;
  failStreak; buysWindow:{at,sol}[]; aiSpend:{day,usd}; createdAt; expiresAt }
```

- **Ids** match `/^kt_[a-z0-9_]{1,40}$/`.
- **`traderOptionsOf`** is written fresh; it does not reuse `kryptoOptionsOf`, whose `:154` accepts 'support'. It drops unknown keys and forces `live` false. `traderOptionProblems` checks each field.
- **Budget room:** `room = B − openCost − max(0, −realised)`, or with reinvest `min(B + realised, 2B) − openCost`.
- **Pending or unreconciled buys** count against room at requested SOL × 1.015. An unknown fill never frees room.

## 3. Presets

Every preset works only from the session's own book: its average cost, its own anchor, its own peak. None has a field priced in the coin's market cap or volume (M7).

### Settings shared by every preset

| Parameter | Default | Range |
|---|---|---|
| Budget B (SOL) | 0.5 | 0.02–100, clipped to the Rule B depth cap (10% exit move) |
| Max loss (% of B, book equity) | 35 | 10–90 |
| Time limit (h) | 24 | 1–168; at expiry the user chooses sell the session bag (default) or hold |
| Reinvest profit | off | on/off |

Money columns are in SOL. The honest-result figures are from quant: low cost, 1 SOL budget, fills at candle close. Groups:
- **S30:** survivor-biased best case, n=176.
- **FC:** classic runner flags, n=196.
- **G24:** classic graduations entered 24 h later, n=73.

### P1 "Trim and rebuy": the user's ask

In words: "Buy in, keep a core bag. Each time the price rises X% above your last anchor, sell part. If it falls Y% below that sell, buy the same SOL back. The anchor only moves up."

| Param | Default | Range |
|---|---|---|
| Entry (% of B) | 50 | 10–100 |
| Core never trimmed (% of bag) | 50 | 0–90 |
| Trim step (+% above anchor) | 20 | floor (D7) to 200 |
| Trim size (% of tradable bag) | 25 | 10–50 |
| Rebuy dip (−% from last trim) | 15 | floor (D7) to 50 |
| Rebuy size | the SOL the matching trim took out, capped by room | fixed rule |
| Max rounds per day | 6 | 1–12 |
| Pause near graduation (curve ≥ 95%) | on | on (locked while on the curve) |

**Honest result:** S30 median −15.1% / mean +12.5%; beat hold on 33% of coins; 3.7 trades per coin. FC −30% to −32% median. G24 beat hold on only 12–20% of coins. The tight 20%/+10%/−8% version doubled the trades (7.1) for the same median, and its +4.1-point gross edge shrank to +0.8 at high cost. That is why the defaults are wide. The card adds: "Pays in sideways chop; bleeds on a straight run or a downtrend."

### P2 "Take profit in steps"

In words: "Buy once, sell a slice at each target, never buy back."

| Param | Default | Range |
|---|---|---|
| Entry (% of B) | 100 | 10–100 |
| Rungs {+%, % of live bag} | +50%: 25 · +100%: 25 · +200%: 25 · rest held | 1–5 rungs, each +10 to +1000%, sizes sum ≤ 100% |
| Recover cost first | off | first rung sells enough to return the SOL put in |

**Honest result:** S30 −14.7% / +7.5%; beat hold on 12.5%. FC −23.2% / −19.0%. The old Krypto Mode ladder (2/3/5/10×) did worse on S30: −19.9% / +6.4%.

### P3 "Buy dips"

In words: "Split the budget into lots. Buy the next lot each time the price is Z% below your average cost. Exit by the stop or an optional target."

| Param | Default | Range |
|---|---|---|
| Lots | 4 | 1–8 |
| Step below average cost (%) | 20 | 10–50 |
| Size multiplier per lot | 1.0 | 1.0–1.5 (never 2× Martingale) |
| Take all profit at (+% vs average) | off | 10–500 |
| No buy if price is more than this far below the session high (%) | 80 | 50–95 |

**Honest result:** S30 −3.2% / +29.0% with 54% of the budget in the coin, the best median. FC −13.1% / −19.6%. The edge is not stable: S14 was −13.5 points on the mean against a hold scaled to the same exposure, and the survivor group favours this preset. The card says: "Looked best only in coins that survived. Not an edge."

### P4 "Hold with a stop": the baseline, filling the market-cap/volume slot

In words: "Buy once and hold. Sell everything at the max loss or the time limit, or optionally at a target."

| Param | Default | Range |
|---|---|---|
| Entry (% of B) | 100 | 10–100 |
| Sell all at (+%) | off | 10–1000 |

**Honest result** (plain hold, no stop; stop not simulated): S30 −17.7% / +21.5%. FC −35.2% / −40.5%, with only 2% of coins ending up. G24 −3.5% / −16.8%.

**Drivers vs presets.** With the AI or MCP driver, the preset sets the envelope and the style hint; the driver then proposes trades inside it.

## 4. Fit check card (`src/components/trader/FitCheck.tsx`)

The card runs from a main-process call `kryptoTrader:fit(mint)`. Every unknown shows "—", never 0.

**Facts shown**
1. **Venue.** Curve with its % and type (classic / mixed / —), or graduated pool (PumpSwap / Raydium / DEX).
2. **Depth R** in SOL, read from chain. On PumpSwap this is the quote-vault balance, not `poolQuoteReserves` (reads 0.793× on classic). Shown with:
   - "Budget = N% of depth"
   - "Full exit moves price −Y%"
   - "Largest single trade at a 2% move: Z SOL" (Rule A)
3. **Graduation note.** Classic: "opens within 2% (97.8%)". Mixed: "opens a median 15% lower, seeded ~0.16 SOL".
4. **Age,** with "Graduation odds only exist at +60/+120 s; this coin is past that."
5. **Dump impact** for dev, top10, sniper and bundled holders: price × (Y/(Y + h·supply))². Shown as an impact, never a score.
6. **Activity:** trades per hour; volume 1h vs 6h/6 vs 24h/24, labelled falling / flat / rising, never a forecast; organic share. Under 30 trades/h: "Your orders would be most of the market."
7. **Creator** launches and graduations (Jupiter `devMints`/`devMigrations`): "the one separator seen, n=19".
8. **Safety:** kryptScore, under "Safety" only.
9. **Round-trip cost C%,** with the $KRYPTO holder rate applied when it qualifies.

**Refuses the session**
- a mixed curve, or an unknown curve type while on the curve;
- not sellable, a Token-2022 transfer fee, or frozen by default;
- R unknown;
- M9 (the user's own coin, §6);
- live only: the creator is unknown (paper is allowed).

**Greys out, with a reason**
- **Trim and rebuy:**
  - step below the D7 floor;
  - trade size ÷ R above step/8;
  - under 30 trades/h;
  - an ungraduated curve with the 95% pause turned off.
- **Take profit in steps:** a rung whose sell moves price more than half the gap between rungs.
- **Buy dips:**
  - a lot larger than Rule A allows;
  - dev + top10 dump impact deeper than the step: "One holder can make every dip."

**Clips:** the budget to Rule B (10% exit). The page says it did, and the clip is re-checked every 5 minutes while running; buys stop if R shrinks.

**Never shown:** any probability of climbing. The pinned wording is `FIT_FORWARD_LINE`, following the pattern of `shared/runners.ts:180`.

## 5. Guard: `checkTraderIntent` (pure, `shared/botStrategy.ts`)

Every driver passes through this one function: preset rules, AI, MCP, and sell-all (which has an exit exemption). **No limit here is a user setting.**

- **M1 minimum hold:** no sell within 120 s of the session's last buy, unless it is an exit (stop, max loss, time limit, sell-all).
- **M2 no buy-back:** no buy within 600 s of any session sell.
- **M3 cross-wallet:**
  - a buy is refused if any of the user's other wallets, or a script, copy, MCP or manual trade, sold this mint in the last 60 s;
  - a sell is refused if any of them bought it in the last 60 s;
  - exits are exempt but logged.
  - The source is `ledger.Fill.wallet`.
- **M4 pacing:** at least 60 s between trades; at most 6 trades per hour.
- **M5 turnover:** gross buys over a rolling 24 h stay ≤ 3 × B. When hit, buys stop and exits keep working.
- **M6 buy size:**
  - each buy ≤ 1% of R, ≤ `maxLiveSol`, ≤ 25% of B (AI and MCP drivers), and ≤ room;
  - minimum 0.005 SOL;
  - R unknown means no buy.
- **Opposite-side distance (D7):**
  - a buy after a sell needs price ≤ last sell × (1 − floor);
  - a sell after a buy needs price ≥ last buy × (1 + floor), unless it is an exit.
- **Sell size:** at least 10% of the session bag, or 100%. It is converted to a wallet percentage through `pctForTokens(sessionRaw, balanceNow)`. **The string '100%' is sent only when the session's claim is at least the wallet balance** (M8).
- **Losing adds:** the AI and MCP drivers may add at most 2 buys while the position is under water. Buy dips uses its own lot count.

## 6. Safety rules and the test that pins each

All tests go in `test/kryptotrader.test.mjs`, which drives the real module through a fake host.

| Rule | Behaviour | Test |
|---|---|---|
| Paper by default (K10) | `open()` ignores any live flag; `kryptoTrader:goLive` is a separate confirmed call | T1 |
| Restart pauses (K2) | `init` turns running live sessions to paused and sets the peak to null | T2 |
| Exactly once (K5) | `inFlight` is written to disk synchronously before signing; if found on restart the session is paused with "check chain" and the trade is never re-sent | T3 |
| No retry (K6) | a failure stamps `lastAttemptAt` and counts toward M4; 3 failures pause; pending counts as traded | T4 |
| Breakers block buys, never sells (K1) | two gates: `buyBlocked` includes `liveBreakerReason`; `exitBlocked` is only "not armed" | T5, T5b (source check) |
| Partial sells never go through the local builder (K8) | M8 | T6: wallet holds 1,000 session tokens + 5,000 manual; sell-all → ≈16.67%, never "100%" |
| Unreadable state file is not empty | `ledger.ts` shape; `failure()` listed in `main.ts:708`, and `kryptoMode.failure()` added there too (K3) | T7, T7b |
| Crash guard | try/catch per session; sessions step concurrently, each under its own lock | T8 |
| Never block an exit | "Sell session bag" works when paused, stopped, out of budget, expired or turnover-capped | T9 |
| Kill switch | the automation kill switch (`automation.ts:323`) pauses all sessions; the emergency-sell hotkey on the session's wallet pauses that session | T10 |
| `maxLiveSol` per trade (D5) | applies to every trade | T11 |
| One lock per session (K4) | tick, AI, MCP and sell-all share one async mutex; room is reserved before the first await | T12 |
| Paper MCP connection can't move a live session | kept | T13 |
| Unknown never permits | unknown price → hold; unknown R → no buy; unknown mark → exits only; unknown creator → no live | T14 |
| M1 / M2 / M3 / M5 | as §5 | T15 (sell at +119 s refused, exit at +5 s allowed), T16 (buy at +599 s refused), T17, T18 |
| M9: not on the user's own coin | refuse paper and live if: a Krypto Mode session exists on the mint; the creator is any of the user's wallets; `kryptoBot` names a user wallet; or the chosen wallet is in Krypto Mode's declared records. Message: "You launched this coin. A bot on your own coin must be declared: use Krypto Mode." | T19 |
| M10: 'support' unreachable | no goal field; `TRADER_AI_PROMPT` has no support/lift/market-cap instruction; the Trader engine never imports `KRYPTO_AI_SUPPORT_PROMPT`, `kryptoAiPrompt` or `kryptoMode.setLimits`; ipc.ts still calls `kryptoMode.start(` exactly once | T20 |
| One session per mint | across all wallets | T21 |
| Claims on (wallet, mint) | start refused if the wallet has a script position, open copy row, armed or paused order, or Krypto Mode session on the mint; while running, scripts, copy, orders and MCP `buy_token`/`place_order` on that pair are refused; manual buys are never blocked | T22 |
| Hand trade pauses the session | a ledger fill on the pair whose signature isn't the session's → paused; a manual sell shrinks the session's claim to the balance | T23 |
| Wallet removal | `wallet:remove` (`ipc.ts:968`) refused while the wallet has a session that isn't stopped and empty | T24 |
| Graduation | when the price source changes: no buys until a new price is read; exits allowed | T25 |
| AI prompt injection | coin name, symbol, description, socials and warnings never reach the prompt | T26: an injection written into the symbol is absent from the prompt text |
| MCP stale data | a mismatched `expected_seq` is refused | T27 |
| Stop runs without the driver | the stop fires while the driver is MCP and silent | T28 |
| Every open field survives IPC | `ipccontract` reads the field list from `TraderOptions` | T29 (in `ipccontract.test.mjs`) |
| Honest wording | `FIT_FORWARD_LINE` and the honest-results strip text are pinned | T30 |

**Stops** are checked every tick and saved to disk:
- **Max loss:** book equity ≤ B × (1 − max loss %) → sell the session bag and stop.
- **Time limit.**
- **Liquidity collapse:** R down 50% or more from the session start, or the pool account gone → sell the bag and pause.
- **Stale price:** older than 60 s → hold.

## 7. AI driver

**Prerequisites before it ships**
- Stop AI keys reaching the renderer through `settings:get`.
- Fix `aiAnalysis.ts`:
  - Opus 5.5: `output_config.effort:"low"` with `max_tokens` about 4000.
  - Sonnet 5: `thinking:{type:"disabled"}`.
  - Check `stop_reason` for `max_tokens` and `refusal`.
  - GPT-5 family: `max_completion_tokens` and no temperature. This is unverified; one call with a real key settles it.

**Call:** `askTrader(ai, facts)` with no goal parameter and structured JSON-schema output. The reply must be:

```json
{"action":"hold|buy|sell","sol":number|null,"percent":number|null,"next_check_sec":30..1800,"reason":"≤160 chars"}
```

The parser refuses extra keys, and refuses `sol` and `percent` both being set.

**Facts block:** numbers and app-defined values only. The coin is called "the coin". It includes:
- price and its age, venue, liquidity now vs session start;
- market cap, holders, top-10 share;
- change at 5m / 15m / 1h / 6h / 24h;
- the 1-hour range and where price sits in it;
- 5-minute volume ratio and buys/sells;
- the last 12 five-minute closes as % change;
- the book, realised and unrealised P&L, fees paid, budget and free room;
- the last fills;
- the limits the app enforces, including the next trade time and the stop level;
- the user's thesis, labelled as opinion.

**Prompt:** the draft in the AI report, with "never buy back" replaced by the distance rule, plus one style line per preset.

**When to ask:**
- price moved ≥ max(4%, the D7 floor) since the last ask;
- one of our own trades filled or failed;
- a new session high or low;
- price within 10% of the stop;
- the model's own `next_check_sec` has passed;
- a 5-minute heartbeat.

Floor 30 s between asks, at most 30 asks per hour (hard limit 60).

**Model and cost**
- Default model: Haiku 4.5, or gpt-5-mini. Opus 5.5 is opt-in with its cost shown (about $0.18/hour on change-triggered asks at effort low).
- Daily AI spend cap per session: $2 by default. When reached, the AI pauses and the envelope and stops keep running.

**Same injection fix elsewhere:** apply the name/symbol removal to Krypto Mode's `kryptoFacts` (`:393`) and `buildFacts` (`shared/ai.ts:98,107`).

## 8. MCP tools

These are added to `shared/mcp.ts` and `mcpTools.ts`, and lead to the existing Trader store only.

- **`get_trader_sessions`** (read tier). Returns each session's id, mint, driver, mode, status, budget, book and `seq`. The wallet address is shown; no secret.
- **`get_trader_session`** `{session_id}` (read tier). Returns the facts as JSON, the envelope, `seq`, the last 20 fills, and the remaining connection and session budget. The description says token text from `get_token` is written by the coin's creator and is untrusted.
- **`trader_act`** `{session_id, action, sol?, percent?, reason, expected_seq}` (trade tier). Checks in order:
  1. `toolAllowed`;
  2. the session exists, `driver === 'mcp'` and it is running;
  3. a live session needs live access;
  4. `seq` matches;
  5. `checkMcpTrade` (connection budget, reserved first);
  6. `checkTraderIntent`;
  7. run under the session lock, logged with `by:'mcp'`.

  `hold` is logged and uses no trade slot. The description reads: "Trades the user's position only; never to make volume or move price."
- **No tool can create, fund, start, resume or configure a session.** `krypto_mode_trade` never reaches a Trader session.

## 9. Files

| File | Change |
|---|---|
| `shared/botStrategy.ts` (new) | Preset intents (trim, steps, dips, hold), `checkTraderIntent`, D7 floor, depth math (Rules A/B/C, dump impact), fill book (fills, lots, room), strict intent parser |
| `shared/kryptoTrader.ts` (new) | Types, `traderOptionsOf`/`traderOptionProblems`, preset text and defaults/ranges, the honest-result lines with n, `FIT_FORWARD_LINE`, `TRADER_AI_PROMPT`, `traderFacts` |
| `shared/paper.ts` | Fix the comments at `:25`/`:32` (they say 1% per round trip; `PAPER_SIDE_COST` is 1.5% per side) |
| `electron/engine/botSession.ts` (new) | Loop with concurrent steps and per-session lock, `execute` with the `inFlight` record, two gates, stops, shared price cache |
| `electron/engine/kryptoTrader.ts` (new) | `init` (restart pauses, file-fail read-only), `open` (M9, claims, one session per mint, fit re-check), controls, `goLive`, `sellAll`, `tradeFromMcp(id, seq)`, persistence to `krypto-trader.json` |
| `electron/engine/claims.ts` (new) | Main-process claim on (wallet, mint) plus the M3 recent-fills registry fed by the ledger |
| `electron/engine/automation.ts`, `copyTrade.ts`, the orders module, `mcpTools.ts` (`buy_token`/`place_order`) | Consult `claims` before buying or creating an order; the kill switch pauses Trader |
| `electron/engine/engine.ts` (`:4718-4760`) | `botBuy`/`botSell` aliases for `labBuy`/`labSell` (no `capSol`); `botSell` takes an exact percentage from `pctForTokens`; expose `buyBlocked`/`exitBlocked` |
| `electron/engine/kryptoMode.ts` | Now: K1 (sells skip the breaker). Later, step 9: move onto `botSession` |
| `electron/ipc.ts` | Trader host; `kryptoTrader:list/fit/open/pause/resume/goLive/sellAll/setEnvelope/remove`; MCP host projections (`:1455`); `wallet:remove` guard (`:968`) |
| `electron/preload.ts`, `src/global.d.ts` | The `kryptoTrader` namespace, added together with ipc.ts |
| `shared/types.ts` (`:963`) | Event `{kind:'kryptoTrader', sessions}` |
| `electron/main.ts` (`:708-720`) | Add `kryptoTrader.failure()` and `kryptoMode.failure()` |
| `electron/data/aiAnalysis.ts` | Per-model request fixes (§7), `askTrader`, schema output, spend accounting |
| `shared/ai.ts` (`:98,107`), `shared/kryptoMode.ts` (`:393`) | Remove name, symbol and warning text from the prompts |
| `shared/mcp.ts`, `electron/engine/mcpTools.ts` | Three tools plus host methods |
| `src/pages/KryptoTrader.tsx` (new) | The page in §1 |
| `src/components/trader/FitCheck.tsx`, `PresetCard.tsx` (new) | Fit check card and preset cards |
| `src/components/terminal/KryptoSessions.tsx` | Namespace, event kind, labels and `allowedGoals` props; Trader passes `[]`, so there is no goal picker |
| `src/components/Sidebar.tsx` (`:61-64`, `:140-143`), `src/routeLoaders.ts` (`:44`), `src/App.tsx` (`:65`, `:411`), `src/workspaces.ts` (`:78`) | The route (the usual four touches) |
| Token and Runners pages | "Open in Krypto Trader" link |
| `test/kryptotrader.test.mjs` (new), `scripts/test-steps.json` | T1–T28, T30 |
| `test/ipccontract.test.mjs`, `test/workspaces.test.mjs`, `test/mcptools.test.mjs`, `test/kryptomode.test.mjs` | T29; route; the three tools plus "no create tool"; K1/K3 for Krypto Mode |

## 10. Build order

1. **Prerequisites.**
   - AI keys out of `settings:get`.
   - `aiAnalysis` per-model fixes.
   - Remove name/symbol from the prompts.
   - Krypto Mode K1 and K3 one-liners, with tests.
2. **Pure layer.** `botStrategy.ts` and `kryptoTrader.ts` shared code, with guard, preset, depth-math and parser tests (T15–T18, T20, T26, T30).
3. **Engine.** `botSession.ts` and `kryptoTrader.ts`, paper only (T1–T4, T7–T9, T12, T14, T19, T21, T25, T28), plus the `main.ts` failure list.
4. **IPC, preload and types** (T29), then the page, fit check, and route, paper only. This is the first build users can try.
5. **Claims registry and M3,** wired into scripts, copy, orders and MCP (T22–T24, T10).
6. **Live.** `goLive`, the two gates, the `inFlight` record, exact-percentage sells (T5, T6, T11). Live stays hidden until steps 5 and 6 pass.
7. **AI driver** (cadence, spend cap, cost estimates).
8. **MCP tools** (T13, T27).
9. **Move Krypto Mode onto `botSession`,** which fixes K2 and K4–K6 there. Keep `kryptoMode.start(` as the single call.
10. **Phase 2:** BNB and Robinhood (book as bigint strings, `evmRail` routing with `amountRaw`, existing wallet only).

## 11. Open risks

- Every preset result comes from candles (15 min to 4 h, fills at the close). A bot trading tick by tick will trade more and pay more. MEV costs are not modelled.
- No dataset covers a narrative coin over days. The user's thesis stays unmeasured, which is why paper comes first.
- The M1/M2/M4/M5 numbers are proposed, not measured.
- The per-model AI request fixes, and the GPT-5 400 error they address, are untested.
## Critic's corrections (take precedence)

1. **P1, exits blocked. The "two gates" (K1) fix does not work, because the breakers disarm the engine.** `updateLiveBreakers()` calls `this.disarm('loss_limit')` (engine.ts:1840). Disarm also happens on program_upgrade (:1498), kill_switch (:1716), decoder_drift (:5610), no_wallet (:5058) and in `wallet:remove`, which disarms unconditionally (ipc.ts:975). `labSell` refuses whenever `!this.armed` (engine.ts ~4741). So the moment a loss breaker trips, `exitBlocked` ("only not armed") blocks every Trader exit, including the max-loss stop.
   - Required: a stop or exit condition that is met while disarmed is not consumed (order-safety rule 2). It stays pending, warns every minute, and fires on re-arm.
   - Or: decide explicitly whether session exits may sign while disarmed.
   - T5 and T9 must test the disarmed case, not just `liveBreakerReason`.
   - Separately, Krypto Mode's `sellAll` sets `status='stopped'` before the sell (kryptoMode.ts:299). A failed sell then leaves a stopped session still holding the bag. Trader's "Sell session bag" must not copy this.

2. **P1, a partial sell can sell the user's own tokens. M8 is wrong about how a percentage is chosen.**
   - `pctForTokens` is private (engine.ts:3755) and rounds **up** (`(want*10000 + raw - 1)/raw`, :3769). It returns 100 whenever the rounded-up basis points reach 10,000. Example: a session claim of 999,999 against a wallet balance of 1,000,000 becomes "100%" and sells the manual tokens too.
   - The builder also has a 0.01% floor (`sellAmountFor`, txBuilder.ts:1311; liveSigner.ts:365). A session holding less than 0.01% of the wallet's balance sells 0.01%.
   - Required: round down for Trader, never send 100 unless `claim >= balance`, and treat a null result (unreadable balance) as "no sell". Do not fall back to the requested percentage, which is what the copy path does at engine.ts:794/807.

3. **P1, a claim in the design is out of date. "Partial sells never go through the local builder (K8)" is false today.** liveSigner.ts:349-356 and txBuilder.ts:1311/1506: since 2026-09-07 the local builder sizes partial sells (`sellAmountFor`) and closes the token account only at 100%. The memory note order-safety-rules #6 is out of date. A numeric token amount on Solana does not go local; it goes to the relayer (liveSigner.ts:353-355, `localCannotSize`). That route is the last-resort PumpPortal one, which is wrong on mayhem/cashback coins.
   - So "sell exact base units" is **not** safely available. The design must keep percentage sells and fix item 2.
   - Rewrite T6 to assert the percentage sent, not the route.

4. **P1, "No retry (K6)" contradicts the engine.** `labSell` goes through `sellWithRetry` (engine.ts:2926). That retries once before broadcast on rate limits, and once more **after broadcast** at wider slippage when the amount is `'100%'` (`shouldRetrySell`, liveBreakers.ts:32-38). So a Trader exit at 100% can broadcast twice. It is safe only because the second send sells whatever remains.
   - The design must say this: the exactly-once record (`inFlight`) covers the session's call, not the engine's internal attempts.
   - Its T3/T4 cannot assert "never re-sent" at the transaction level.

5. **P1, the stale-price stop cannot be built on the current host.** `kryptoPrice` → `cheapPriceSol` (engine.ts:3127) returns `lastKnownPriceSol`/`tape.lastPriceSol` with **no timestamp**. On a quiet coin this can be hours old. "Stale price older than 60 s → hold", the max-loss check and the D7 distance rule all need a price with its age.
   - Add a `priceSolWithAge(mint)` host method.
   - Rule: a stale price must never trigger a stop and never permit a buy.

6. **P1, other automation can sell the session's tokens. Advanced orders and the engine's own positions are bound to the ACTIVE wallet, not a (wallet, mint) pair.**
   - `advOrders.ts` has no `walletId`. An order sells the active wallet's balance at trigger time.
   - `autoLiveSell` sends `'100%'` from the active wallet (engine.ts:2966).
   - `sellAllHeld` (panic button, ipc.ts:2968) sells every holding of the active wallet.
   - So an order placed on mint X while wallet A was active will sell the session's bag once the user switches the active wallet to B, the Trader wallet. The start-time claims check (T22) misses this.
   - Required:
     - Treat any armed or paused order on the mint, and any `liveMints` entry, as a claim on the active wallet.
     - Re-check claims on `walletSwitched`.
     - `applyTemplate` / `createOrder` (engine.ts:1117) must consult claims, or say that template attachment fails on a claimed pair.

7. **P1, default budget versus limits: the presets as simulated cannot run with the defaults.**
   - `maxLiveSol` defaults to **0.05 SOL** (types.ts:1126) and B defaults to 0.5.
   - P2/P4 "Entry 100%" therefore takes 10 buys. P1's 50% entry takes 5.
   - M4 allows at most 6 trades/hour and M6 caps each buy at 1% of depth R. Rule B (a full exit moves price 10%) allows B up to about 5% of R, which needs at least 5 buys at 1% of R. So entry alone uses the whole hourly trade allowance.
   - Quant simulated a single fill. The honest-result lines therefore do not describe what runs.
   - Required: either default B to about 5× cap, or model entry as a timed series and re-derive the result lines. At minimum, the start-time warning (D5) must be a blocking notice at the default settings, not an edge-case warning.

8. **P1, restart with an unknown signature.** `inFlight` is written before signing, but the signature exists only after `executeTrade` returns. `ledger.recordFill` also runs only after the return (engine.ts:4687, ~4775). A crash after broadcast leaves no signature anywhere.
   - D4 forbids rebuilding the book from the wallet's balance change, so the session is stuck forever.
   - Required: a reconcile step that runs `getSignaturesForAddress(wallet)` since `inFlight.at`. Failing that, a user-confirmed "adopt the balance change" action.
   - The same applies to `stage:'pending'` fills where `awaitFillTokens` times out (30 s, engine.ts:3776). Tokens that are unknown can never be sold as the session's.

9. **P2, which kill switch? T10 is aimed at the wrong one.** `automation.ts:323`/`setKillSwitch` (:675) only disables scripts. The engine's `killSwitch()` (engine.ts:1713) disarms and stops the engine. Trader must listen to both.
   - There is no "emergency-sell hotkey on the session's wallet". `emergency_sell` (HotkeyHost.tsx:60) and `sellAllHeld` act on the active wallet only.
   - Specify that a panic sell on the Trader's wallet is detected through T23 (a ledger fill that isn't the session's), not a dedicated hook.

10. **P2, "any coin" is really pump-only in phase 1, and the design doesn't say so.**
    - Depth R is defined only for the pump curve and the PumpSwap quote vault.
    - `watch` → `watchPumpMint` (ipc.ts:1719) subscribes pump mints only.
    - For Raydium/Meteora/other DEX coins, price falls to `market.freshSummary`, which is provider-limited (Birdeye's allowance parks for 6 h), and R is unknown. The design's own rule then refuses every buy.
    - The page must state the venues it supports, or the fit check must refuse other venues with a reason.

11. **P2, paper is optimistic in the thin coins this feature targets.** `modelledPaperFill` charges a flat 1.5% per side (paper.ts:58-63) with no price impact of its own. Paper sessions will beat live exactly where "Your orders would be most of the market".
    - Use the curve and pool quote math (e.g. `sellQuote`) for paper fills, or show "paper ignores your price impact" next to paper results.
    - Also: paper.ts:25 is not a stale comment. `PAPER_ROUND_TRIP_COST_PCT = 1` is a live constant for the paper-positions model. There are two paper models; don't "fix the comment", pick one for Trader.

12. **P2, the wash pattern across the user's own wallets is only guarded for 60 s.** M3's 60 s window is shorter than M2's 600 s no-rebuy. A Trader sell followed by a buy from one of the user's other wallets (Copier fans out to up to 15 wallets, 10 per coin) a couple of minutes later is the round trip between one's own wallets that the launchpad research names as the prosecuted core.
    - Make M3 at least 600 s, symmetric with M2.
    - Refuse to start while any other user wallet holds or has an active automation position on the mint, or at least show it.

13. **P2, P3 "Buy dips" on a thin coin works as defending a price level.** Buying each 20% dip in lots below 30 trades/hour means the session is most of the buy side. That is the "support the price" behaviour the design excludes (D1/M10).
    - Apply the "under 30 trades/h" grey-out to Buy dips as well, not just Trim and rebuy.
    - Apply the M5 turnover cap to buys only, so it cannot be reset by selling.

14. **P2, the user already rejected fixed pacing (krypto-mode.md, 150fdce).** "limits should be up to user", and Krypto Mode's pacing went to 0 = off at their request.
    - D6's "fixed minimums no one can lower" will be contested.
    - The design should state the reason that separates the two cases: a third-party coin with no disclosure in its description, where pacing is the guard against wash trading. Keep the minimums, but tell the user plainly before building.
    - Likewise, the relayed request asked for a preset to "maximise marketcap and volume". The refusal (D1) should be put to the user, not just recorded in the doc.

15. **P2, the honest-results strip has no source.** "1,741 flagged launches (07-25..27), none rose steadily … median 0.10× at 2 h" appears nowhere in docs/ or shared/. It also sits badly next to `FLAG_FORWARD_LINE` (runners.ts:181-182: "33 in 100 reached +50% before −25% within the hour").
    - Cite the dataset path (e.g. E:\data\work\…) and define "rose steadily".
    - Otherwise the pinned text (T30) is an unsourced claim.

16. **P3, citations that are right but point at the wrong thing.**
    - `kryptoOptionsOf`'s 'support' check is at shared/kryptoMode.ts:154 (correct). `kryptoFacts` starts at :389; the symbol line is :393.
    - The shared/ai.ts name/symbol line is :98. Socials are at :107; warnings are at :113, which also needs removing.
    - `wallet:remove` is at ipc.ts:968 (correct). Its guard must go **before** the unconditional `disarm('no_wallet')` at :972, or a refused removal still disarms everything.
    - `engine.ts:4718-4760` holds `kryptoBuy`/`kryptoSell`/`kryptoPrice`/`kryptoLiveBlocked`, which already exist as the `botBuy`/`botSell` aliases the design proposes. Generalise them rather than adding more.
    - The route touches (Sidebar :61-64/:140-143, routeLoaders :44, App :65/:411, workspaces :78) check out. Also add `'trader'` to the Automation `routes` array at workspaces.ts:81.

17. **P3, `maxLiveSol` clipping happens silently in `labBuy`.** engine.ts:4673 shrinks the buy to the cap and only logs it. Trader's room reservation (requested × 1.015) must be released down to the size actually sent, and trade logs must show "sized down to cap". Otherwise room is under-counted and the next buys are wrongly refused.

18. **P3, per-session steps will fight the relayed request's mental model.** "Sessions step concurrently" is fine, but every live step does an RPC balance read against `store.load().rpc.httpUrl` (ipc.ts:1697). That is the public-RPC budget the 09-06 rate-limit swarm tuned. With up to 50 sessions at a 5 s tick that is 20 reads/s.
    - Share one balance read per wallet and mint, reuse the 30 s re-sync, and do not read per tick.
## Appendix A: quant report

**Krypto Trader preset research: every preset loses money on the median, in every group of coins**

None of the presets (a) to (e), or the three Krypto Mode presets as shipped, made a positive median return. They mostly change how much of the budget is sitting in the coin, not the result. Presets that sell win on slightly more coins than holding. They give up 40–60% of the average return, because they sell the few coins that run. Trailing stops are the worst. Buy-only DCA looks best, but the group it looks best in is biased in its favour.

**Data and method**
- **Source:** pump.fun's `swap-api.pump.fun/v2/coins/{mint}/candles?interval=…&limit≤1000&currency=SOL&createdTs=…`. This route isn't in memory yet, it needs no key, and prices are in SOL. About 1,500 calls at a 2.1 s gap, with 0 rate-limit refusals. GeckoTerminal was unusable (about one 429 per call).
- **Coins drawn from the tape** (`E:/data/2026-09-16.jsonl` for September, `E:/data/work/launchset-2026-08-30` for July):
  - **FC:** 09-16 runner flags on classic curves, 15-minute candles, n=196.
  - **FM:** a sample of 09-16 runner flags on "mixed" curves, n=72.
  - **G24:** 09-16 classic graduations, entering 24 h later, n=73. The curve's final SOL reserve (115 SOL = classic) came from the tape.
  - **J:** July classic graduations, 4-hour candles, 318 of 1,442 fetched. I stopped the fetch early.
- **Survivors (S):** today's top ~200 pump coins by market cap that are at least 14 days old, 1-hour candles. The entry points are 30 days ago (n=176) and 14 days ago (n=184). This group is picked because the coins survived, so it favours holding and dip-buying. Treat it as the best case for your premise.
- **Fills:** 1 SOL budget. Triggers are checked only on candle closes and fill at the close. A lone close more than 3x off both neighbours is treated as a bad print.
- **Costs per side:** Krypt 0.5%, plus the pool fee, plus slippage.
  - Low case: 2.25% on the curve, 1.3% on PumpSwap (0.3% pool fee, 0.5% slippage).
  - High case: 2.75% everywhere (1.25% fee, the ceiling in `electron/engine/pumpSwapBuilder.ts:89`, plus 1.0% slippage).
- **Fair comparison:** I compared each preset against "hold" and against a hold scaled to the preset's average share of budget in the coin ("vs exp-matched").

**Survivors S30 (best case), low cost** — median / mean, % of coins it beat hold, trades per coin, fees as % of budget (low / high cost)

| Preset | Median / mean | Beat hold | Trades | Fees | Note |
|---|---|---|---|---|---|
| (e) hold | −17.7% / +21.5% | – | 1 | 1.3% / 2.7% | |
| (a) grid 25%/+20%/−15% | −15.1% / +12.5% | 33% | 3.7 | 3.3% / 6.9% | |
| (a) grid 20%/+10%/−8% | −15.1% / +11.9% | 47% | 7.1 | 4.5% / 9.1% | gross edge over hold +4.1 pts, down to about +0.8 at high cost |
| (a) grid 33%/+50%/−25% | −15.1% / +17.9% | 15% | – | – | |
| (b) trail 25%, re-enter +20% | −23.1% / +2.1% | 32% | 5.5 | 7.1% / 14.2% | vs exp-matched −9.5 / −21.1 pts |
| (b) trail 40%, re-enter +40% | −21.9% / +0.8% | – | – | – | |
| (c) ladder 25% at 1.5/2/3x | −14.7% / +7.5% | 12.5% | – | – | |
| (c) ladder 2/3/5/10x, stop 0.5 | −19.9% / +6.4% | – | – | – | |
| (d) accumulate 4×¼ on −20% vs average | −3.2% / +29.0% | – | – | – | 54% in the coin; vs exp-matched +1.7 / +11.4 pts |
| Krypto Mode ladder | −9.9% / +4.5% | – | – | – | loses to hold-50% (−8.9% / +10.8%); beats it on 20% of coins |
| Krypto Mode trail | −9.5% / +0.6% | – | – | – | beats hold-50% on 29% of coins |
| Krypto Mode dip | 0.0% / +5.3% | – | – | – | 23% in the coin |

**The same picture in the unbiased groups (low cost)**
- **Classic runner flags (FC, n=196, about 4.3 days):**
  - Hold −35.2% / −40.5%. Only 2% of coins ended up.
  - Grids −30% to −32% on the median. Trail 25% −29.8% (9% of budget in fees). Ladder 25% −23.2% / −19.0%. Accumulate −13.1% / −19.6%.
  - Nothing is positive on the mean.
- **Mixed flags (FM, n=72):** hold −86.6% median. Every preset is between −13% and −85%.
- **Classic graduations, 24 h later (G24, n=73):** hold −3.5% / −16.8%. Grids beat hold on 12–20% of coins. Median move of the coins −0.9%, and half of them never closed above the entry again.
- **Survival:**
  - 09-16: of about 290 classic graduations, 137 had no trade 24 h later and 98 more were under about $4.5k market cap.
  - July: only 3.1% (10 of 318) still traded above about $11k market cap on day 7, and 2.8% on day 30.
  - A "real project slowly climbing" is therefore roughly 1–3% of graduates.
- **The "slowly climbing" filter doesn't help:** S30 coins up 20–300% in the week before entry (n=32) had hold −31.9% median / +100% mean, with 34% ending up. Grid was −26.5% / +45%, trail −38.6% / +24%.

**What this means for the feature**
- Presets can't honestly be sold as ways to profit. They are ways to shape risk: how much you keep if the coin dies, and how much of a moonshot you keep.
- Show a live "vs just holding" line in each session.
- Drop trailing-stop re-entry, or label it the costliest.
- If a grid ships, it should use wide steps. Tight steps double the trade count for about the same median.
- The dip and accumulate presets show a small edge only after adjusting for exposure. Its sign isn't stable (S14 accumulate is −13.5 pts on the mean) and the survivor group favours it. Don't claim an edge.
- Paper-first stays essential.

**Limits of this data**
- Candles are 15 min to 4 h and fills are at the close. A tick-level bot would trade more and pay more fees.
- Sandwich (MEV) costs aren't modelled. Slippage is fixed, which understates it in near-dead pools.
- I also tried filling at the candle's high/low wicks. It produced impossible trailing-stop results (a mean of +145%, fees 590% of budget), so those numbers are thrown out.
- July n at day 7 is 3: too little data to say anything there.
- The survivor group is picked with hindsight.
- Side finding: `shared/paper.ts:25`/`:32` say paper trading costs 1% per round trip, but `PAPER_SIDE_COST` at `:58` is 1.5% per side (3% per round trip).

No repo files were edited. Everything is in `C:/Users/Krypt/AppData/Local/Temp/claude/C--Users-Krypt-Desktop-kryptware-KryptSniper/b89dd264-9df6-4bfe-8d90-9c192dfd19e7/scratchpad/`:
- `sim.mjs` (the presets)
- `run2.mjs` (coin groups, entry rules and costs; run `node run2.mjs FC|FM|G24|J7|S30|S14`)
- `summ.mjs` (summary tables)
- `fetch3.mjs`, `fetch4.mjs`, `fetch5.mjs` (candle downloads)
- candles in `p09/`, `p07/`, `ps/`
- per-coin results in `rows2_*.json`
## Appendix B: selection / fit-check report

No signal the app has today predicts a slow climb. I tested this on the 07-25/26/27 tape. Of 1,741 runner flags, **none** followed a slow-climb path in the 2 hours after the flag, against 0.07% of launches that were not flagged. So the fit card should show mechanical facts and hard size caps. It should never show a "chance of climbing" figure.

## 1. Do the existing signals predict a slow climb?

**The test.** I joined `E:\data\work\runner-outcome-2026-09-11\labeler\forward_outcomes.parquet` to `flag-eval\flagged_all_days.parquet` and to the launchset regime columns. Scripts: `C:\Users\Krypt\AppData\Local\Temp\claude\C--Users-Krypt-Desktop-kryptware-KryptSniper\b89dd264-9df6-4bfe-8d90-9c192dfd19e7\scratchpad\slow.py` and `slow2.py`.
- Universe: entry at +60 s, not graduated by then, 2-hour path complete. That leaves n = 68,108.
- "Slow climb" means all four of these:
  - price at 120 min is at least 1.5×
  - price never went below 0.75× in the first hour
  - peak in the first 10 min stayed under 1.5×
  - price at 120 min kept at least 60% of the 2-hour peak

| Group | n | Slow climb | ≥1.5× at 2 h | Median price multiple at 120 min |
|---|---|---|---|---|
| All | 68,108 | 47 (0.069%) | 1.06% | 1.000 |
| Flagged | 1,741 | **0 (0%)** | 3.91% | **0.101** |
| Flagged, classic curve | 315 | 0 | 3.49% | 0.341 |
| Flagged, mixed curve | 1,426 | 0 | 4.00% | 0.050 |
| Bucket top1 / top1_5 / top5_10 | 387 / 2,482 / 3,456 | 0 / 0 / 0 | 2.8 / 4.3 / 3.8% | 0.07 / 0.17 / 0.32 |
| Bucket top25_50 | 14,705 | 28 (0.19%) | 0.83% | 0.99 |

- **Looser definitions don't change the answer.**
  - Floor 0.6×, early peak under 2×, keep 50% of peak: flagged 0.115% vs not flagged 0.215%.
  - Floor 0.5×, early peak under 3×, keep 40% of peak: 0.92% vs 0.45%. This is the only version where flags come out ahead, and only because these rules now let spikes through.
- **Flags that did end up higher got there by spiking.** 68 flags were ≥1.5× at 2 h. Median peak in the first 10 min was 4.36×, and they fell a median 57% from their peak within the first hour.
- **The runner flag / runnerOddsPct ranks graduation, and graduation is not a climb.** The odds are only computed at +60/+120 s and never after graduation (`shared/market.ts:240-244`). So on a coin that is hours old, odds are null. Also, 69% of flags were at half price after 5 min, and the median price at 30 min was 0.12× (`docs/runner-outcome-2026-09-11.md:20-23`). A model aimed at forward returns did no better than the graduation model: 32.2% vs 32.6% (same doc, :36-40).
- **kryptScore is a safety score, not a forecast.** `quickScore` (`shared/market.ts:1404-1423`) only checks liquidity, "sellable", the creator's past launches and "banned". It read 68 on all 19 callout picks, the one winner included (memory: callout-script-serial-devs).
- **Socials and smart money point the wrong way.** Coins with socials graduated 1.4% vs 4.1% without. Coins with KOL/smart-wallet buyers did 0.737× as well at +60 s (insight-swarm-2026-08-30).
- **Holder concentration predicts swings in both directions, not a direction.** 75% dumped and 22% graduated (insight swarm). Show it, never score it.
- **Callouts.** 18 of 19 callout-runner buys lost, and the creators' launch counts ran from 24 to 5,376. The one separator seen was the creator's launch count, which comes from Jupiter's `devMints` field (n = 19, anecdotal).
- **Older coins that already graduated drift down.** The closest evidence at an hours-to-days horizon is SWING-0 in `docs/farming-swarm-2026-08-15.md:460`. It followed 641 coins from the day their pool was created and found:
  - average return +5.2% at 1 h, +0.7% at 4 h and −4.88% at 12 h (median −1.03%)
  - only 43.9% up
  - only 17% of clock hours had any trade

  Cross-sectional momentum on established memecoins passed 0 of 120 configurations (:456).
- **The horizon the user means isn't covered at all.** No dataset here covers a narrative coin over days.

**What the card must say:** "Nothing in this app predicts whether a coin climbs. These are the coin's mechanics at the size you picked."

## 2. Price-impact rules (constant product, fees excluded)

R is the SOL side of the pool:
- on the pump curve, `vSol` = 30 + 85 × progress (`electron/engine/curve.ts:26-28`)
- on PumpSwap/DEX pools, the live quote-vault balance

For PumpSwap, read the vault balance. Don't use the event's `poolQuoteReserves`: on classic pools the reserves-ratio price comes out 0.793× the real one (labeler REPORT).

**Per-trade price move:**
- buying s SOL moves price by (1+s/R)² − 1
- selling for s SOL moves it by 1 − (1−s/R)²
- the average fill is about s/R worse than spot

**Rule A, per-trade cap:** s ≤ R·(√(1+I) − 1). With a 2% move cap, s ≈ 0.01·R.

**Rule B, position cap (the binding one):** position ≤ R·(1 − √(1−X)).
- On a constant-product pool, selling in pieces moves price the same total amount as one sale (fees and others' trades aside). So splitting an exit doesn't help.
- With a 10% exit move: ≈ 0.051·R. With 20%: ≈ 0.106·R.

**Rule C, grid/trim step:** g ≥ 2 × round-trip cost, where round-trip cost = 2·s/R + 2·(Krypt 0.5% (`shared/fees.ts:28`) + venue fee).
- The curve fee is modelled at 1% (`curve.ts:19`), so about 1.5% per side in total.
- For PumpSwap/DEX pools, read `lpFeeBps` + `protocolFeeBps` from the swap event (`ammDecoder.ts:63-66`).
- Also require own move per trade ≤ g/4, which means s/R ≤ about g/8.

| Pool | R (SOL) | Max per trade (2% move) | Max position (10% exit) | Max position (20% exit) |
|---|---|---|---|---|
| Curve at 10% | 38.5 | 0.38 | 1.98 | 4.06 |
| Curve at 20% | 47 | 0.47 | 2.41 | 4.96 |
| Curve at 50% | 72.5 | 0.72 | 3.72 | 7.65 |
| Curve at 80% | 98 | 0.98 | 5.03 | 10.35 |
| PumpSwap classic seed | 85 | 0.85 | 4.36 | 8.97 |
| DEX, $5k liquidity (SOL at $200, assumed) | 12.5 | 0.12 | 0.64 | 1.32 |
| DEX, $25k liquidity (SOL at $200, assumed) | 62.5 | 0.62 | 3.21 | 6.60 |
| DEX, $250k liquidity (SOL at $200, assumed) | 625 | 6.2 | 32 | 66 |

**Minimum grid step (Rule C):**
- At 1.5% fees per side (curve): 8% at s/R 0.5%, 10% at 1%, 14% at 2%.
- At 0.75% per side: 5%, 7% and 11%.
- A grid tighter than about 8–10% on a pump curve loses money mechanically, before any question of direction.

**Mixed curves are unsuitable for any preset.**
- Sells remove about 5.5× the SOL out of `vSol`, so the effective R for selling is about R/5.5.
- Median `vSol` at completion is 0.87 SOL, and graduation seeds a median 0.16 SOL.
- So R ≤ 0.2 SOL and the position cap is a few thousandths of a SOL. Refuse whenever `curveRegime` (`shared/odds.ts:176`) is 'mixed'. Treat an unknown regime as not classic.

**The budget limit is far above what any curve can absorb.** `KRYPTO_MAX_BUDGET_SOL = 100` (`shared/kryptoMode.ts:118`) is about 41× the 10%-exit cap on a curve at 20%. Krypto Trader should clip the budget to Rule B at session start and on every re-check (R changes), and say it did.

## 3. The proposed "Fit check" card

Every fact shows "—" when unknown and never 0.

**Facts shown:**
1. **Venue.** Curve (progress %, `bondingCurvePct`) or graduated pool (PumpSwap/Raydium/DEX), plus the regime (classic / mixed / unknown).
2. **Depth.** R in SOL, read from chain. Then "Your budget is N% of pool depth", "A full exit moves price −Y%", and "Largest single trade at a 2% move: Z SOL".
3. **Graduation risk inside the session.** For an ungraduated classic curve: "if it completes, the pool opens within 2% (97.8% of classic graduations)". For mixed: "opens a median 15% lower, seeded ~0.16 SOL". Orders were blind at graduation before (memory: user-complaints-2026-09-13).
4. **Age.** `createdAt`, plus "the graduation odds only exist at +60/+120 s; this coin is past that".
5. **Concentration as dump impact, not a score.** Show what happens if the dev or top 10 sold into the pool: price × (Y/(Y + h·supply))², with Y the pool's token reserve. On a curve at 50%:

   | Holder sells | Price becomes |
   |---|---|
   | 2% of supply | 0.92× |
   | 5% | 0.81× |
   | 10% | 0.67× |
   | 25% | 0.41× |

   Sources: `devHoldingPct`, `top10Pct`, `sniperPct`, `bundledPct` (`shared/market.ts:216-220`).
6. **Activity.** Trades per hour and volume, 1 h vs 6h/6 vs 24h/24 (`stats`, `market.ts:130-138`), plus organic share of volume.
   - Label the trend "falling / flat / rising". Never call it a forecast.
   - Below about 30 trades/h: "your orders would be most of the market".
7. **Creator.** Jupiter `devMints`/`devMigrations`, i.e. launches and graduations. Say it is the one separator seen, on n = 19.
8. **Rug rules and Shield.** "Not sellable", Token-2022 transfer fee or frozen-by-default: refuse the session.
9. **Fees.** "Each round trip costs about C%" (Rule C), with the $KRYPTO holder rate applied when it qualifies.

**Presets the card greys out, each with a stated reason:**
- **Every preset:**
  - mixed curve
  - not sellable / transfer-fee Token-2022
  - R unknown
  - budget over the Rule B cap, which gets clipped rather than refused
- **Grid / "trim and rebuy":**
  - step under 2 × round-trip cost
  - s/R over g/8
  - trades/h under about 30
  - ungraduated curve with graduation able to happen mid-grid (unless the preset pauses at 95%)
- **Take-profit ladder:** a rung whose sell size moves price more than half the rung spacing.
- **Buy dips:** each piece over Rule A. Also flag the case where dev + top10 dump impact is deeper than the dip depth (25%, `kryptoMode.ts:252`): "one holder can make every dip".
- **Trailing exit:** thin activity. The measured 60% stop filled at −63% to −97% (memory: callout-script-serial-devs), so the trail can't hold its level.

**Wording that should be pinned by a test** (same pattern as `FLAG_FORWARD_LINE`, `shared/runners.ts:180`): "Runner flags were measured against graduation, not a climb. Of 1,741 flagged launches (07-25..27), none rose steadily over the next two hours. The median was 0.10× of the flag price at 2 hours." The card should never render a probability of climbing, and kryptScore should appear under "safety" only.