# Phase 2 — Live Execution Roadmap

> **Progress (updated after the July 2026 research swarm — see
> `docs/research-swarm-2026-07.md`):**
> - **Milestone A** — real mainnet fixtures harvested (`test/harvest.fixtures.mjs` →
>   `test/fixtures/live-logs.json`) and pinned in `npm test`. PDA prewarm
>   (`electron/engine/addresses.ts`) derives bonding-curve / creator-vault /
>   sharing-config / ATA / UVA accounts from the verified seeds. **Still open:** the full
>   27-account buy_v2 / 26-account sell_v2 lists (deliberately NOT hardcoded — volatile
>   config that must be validated against a live IDL before arming).
> - **Milestone C** — order-intent state machine (`orders.ts`, exactly-once per mint per
>   session) + allowlist policy gate (`policy.ts`) run in front of every paper fill.
> - **Milestone C/D (landing)** — priority-fee estimator (`feeEstimator.ts`, Helius
>   backend + scoped getRecentPrioritizationFees fallback), live Jito tip-floor feed
>   (`jitoTips.ts`), and the **shadow multi-lane sender** (`sender.ts`): builds the exact
>   send plan a live buy would submit — lane selection (Helius Sender swqosOnly free
>   default / exclusive Jito bundle / RPC fanout), tip-floor-driven tip, fee-scoped CU
>   price, modeled all-in cost — and records it WITHOUT signing. Visible in the Execution
>   Lab page.
> - **#9 blocklist seeding** — `creators.seedBlacklist` + Settings importer (ScamSniffer /
>   RED-COHORT lists as risk flags).
>
> **Still open before live fire:** v2 instruction *construction* (builders from a
> validated IDL), the separate signer process + policy re-validation at sign time,
> deliberate arming with auto-disarm, startup chain-reconciliation, full v0/ALT/CPI
> transaction resolution, per-lane landing telemetry.

> **STATUS CORRECTION (2026-08-16).** The progress block above is stale. Live execution
> is no longer gated: `LIVE_EXECUTION_AVAILABLE` is **`true`** in `shared/types.ts`,
> the instruction builders exist (`txBuilder.ts`), and real mainnet trades have landed.
> What is still open from Milestone C/D: **signer-side decode-and-revalidate**
> (`wallet.ts` checks fee payer and signature count only — no outflow cap, no
> destination rule) and **startup chain-reconciliation**. Autonomous live firing was
> REMOVED on 2026-08-16; execution is manual-only, so the exactly-once *strategy* intent
> problem is narrower than this file assumes. Current gate list for a public release:
> `docs/product-swarm-2026-08-16.md` §8.

v1 was deliberately a recorder, scorer and paper trader (shadow mode). This file is the
gate list for live trading, distilled from `research.txt` and the production critique in
`wemissinshi.txt`. The invariants below still bind; several are **not yet implemented**
— see the status correction above rather than assuming this file is current.

## Execution invariants (must always be true)

1. One strategy intent creates at most one economic position.
2. No transaction signs against state older than the configured freshness limit.
3. Unknown instructions, account layouts, program versions or fee configurations
   disable trading (v1 already fails closed on program upgrades and event-layout drift).
4. After a crash, the chain — not local storage — is the source of truth: startup
   enters reconciliation mode before any new entry.
5. A timed-out RPC response never automatically means a transaction failed.
6. Every live transaction is fully decoded and policy-validated before signing.
7. Exit processing always outranks discovery and enrichment work.
8. Monetary calculations never use floating point (v1 already integer-only).

## Milestone A — protocol laboratory (no UI, no trading)

