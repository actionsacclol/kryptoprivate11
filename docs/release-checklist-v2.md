# Krypto Bot 2.0.0 — what is missing, and what to check before shipping

Version bumped 1.1.0 → **2.0.0** on 2026-09-10. Revised 2026-09-11 after the
Wallet Scout, the launcher, the EVM runner filters, the Swap and Bridge pages,
and three audit swarms (Robinhood, BNB, Solana — one memo each) landed:
typecheck clean, **114 suites pass**, `npm run build` exit 0.

This is not a list of everything that could be done. It is the list of things
that would embarrass us if a user found them first, ordered by how likely that
is.

---

## 1. ~~The blocker: none of this is committed~~ — committed, but there is no remote

Committed 2026-09-11 in five commits on `release/beta.7`, starting at
`d1e93b4`. The working tree is clean and a stray `git checkout` can no longer
lose weeks of work.

**The remaining half of this blocker is worse than it looked.** `git remote -v`
is EMPTY. There is no GitHub repository attached to this checkout at all, so
`.github/workflows/release.yml` has never run and cannot run: no push, no tag,
no macOS or Linux artifact, and the ~50 test files have still only ever run on
one machine. Creating and pushing a repository is the user's to do — it needs
their account — and until it happens every claim about cross-platform support
is untested.

The original text follows, for the reasoning.

### Why it mattered

`git status` shows **247 changed or untracked paths**, and the last commit is
`c1df49c`. Everything in this release — the two EVM chains, the scripting
sandbox, the workspace layout, My Layout, the three Observatories, and every
fix from the 09-09 audit — exists only in this working tree.

Consequences, all of them real today:

- **CI has never run any of it.** `.github/workflows/release.yml` builds on
  push to main and on a `v*` tag, on three runners. The ~45 new test files and
  `scripts/test-steps.json` are uncommitted, so the EVM, sandbox, automation,
  fail-closed, panel-layout and scanner suites have only ever run on one
  machine.
- **There is no tag to build from**, so there is no macOS or Linux artifact at
  all — and there cannot be, because V8 bytecode is platform-locked and each
  platform must build on its own runner.
- A single `git checkout` of the wrong path loses work that took weeks. This
  has already happened once in this repo, to `scripts/test-steps.json`.

**Do this first.** Nothing else on this list matters until the tree is
committed and CI is green.

## 2. Features that have never run

Written, typechecked, built, unit-tested — and never exercised against a live
chain or a real screen. This is the largest honest gap in 2.0.0.

**~~The two EVM Observatories~~ — now run, and Robinhood has a real model.**
Settled by running them: Robinhood has watched **1,962 launches to a
conclusion, 28 graduated, a 1.43 % base rate**, and its buckets are cleanly
monotone — 0 buyers 0.0 %, 3+ 0.3 %, 6+ 0.8 %, 11+ 1.6 %, **21+ 9.5 %
(n=222)**. That is a measured 6.6× signal on this chain's own records.

BNB has settled **zero**, and the cause was a bug, found 2026-09-11: `pending`
lived only in memory while the model persisted, so any restart inside the
six-hour outcome horizon threw away every launch still in flight. Fixed —
pendings are saved, and a restored launch is re-verified against the chain
rather than settled on an event feed that was not running. **BNB's model is
therefore still empty and needs an uninterrupted day to say anything.**

Still worth checking by hand:
- Turn a chain off in Settings while its scanner runs.
- Watch for `lastError` — the BNB audit found publicnode serves no receipts
  and the dataseeds refuse `eth_getLogs` outright, so the endpoint map is the
  first suspect if BNB stays empty while Robinhood fills.

**The launcher has never created a token.** Built 2026-09-11, both chains,
both instructions pinned byte-for-byte against real transactions — and not one
real launch has been sent. This is now the largest never-run path in the
release, and it is the least reversible thing the app can do. One cheap launch
per chain, on a throwaway ticker, covers the whole path: pin, simulate, sign,
send, and (on Solana) the follow-up first buy through the trade pipeline.

**My Layout.** Two bugs were found by using it for a minute (panels arriving
1×1, the picker clipped by the scroll container). Both fixed, neither was
caught by a test, and the render-ordering bug that caused the first one is
**not** testable without a renderer. Assume more remain: drag two panels onto
each other, resize to the minimum, switch every panel off and on, reload, pin
six pages, open the picker at the bottom of a short window.

**The three Solana money-path fixes from Tier 3.** The sell receipt check, the
scaled relayer cap and the tip-aware loss bound all change what the signer
accepts on a REAL sell. They are proven against constructed transactions, not
against a live exit. One small live sell on Solana would cover all three.

## 3. Decisions still open

