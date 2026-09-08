// Settings persistence — guidelines §5.8/§5.9: userData only, atomic
// writes, and ALWAYS merge loaded JSON over defaults (old saves lack new
// fields; never trust persisted JSON even though we wrote it).

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, SETTINGS_REVISION, type AppSettings } from '@shared/types';
import { logger } from './logger';

let cached: AppSettings | null = null;

/**
 * One-time safety migration for saves written before a default was corrected.
 *
 * mergeState() merges persisted values OVER defaults — correct for not losing
 * user choices, but it means a dangerous default that ships fixed never
 * reaches anyone who already has the old value on disk. Three flags were
 * default-ON and should not have been (2026-08-16 product swarm §8); each is
 * forced off exactly once, then the revision stamp stops it re-firing so the
 * user can turn any of them back on and have it stick.
 *
 * Returns true if anything changed (the caller persists).
 */
function migrateUnsafe(s: AppSettings, fromRevision: number): boolean {
  if (fromRevision >= SETTINGS_REVISION) return false;

  if (fromRevision < 2) {
    // Market-dumped EVERY SPL token in the wallet — not just this session's
    // positions — on the ordinary Stop button, at up to 15% slippage.
    s.execution.autoSellOnExit = false;
    // Decides which accounts a SIGNED instruction touches, with no golden
    // fixtures. Opt in from the Execution page once that coverage exists.
    s.execution.localTxBuild = false;
    // Outbound connection publishing engine state, against a "No telemetry"
    // promise in the README.
    s.discordRpcEnabled = false;
  }

  if (fromRevision < 3) {
    // The live breakers shipped ON (2 losses / 0.03 SOL) from the sniper
    // era and flipped a manual trader to Paper after two ordinary losing
    // trades (2026-08-29). Only the OLD DEFAULTS are turned off — a user who
    // chose their own numbers keeps them.
    if (s.execution.maxLiveConsecutiveLosses === 2) s.execution.maxLiveConsecutiveLosses = 0;
    if (s.execution.maxLiveSessionLossSol === 0.03) s.execution.maxLiveSessionLossSol = 0;
  }

  if (fromRevision < 4) {
    // Revision 2 turned the local builder OFF "until coverage exists". It
    // does now: the derived layout is pinned against real landed trades
    // (test/fixtures/pump-derived-layout.json) and every local build is
    // simulated before signing with the relayer as fallback. Local is the
    // fast path — one batched account read instead of a third-party HTTP
    // build (~400 ms measured) — and pays no relayer fee, so it is on for
    // everyone (2026-09-01, user's call).
    s.execution.localTxBuild = true;
  }

  if (fromRevision < 5) {
    // Runner alerts replace paper auto-entry (2026-09-02). A saved strategy
    // from before has neither field; fill both with the defaults.
    if (!s.strategy.runnerAlerts) s.strategy.runnerAlerts = { ...DEFAULT_SETTINGS.strategy.runnerAlerts };
    if (typeof s.strategy.paperEntries !== 'boolean') s.strategy.paperEntries = false;
  }

  s.settingsRevision = SETTINGS_REVISION;
  return true;
}

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function mergeState(loaded: Partial<AppSettings> | null): AppSettings {
  const d = DEFAULT_SETTINGS;
  if (!loaded || typeof loaded !== 'object') return structuredClone(d);
  // heliusHttpUrl is DERIVED by resolveRpc() and embeds the API key — if a
  // resolved rpc object ever reaches this boundary, drop it so the key is
  // stored once (its own field) and never duplicated into settings.json.
  const rpc = { ...d.rpc, ...(loaded.rpc ?? {}) };
  delete rpc.heliusHttpUrl;
  // The Helius feed socket is derived too (key + heliusFeedSocket, appended
  // by resolveRpc). A resolved copy that reached the store — every RPC save
  // until 2026-09-08 — is dropped here, and duplicates with it.
  rpc.extraWssUrls = [
    ...new Set((rpc.extraWssUrls ?? []).filter((u) => typeof u === 'string' && !/helius-rpc\.com/i.test(u) && !/api-key=/i.test(u))),
  ];
  // `autoLive` (autonomous real trading) was removed 2026-08-16. Drop it from
  // old saves so it never round-trips back into settings.json.
  const execution = { ...d.execution, ...(loaded.execution ?? {}) } as AppSettings['execution'] & { autoLive?: boolean };
  delete execution.autoLive;
  // `data.providers` is itself a map, so a plain one-level spread would let
  // a save written before a provider existed drop that provider's default.
  const data = {
    ...d.data,
    ...(loaded.data ?? {}),
    providers: { ...d.data.providers, ...(loaded.data?.providers ?? {}) },
  };
  // Hotkey bindings are a LIST, so a plain merge would keep a stale saved
  // array forever. Saved bindings win where the id still exists; new default
  // bindings are appended so a future release can add one.
  const savedBindings = loaded.hotkeys?.bindings ?? [];
  const hotkeys = {
    ...d.hotkeys,
    ...(loaded.hotkeys ?? {}),
    bindings: d.hotkeys.bindings.map((def) => savedBindings.find((b) => b.id === def.id) ?? def),
  };
  return {
    settingsRevision: loaded.settingsRevision ?? 0,
    alerts: { ...d.alerts, ...(loaded.alerts ?? {}) },
    hotkeys,
    // Merged per bot so a saved token and owner survive, while a newly added
    // field picks up its default rather than reading as undefined.
    bots: {
      telegram: { ...d.bots.telegram, ...(loaded.bots?.telegram ?? {}) },
      discord: { ...d.bots.discord, ...(loaded.bots?.discord ?? {}) },
      // A save written before chat trading existed gets the safe default
      // (everything off) rather than undefined.
      trading: { ...d.bots.trading, ...(loaded.bots?.trading ?? {}) },
    },
    rpc,
    strategy: {
      ...d.strategy,
      ...(loaded.strategy ?? {}),
      runnerAlerts: { ...d.strategy.runnerAlerts, ...(loaded.strategy?.runnerAlerts ?? {}) },
    },
    execution,
    data,
    ai: { ...d.ai, ...(loaded.ai ?? {}) },
    referrer: typeof loaded.referrer === 'string' ? loaded.referrer : d.referrer,
    onboarded: loaded.onboarded ?? d.onboarded,
    watchOnBuy: loaded.watchOnBuy ?? d.watchOnBuy,
    recorderEnabled: loaded.recorderEnabled ?? d.recorderEnabled,
    reduceEffects: loaded.reduceEffects ?? d.reduceEffects,
    hardwareAcceleration: loaded.hardwareAcceleration ?? d.hardwareAcceleration,
    recorderDir: loaded.recorderDir ?? d.recorderDir,
    recorderMaxGb: typeof loaded.recorderMaxGb === 'number' ? loaded.recorderMaxGb : d.recorderMaxGb,
    recordFirehose: loaded.recordFirehose ?? d.recordFirehose,
    shadowDipBuy: loaded.shadowDipBuy ?? d.shadowDipBuy,
    shadowStratLab: loaded.shadowStratLab ?? d.shadowStratLab,
    shadowMigration: loaded.shadowMigration ?? d.shadowMigration,
    discordRpcEnabled: loaded.discordRpcEnabled ?? d.discordRpcEnabled,
    autoStartEngine: loaded.autoStartEngine ?? d.autoStartEngine,
    shadowMode: true, // v1 invariant — not user-flippable
  };
}