- Pin and hash the current official Pump IDLs; record program IDs + ProgramData
  deployment slots (v1's watchdog baseline becomes the anchor).
- Gather 25–50 real mainnet transaction fixtures covering create, buy_v2, sell_v2,
  buy_exact_quote_in_v2, completion, migration.
- Reproduce actual balance changes and fees from transaction metadata; golden-test the
  integer math against them.
- Explicitly support or reject: SOL/USDC quote mints, user_volume_accumulator,
  sharing_config, fee recipient selection, buyback fee recipient, creator vault +
  fee sharing, cashback, bonding-curve account extension, canonical vs noncanonical
  PumpSwap pools, dynamic global config. **Never hardcode fee percentages or reserve
  constants — fetch and version the on-chain config accounts.**

## Milestone B — full transaction resolution + fork lifecycle

- Resolve legacy + v0 transactions, address lookup tables, inner CPI instructions,
  stack height, pre/post balances, return data, compute units, log truncation.
- Event identity = signature + outer_instruction_index + inner_instruction_path +
  event_index (v1 uses signature-level dedupe, which is fine for log streaming).
- Event lifecycle: OBSERVED_PROCESSED → CONFIRMED → FINALIZED / ORPHANED / REPLACED,
  with separate trading state (processed), accounting state (confirmed) and historical
  state (finalized). v1's post-entry orphan check is the seed of this.
- Provider coordinator: slot lag, blockhash disagreement, missing signatures, duplicate
  rate, completeness. Material divergence → disable entries, exit via healthiest feed.
- Yellowstone gRPC as primary production feed; native WSS as fallback.

## Milestone C — exactly-once economic intent

Persisted order state machine:
CREATED → POLICY_VALIDATED → PERSISTED → SIGNED → SUBMITTED_UNKNOWN →
OBSERVED_PROCESSED → CONFIRMED / FINALIZED / EXPIRED_NOT_FOUND / REPLACED / FAILED →
RECONCILED.

Protections: persisted intent ID before signing, deterministic client order ID,
signature persisted before submission, signature-status lookup after timeout, wallet
balance-delta reconciliation, no replacement until the old blockhash expires, per-mint
execution mutex, per-wallet sequencing, single-instance lock on the trading wallet.

## Milestone D — policy signer + arming

> **Progress:** The **wallet + arming machinery is built and shipped** (shadow-safe).
> `electron/system/wallet.ts` generates a dedicated in-app ed25519 hot wallet, encrypts
> the secret with Electron `safeStorage` (OS keystore / Windows DPAPI), and manages
> balance, a max-balance cap, a withdrawal address, keypair backup-to-file, and removal —
> the secret never reaches the renderer or a log. The engine has a real **arm/disarm
> state machine** that auto-disarms on restart, program upgrade, decoder drift, and the
> loss limit. ALL of it is hard-gated behind `LIVE_EXECUTION_AVAILABLE = false` in
> `shared/types.ts`: arming signs nothing. **Still open here:** the signer's
> decode-and-revalidate step, and flipping the gate once the instruction builders exist.


Separate signer process with a narrow allowlist: program IDs, quote mints, max quote
amount, max fee, max tip, wallet-owned destinations only; no arbitrary transfers,
approvals, authority changes or account closures. The signer independently decodes and
validates every transaction before signing.

Live mode requires deliberate arming and auto-disarms on: restart, program upgrade,
provider divergence, decoder failures, daily loss limit, configured expiry.

## Milestone E — realistic replay + sizing

- Replay paper fills against the actual reserve sequence: submission slot estimate,
  intervening real trades applied, ordering percentile, minimum-output check, exits
  against future executable reserves.
- Feature-time correctness: every feature carries chain_effective_slot AND
  bot_available_at; no lookahead, no survivorship, creator-cluster-separated splits.
- Position sizing = min(configured max, wallet risk allowance, daily remaining risk,
  liquidity max, price-impact max, creator/cluster exposure max, exit-liquidity max).
- Portfolio controls: per-mint/per-creator/per-cluster exposure, entries-per-minute cap,
  correlated-position cap, cooldowns after emergency exits and feed failures
  (v1 already has session loss limit + consecutive-loss cooldown).

## Milestone F — metadata pipeline (only when the UI renders remote content)

Sandboxed fetch worker: HTTPS-only, private-range + DNS-rebinding blocked, redirect and
size limits, MIME validation, no SVG/HTML/JS rendering, cached sanitized thumbnails,
content hashing. v1 never fetches metadata URIs, so this is not yet a surface.

## Auditability (applies from Milestone A)

Every decision retains: app version, git commit, adapter version, program executable
hash, IDL hash, config hash, strategy version, risk-rule version, provider + slot,
feature snapshot. Plus: lockfile enforcement, dependency audit, secret scanning,
signed releases, no telemetry.