**~~The Warmer versus our own Terms~~ — REVERSED 2026-09-14: removed.** The
2026-09-10 decision to keep it did not survive a second look. A feature whose
whole job is to generate buys and sells across wallets one person controls
reads as wash trading however carefully the copy is worded, and the copy was
never written. Removed with it: the Copier page's follow-my-manual-trades mode
and the multi-wallet simultaneous buy, for the same reason. See HANDOFF.md
"Wallet Lab" for exactly what went and what stayed.

The Scout change that came out of the 09-10 decision is kept and still pinned:
it excludes the user's own wallets on every chain and purges any it recorded
before it knew they were ours, which is right regardless of what makes the
trades.

**`blockFeed` on by default** — 5.51 GB/h, no UI toggle. Three options are
written up in `docs/api-swarm-2026-09-09.md` §8b and none was picked.

**~~No graduation odds on the EVM chains~~ — now each chain has its own.**
Built from each chain's own observed records rather than borrowed from pump,
with a per-chain notification filter (floor, hourly cap, must-beat-base). The
corpus persists across restarts as of the pending fix above. Robinhood's is
usable today; BNB's needs a day of uptime.

## 3b. Functional holes found 2026-09-11 — all five CLOSED

These were not polish; each was something a user could walk into. All five
were fixed on 2026-09-11 and are struck through below, kept rather than
deleted so the next audit can see what was found and what was done.

- ~~**There is no updater, and no version check of anything.**~~ **FIXED.** Nothing in the
  app ever asks whether a newer build exists; `krypt.cc` appears only in the
  sidebar link and in tamper warnings. Every user who installs 2.0.0 stays on
  2.0.0 until they happen to revisit the site. `crash-guard-policy` says a
  launcher handles updates rather than electron-updater — that launcher does
  not exist. **This is the single biggest gap in the release.**
- ~~**Creator fees cannot be claimed.**~~ **FIXED.** The launcher ships, so a user can create
  a token on pump and accrue creator fees — and there is no
  `collect_creator_fee` / `_v2` path anywhere in the repo, so they cannot
  collect them from inside the app. Shipping the earning half without the
  collecting half is the wrong order, and it was already agreed and not built.
- ~~**No emergency exit on the EVM chains.**~~ **FIXED.** Solana has `live:sellAll` and a
  panic hotkey; `HotkeyHost` routes `emergency_sell` to
  `window.krypt.live.sellToken`, which is Solana-only. A user holding five BNB
  positions who wants out sells them one at a time, by hand. Against the house
  rule that nothing blocks an exit, this asymmetry is hard to defend.
- ~~**`blockFeed` has no UI anywhere.**~~ **FIXED** — the switch exists and states the cost. The DEFAULT is still an open decision (§3).
  `grep blockFeed src/` returns nothing. A user on a metered connection has no
  way to find it, let alone turn it off. See §3 — the decision is still open,
  but the *toggle* is a gap regardless of which default wins.

## 4. Known gaps worth naming out loud

- **Nothing is code-signed.** Software Terms §10 already concedes it, and
  Microsoft's criteria have no category for what this app does, so signing is
  content-neutral — but SmartScreen reputation attaches to a certificate, so
  every build starts from zero. This is the single biggest install-friction
  item and it is a purchase, not a code change.
- **There is no devnet or testnet path anywhere in the repo.** Every live test
  of a signing path costs real mainnet SOL, ETH or BNB. It is why §2 above is
  the size it is.
- **Merkl and LI.FI are not real `ProviderId`s** (`HttpProviderId = ProviderId
  | 'merkl' | 'lifi' | 'lifi-status'`), so they never appear in the Providers
  panel and their budgets are invisible there (the bridge page states its own).
- **`PanelGrid` minimums, `pinned` and `layout`** are all per-machine
  localStorage. Nothing syncs, and that is by design — but it means a user who
  moves machines rebuilds their layout, and nobody has been told that.

## 4b. What was actually verified, 2026-09-11

Done on this machine, against the packaged 2.0.0 artifact
(`release/Krypto Bot-Setup-2.0.0.exe`, 117 MB):

- **Packaged.** `npm run build` then `npx electron-builder`, with the dev
  instance closed and nothing else writing to `dist-electron`. The afterPack
  hook reported `bytecode verified in app.asar — 6 .jsc file(s) present` and
  applied the fuses (RunAsNode/inspect/NODE_OPTIONS off, asar-only on).
- **Artifact checked** against the beta7 recipe: 9,860 asar entries, **zero**
  containing a forward slash, **zero** `.map` files, `undici` / `ws` /
  `bytenode` / `@solana/web3.js` / `viem` all present, and no hashed-chunk
  bloat in `dist-electron` (16 files, 0 hashed).