/**
 * Set when settings.json exists but could not be read or parsed. Falling
 * back to defaults and writing them out would silently discard the user's
 * RPC keys, limits and preferences, so while this is set the store serves
 * defaults for THIS session and refuses to persist over the file.
 */
let loadFailure: string | null = null;

/** Why settings are not being saved right now, or null when healthy. */
export function failure(): string | null {
  return loadFailure;
}

export function load(): AppSettings {
  if (cached) return cached;
  let migrated = false;
  let text: string | null = null;
  try {
    text = fs.readFileSync(file(), 'utf8');
    loadFailure = null;
  } catch (e) {
    // Absent is a normal first run; anything else is a read failure.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      loadFailure = `${file()} could not be read (${(e as Error).message}) — your saved settings are still in it, so this session runs on defaults without overwriting them`;
      logger.error(`settings: ${loadFailure}`);
    }
  }
  if (text !== null) {
    try {
      const raw = JSON.parse(text) as Partial<AppSettings>;
      const merged = mergeState(raw);
      migrated = migrateUnsafe(merged, merged.settingsRevision);
      cached = merged;
    } catch (e) {
      loadFailure = `${file()} is corrupt (${(e as Error).message}) — this session runs on defaults and will not overwrite it`;
      logger.error(`settings: ${loadFailure}`);
    }
  }
  if (!cached) {
    cached = mergeState(null);
    cached.settingsRevision = SETTINGS_REVISION;
  }
  // Persist the migration immediately: a crash before the next update() would
  // otherwise re-apply it and silently undo a deliberate re-enable.
  if (migrated) persist(cached);
  return cached;
}

function persist(s: AppSettings): void {
  // A file we could not read is a file we must not overwrite.
  if (loadFailure) {
    logger.warn(`settings: not saving — ${loadFailure}`);
    return;
  }
  try {
    const f = file();
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  } catch {
    /* best-effort persistence; memory state is authoritative this session */
  }
}

export function update(patch: Partial<AppSettings>): AppSettings {
  const cur = load();
  const next: AppSettings = mergeState({
    ...cur,
    ...patch,
    rpc: { ...cur.rpc, ...(patch.rpc ?? {}) },
    strategy: { ...cur.strategy, ...(patch.strategy ?? {}) },
    execution: { ...cur.execution, ...(patch.execution ?? {}) },
    data: {
      ...cur.data,
      ...(patch.data ?? {}),
      providers: { ...cur.data.providers, ...(patch.data?.providers ?? {}) },
    },
    alerts: { ...cur.alerts, ...(patch.alerts ?? {}) },
    hotkeys: {
      ...cur.hotkeys,
      ...(patch.hotkeys ?? {}),
      // A bindings patch REPLACES the list — the editor always sends the
      // whole set, and merging by index would corrupt a reorder.
      bindings: patch.hotkeys?.bindings ?? cur.hotkeys.bindings,
    },
  });
  cached = next;
  persist(next);
  return next;
}
