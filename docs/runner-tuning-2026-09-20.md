# Runner-alert tuning on the Execution page — 2026-09-20

The user's point, verified: the scanner has not bought anything on its own
since 2026-08-16 (`autoLiveActive()` is hard-wired false) and stopped opening
paper positions by default on 09-02, yet the pages still read as if a
strategy decided buys. The Strategy page ("Spellbook") held the runner-alert
switches beside the paper-entry gates, which made the gates look like the
thing that decides a flag; the Execution page carried "Paper send plans" —
what a live buy would have submitted for each paper entry — and a banner
about "each would-be snipe". None of it drove a flag.

## What decides a flag, and where it is tuned now

The flag is `runnerVerdict` in `shared/runners.ts`: the graduation-odds
bucket at +60 s (and +120 s if +60 s did not flag), never on a hard reject,
a creator sell, a truncated tape, a non-SOL quote, and — since today — never
on a launch the user's own filters refuse. All of it is on the **Execution**
page, first section, next to the mayhem filter that decides which curves the
scanner watches at all.

New filters on `strategy.runnerAlerts` (all off by default, absent on older
saves and read as off, validated in `settingsValidation.ts`):

| field | what | refuses when |
|---|---|---|
| `windows` | `both` / `60` / `120` | the judge is at a window that is off |
| `minBuyers` | unique buyers at the judge, 0 = none | count known and under |
| `minNetSol` | net SOL drawn at the judge, 0 = none | amount known and under |
| `minCurvePct` / `maxCurvePct` | % of supply sold, 0–100 = none | progress known and outside |
| `skipRepeatDumpers` | creator dumped an earlier launch on the app's record | dumps on record > 0 |

Each applies only when the fact is KNOWN. A missing count, an unknown
regime, or a creator with no record never hides a launch — the app does not
hide things for reasons it cannot state. The verdict's reason names the
setting that refused, so a launch row can say so.

The engine skips the odds computation entirely for a window the user turned
off (`windowAllowed`), and the next window is still judged. The Runners tab
subtitle lists the active filters (`describeRunnerFilters`) so a short list
explains itself.

## The bug this pass found

`validateSettingsPatch` drops any key the defaults do not have. Yesterday's
`excludeMixed` ("Skip mixed curves") was added to `DEFAULT_RUNNER_ALERTS` in
`shared/runners.ts` but not to `DEFAULT_SETTINGS.strategy.runnerAlerts` in
`shared/types.ts`, so the switch saved as nothing. The defaults now spell out
every field, and `test/settingsvalidation.test.mjs` pins that the whole
filter block survives the validator. This is the settings-validation-traps
class again: a validator refusing (here, silently dropping) the app's own
payload.

## What moved, what went

- Execution page: runner-alert section added (switch, bucket floor, window,
  buyer floor, net-SOL floor, supply-sold band, skip mixed, skip repeat
  dumpers, cap per hour, mayhem filter, and a "right now" line). "Paper send
  plans" removed; the engine still builds shadow plans for paper entries and
  records them, nothing reads them on a page. Banner and local-builder copy
  now describe manual trades (and the PumpSwap local build).
- Strategy page: runner section removed; a "Paper entries (research)"
  section at the top says what the gates still decide (paper positions when
  on, Backtest defaults, the "did not qualify" line) and points at Execution.
- Plain names, at the user's request: Spellbook → Strategy, Inscriptions →
  Presets, Inscribe → Apply, Warded/Reckless → Strict/Loose, Entry wards →
  Entry gates, Rites of exit → Exit rules, Honesty box → About these
  defaults, Grimoire → Console (sidebar, page title, guide, a toast), "Risk
  wards" → "Risk checks", "Concentration wards" → "Concentration checks".
  Observatory stays: it is not a magic word.

## Not done

- The EVM chains' runner alerts (Robinhood, BNB) keep their own bucket floor
  and cap on their Observatory pages; the new filters are Solana-only. The
  odds model and the curve facts they read are Solana's.
- No filter on the Krypt score: it is fetched by the renderer after the
  flag, from providers that may not know the token yet, so it cannot gate a
  flag honestly.