- **The bytecode is really the only copy.** Each `.js` beside a `.jsc` is a
  72–73 byte loader stub (`require('bytenode'); module.exports =
  require('./X.jsc')`); `main.js` is a 2 KB obfuscated entry and `preload.js`
  is obfuscated plaintext, as designed. No readable main-process source ships.
- **Smoke booted to a window**, not just to a banner — the thing the last
  attempt could not finish because the dev instance held the lock. It found
  the legacy profile (`cc.krypt.terminal`, wallet intact), brought all three
  Solana feed sockets live, auto-started the engine and both EVM scanners.
- **The corrupt-state test passed.** `order-templates.json` was deliberately
  truncated mid-object; the packaged app started, logged
  `… is not valid JSON (Expected ',' or '}' … position 46) — built-ins still
  work, and the file will not be overwritten`, stayed up, and left the damaged
  file byte-for-byte intact. This is the 09-09 blocker, and it is closed.
- **A real bug was found by doing this.** Pending launches were persisted only
  when the model changed — six hours away on a fresh model — so a restart
  inside that window still lost them. Fixed, tested, and confirmed on the
  repackaged artifact: 22 launches in flight on disk within 2.5 minutes.

Still NOT done, and still needing a human: the live money-path checks (§5
steps 9–11) and an install-over-existing-profile run from the installer rather
than from `win-unpacked`.

## 5. The pre-release checks, in order

**Build and artifact**

1. Close the running dev instance. It holds the single-instance lock, which is
   why the last smoke boot could not complete.
2. `npm run typecheck && npm test && npm run build` — expect 114 suites.
3. `npx electron-builder`. The afterPack hook now asserts that every built
   `.jsc` is present in `app.asar` (`scripts/apply-fuses.cjs`); a build that
   exits 0 has passed that check. **Nothing may write to `dist-electron` while
   the packager runs** — a concurrent `npm run build` is exactly what produced
   a bytecode-less 113 MiB installer on 09-09.
4. Verify the artifact against the recipe in `beta7-release`: fuses on, asar
   paths all backslash, no `*.map`, `undici`/`ws`/`bytenode` present,
   `dist-electron` free of hashed-chunk bloat.
5. **Smoke boot the packaged app** with the dev instance closed, to a window —
   not just to the main-process banner.

**Upgrade path** — the one that touches existing users' money

6. Install over an existing profile. Confirm the wallet, positions, ledger,
   orders and paper book all survive. `appId` is unchanged at
   `cc.krypt.terminal`; keep it that way, or wallets vanish.
7. Confirm the terms gate DOES re-prompt once: `TERMS_VERSION` is
   `2026-09-11.1` (the privacy policy now names li.quest, pump.fun, krypt.cc
   and the automatic update check; the Terms cover bridging and launching).
   Accept, restart, confirm it does not prompt again.
8. Corrupt a copy of `order-templates.json` on purpose and launch. It must
   start, name the file, and keep working — that is the 09-09 blocker, and it
   is the single most valuable five minutes on this list.

**Money path, smallest possible amounts**

9. Solana: one buy, one sell, on a live token. Check the fill reaches the
   ledger and the cost basis is the on-chain delta.
10. Robinhood and BNB: follow `docs/testing-evm.md`. Tier 0 and 1 cost nothing;
    tier 2 is one small round trip per chain on a curve token and one on a
    graduated token.
11. Arm and disarm each chain. Confirm arming one leaves the others in Paper.

**Housekeeping**

12. Write `release/RELEASE-NOTES-2.0.0.md` — the previous three are the format.
13. Tag `v2.0.0` and let CI build all three platforms.

---

## What 2.0.0 contains

Two new chains (Robinhood Chain 4663 and BNB Smart Chain 56) with their own
wallets (one signer per chain since 09-11), ledgers, arm state and
Observatories · a sandboxed user-scripting engine · the Hub and workspace
split, with per-chain wallet pages · My Layout, a user-arranged dashboard with
a user-chosen sidebar · the Rewards page · auto-sell templates · the Swap page
(Wallet Utilities; Jupiter on Solana, the chain's own venues on EVM) · the
Bridge page (Wallet Utilities; LI.FI; off by default; Solana→Robinhood via
Relay measured, Solana→BNB refused for hiding its destination in lookup
tables) · Launch a token (pump.fun `create_v2` and Pons) with creator-fee
claiming · the Wallet Scout · the update notice (krypt.cc/version.json, every
six hours, notice only) · the live Grimoire log · and the 09-09 and 09-11
audits, whose fixes are recorded in `docs/release-audit-2026-09-09.md` and
the three 09-11 audit memos.
