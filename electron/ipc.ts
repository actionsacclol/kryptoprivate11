// ALL ipcMain.handle() channels live in this ONE file (guidelines §4.3) —
// the greppable contract between main and renderer. Handlers never throw
// across IPC; they return { ok, message, data? }.

import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } from 'electron';
import { probeRoundTrip } from './engine/farmProbe';
import { postFlag } from './system/discordWebhook';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveRpc, type AppSettings, type EngineEvent, type IpcResult } from '@shared/types';
import * as rpcProbe from './engine/rpcProbe';
import * as kryptoHolding from './engine/kryptoHolding';
import * as evmTrade from './evm/trade';
import { KRYPTO_FEE_WAIVER_TOKENS } from '@shared/krypto';
import * as store from './system/settings-store';
import { validateSettingsPatch } from './system/settingsValidation';
import type { AiAnalysis } from '@shared/ai';
import * as wallet from './system/wallet';
import * as fund from './engine/fund';
import * as lab from '@shared/lab';
import { getBalance } from './chain/rpcClient';
import * as bots from './system/bots';
import * as heliusBudget from './system/heliusBudget';
import * as integrityGuard from './system/integrityGuard';
import * as evmRail from './evm/rail';
import * as evmScanner from './evm/scanner';
import * as walletScout from './engine/walletScout';
import * as scoutScan from './engine/scoutScan';
import { sourceFor as scoutSourceFor } from './engine/scoutScanSources';
import * as evmWallet from './evm/evmWallet';
import { SCOUT_CHAINS, SCOUT_SCAN_HOURS, rankScout, summarise, type ScoutChain, type ScoutScanHours, type ScoutSort, type ScoutWindow } from '@shared/walletScout';
import * as evmDiscover from './evm/discover';
import * as merkl from './data/providers/merkl';
import * as callouts from './data/providers/pumpCallouts';
import * as dexMeta from './data/providers/dexscreenerMeta';
import { clearRpcRejection } from './evm/client';
import { EVM_CHAINS, EVM_CHAIN_META, isEvmAddress, isEvmChain, type EvmChainKind, type ChainKind } from '@shared/evm';
import * as launcher from './engine/launcher';
import type { LaunchDeps } from './engine/launcher';
import { MAX_DESCRIPTION, MAX_NAME, MAX_SYMBOL, type LaunchDraft } from '@shared/launch';
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, uploadLaunchMetadata, type MetadataFields } from './system/launchMeta';
import * as updateCheck from './system/updateCheck';
import * as pumpFees from './engine/pumpFees';
import * as swap from './engine/swap';
import * as bridge from './engine/bridge';
import type { BridgeDraft } from '@shared/bridge';
import type { SwapDraft } from '@shared/swap';

/** Chat replies are plain text; a named constant keeps the join sites tidy. */
const NL = String.fromCharCode(10);

/** Last rendered portfolio views for the chat bots. Refreshed on demand and
 *  on a slow timer; never blocks a reply. */
const botCache = { positions: 'No portfolio data yet.', pnl: 'No portfolio data yet.', at: 0 };

async function refreshBotCache(engine: SniperEngine): Promise<void> {
  if (Date.now() - botCache.at < 10_000) return;
  botCache.at = Date.now();
  try {
    const p = await engine.portfolioSummary();
    const open = p.positions.filter((x) => x.amount > 0);
    botCache.positions = open.length
      ? open
          .slice(0, 15)
          .map((x) => {
            const pnl = x.unrealizedPnlPct === null ? '—' : `${x.unrealizedPnlPct >= 0 ? '+' : ''}${x.unrealizedPnlPct.toFixed(1)}%`;
            const val = x.valueSol === null ? '—' : `${x.valueSol.toFixed(3)} SOL`;
            return `${x.symbol || x.mint.slice(0, 8)}  ${val}  ${pnl}`;
          })
          .join(NL)
      : 'No open positions.';
    // Unknowns stay em dashes here exactly as they do in the UI — a chat
    // reply is not a place to start inventing zeros.
    botCache.pnl = [
      `Wallet: ${p.solBalance === null ? '—' : `${p.solBalance.toFixed(4)} SOL`}`,
      `Positions value: ${p.positionsValueUsd === null ? '—' : `$${Math.round(p.positionsValueUsd)}`}`,
      `Unrealised: ${p.unrealizedPnlSol === null ? '—' : `${p.unrealizedPnlSol.toFixed(3)} SOL`}`,
      `Realised: ${p.realizedPnlSol === null ? '—' : `${p.realizedPnlSol.toFixed(3)} SOL`}`,
    ].join(NL);
  } catch {
    /* keep the previous text rather than replacing it with an error */
  }
}
import { logger } from './system/logger';
import * as crashGuard from './system/crashGuard';
import { SniperEngine } from './engine/engine';
import * as recorder from './engine/recorder';
import * as gifs from './data/gifs';
import * as templateStore from './system/templateStore';
import { describeOrder } from '@shared/orders';
import * as acceptance from './system/acceptance';
import { TERMS_VERSION, PRODUCT_NAME } from '@shared/legal/entity';
import { ALL_DOCUMENTS, documentText } from '@shared/legal/documents';
import * as creators from './engine/creators';
import { summarize, backtestDataset } from './engine/history';
import * as watchlist from './engine/watchlist';
import * as market from './data/market';
import { clearCache } from './data/http';
import { clearImageCache, setEnabled as setImagesEnabled } from './data/images';
import {
  CANDLE_INTERVALS,
  DISCOVER_COLUMNS,
  STATS_WINDOWS,
  type CandleInterval,
  type DiscoverColumn,
  type StatsWindow, imageSrc } from '@shared/market';
import { TRIGGER_BASES, validateOrder, type NewOrderRequest, type TriggerBasis } from '@shared/orders';
import { validateAlert, type NewAlertRequest } from '@shared/alerts';
import { toCsv } from '@shared/portfolio';
import { validateConfig, type CopyConfig } from '@shared/copytrade';
import * as automation from './engine/automation';
import { MAX_ACTIONS, MAX_CONDITIONS, type RuleAction, type RuleCondition, type RuleSet } from '@shared/automation';

let engine: SniperEngine | null = null;

export function getEngine(): SniperEngine {
  if (!engine) {
    engine = new SniperEngine(
      // The engine sees RESOLVED rpc settings (Helius key expanded into feed
      // socket + http endpoint); the store keeps the raw single-field form.
      () => {
        const s = store.load();
        return { ...s, rpc: resolveRpc(s.rpc) };
      },
      (ev) => {
        broadcast(ev);
        // A fill, real or paper, dates the kept portfolio build.
        if ((ev.kind === 'fill' && ev.state !== 'failed') || ev.kind === 'paper') engine?.markPortfolioDirty();
        // User scripts see the same events the UI does, after it.
        automation.onEngineEvent(ev);
      },
    );
  }
  return engine;
}

/**
 * Push an event to every real window. Extracted from `broadcast` so the log
 * feed can reach the renderer without going back through it — see below.
 */
function sendToWindows(ev: EngineEvent): void {
  // Broadcast to every window (guidelines §6) — never a hardcoded recipient.
  //
  // `win.isDestroyed()` is NOT sufficient: when the render process dies the
  // BrowserWindow object survives while its frame is gone, and every send
  // then throws "Render frame was disposed before WebFrameMain could be
  // accessed". The engine emits on every trade, so one renderer crash turned
  // into an unbounded error storm out of the feed hot path. Check the
  // webContents too, and treat a send failure as non-fatal — the engine must
  // never be taken down by a dead UI.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) continue;
    // Script sandboxes are hidden BrowserWindows too (system/scriptSandbox.ts,
    // partition 'script-sandbox'), so "every window" was also every sandbox.
    // The automation event carries snapshot(), which spreads each script
    // including its full `code` — ten 40 KB scripts measured at 418,011 bytes,
    // structured-cloned into a renderer that is deliberately hostile
    // territory, on every script log line. Not a disclosure (the sandbox
    // preload exposes only its own channel, and contextIsolation keeps
    // ipcRenderer out of the page realm) but pure waste, and defence in depth
    // besides. Sandboxes are told apart by their session: the main window
    // declares no `partition`, so it is the only window on the default one.
    if (wc.session !== session.defaultSession) continue;
    try {
      wc.send('engine:event', ev);
    } catch {
      /* frame disposed between the check and the send — drop this event */
    }
  }
}

/**
 * Everything the app says, in one place.
 *
 * Until 2026-09-11 this was one-directional and half the app was missing from
 * the Grimoire. `broadcast({kind:'log'})` sent a line to the renderer AND
 * wrote it to the logger — but a direct `logger.info(...)` call, which is what
 * every module outside the engine and the EVM scanner uses, only reached the
 * file and the in-memory buffer. The Console page loads that buffer on mount,
 * so those lines appeared if you OPENED the page and never if you were
 * already watching it. A user sitting on the live log while a launch, a swap,
 * a fee claim or a bridge failed saw nothing at all.
 *
 * So there is now one path. `logger.*` is the only way a line is produced, and
 * this subscription is the only thing that puts one on screen. `broadcast`
 * hands log events to the logger instead of sending them itself, which is why
 * this cannot recurse: the subscriber calls `sendToWindows`, never `broadcast`.
 *
 * Redaction is already done — `push()` in logger.ts redacts BEFORE the feed
 * precisely so that every listener, including this one, is safe.
 */
logger.subscribe((l) => sendToWindows({ kind: 'log', level: l.level, line: l.line, at: l.at }));

function broadcast(ev: EngineEvent): void {
  // A log event goes to the logger, and the subscription above puts it on
  // screen. Sending it here as well would show it twice.
  if (ev.kind === 'log') {
    logger[ev.level](ev.line);
    return;
  }
  sendToWindows(ev);
}

const ok = <T>(message: string, data?: T): IpcResult<T> => ({ ok: true, message, data });
const fail = (message: string): IpcResult<never> => ({ ok: false, message });

/**
 * A Solana address, exactly. `length < 32` alone let a 10,000-character
 * non-base58 string through several handlers — accepted, persisted, and in
 * one case handed to the wallet watcher to subscribe on. Same expression as
 * `copy:resetStats`, data/market.ts and engine/automation.ts.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isAddress = (v: unknown): v is string => typeof v === 'string' && BASE58_ADDRESS.test(v);

/** The Solana endpoint a bridge reads and sends on — the same one trades use. */
export function bridgeDeps(): bridge.BridgeDeps {
  const s = store.load();
  return { httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl };
}

/**
 * Window control, injected by main.
 *
 * main.ts already imports this file (`registerIpc`, `bridgeDeps`), so
 * importing back would be a cycle. The rest of the file takes its
 * main-process capabilities the same way — see `bridgeDeps`.
 */
export interface WindowHost {
  openPanel(panelId: string): { ok: boolean; message: string };
  closePanel(win: BrowserWindow | null): boolean;
  focusMain(): BrowserWindow | null;
}
let windows: WindowHost | null = null;
export function setWindowHost(h: WindowHost): void {
  windows = h;
}

export function registerIpc(): void {
  // Construct the engine eagerly. It is otherwise built on first use, and
  // the terminal's data layer gets its context from the engine constructor —
  // a Discover call before the engine existed would throw "context not
  // attached" on a cold start with the engine stopped.
  getEngine();
  // The Robinhood Chain rail beside it: its own wallet file, ledger and arm
  // state, sharing only the settings and the event stream.
  evmRail.init({ userData: app.getPath('userData'), getSettings: () => store.load(), emit: broadcast });
  // One Observatory per EVM chain. They are started by the user, not on boot:
  // a scanner polls RPC, and a chain nobody is looking at should not.
  /**
   * Keep the Wallet Scout's idea of "your wallets" current.
   *
   * Called at boot and after anything that can add or remove one. The Scout
   * ranks wallets by round trips, and this install makes round trips on the
   * user's OWN wallets — so without this, the user's own activity comes back
   * to them as if it were somebody else's measured record.
   */
  const refreshScoutOwnership = (): void => {
    try {
      walletScout.setOwnAddresses('solana', wallet.list().map((w) => w.publicKey));
    } catch {
      /* no wallet file yet — nothing to exclude */
    }
    for (const c of EVM_CHAINS) {
      try {
        walletScout.setOwnAddresses(c, evmWallet.list(c).map((w) => w.address));
      } catch {
        /* same */
      }
    }
  };
  refreshScoutOwnership();

  evmScanner.attach({
    enabled: (chain) => store.load().evm[chain].enabled,
    emit: (chain) => broadcast({ kind: 'evmScan', status: evmScanner.status(chain) }),
    log: (level, line) => broadcast({ kind: 'log', level, line, at: Date.now() }),
    // Read fresh on every call, so changing the floor in Settings takes
    // effect on the next launch rather than the next restart.
    runnerAlerts: (chain) => store.load().evm[chain].runnerAlerts,
    // Through the engine, so the desktop-notification switch and the chat
    // push mean the same thing here as they do for a Solana runner.
    notify: (title, body, target) => getEngine().pushNotification(title, body, target),
    // User scripts on THIS chain see the launch (Automation → Scripts). The
    // Solana feed reaches automation from `onEngineEvent`; the EVM rails have
    // no equivalent event, so the scanner hands them over directly.
    onLaunchWindow: (chain, launch) => automation.onEvmLaunch(chain, launch),
  });
  // Recorder mode follows the firehose switch: off = launch tape (creates,
  // first 30 min of trades per mint, completions, health), on = everything.
  recorder.setMode(store.load().recordFirehose ? 'firehose' : 'launch');

  // ── app ──────────────────────────────────────────────────────────
  // ── Popped-out panels ────────────────────────────────────────────
  //
  // The renderer names a panel; main decides whether that is a panel and owns
  // the window. `close` and `openToken` act on the CALLING window, taken from
  // the event — never on a window id the renderer passes, which is the same
  // rule the rest of this file follows for addresses and wallets.
  ipcMain.handle('panel:popout', (_e, panelId: unknown) => {
    if (typeof panelId !== 'string') return fail('Unknown panel');
    if (!windows) return fail('Windows are not ready yet');
    const r = windows.openPanel(panelId);
    return r.ok ? ok(r.message) : fail(r.message);
  });

  ipcMain.handle('panel:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return windows?.closePanel(win) ? ok('Closed') : fail('Not a panel window');
  });

  // A coin opened from a popped-out panel belongs in the MAIN window: that is
  // where the token page lives, and the panel keeps showing its panel.
  ipcMain.handle('panel:openToken', (_e, mint: unknown, chain: unknown) => {
    if (typeof mint !== 'string' || !mint) return fail('No token');
    const c = chainOf(chain) ?? 'solana';
    windows?.focusMain();
    try {
      getEngine().requestOpenToken(mint, c);
    } catch {
      return fail('Could not open that token');
    }
    return ok('ok');
  });

  ipcMain.handle('app:version', () => ok('ok', app.getVersion()));

  // Is there a newer build? `status` is free and answers from memory;
  // `check` may leave the machine, and is rate-limited inside the module.
  // Neither downloads or installs anything — see shared/version.ts.
  ipcMain.handle('app:updateStatus', () => ok('ok', updateCheck.status()));
  ipcMain.handle('app:checkForUpdate', async () => {
    try {
      return ok('ok', await updateCheck.check(true));
    } catch (err) {
      // The module is written not to throw; if it ever does, the UI still
      // gets a state rather than a rejected invoke.
      return fail(`Could not check for updates: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return fail('Only https:// links can be opened');
    }
    void shell.openExternal(url);
    return ok('opened');
  });

  ipcMain.handle('app:openRecordingsFolder', () => {
    const dir = recorder.recordingsDir();
    if (!dir) return fail('Recorder not initialized');
    void shell.openPath(dir);
    return ok('opened');
  });

  ipcMain.handle('app:openLogs', () => {
    const dir = logger.logsDir();
    if (!dir) return fail('File logging is not active');
    void shell.openPath(dir);
    return ok('opened');
  });

  // Whether this build has stopped opening positions because its runtime
  // self-checks failed. Always {seized:false} on a genuine build.
  ipcMain.handle('app:integrity', () =>
    ok('ok', { seized: integrityGuard.seized(), message: integrityGuard.seizeMessage() }),
  );

  ipcMain.handle('app:logPaths', () =>
    ok('ok', { logs: logger.logsDir(), crashes: crashGuard.crashDir() }),
  );

  // ── settings ─────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => ok('ok', store.load()));

  ipcMain.handle('settings:update', (_e, patch: unknown) => {
    // `Partial<AppSettings>` is a compile-time claim only — at runtime the
    // renderer can send anything. Validate main-side before it reaches the
    // store (see settingsValidation.ts for why this matters).
    const v = validateSettingsPatch(patch);
    if (!v.ok || !v.patch) {
      logger.warn(`settings:update rejected — ${v.message}`);
      return fail(v.message);
    }
    try {
      const before = store.load();
      // The trading mode is stripped from every patch (settingsValidation.ts).
      // Usually it was just carried along by a spread and matches what is
      // already stored — nothing to say. A patch asking for a DIFFERENT mode
      // is the interesting case: it means something tried to change the mode
      // without arming the engine, so it is logged even though it was ignored.
      if (v.stripped?.length) {
        const asked = (patch as { execution?: { liveEnabled?: unknown } } | null)?.execution?.liveEnabled;
        if (typeof asked === 'boolean' && asked !== before.execution.liveEnabled) {
          logger.warn(`settings:update tried to set execution.liveEnabled=${asked} — ignored, the Paper/Live switch owns it`);
        }
      }
      const next = store.update(v.patch);
      recorder.setEnabled(next.recorderEnabled);
      recorder.setMode(next.recordFirehose ? 'firehose' : 'launch');
      // The credit ceiling is read by the running guard, not re-read from
      // settings — without this, editing it in Settings changed the file and
      // nothing else until the next restart.
      if (next.rpc.heliusMonthlyCredits !== before.rpc.heliusMonthlyCredits) {
        heliusBudget.setLimit(next.rpc.heliusMonthlyCredits ?? 0);
      }
      // A new key deserves a fresh try: without this, an endpoint rejected
      // once would keep being skipped for fifteen minutes after the user
      // pasted the corrected key.
      if (next.rpc.heliusApiKey !== before.rpc.heliusApiKey || next.rpc.httpUrl !== before.rpc.httpUrl) {
        void import('./chain/rpcClient').then((m) => m.clearRpcRejections());
      }
      // Same for the EVM chains: a corrected Alchemy key or RPC URL gets a
      // fresh try, and a chain switched on at runtime warms its launch
      // index now instead of paying the first scan on the first Discover paint.
      for (const c of EVM_CHAINS) {
        const was = before.evm[c];
        const now = next.evm[c];
        if (now.apiKey !== was.apiKey || now.rpcUrl !== was.rpcUrl) clearRpcRejection(c);
        if (now.enabled && !was.enabled) evmDiscover.prewarm(c);
        // Off means off: a chain hidden from the app used to stay ARMED
        // (trades were refused by `enabled()`, but re-enabling returned it
        // live without a hand on the switch) and its scanner kept polling
        // the RPC for a page nobody could open. Found by audit 2026-09-11;
        // 'chain_disabled' had been declared as a reason with no producer.
        if (was.enabled && !now.enabled) {
          evmRail.disarm(c, 'chain_disabled');
          evmScanner.stop(c);
        }
      }
      // The fee split reads this on every trade; applying it here means the
      // engine's six trade call sites never have to remember to pass it.
      void import('./engine/liveSigner').then((m) => m.setReferrer(next.referrer));
      // Turning market data (or images specifically) off must stop the image
      // handler immediately, not at the next restart.
      setImagesEnabled(next.data.networkDataEnabled && next.data.loadTokenImages);
      // Re-point the recorder if the store directory changed.
      if (next.recorderDir !== before.recorderDir) {
        const d = recorder.init(app.getPath('userData'), next.recorderEnabled, next.recorderDir);
        recorder.setMaxBytes((next.recorderMaxGb ?? 0) * 1e9);
        recorder.prune();
        logger.info(`recordings dir changed to: ${d}`);
      }
      return ok('Settings saved', next);
    } catch (err) {
      return fail(`Failed to save settings: ${(err as Error).message}`);
    }
  });

  // ── engine ───────────────────────────────────────────────────────
  ipcMain.handle('engine:start', () => {
    try {
      const r = getEngine().start();
      return r.ok ? ok(r.message) : fail(r.message);
    } catch (err) {
      return fail(`Engine failed to start: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('engine:stop', () => {
    try {
      const r = getEngine().stop();
      return r.ok ? ok(r.message) : fail(r.message);
    } catch (err) {
      return fail(`Engine failed to stop: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('engine:kill', () => {
    const r = getEngine().killSwitch();
    // The kill switch is the "stop everything" button: it must also take
    // every EVM chain back to Paper, or the reply "live execution disarmed"
    // would be false for a user who is live on Robinhood or BNB.
    const evmDisarmed = EVM_CHAINS.filter((c) => evmRail.armed(c));
    for (const c of evmDisarmed) evmRail.disarm(c, 'kill_switch');
    // ...and stop the per-chain scanners. "Stop everything" that leaves two
    // pollers running is a button that lied, even though a scanner spends
    // nothing — someone reaching for the kill switch wants it all to stop.
    evmScanner.stopAll();
    const message = evmDisarmed.length ? `${r.message} ${evmDisarmed.map((c) => EVM_CHAIN_META[c].shortName).join('/')} disarmed too.` : r.message;
    return r.ok ? ok(message) : fail(message);
  });

  // The engine's copy of the settings is the RESOLVED form (Helius key
  // expanded into the feed socket + http endpoint). The renderer must see
  // the RAW store: it spreads `rpc` back on every RPC save, and until
  // 2026-09-08 that wrote the key-bearing feed socket into extraWssUrls —
  // one more copy per save, a socket that outlived its switch, and after
  // 31 saves every RPC save rejected by the 32-entry cap.
  ipcMain.handle('engine:snapshot', () => ok('ok', { ...getEngine().snapshot(), settings: store.load() }));

  ipcMain.handle('engine:execution', () => ok('ok', getEngine().executionSnapshot()));

  // ── blocklist import (research action #9) ───────────────────────
  ipcMain.handle('creators:importBlocklist', (_e, addresses: string[]) => {
    if (!Array.isArray(addresses)) return fail('Expected an array of addresses');
    const added = creators.seedBlacklist(addresses);
    return ok(`Imported ${added} new address${added === 1 ? '' : 'es'} (${creators.blacklistSize()} total)`, { added, total: creators.blacklistSize() });
  });

  // ── creators ─────────────────────────────────────────────────────
  ipcMain.handle('creators:blacklist', (_e, creator: string) => {
    if (typeof creator !== 'string' || creator.length < 32) return fail('Invalid creator address');
    creators.addToBlacklist(creator);
    return ok(`Blacklisted ${creator.slice(0, 6)}…`);
  });

  // ── recorder ─────────────────────────────────────────────────────
  ipcMain.handle('recorder:stats', () => ok('ok', recorder.stats()));

  // ── smart-wallet watchlist ───────────────────────────────────────
  ipcMain.handle('watchlist:get', () => ok('ok', watchlist.all()));
  ipcMain.handle('watchlist:add', (_e, address: string, label: string) => {
    const r = watchlist.add(String(address), String(label ?? ''));
    return r.ok ? ok(r.message, watchlist.all()) : fail(r.message);
  });
  ipcMain.handle('watchlist:remove', (_e, address: string) => {
    const r = watchlist.remove(String(address));
    return ok(r.message, watchlist.all());
  });

  // ── backtest dataset ─────────────────────────────────────────────
  ipcMain.handle('backtest:dataset', async () => {
    try {
      const dir = recorder.recordingsDir();
      if (!dir) return fail('Recorder not initialized');
      return ok('ok', await backtestDataset(dir));
    } catch (err) {
      return fail(`Failed to build dataset: ${(err as Error).message}`);
    }
  });

  // ── wallet (dedicated hot wallet, encrypted via OS keystore) ─────
  ipcMain.handle('wallet:info', () => ok('ok', wallet.info()));

  ipcMain.handle('wallet:list', () => ok('ok', wallet.list()));

  ipcMain.handle('wallet:generate', (_e, label: unknown) => {
    const r = wallet.generate(typeof label === 'string' ? label : '');
    if (r.ok) { syncLiveMode(); refreshScoutOwnership(); }
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  ipcMain.handle('wallet:import', (_e, secret: string, label: unknown) => {
    if (typeof secret !== 'string') return fail('Invalid key');
    const r = wallet.importSecret(secret, typeof label === 'string' ? label : '');
    if (r.ok) { syncLiveMode(); refreshScoutOwnership(); }
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  /**
   * Switch which wallet signs.
   *
   * REFUSED WHILE ARMED. The engine caches the owner it is trading for, an
   * order may already be mid-flight, and a signer that changes identity
   * underneath a broadcast is how a fill lands from a wallet the user was not
   * looking at. Disarming first is one click and makes the change deliberate.
   */
  ipcMain.handle('wallet:select', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid wallet id');
    if (getEngine().liveState().armed) {
      return fail('Disarm live execution before switching wallets.');
    }
    const r = wallet.select(id);
    if (r.ok) logger.warn(`wallet:select — active wallet is now ${wallet.publicKey() ?? 'none'}`);
    if (r.ok) syncLiveMode();
    if (r.ok) {
      // Nothing kept for the old signer may show for the new one.
      getEngine().clearWalletCaches();
      broadcast({ kind: 'walletSwitched', publicKey: wallet.publicKey() ?? null });
    }
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  ipcMain.handle('wallet:rename', (_e, id: unknown, label: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid wallet id');
    if (typeof label !== 'string') return fail('Invalid label');
    const r = wallet.rename(id, label);
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  ipcMain.handle('wallet:setHome', async (_e, addr: string) => {
    // The withdrawal address is the ONE destination the signer will send the
    // full balance to. Changing it must require a human, not just a renderer
    // message — that link is what turned an unvalidated settings patch into a
    // drain. A native dialog cannot be actuated by page content.
    const next = String(addr).trim();
    const current = wallet.info().homeAddress;
    if (next === current) return ok('Withdrawal address unchanged', wallet.info());

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Change withdrawal address'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Confirm withdrawal address',
      message: 'Change the address this wallet withdraws to?',
      detail:
        `${current ? `Current:\n${current}\n\n` : 'No withdrawal address is currently set.\n\n'}` +
        `New:\n${next}\n\n` +
        'This is the only address profit sweeps can be sent to. If you did not just ' +
        'request this change in Krypto Bot, press Cancel — something else is trying ' +
        'to redirect your funds.',
    });
    if (response !== 1) {
      logger.warn('wallet:setHome cancelled at the confirmation dialog');
      return fail('Withdrawal address change cancelled');
    }

    const r = wallet.setHomeAddress(next);
    if (r.ok) logger.warn(`wallet:setHome confirmed — withdrawal address is now ${next}`);
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  /**
   * Withdraw SOL to a wallet's confirmed withdrawal address. SOL only — the
   * signer's sweep policy allows exactly one SystemProgram transfer to the
   * stored home address, so this cannot be pointed anywhere else. Serialised
   * behind in-flight live trades inside engine.withdraw (never races a buy).
   */
  ipcMain.handle('wallet:withdraw', async (_e, args: unknown) => {
    const a = (args && typeof args === 'object' ? args : {}) as { walletId?: unknown; lamports?: unknown };
    const walletId = typeof a.walletId === 'string' && a.walletId ? a.walletId : undefined;
    let lamports: number | 'max';
    if (a.lamports === 'max') lamports = 'max';
    else if (typeof a.lamports === 'number' && Number.isFinite(a.lamports) && a.lamports > 0) lamports = Math.floor(a.lamports);
    else return fail('Amount must be a positive number of lamports');

    const owner = walletId ? wallet.publicKeyOf(walletId) : wallet.publicKey();
    if (!owner) return fail(walletId ? 'No such wallet' : 'No trading wallet');
    const home = wallet.list().find((w) => w.publicKey === owner)?.homeAddress ?? null;
    if (!home) return fail('Set a withdrawal address first');
    if (lamports !== 'max') {
      const bal = await getBalance(resolveRpc(store.load().rpc).httpUrl, owner);
      if (!bal.ok || bal.data === undefined) return fail(`Balance unknown: ${bal.message}`);
      if (lamports > bal.data) return fail(`Amount exceeds the wallet balance (${(bal.data / 1e9).toFixed(4)} SOL)`);
    }

    logger.warn(`wallet:withdraw requested — ${lamports === 'max' ? 'max' : `${(lamports / 1e9).toFixed(4)} SOL`} from ${owner.slice(0, 8)}… to ${home}`);
    try {
      const r = await getEngine().withdraw({ walletId, lamports });
      if (r.ok) logger.warn(`wallet:withdraw sent ${(r.lamports / 1e9).toFixed(4)} SOL to ${r.dest} sig=${r.signature ?? 'none'}`);
      else logger.warn(`wallet:withdraw failed — ${r.message}${r.signature ? ` sig=${r.signature}` : ''}`);
      return r.ok ? ok(r.message, r) : { ok: false, message: r.message, data: r };
    } catch (err) {
      return fail(`Withdraw error: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('wallet:setMaxBalance', (_e, sol: number) => {
    const r = wallet.setMaxBalance(Number(sol));
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  ipcMain.handle('wallet:refreshBalance', async () => {
    const r = await wallet.refreshBalance(resolveRpc(store.load().rpc).httpUrl);
    return r.ok ? ok('ok', wallet.info()) : fail(r.message);
  });

  ipcMain.handle('wallet:backup', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      title: 'Back up trading wallet keypair',
      defaultPath: 'krypt-sniper-wallet.json',
      filters: [{ name: 'Solana keypair', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return fail('Backup cancelled');
    const r = wallet.backupToFile(res.filePath);
    return r.ok ? ok(r.message) : fail(r.message);
  });

  ipcMain.handle('wallet:export', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export all wallets (private keys, plaintext)',
      defaultPath: 'krypt-wallets-PRIVATE.txt',
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return fail('Export cancelled');
    const r = wallet.exportAllToFile(res.filePath);
    return r.ok ? ok(r.message, { count: r.count }) : fail(r.message);
  });

  ipcMain.handle('wallet:holdings', async () => {
    // The panels open on the last read; a fresh one follows as a 'holdings'
    // event when anything changed. Only this handler answers from the
    // snapshot — sell-all, recovery, scripts and the portfolio build call
    // engine.holdings() and wait for the chain.
    const fast = getEngine().holdingsCached();
    if (fast && !fast.stale) return ok('ok', fast.data);
    // Stale (or none): wait for the chain read — the page already painted
    // its seed, and a failed refresh must surface as the error it is.
    const r = await getEngine().holdings();
    return r.ok ? ok('ok', r.data) : fail(r.message);
  });

  ipcMain.handle('wallet:remove', (_e, id: unknown) => {
    // Disarm FIRST and unconditionally. Removing any wallet can promote a
    // different one to active, and staying armed across that change is the
    // same hazard `wallet:select` refuses outright.
    getEngine().disarm('no_wallet');
    const r = wallet.remove(typeof id === 'string' && id ? id : undefined);
    if (r.ok) logger.warn(`wallet:remove — active wallet is now ${wallet.publicKey() ?? 'none'}`);
    if (r.ok) syncLiveMode(); // a promoted wallet re-arms; no wallet stays disarmed
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  // ── chat bots (Telegram / Discord) ───────────────────────────────
  //
  // READ-ONLY by construction — see shared/bots.ts. Nothing here reaches the
  // trading surface, and the token never crosses back to the renderer.

  bots.attach({
    settings: () => store.load().bots,
    saveOwner: (kind, ownerId) => {
      const cur = store.load();
      store.update({ bots: { ...cur.bots, [kind]: { ...cur.bots[kind], ownerId } } });
    },
    statusText: () => {
      const live = getEngine().liveState();
      const st = getEngine().snapshot().status;
      // The EVM chains arm separately from the Solana signer; a phone check
      // of /status must say so, or "disarmed" reads as "nothing can spend".
      const evm = EVM_CHAINS.filter((c) => evmRail.enabled(c)).map((c) => `${EVM_CHAIN_META[c].shortName}: ${evmRail.armed(c) ? 'LIVE' : 'Paper'}`);
      return [
        `Engine: ${st.running ? 'running' : 'stopped'}`,
        `Feed: ${st.feed}`,
        `Live trading (Solana): ${live.armed ? 'ARMED' : 'disarmed'}`,
        ...evm,
        `Launches seen: ${st.launchesSeen}`,
      ].join(NL);
    },
    // These are async in the engine, so the bot host keeps the LAST value
    // and refreshes it in the background. A chat reply must not block on an
    // RPC round trip, and a slightly stale number is clearly better than a
    // command that hangs.
    positionsText: () => botCache.positions,
    pnlText: () => botCache.pnl,
    walletText: () => {
      const info = wallet.info();
      if (!info.exists) return 'No trading wallet.';
      return [
        `Wallet: ${info.label ?? 'active'} ${info.publicKey ?? ''}`,
        `Balance: ${info.balanceSol != null ? `${info.balanceSol.toFixed(4)} SOL` : 'unknown'}`,
      ].join(NL);
    },
    alertsText: () => {
      const snap = getEngine().alertsSnapshot();
      const armed = snap.alerts.filter((a) => a.state === 'armed');
      if (!armed.length) return 'No armed alerts.';
      return armed.map((a) => `${a.symbol || a.mint.slice(0, 8)} — ${a.kind} ${a.threshold}`).join(NL);
    },
    ordersText: () => {
      const snap = getEngine().ordersSnapshot();
      const armed = snap.orders.filter((o) => o.state === 'armed' || o.state === 'paused');
      if (!armed.length) return 'No armed orders.';
      const lines = armed.slice(0, 20).map((o) => `${o.symbol || o.mint.slice(0, 8)} — ${describeOrder(o)}${o.state === 'paused' ? ' (PAUSED)' : ''}`);
      if (snap.blockedReason) lines.push(`Blocked: ${snap.blockedReason}`);
      return lines.join(NL);
    },
    priceText: async (mint) => {
      try {
        const s = await market.summary(mint);
        const price = s.priceUsd !== null ? `$${s.priceUsd.toPrecision(4)}` : '—';
        const mc = s.marketCapUsd !== null ? `${Math.round(s.marketCapUsd).toLocaleString()} USD MC` : 'market cap unknown';
        return `${s.symbol || mint.slice(0, 8)} — ${price} · ${mc}`;
      } catch (e) {
        return `Could not read that token: ${(e as Error).message}`;
      }
    },
    symbolFor: (mint) => getEngine().snapshot().launches.find((l) => l.mint === mint)?.symbol ?? '',
    // The only two host calls that can move money. Both go through the SAME
    // engine entry points a click uses, so the arming state, the loss guard,
    // the fee interlock and the per-trade cap all still apply — a chat
    // message is a request, not a bypass.
    buy: async (mint, sol) => {
      const r = await getEngine().testTrade(mint, sol, false);
      return { ok: r.ok, message: r.message };
    },
    sell: async (mint, pct) => {
      const r = await getEngine().manualSell(mint, pct);
      return { ok: r.ok, message: r.message };
    },
    lockTrading: () => {
      const cur = store.load();
      store.update({ bots: { ...cur.bots, trading: { ...cur.bots.trading, enabled: false, allowBuys: false } } });
    },
    announce: (level, line) => getEngine().announce(level, line),
    log: (level, line) => logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](line),
  });
  bots.sync();
  // Refresh the cached portfolio views on a slow timer, and only while a bot
  // is actually paired — an unpaired install should not be doing RPC work for
  // a feature nobody switched on.
  setInterval(() => {
    if (bots.status().some((b) => b.paired && b.enabled)) void refreshBotCache(getEngine());
  }, 30_000);

  ipcMain.handle('recorder:usage', () => ok('ok', recorder.usage()));

  // ─── Legal acceptance (clickwrap) ───────────────────────────────────
  // The renderer asks whether THIS version has been accepted; it never decides
  // that for itself, and it never supplies the version string — the main
  // process uses the one it compiled with. legalcheck.md: "only record a terms
  // version the server itself serves, never whatever the client sends."
  // Declining the terms has to actually do something. An app that says
  // "declining closes the app" and then does not is making a false statement
  // in the same modal that asks for agreement.
  ipcMain.handle('app:quit', () => {
    logger.info('legal: terms declined — quitting');
    setTimeout(() => app.quit(), 100);
    return ok('Quitting');
  });

  ipcMain.handle('legal:status', () => {
    const rows = acceptance.all();
    const last = acceptance.latest(rows);
    return ok('ok', {
      version: TERMS_VERSION,
      accepted: acceptance.hasAccepted(rows, TERMS_VERSION),
      acceptedAt: last?.acceptedAt ?? null,
      acceptedVersion: last?.termsVersion ?? null,
      logPath: acceptance.logPath(),
    });
  });

  ipcMain.handle('legal:accept', () => {
    const row = acceptance.newRecord({
      product: PRODUCT_NAME,
      termsVersion: TERMS_VERSION,
      appVersion: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      locale: app.getLocale(),
      // Hash of the exact text shown, so the row proves WHICH words were
      // agreed to, not merely that a button was clicked.
      documents: ALL_DOCUMENTS.map((d) => ({ id: d.id, sha256: acceptance.sha256(documentText(d)) })),
    });
    // Fire-and-forget by design: a profile we cannot write to must not lock a
    // user out of software they have just agreed to.
    const written = acceptance.append(row);
    if (!written) logger.warn('legal: acceptance could not be written to disk — continuing anyway');
    return ok('Accepted', { version: TERMS_VERSION, acceptedAt: row.acceptedAt, written });
  });

  // What this install holds of $KRYPTO, and whether that waives Krypt's fee.
  // A cached reading, the same one the signer uses — the two must never be
  // able to disagree, or the app would show "waived" and charge anyway.
  ipcMain.handle('krypto:holding', async (_e, refresh: unknown) => {
    if (refresh === true) await kryptoHolding.refresh();
    const h = kryptoHolding.current();
    return ok('ok', { ...h, waived: kryptoHolding.feeWaived(), thresholdTokens: KRYPTO_FEE_WAIVER_TOKENS });
  });

  ipcMain.handle('rpc:credits', () => ok('ok', heliusBudget.current()));

  // Whether an endpoint is currently refusing our key. Polled by the panel
  // the key is pasted into, so the answer appears where the fix is made.
  ipcMain.handle('rpc:health', async () => {
    const m = await import('./chain/rpcClient');
    return ok('ok', { rejected: m.rpcCredentialsRejected() });
  });

  // Measure the endpoints this install is configured to use, so a paid one
  // can be told from a slow one. A BUTTON, never a poll: it is five requests
  // per endpoint against the wire with none of the client's parks or buckets
  // in the way, which is the point of it and also why it must not run itself.
  ipcMain.handle('rpc:probe', async () => {
    const s = store.load();
    const r = resolveRpc(s.rpc);
    const seen = new Set<string>();
    const endpoints: Array<{ label: string; url: string }> = [];
    const add = (label: string, url: string | undefined): void => {
      const u = (url ?? '').trim();
      if (!u || seen.has(u)) return;
      seen.add(u);
      endpoints.push({ label, url: u });
    };
    // Named by the JOB each one does, because that is what a user is
    // deciding about — not by which field it came from.
    add('Execution (buys, sells, confirmations)', r.execHttpUrl);
    add('Everything else (mint checks, balances, holders)', r.httpUrl);
    if (endpoints.length === 0) return fail('No HTTP endpoint is configured');
    const owner = wallet.publicKey() || undefined;
    const results = await rpcProbe.probeAll(endpoints, owner);
    return ok('ok', results);
  });

  ipcMain.handle('rpc:resetCredits', () => {
    heliusBudget.reset();
    return ok('Credit counter reset', heliusBudget.current());
  });

  ipcMain.handle('bots:status', () => ok('ok', bots.status()));

  ipcMain.handle('bots:pair', (_e, kind: unknown) => {
    if (kind !== 'telegram' && kind !== 'discord') return fail('Unknown bot');
    // Starting the transport is what lets the user's /pair message arrive.
    bots.sync();
    return ok('ok', bots.beginPairing(kind));
  });

  ipcMain.handle('bots:cancelPair', (_e, kind: unknown) => {
    if (kind !== 'telegram' && kind !== 'discord') return fail('Unknown bot');
    bots.cancelPairing(kind);
    return ok('ok', bots.status());
  });

  ipcMain.handle('bots:unpair', (_e, kind: unknown) => {
    if (kind !== 'telegram' && kind !== 'discord') return fail('Unknown bot');
    bots.unpair(kind);
    return ok('ok', bots.status());
  });

  ipcMain.handle('bots:verify', async (_e, kind: unknown, token: unknown) => {
    if (kind !== 'telegram' && kind !== 'discord') return fail('Unknown bot');
    if (typeof token !== 'string') return fail('Invalid token');
    const r = await bots.verifyToken[kind](token);
    return r.ok ? ok(r.message, { username: r.username }) : fail(r.message);
  });

  ipcMain.handle('bots:test', async (_e, kind: unknown) => {
    if (kind !== 'telegram' && kind !== 'discord') return fail('Unknown bot');
    bots.push('Test message from Krypto Bot.');
    return ok('Sent — check your chat');
  });

  // ── EVM rail: Robinhood Chain + BNB Smart Chain (electron/evm) ────
  // One wallet file shared by both chains; arm state, balances, fills and
  // positions per chain. Every handler names the chain first and takes an
  // address, a column or a number — the endpoint is a setting.
  const chainOf = (raw: unknown): EvmChainKind | null => (isEvmChain(raw) ? raw : null);
  // A viem transport error carries the FULL RPC URL in .message — with the
  // user's Alchemy key in its path. Prefer the short fields and strip any
  // URL that slips through to its host before it reaches a toast or a log.
  const safeErr = (err: unknown): string => {
    const e = err as { details?: string; shortMessage?: string; message?: string };
    const s = String(e?.details || e?.shortMessage || e?.message || 'error');
    return s.replace(/https?:\/\/([^\s/"']+)[^\s"']*/gi, '$1').replace(/\s+/g, ' ').slice(0, 200);
  };

  // ── Wallet Scout ─────────────────────────────────────────────────────
  // A data tool: what wallets on a chain actually did over a window. Ranking
  // and windowing happen HERE rather than in the renderer, so the page never
  // holds thousands of wallet books.
  ipcMain.handle('scout:top', (_e, chain: unknown, window: unknown, sort: unknown, limit: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    const w = (['day', 'week', 'month', 'all'] as ScoutWindow[]).includes(window as ScoutWindow) ? (window as ScoutWindow) : 'day';
    const by = (['pnl', 'returnPct', 'winRatePct', 'roundTrips', 'volume'] as ScoutSort[]).includes(sort as ScoutSort)
      ? (sort as ScoutSort)
      : 'pnl';
    const cap = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
    const rows = walletScout.wallets(chain as ScoutChain).map((x) => summarise(x, w));
    // A wallet that did nothing in the window is not a row — it is absence.
    const active = rows.filter((r) => r.buys + r.sells > 0);
    return ok('ok', {
      rows: rankScout(active, by).slice(0, cap),
      counts: walletScout.counts(chain as ScoutChain),
      failure: walletScout.failure(),
    });
  });

  ipcMain.handle('scout:saved', (_e, chain: unknown, window: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    const w = (['day', 'week', 'month', 'all'] as ScoutWindow[]).includes(window as ScoutWindow) ? (window as ScoutWindow) : 'day';
    const marks = new Set(walletScout.savedList(chain as ScoutChain));
    // A saved wallet with no record yet still appears, as a row of em dashes:
    // it was saved on purpose, and hiding it would read as "we lost it".
    const known = new Map(walletScout.wallets(chain as ScoutChain).map((x) => [x.address, x]));
    const rows = [...marks].map((address) => {
      const rec = known.get(address);
      return rec
        ? summarise(rec, w)
        : {
            chain: chain as ScoutChain,
            address,
            window: w,
            buys: 0,
            sells: 0,
            roundTrips: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            volume: 0,
            returnPct: null,
            winRatePct: null,
            medianHoldMs: null,
            lastSeen: 0,
            ranked: false,
            looksAutomated: false,
          };
    });
    return ok('ok', { rows, saved: [...marks] });
  });

  ipcMain.handle('scout:save', (_e, chain: unknown, address: unknown, on: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    if (typeof address !== 'string' || !address) return fail('No wallet given');
    const r = walletScout.setSaved(chain as ScoutChain, address, on !== false);
    return r.ok ? ok(r.message, walletScout.savedList(chain as ScoutChain)) : fail(r.message);
  });

  // The manual scan: the last N hours of trades read from a historical
  // source and fed through the same `note` as the live feed. Spends nothing;
  // one job per chain; the status is polled, never pushed.
  ipcMain.handle('scout:scan', (_e, chain: unknown, hours: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    const h: ScoutScanHours = SCOUT_SCAN_HOURS.includes(hours as ScoutScanHours) ? (hours as ScoutScanHours) : 6;
    const r = scoutScan.start(chain as ScoutChain, h, scoutSourceFor(chain as ScoutChain));
    return r.ok ? ok(r.message, scoutScan.status(chain as ScoutChain)) : fail(r.message);
  });

  ipcMain.handle('scout:scanStatus', (_e, chain: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    return ok('ok', scoutScan.status(chain as ScoutChain));
  });

  ipcMain.handle('scout:clear', (_e, chain: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    const r = walletScout.clearTracked(chain as ScoutChain);
    return ok(r.message, r.cleared);
  });

  ipcMain.handle('scout:scanCancel', (_e, chain: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    const asked = scoutScan.cancel(chain as ScoutChain);
    return ok(asked ? 'Stopping after the current step' : 'No scan running', scoutScan.status(chain as ScoutChain));
  });

  // ── Per-chain Observatory ────────────────────────────────────────────
  // One scanner per chain, isolated. `scan:*` never takes a "current chain":
  // the chain is always an argument, so a Robinhood number cannot be served
  // to a page showing BNB.
  ipcMain.handle('evm:scan:status', (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    return ok('ok', evmScanner.status(c));
  });

  ipcMain.handle('evm:scan:model', (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    return ok('ok', evmScanner.modelOf(c));
  });

  // ── Launching a token ──────────────────────────────────────────────
  //
  // Four handlers, and the only one that spends anything is the last. The
  // gate lives in `launcher.refuse` — main-process code, checking the same
  // shared rules the form checks, because the form is the renderer and the
  // renderer does not get to decide what gets signed.

  /** The draft, rebuilt field by field from whatever the renderer sent. */
  const draftOf = (raw: unknown): LaunchDraft | null => {
    const d = raw as Partial<LaunchDraft> | null;
    if (!d || (d.chain !== 'solana' && d.chain !== 'robinhood')) return null;
    const str = (v: unknown, cap: number): string => (typeof v === 'string' ? v.slice(0, cap) : '');
    return {
      chain: d.chain,
      name: str(d.name, 200),
      symbol: str(d.symbol, 64),
      description: str(d.description, 2_000),
      imageUrl: str(d.imageUrl, 500),
      metadataUri: str(d.metadataUri, 500),
      twitter: str(d.twitter, 300),
      telegram: str(d.telegram, 300),
      website: str(d.website, 300),
      devBuy: Number(d.devBuy),
      mayhem: d.mayhem === true,
      cashback: d.cashback === true,
      creatorTaxBps: Math.round(Number(d.creatorTaxBps)),
    };
  };

  const launchDeps = (): LaunchDeps => {
    const s = store.load();
    return {
      cfg: s.launch,
      httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl,
      activeSolanaWalletId: wallet.list().find((w) => w.active)?.id ?? null,
      activeEvmWalletId: evmWallet.list('robinhood').find((w) => w.active)?.id ?? null,
      // The EVM referrer, not the Solana one: this only reaches
      // `chargeLaunchFee` on Robinhood, and every EVM trade pays
      // `settings.evm.referrer`. Found by audit 2026-09-11 — the Solana field
      // was being read, so an EVM referrer was never paid on a launch.
      referrer: s.evm.referrer,
      // Read from the engine, not from settings alone: `liveEnabled` is the
      // switch, `armed` is whether it is actually running, and the buy needs
      // both. Checked before the token exists rather than after.
      liveReady: getEngine().liveState().armed && s.execution.liveEnabled,
      // The creator's first buy is an ordinary fan-out of one: same arming,
      // same live cap, same breakers, same fee, same position record. There
      // is no launch-shaped shortcut into the spending path.
      devBuy: async (mint, walletId, sol) => {
        const r = await getEngine().fanoutBuy(mint, [walletId], { mode: 'same', amountSol: sol });
        return { ok: r.ok, message: r.message };
      },
      canBuy: (walletId, sol) => getEngine().fanoutPreflight([walletId], { mode: 'same', amountSol: sol }),
    };
  };

  // ── Swap (Wallet Utilities) ────────────────────────────────────────
  //
  // A utility, not a trade: no position, no PnL, no strategy. `balance` and
  // `quote` touch no key; `execute` is the only one that signs, and it
  // re-checks the draft against what the wallet actually holds rather than
  // against what the card believed.

  const swapDeps = (): swap.SwapDeps => {
    const s = store.load();
    return {
      httpUrl: s.rpc.execHttpUrl ?? s.rpc.httpUrl,
      referrer: s.referrer,
      live: getEngine().liveState().armed && s.execution.liveEnabled,
    };
  };

  const swapDraftOf = (raw: unknown): SwapDraft | null => {
    const d = raw as Partial<SwapDraft> | null;
    if (!d || typeof d.inputMint !== 'string' || typeof d.outputMint !== 'string') return null;
    const chain = d.chain === 'robinhood' || d.chain === 'bnb' ? d.chain : 'solana';
    return {
      chain,
      inputMint: d.inputMint.trim().slice(0, 64),
      outputMint: d.outputMint.trim().slice(0, 64),
      amount: Number(d.amount),
      slippagePct: Number(d.slippagePct),
      // An unknown speed falls back to the middle one rather than being
      // refused: the preset decides what the transaction BIDS, never what it
      // does, so a bad value is a default, not a hazard.
      speed: d.speed === 'cheap' || d.speed === 'fast' ? d.speed : 'normal',
    };
  };

  ipcMain.handle('swap:balance', async (_e, mint: unknown, chain: unknown) => {
    if (typeof mint !== 'string' || !mint) return fail('Invalid mint');
    // Refused, not defaulted: a chain this handler does not know is not
    // Solana, and a Solana balance under a BNB label would be a wrong number.
    const c = chain === 'solana' || chain === 'robinhood' || chain === 'bnb' ? chain : null;
    if (!c) return fail('Unknown chain');
    try {
      return ok('ok', await swap.balanceOf(swapDeps(), mint.trim(), c));
    } catch (err) {
      return fail(`Could not read that balance: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('swap:quote', async (_e, raw: unknown) => {
    const draft = swapDraftOf(raw);
    if (!draft) return fail('That is not a swap');
    try {
      const r = await swap.quote(draft, swapDeps());
      return r.ok ? ok(r.message, r.quote) : fail(r.message);
    } catch (err) {
      return fail(`Could not price that swap: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('swap:execute', async (_e, raw: unknown, simulateOnly: unknown) => {
    const draft = swapDraftOf(raw);
    if (!draft) return fail('That is not a swap');
    try {
      const r = await swap.execute(draft, swapDeps(), simulateOnly === true);
      return r.ok ? ok(r.message, r) : fail(r.message);
    } catch (err) {
      return fail(`Swap error: ${safeErr(err)}`);
    }
  });

  // ── Bridging between chains ────────────────────────────────────────
  //
  // `routes` and `inflight` are free. `quote` spends one of 75 tokens that
  // refill over two hours, so it is only ever called when a user asks. `send`
  // is the one that puts money in somebody else's hands.


  const bridgeDraftOf = (raw: unknown): BridgeDraft | null => {
    const d = raw as Partial<BridgeDraft> | null;
    const ok = (c: unknown): c is BridgeDraft['from'] => c === 'solana' || c === 'robinhood' || c === 'bnb';
    if (!d || !ok(d.from) || !ok(d.to)) return null;
    return { from: d.from, to: d.to, amount: Number(d.amount) };
  };

  /** Which directions this build will sign for, and what is in flight. */
  ipcMain.handle('bridge:state', () => {
    const s = store.load();
    return ok('ok', {
      enabled: s.bridge.enabled,
      routes: [...bridge.ENABLED_ROUTES],
      inFlight: bridge.inFlight(),
      history: bridge.history().slice(0, 40),
      // Never "none in flight" when the truth is "could not read the record".
      failure: bridge.recordFailure(),
    });
  });

  ipcMain.handle('bridge:quote', async (_e, raw: unknown) => {
    if (!store.load().bridge.enabled) return fail('Bridging is switched off for this install.');
    const draft = bridgeDraftOf(raw);
    if (!draft) return fail('That is not a transfer');
    try {
      const r = await bridge.quote(draft, bridgeDeps());
      // `_raw` carries the unsigned transaction and never crosses IPC.
      return r.ok && r.quote ? ok(r.message, r.quote) : fail(r.message);
    } catch (err) {
      return fail(`Could not price that transfer: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('bridge:send', async (_e, raw: unknown, simulateOnly: unknown) => {
    if (!store.load().bridge.enabled) return fail('Bridging is switched off for this install.');
    const draft = bridgeDraftOf(raw);
    if (!draft) return fail('That is not a transfer');
    try {
      const r = await bridge.send(draft, bridgeDeps(), simulateOnly === true);
      if (r.ok && simulateOnly !== true) logger.warn(`bridge: ${draft.amount} sent ${draft.from} to ${draft.to} (${r.txHash ?? 'no hash'})`);
      return r.ok ? ok(r.message, r) : fail(r.message);
    } catch (err) {
      return fail(`Transfer error: ${safeErr(err)}`);
    }
  });

  /** Ask the aggregator where everything in flight got to. */
  ipcMain.handle('bridge:refresh', async () => {
    try {
      const changed = await bridge.poll();
      return ok(changed ? `${changed} transfer(s) updated` : 'No change', bridge.inFlight());
    } catch (err) {
      return fail(`Could not check: ${safeErr(err)}`);
    }
  });

  /** Images picked this session, by handle. The renderer never sees a path. */
  const pickedImages = new Map<string, string>();

  /** Pick an image off disk. The renderer never names a path; this does. */
  ipcMain.handle('launch:pickImage', async () => {
    const owner = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(owner!, {
      title: 'Choose your token image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }],
    });
    const file = res.canceled ? null : res.filePaths[0] ?? null;
    if (!file) return ok('cancelled', null);
    try {
      const bytes = await readFile(file);
      if (bytes.length > MAX_IMAGE_BYTES) return fail(`That image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; ${MAX_IMAGE_BYTES / 1024 / 1024} MB is the maximum.`);
      const ext = path.extname(file).toLowerCase().replace('.', '');
      // The preview is a data URL so the renderer never gets a filesystem
      // path and the page needs no file:// access to show what was picked.
      // The PATH stays here too, behind a handle: until 2026-09-11 it went to
      // the renderer and came back as the upload's argument, so a compromised
      // page could have pinned any image on the disk. Found by audit.
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      const handle = randomBytes(12).toString('hex');
      pickedImages.set(handle, file);
      if (pickedImages.size > 8) pickedImages.delete(pickedImages.keys().next().value!);
      return ok('picked', { handle, name: path.basename(file), dataUrl: `data:image/${mime};base64,${bytes.toString('base64')}` });
    } catch (err) {
      return fail(`Could not read that image: ${safeErr(err)}`);
    }
  });

  /** Pin the image and its metadata. Creates nothing on any chain. */
  ipcMain.handle('launch:upload', async (_e, handle: unknown, fields: unknown) => {
    const filePath = typeof handle === 'string' ? pickedImages.get(handle) : undefined;
    if (!filePath) return fail('No image chosen — pick one first');
    if (!store.load().launch.enabled) return fail('Launching is switched off for this install.');
    const f = fields as Partial<MetadataFields> | null;
    const str = (v: unknown, cap: number): string => (typeof v === 'string' ? v.slice(0, cap) : '');
    // The same caps the form enforces (shared/launch.ts), not looser ones.
    const r = await uploadLaunchMetadata(filePath, {
      name: str(f?.name, MAX_NAME),
      symbol: str(f?.symbol, MAX_SYMBOL),
      description: str(f?.description, MAX_DESCRIPTION),
      twitter: str(f?.twitter, 300),
      telegram: str(f?.telegram, 300),
      website: str(f?.website, 300),
    });
    return 'error' in r ? fail(r.error) : ok('pinned', r);
  });

  /**
   * What this install's launch wallet has earned as a creator, and claiming
   * it. The vault is per creator, so one read and one claim cover every coin
   * that wallet ever launched.
   */
  ipcMain.handle('launch:fees', async () => {
    const s = store.load();
    const id = s.launch.walletId;
    if (!id) return fail('No Solana launch wallet is set.');
    const key = wallet.publicKeyOf(id);
    if (!key) return fail('The launch wallet no longer exists.');
    try {
      return ok('ok', await pumpFees.readCreatorFees(s.rpc.execHttpUrl ?? s.rpc.httpUrl, key));
    } catch (err) {
      return fail(`Could not read creator fees: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('launch:claimFees', async () => {
    const s = store.load();
    // The switch gates the claim as well as the launch: an install that has
    // never opted in has nothing to claim and no business signing for pump.
    if (!s.launch.enabled) return fail('Launching is switched off for this install.');
    const id = s.launch.walletId;
    if (!id) return fail('No Solana launch wallet is set.');
    try {
      const r = await pumpFees.claimCreatorFees(s.rpc.execHttpUrl ?? s.rpc.httpUrl, id);
      return r.ok ? ok(r.message, r) : fail(r.message);
    } catch (err) {
      return fail(`Claim error: ${safeErr(err)}`);
    }
  });

  /** Ask the chain whether this launch would work. Broadcasts nothing. */
  ipcMain.handle('launch:preview', async (_e, raw: unknown) => {
    const draft = draftOf(raw);
    if (!draft) return fail('That is not a launch');
    try {
      const r = await launcher.launch(draft, launchDeps(), true);
      return r.ok ? ok(r.message, r) : fail(r.message);
    } catch (err) {
      return fail(`Could not check the launch: ${safeErr(err)}`);
    }
  });

  /** Create the token. The one irreversible handler in this file. */
  ipcMain.handle('launch:send', async (_e, raw: unknown) => {
    const draft = draftOf(raw);
    if (!draft) return fail('That is not a launch');
    try {
      const r = await launcher.launch(draft, launchDeps(), false);
      if (r.ok) logger.warn(`launch: created ${r.token ?? '?'} on ${draft.chain}`);
      // A failure still carries the outcome: a hash on a timed-out receipt
      // is the one thing the user needs, and `fail()` would throw it away.
      return r.ok ? ok(r.message, r) : { ok: false, message: r.message, data: r };
    } catch (err) {
      return fail(`Launch error: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('evm:scan:launches', (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    return ok('ok', evmScanner.launches(c));
  });

  // Runner calls this chain flagged this session. Separate from `launches`,
  // which purges a launch 130 s after it is seen — a flag has to outlive that
  // or the Runner alerts panel can never show one.
  ipcMain.handle('evm:scan:flagged', (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    return ok('ok', evmScanner.flagged(c));
  });

  ipcMain.handle('evm:scan:start', (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    const r = evmScanner.start(c);
    return r.ok ? ok(r.message, evmScanner.status(c)) : fail(r.message);
  });

  ipcMain.handle('evm:scan:stop', (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    const r = evmScanner.stop(c);
    return r.ok ? ok(r.message, evmScanner.status(c)) : fail(r.message);
  });

  ipcMain.handle('evm:state', async (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    return ok('ok', await evmRail.state(c));
  });
  ipcMain.handle('evm:arm', (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    const r = evmRail.arm(c);
    return r.ok ? ok(r.message, evmRail.liveState(c)) : fail(r.message);
  });
  ipcMain.handle('evm:disarm', (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    const r = evmRail.disarm(c, 'user');
    return ok(r.message, evmRail.liveState(c));
  });

  ipcMain.handle('evm:wallet:info', (_e, chain: unknown) => {
    const c = chainOf(chain);
    return c ? ok('ok', evmRail.wallet.info(c)) : fail('Unknown chain');
  });
  ipcMain.handle('evm:wallet:list', (_e, chain: unknown) => {
    const c = chainOf(chain);
    return c ? ok('ok', evmRail.wallet.list(c)) : fail('Unknown chain');
  });
  // Every wallet mutation is try/caught: a write failure (disk full, AV lock)
  // must come back as a plain refusal the panel can show, never a rejected
  // invoke that leaves the renderer believing the wallet was saved.
  //
  // Every one of these takes the CHAIN first, because that is what preload
  // sends (electron/preload.ts, `wallet.generate(chain, label)` etc.). Until
  // 2026-09-11 four of the five read their arguments one slot to the left —
  // `generate` took the chain name as the label, `import` took it as the
  // secret and always failed the hex check, `rename` and `remove` took it as
  // the wallet id and always answered "No such wallet". Only `select` had
  // been corrected. A contract test now pins the order for all five.
  ipcMain.handle('evm:wallet:generate', (_e, chain: unknown, label: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    try {
      // Made FOR the chain whose page asked — see evmWalletStore.addWalletFor.
      const r = evmRail.wallet.generate(typeof label === 'string' ? label : '', c);
      if (r.ok) { logger.warn(`evm wallet: generated ${r.address} for ${c}`); refreshScoutOwnership(); }
      return r.ok ? ok(r.message, evmRail.wallet.info(c)) : fail(r.message);
    } catch (err) {
      return fail(`Wallet not saved: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:wallet:import', (_e, chain: unknown, secret: unknown, label: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (typeof secret !== 'string' || !secret.trim()) return fail('Paste a private key');
    try {
      const r = evmRail.wallet.importSecret(secret, typeof label === 'string' ? label : '', c);
      if (r.ok) { logger.warn(`evm wallet: imported ${r.address} for ${c}`); refreshScoutOwnership(); }
      return r.ok ? ok(r.message, evmRail.wallet.info(c)) : fail(r.message);
    } catch (err) {
      return fail(`Wallet not saved: ${safeErr(err)}`);
    }
  });
  // Per chain: the wallet LIST is shared (an EVM key is the same address on
  // both chains), but which of them signs is each chain's own choice.
  ipcMain.handle('evm:wallet:select', (_e, chain: unknown, id: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (typeof id !== 'string' || !id) return fail('Invalid wallet id');
    try {
      const r = evmRail.wallet.select(c, id);
      if (r.ok) logger.warn(`evm wallet: ${c} now signs with ${evmRail.wallet.info(c).address ?? 'none'}`);
      return r.ok ? ok(r.message, evmRail.wallet.info(c)) : fail(r.message);
    } catch (err) {
      return fail(`Wallet not switched: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:wallet:assign', (_e, chain: unknown, id: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (typeof id !== 'string' || !id) return fail('Invalid wallet id');
    try {
      const r = evmRail.wallet.assign(c, id);
      return r.ok ? ok(r.message, evmRail.wallet.info(c)) : fail(r.message);
    } catch (err) {
      return fail(`Wallet not assigned: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:wallet:rename', (_e, chain: unknown, id: unknown, label: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (typeof id !== 'string' || !id) return fail('Invalid wallet id');
    if (typeof label !== 'string') return fail('Invalid label');
    try {
      const r = evmRail.wallet.rename(id, label);
      return r.ok ? ok(r.message, evmRail.wallet.info(c)) : fail(r.message);
    } catch (err) {
      return fail(`Wallet not renamed: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:wallet:remove', (_e, chain: unknown, id: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    try {
      const r = evmRail.wallet.remove(typeof id === 'string' && id ? id : undefined);
      return r.ok ? ok(r.message, evmRail.wallet.info(c)) : fail(r.message);
    } catch (err) {
      return fail(`Wallet not removed: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:wallet:export', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export EVM wallets (private keys, plaintext)',
      defaultPath: 'krypt-evm-wallets-PRIVATE.txt',
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return fail('Export cancelled');
    const r = evmRail.wallet.exportAll(res.filePath);
    return r.ok ? ok(r.message, { count: r.count }) : fail(r.message);
  });
  ipcMain.handle('evm:wallet:refreshBalance', async (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    const r = await evmRail.wallet.refreshBalance(c);
    return r.ok ? ok('ok', evmRail.wallet.info(c)) : fail(r.message);
  });
  ipcMain.handle('evm:wallet:refreshAll', async (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    await evmRail.wallet.refreshAll(c);
    return ok('ok', evmRail.wallet.list(c));
  });

  ipcMain.handle('evm:discover', async (_e, chain: unknown, column: unknown, limit: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (!DISCOVER_COLUMNS.includes(column as DiscoverColumn)) return fail('Unknown column');
    const n = typeof limit === 'number' && Number.isFinite(limit) ? limit : 40;
    try {
      const r = await evmRail.discover(c, column as DiscoverColumn, n);
      return ok(r.message, r.rows);
    } catch (err) {
      return fail(`Discover failed: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:summary', async (_e, chain: unknown, address: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (!isEvmAddress(address)) return fail('Invalid token address');
    try {
      return ok('ok', await evmRail.summary(c, address));
    } catch (err) {
      return fail(`Summary failed: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:token', async (_e, chain: unknown, address: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (!isEvmAddress(address)) return fail('Invalid token address');
    try {
      return ok('ok', await evmRail.detail(c, address));
    } catch (err) {
      return fail(`Token lookup failed: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:candles', async (_e, chain: unknown, address: unknown, interval: unknown, limit: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (!isEvmAddress(address)) return fail('Invalid token address');
    if (!CANDLE_INTERVALS.includes(interval as CandleInterval)) return fail('Unknown interval');
    const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(1000, Math.max(10, limit)) : 500;
    try {
      return ok('ok', await evmRail.candles(c, address, interval as CandleInterval, n));
    } catch (err) {
      return fail(`Candles failed: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:quote', async (_e, chain: unknown, side: unknown, address: unknown, amount: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (side !== 'buy' && side !== 'sell') return fail('Side must be buy or sell');
    if (!isEvmAddress(address)) return fail('Invalid token address');
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return fail('Amount must be positive');
    try {
      const q = await evmRail.quote(c, side, address, amount);
      return 'error' in q ? fail(q.error) : ok('ok', q);
    } catch (err) {
      return fail(`Quote failed: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:buy', async (_e, chain: unknown, address: unknown, amount: unknown, simulateOnly: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (!isEvmAddress(address)) return fail('Invalid token address');
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return fail('Amount must be positive');
    if (amount > 50) return fail(`That is more than 50 ${EVM_CHAIN_META[c].nativeSymbol} in one trade — refusing`);
    try {
      const res = await evmRail.buy(c, address, amount, simulateOnly !== false);
      return res.ok ? ok(res.message, res) : { ok: false, message: res.message, data: res };
    } catch (err) {
      return fail(`Buy error: ${safeErr(err)}`);
    }
  });
  // Get out of everything on one chain. Never simulated: there is no such
  // thing as a dry-run panic button, and a user pressing this wants the
  // positions gone. The rail refuses it while the chain is disarmed, exactly
  // as a single sell is refused.
  ipcMain.handle('evm:sellAll', async (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    try {
      const res = await evmRail.sellAll(c);
      return res.ok ? ok(res.message, res) : { ok: false, message: res.message, data: res };
    } catch (err) {
      return fail(`Sell-all error: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('evm:sell', async (_e, chain: unknown, address: unknown, pct: unknown, simulateOnly: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (!isEvmAddress(address)) return fail('Invalid token address');
    const p = typeof pct === 'number' && Number.isFinite(pct) ? pct : 100;
    if (p <= 0 || p > 100) return fail('Sell percent must be between 1 and 100');
    try {
      const res = await evmRail.sell(c, address, p, simulateOnly !== false);
      return res.ok ? ok(res.message, res) : { ok: false, message: res.message, data: res };
    } catch (err) {
      return fail(`Sell error: ${safeErr(err)}`);
    }
  });
  // Several pinned tokens at once. One DexScreener request for the whole
  // list instead of one per token — the watchlist polls every 20 s, and the
  // Solana half has been batched since 2026-09-08.
  ipcMain.handle('evm:summaries', async (_e, chain: unknown, addresses: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (!Array.isArray(addresses) || addresses.length > 60 || !addresses.every((a) => typeof a === 'string' && isEvmAddress(a))) {
      return fail('Invalid token list');
    }
    try {
      return ok('ok', await evmRail.summaries(c, addresses as string[]));
    } catch (err) {
      return fail(`Summaries failed: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('evm:holdings', async (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    try {
      return ok('ok', await evmRail.holdings(c));
    } catch (err) {
      return fail(`Holdings failed: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:portfolio', async (_e, chain: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    try {
      return ok('ok', await evmRail.portfolio(c));
    } catch (err) {
      return fail(`Portfolio failed: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('evm:fills', (_e, chain: unknown) => {
    const c = chainOf(chain);
    return c ? ok('ok', evmRail.fills(c)) : fail('Unknown chain');
  });
  ipcMain.handle('evm:track', (_e, chain: unknown, address: unknown, on: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (!isEvmAddress(address)) return fail('Invalid token address');
    return ok('ok', evmRail.track(c, address, on !== false));
  });

  // ── rewards (Merkl) ──────────────────────────────────────────────
  //
  // Two channels, both keyed by CHAIN and nothing else. The renderer never
  // passes an address here: `rewards:wallet` resolves this install's own EVM
  // address from the wallet store main-side, the same rule that keeps URLs
  // and addresses out of the market channels. A chain switched off in
  // Settings answers nothing at all, exactly like its wallet page.
  //
  // Neither handler can throw across IPC: the provider returns
  // `{ rows: null }` for every failure rather than rejecting, and `rows: null`
  // is the renderer's contract for "unknown" — an em dash, never a zero.
  const rewardsChain = (raw: unknown): { chain: EvmChainKind; chainId: number } | null => {
    const c = chainOf(raw);
    return c ? { chain: c, chainId: EVM_CHAIN_META[c].id } : null;
  };

  ipcMain.handle('rewards:opportunities', async (_e, chain: unknown) => {
    const c = rewardsChain(chain);
    if (!c) return fail('Unknown chain');
    if (!evmRail.enabled(c.chain)) return fail(`${EVM_CHAIN_META[c.chain].name} is turned off in Settings`);
    return ok('ok', await merkl.opportunities(c.chainId));
  });

  // The one call in this feature that discloses anything. It is reached only
  // from a button the user presses, next to a sentence saying the address
  // goes to Merkl.
  ipcMain.handle('rewards:wallet', async (_e, chain: unknown) => {
    const c = rewardsChain(chain);
    if (!c) return fail('Unknown chain');
    if (!evmRail.enabled(c.chain)) return fail(`${EVM_CHAIN_META[c.chain].name} is turned off in Settings`);
    const info = evmRail.wallet.info(c.chain);
    if (info.failure) return fail(info.failure);
    if (!info.address) return fail('No EVM wallet on this install');
    return ok('ok', await merkl.walletRewards(c.chainId, info.address));
  });

  // ── live arming (gated behind LIVE_EXECUTION_AVAILABLE) ──────────
  ipcMain.handle('live:state', () => ok('ok', getEngine().liveState()));

  ipcMain.handle('live:arm', () => {
    const r = getEngine().arm(wallet.exists());
    return r.ok ? ok(r.message, getEngine().liveState()) : fail(r.message);
  });

  ipcMain.handle('live:disarm', () => {
    const r = getEngine().disarm('user');
    return ok(r.message, getEngine().liveState());
  });

  // The ONE switch: Paper vs Live. Collapses the old arm + enable-broadcast
  // pair into a single mode. Live requires a wallet; turning it off disarms.
  // Everything downstream keys off this. Live is the default mode —
  // syncLiveMode() arms at boot and whenever a wallet appears.
  ipcMain.handle('live:setLive', (_e, on: unknown) => {
    const want = on === true;
    const cur = store.load();
    if (want) {
      const armed = getEngine().arm(wallet.exists());
      if (!armed.ok) return fail(armed.message);
      store.update({ execution: { ...cur.execution, liveEnabled: true } });
    } else {
      getEngine().disarm('user');
      store.update({ execution: { ...cur.execution, liveEnabled: false } });
    }
    // arm()/disarm() pushed a status BEFORE the mode bit above was written;
    // push again now so status.liveActive reflects both halves.
    getEngine().announceStatus();
    return ok(want ? 'Live trading ON — trades spend real SOL' : 'Paper trading — nothing is broadcast', {
      live: getEngine().liveState(),
      liveEnabled: want,
    });
  });

  // ── wallet groups (fan-out) ──────────────────────────────────────
  ipcMain.handle('wallet:groups', () => ok('ok', wallet.groups()));
  ipcMain.handle('wallet:createGroup', (_e, name: unknown) => {
    const r = wallet.createGroup(typeof name === 'string' ? name : '');
    return r.ok ? ok(r.message, wallet.groups()) : fail(r.message);
  });
  ipcMain.handle('wallet:renameGroup', (_e, id: unknown, name: unknown) => {
    if (typeof id !== 'string') return fail('Bad group id');
    const r = wallet.renameGroup(id, typeof name === 'string' ? name : '');
    return r.ok ? ok(r.message, wallet.groups()) : fail(r.message);
  });
  ipcMain.handle('wallet:deleteGroup', (_e, id: unknown) => {
    if (typeof id !== 'string') return fail('Bad group id');
    const r = wallet.deleteGroup(id);
    return r.ok ? ok(r.message, wallet.groups()) : fail(r.message);
  });
  ipcMain.handle('wallet:setGroupMembers', (_e, id: unknown, walletIds: unknown) => {
    if (typeof id !== 'string') return fail('Bad group id');
    if (!Array.isArray(walletIds) || walletIds.some((w) => typeof w !== 'string')) return fail('Bad member list');
    const r = wallet.setGroupMembers(id, walletIds as string[]);
    return r.ok ? ok(r.message, wallet.groups()) : fail(r.message);
  });

  // ── Wallet Lab ─────────────────────────────────────────────────
  ipcMain.handle('lab:generateMany', (_e, count: unknown, prefix: unknown, groupId: unknown) => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 20) return fail('Count must be 1–20');
    if (groupId !== undefined && groupId !== null && groupId !== '' && typeof groupId !== 'string') return fail('Invalid group');
    const gid = typeof groupId === 'string' && groupId ? groupId : null;
    if (gid && !wallet.groups().some((g) => g.id === gid)) return fail('No such group');
    const r = wallet.generateMany(n, typeof prefix === 'string' ? prefix : '');
    if (r.created > 0) syncLiveMode();
    if (gid && r.ids.length) {
      // New wallets join the chosen group straight away — the Group Wallets
      // flow is "make a group, then fill it".
      const g = wallet.groups().find((x) => x.id === gid);
      const members = [...(g?.members.map((m) => m.id) ?? []), ...r.ids];
      const gr = wallet.setGroupMembers(gid, members);
      if (!gr.ok) return fail(`${r.message}, but adding them to the group failed: ${gr.message}`);
    }
    return r.ok ? ok(r.message, wallet.list()) : fail(r.message);
  });
  /** Known keys only, on top of the stored value, on top of the defaults —
   *  an unknown or extra key never reaches wallets.json. */
  const pickLab = <T extends object>(defaults: T, current: T | undefined, cfg: unknown): T => {
    const src = (cfg && typeof cfg === 'object' ? cfg : {}) as Record<string, unknown>;
    const out = { ...defaults, ...(current ?? {}) } as Record<string, unknown>;
    for (const k of Object.keys(defaults)) if (k in src) out[k] = src[k];
    return out as T;
  };
  ipcMain.handle('lab:fund', async (_e, targets: unknown, fromWalletId: unknown) => {
    if (!getEngine().liveState().armed || !store.load().execution.liveEnabled) return fail('Arm live execution first — funding moves real SOL');
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 20) return fail('Pick 1–20 wallets');
    const byId = new Map(wallet.list().map((w) => [w.id, w.publicKey]));
    // The source is one of OURS or it is the active wallet — never an id the
    // renderer made up.
    const fromId = typeof fromWalletId === 'string' && fromWalletId ? fromWalletId : undefined;
    if (fromId && !byId.has(fromId)) return fail('The wallet to send from is not one of yours');
    const resolved: Array<{ publicKey: string; lamports: number }> = [];
    const seen = new Set<string>();
    let totalLamports = 0;
    for (const t of targets as Array<{ walletId?: unknown; sol?: unknown }>) {
      const pk = typeof t?.walletId === 'string' ? byId.get(t.walletId) : undefined;
      const sol = Number(t?.sol);
      if (!pk) return fail('A target is not one of your wallets');
      if (seen.has(pk)) return fail('A wallet is listed twice');
      seen.add(pk);
      if (!(sol > 0) || !Number.isFinite(sol) || sol > lab.MAX_FUND_PER_WALLET_SOL) return fail(`Amount per wallet must be between 0 and ${lab.MAX_FUND_PER_WALLET_SOL} SOL`);
      const lamports = Math.round(sol * 1e9);
      totalLamports += lamports;
      resolved.push({ publicKey: pk, lamports });
    }
    if (totalLamports > lab.MAX_FUND_BATCH_LAMPORTS) return fail(`Fund at most ${lab.MAX_FUND_BATCH_LAMPORTS / 1e9} SOL per batch`);
    const httpUrl = resolveRpc(store.load().rpc).execHttpUrl ?? store.load().rpc.httpUrl;
    const r = await fund.fundWallets(httpUrl, resolved, fromId);
    logger.info(`lab fund: ${r.message}${r.signature ? ` ${r.signature.slice(0, 12)}…` : ''}`);
    const data = { signature: r.signature ?? '', sentSol: r.sentLamports / 1e9, count: r.count };
    // A partial outcome carries what DID leave the wallet, with its signature.
    return r.ok ? ok(r.message, data) : { ok: false as const, message: r.message, data };
  });
  ipcMain.handle('lab:collect', async (_e, walletIds: unknown, toWalletId: unknown) => {
    if (!getEngine().liveState().armed || !store.load().execution.liveEnabled) return fail('Arm live execution first — collecting moves real SOL');
    if (!Array.isArray(walletIds) || walletIds.length === 0 || walletIds.length > 20 || !walletIds.every((x) => typeof x === 'string')) return fail('Pick 1–20 wallets');
    const httpUrl = resolveRpc(store.load().rpc).execHttpUrl ?? store.load().rpc.httpUrl;
    const toId = typeof toWalletId === 'string' && toWalletId ? toWalletId : undefined;
    if (toId && !wallet.list().some((w) => w.id === toId)) return fail('The wallet to collect to is not one of yours');
    const r = await fund.collectToActive(httpUrl, walletIds as string[], toId);
    const landed = r.filter((x) => x.ok).length;
    logger.info(`lab collect: ${landed}/${r.length} wallet(s) sent back`);
    return ok(`${landed}/${r.length} collected`, r.map((x) => ({ walletId: x.walletId, ok: x.ok, message: x.message, sol: x.lamports / 1e9, signature: x.signature })));
  });
  ipcMain.handle('wallet:refreshAll', async () => {
    const noted = await getEngine().refreshAllBalances();
    return ok(`${noted} balance(s) read`, wallet.list());
  });
  // Four bounds on the wallet list and the size, plus a real
  // base58 test on the mint. The blast radius is bounded downstream, so this
  // is defence in depth — but a buy handler that trusts more than its own
  // sell twin is exactly the asymmetry the EVM handlers were hardened away
  // from, and this one spends SOL rather than returning it.
  ipcMain.handle('live:sellToken', async (_e, mint: string, percent: unknown) => {
    if (typeof mint !== 'string' || mint.length < 32) return fail('Invalid mint address');
    const pct = percent === undefined ? 100 : Number(percent);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return fail('Sell percent must be between 1 and 100');
    try {
      const res = await getEngine().manualSell(mint, pct);
      return res.ok ? ok(res.message, res) : { ok: false, message: res.message, data: res };
    } catch (err) {
      return fail(`Sell error: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('live:sellAll', () => {
    const r = getEngine().sellAllHeld('manual');
    return r.ok ? ok(r.message) : fail(r.message);
  });

  ipcMain.handle('live:sweepRent', async () => {
    try {
      const r = await getEngine().sweepRent();
      return r.ok ? ok(r.message, r) : { ok: false, message: r.message, data: r };
    } catch (err) {
      return fail(`Rent sweep error: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('live:testTrade', async (_e, mint: string, sol: number, simulateOnly: boolean) => {
    if (typeof mint !== 'string' || mint.length < 32) return fail('Invalid mint address');
    if (!(sol > 0)) return fail('Amount must be positive');
    try {
      // Trade panel, Discover quick-buy and hotkeys all arrive here: a human
      // pressing the button now. Orders/copy/fan-out call the engine directly
      // and keep the per-trade cap.
      const res = await getEngine().testTrade(mint, sol, simulateOnly !== false, { manual: true });
      return res.ok ? ok(res.message, res) : { ok: false, message: res.message, data: res };
    } catch (err) {
      return fail(`Live trade error: ${(err as Error).message}`);
    }
  });

  // ── history (aggregated from recordings on disk) ─────────────────
  ipcMain.handle('history:load', async () => {
    try {
      const dir = recorder.recordingsDir();
      if (!dir) return fail('Recorder not initialized');
      const summary = await summarize(dir);
      return ok('ok', summary);
    } catch (err) {
      return fail(`Failed to read history: ${(err as Error).message}`);
    }
  });

  // ── market data (Krypto Bot) ─────────────────────────────────
  //
  // Every handler here can reach the network, so every one of them takes a
  // narrow, validated argument. NOTHING in this section accepts a URL or a
  // host: the renderer names a mint, a column or an interval, and the
  // provider layer decides which of its hardcoded hosts to contact. That is
  // the structural fix for the metadata SSRF (product swarm §8.3) rather
  // than a filter that has to be got right every time.

  const isMint = (v: unknown): v is string =>
    typeof v === 'string' && market.looksLikeMint(v);

  // ── GIF backgrounds ──────────────────────────────────────────────
  // The renderer sends a provider and a search string; it never sends a URL,
  // and the key never leaves main. Picking is by id from the last search.
  ipcMain.handle('gifs:search', async (_e, provider: unknown, query: unknown) => {
    if (provider !== 'giphy' && provider !== 'tenor') return fail('Unknown GIF provider');
    if (typeof query !== 'string') return fail('Invalid search');
    const s = store.load();
    if (!s.data.networkDataEnabled) return fail('Market data is off — turn it on in Settings to search GIFs.');
    const key = provider === 'giphy' ? s.data.giphyApiKey : s.data.tenorApiKey;
    const r = await gifs.search(provider, query, key ?? '');
    // Only the fields the picker needs, with previews served through the
    // hardened image handler rather than as raw links.
    return r.ok
      ? ok(r.message, r.items.map((i) => ({ id: i.id, title: i.title, preview: imageSrc(i.previewUrl), width: i.width, height: i.height })))
      : fail(r.message);
  });
  ipcMain.handle('gifs:pick', async (_e, provider: unknown, id: unknown) => {
    if (provider !== 'giphy' && provider !== 'tenor') return fail('Unknown GIF provider');
    if (typeof id !== 'string' || !id || id.length > 128) return fail('Invalid GIF id');
    if (!store.load().data.networkDataEnabled) return fail('Market data is off.');
    const r = await gifs.pick(provider, id);
    return r.ok && r.dataUrl ? ok('ok', { dataUrl: r.dataUrl }) : fail(r.message);
  });

  ipcMain.handle('market:providers', () => ok('ok', market.providerStatuses()));

  ipcMain.handle('market:discover', async (_e, column: unknown, limit: unknown, win: unknown) => {
    if (!DISCOVER_COLUMNS.includes(column as DiscoverColumn)) return fail('Unknown column');
    const n = Number(limit);
    // An unknown window falls back to 5m rather than reaching a provider with
    // whatever the renderer sent.
    const w = STATS_WINDOWS.includes(win as StatsWindow) ? (win as StatsWindow) : '5m';
    try {
      const rows = await market.discover(column as DiscoverColumn, Number.isFinite(n) ? n : 40, w);
      // A parked provider rides back in the message so the column can say
      // 'rate limited' over the rows it keeps, instead of blanking.
      return ok(market.discoverParkNote(column as DiscoverColumn) || 'ok', rows);
    } catch (err) {
      return fail(`Discover failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('market:token', async (_e, mint: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    try {
      return ok('ok', await market.tokenDetail(mint));
    } catch (err) {
      return fail(`Token load failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('market:summary', async (_e, mint: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    try {
      return ok('ok', await market.summary(mint));
    } catch (err) {
      return fail(`Summary failed: ${(err as Error).message}`);
    }
  });

  // Many mints in one round trip, with the Jupiter half batched main-side.
  // The watchlist asked one summary per pin every 20 s — thirty pins were
  // sixty Jupiter calls a refresh (rate-limit swarm, 2026-09-06).
  ipcMain.handle('market:summaries', async (_e, mints: unknown) => {
    if (!Array.isArray(mints) || mints.length > 100 || !mints.every(isMint)) return fail('Invalid mint list');
    try {
      const map = await market.summaryMany(mints as string[], 3);
      return ok(market.parkNote() || 'ok', Object.fromEntries(map));
    } catch (err) {
      return fail(`Summaries failed: ${(err as Error).message}`);
    }
  });

  // ── AI analysis (BYO key; the key stays main-side) ───────────────────
  // AI analyses are cached in-process, per mint, for the life of the session.
  // Each one spends the user's own API credits, so a re-visit or a tab switch
  // must return the stored take rather than paying to regenerate it; only an
  // explicit "Re-analyze" (force) bypasses the cache. Cleared on restart.
  const aiCache = new Map<string, AiAnalysis>();

  ipcMain.handle('ai:cached', (_e, mint: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    const hit = aiCache.get(mint);
    return hit ? ok('cached', hit) : ok('none', null);
  });

  ipcMain.handle('ai:analyze', async (_e, mint: unknown, force: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    if (force !== true) {
      const hit = aiCache.get(mint);
      if (hit) return ok('cached', hit);
    }
    try {
      const detail = await market.tokenDetail(mint);
      if (!detail?.summary) return fail('Could not load token data to analyse');
      const { analyze } = await import('./data/aiAnalysis');
      const r = await analyze(store.load().ai, detail.summary, detail, Date.now());
      if (r.ok && r.analysis) aiCache.set(mint, r.analysis);
      return r.ok ? ok(r.message, r.analysis) : fail(r.message);
    } catch (err) {
      return fail(`Analysis failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('ai:verify', async (_e, provider: unknown, key: unknown, model: unknown) => {
    if (provider !== 'openai' && provider !== 'anthropic') return fail('Bad provider');
    const { verifyKey } = await import('./data/aiAnalysis');
    const r = await verifyKey(provider, typeof key === 'string' ? key : '', typeof model === 'string' ? model : '');
    return r.ok ? ok(r.message) : fail(r.message);
  });

  // The chart's provider-merged series arrives after the instant answer —
  // see market.candlesFast. Broadcast like any engine event.
  market.onCandlesReady((series) => broadcast({ kind: 'candles', series }));

  ipcMain.handle('market:candles', async (_e, mint: unknown, interval: unknown, limit: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    if (!CANDLE_INTERVALS.includes(interval as CandleInterval)) return fail('Unknown interval');
    const n = Number(limit);
    try {
      return ok('ok', await market.candlesFast(mint, interval as CandleInterval, Number.isFinite(n) ? n : 500));
    } catch (err) {
      return fail(`Chart load failed: ${(err as Error).message}`);
    }
  });

  // The full merged series, however long the provider walk takes. For a
  // deliberate, non-navigation ask (the trade replay) — market:candles
  // answers a pending placeholder after 1.2 s, which the token page upgrades
  // from the `candles` push but a one-shot caller would take as "no chart".
  ipcMain.handle('market:candlesFull', async (_e, mint: unknown, interval: unknown, limit: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    if (!CANDLE_INTERVALS.includes(interval as CandleInterval)) return fail('Unknown interval');
    const n = Number(limit);
    try {
      return ok('ok', await market.candles(mint, interval as CandleInterval, Number.isFinite(n) ? n : 500));
    } catch (err) {
      return fail(`Chart load failed: ${(err as Error).message}`);
    }
  });

  // Incremental chart poll — only buckets at/after sinceTime, from the same
  // merged view as market:candles. Cheap: cache + tape, providers at most
  // once per bucket.
  ipcMain.handle('market:candlesTail', async (_e, mint: unknown, interval: unknown, sinceTime: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    if (!CANDLE_INTERVALS.includes(interval as CandleInterval)) return fail('Unknown interval');
    const t = Number(sinceTime);
    try {
      return ok('ok', await market.candlesTail(mint, interval as CandleInterval, Number.isFinite(t) ? t : 0));
    } catch (err) {
      return fail(`Chart tail failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('market:holders', async (_e, mint: unknown, limit: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    const n = Number(limit);
    try {
      return ok('ok', await market.holders(mint, Number.isFinite(n) ? Math.min(100, n) : 50));
    } catch (err) {
      return fail(`Holder load failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('market:trades', async (_e, mint: unknown, limit: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    const n = Number(limit);
    try {
      return ok('ok', await market.trades(mint, Number.isFinite(n) ? Math.min(200, n) : 60));
    } catch (err) {
      return fail(`Trade load failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('market:holderGraph', async (_e, mint: unknown, limit: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    const n = Number(limit);
    try {
      return ok('ok', await market.holderGraph_(mint, Number.isFinite(n) ? Math.min(60, n) : 40));
    } catch (err) {
      return fail(`Holder graph failed: ${(err as Error).message}`);
    }
  });

  // Deliberately a separate channel from `market:holderGraph`: this one
  // spends dozens of RPC calls and must only ever run because a human asked.
  ipcMain.handle('market:analyseHolders', async (_e, mint: unknown, limit: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    const n = Number(limit);
    try {
      return ok('ok', await market.analyseHolderGraph(mint, Number.isFinite(n) ? Math.min(60, n) : 40));
    } catch (err) {
      return fail(`Funding analysis failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('market:traderScan', async (_e, mint: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    try {
      return ok('ok', await market.traderScan(mint));
    } catch (err) {
      return fail(`Trader scan failed: ${(err as Error).message}`);
    }
  });

  // Launch intel: bundle / sniper cohorts and what they still hold. Cheap
  // enough to run on token-page open (1-2 provider calls + one RPC batch,
  // memoised), unlike the funding-cluster analysis next door.
  ipcMain.handle('market:launchIntel', async (_e, mint: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    try {
      return ok('ok', await market.launchIntel(mint));
    } catch (err) {
      return fail(`Launch analysis failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('market:creatorHistory', async (_e, creator: unknown) => {
    if (!isMint(creator)) return fail('Invalid creator address');
    try {
      return ok('ok', await market.creatorHistory(creator));
    } catch (err) {
      return fail(`Creator history failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('market:search', async (_e, query: unknown) => {
    if (typeof query !== 'string' || query.trim().length < 1) return ok('ok', []);
    try {
      return ok('ok', await market.search(query.slice(0, 100)));
    } catch (err) {
      return fail(`Search failed: ${(err as Error).message}`);
    }
  });

  // Tape subscription — the token page tells the engine which mint it has
  // open so sub-second candles get recorded for it. Bounded main-side.
  ipcMain.handle('market:watch', async (_e, mint: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    await market.watch(mint);
    return ok('watching');
  });

  ipcMain.handle('market:unwatch', (_e, mint: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    market.unwatch(mint);
    return ok('stopped');
  });

  ipcMain.handle('market:presets', () => ok('ok', market.presets()));

  ipcMain.handle('market:clearCache', () => {
    clearCache();
    market.clearChartCache();
    clearImageCache();
    return ok('Market data cache cleared');
  });

  // ── advanced orders (term.txt §2) ────────────────────────────────
  //
  // Creating an order is the only place the renderer can arrange for a
  // future signature, so the request is validated with the SAME function the
  // UI uses (shared/orders.ts) and then again by the engine, which owns the
  // per-trade cap and the reference price.

  ipcMain.handle('orders:list', () => ok('ok', getEngine().ordersSnapshot()));

  // ── Auto-sell templates ──────────────────────────────────────────
  const templatesPayload = (): { templates: unknown[]; activeId: string | null } => ({
    templates: templateStore.list(),
    activeId: templateStore.activeId(),
  });
  ipcMain.handle('templates:list', () => ok('ok', templatesPayload()));
  ipcMain.handle('templates:save', (_e, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return fail('Invalid template');
    const t = raw as import('@shared/orderTemplates').OrderTemplate;
    const clean: import('@shared/orderTemplates').OrderTemplate = {
      id: String(t.id ?? ''),
      name: String(t.name ?? '').slice(0, 40),
      stopLossPct: t.stopLossPct === null || t.stopLossPct === undefined ? null : Number(t.stopLossPct),
      trailingPct: t.trailingPct === null || t.trailingPct === undefined ? null : Number(t.trailingPct),
      sellOnDevSell: t.sellOnDevSell === true,
      takeProfits: Array.isArray(t.takeProfits)
        ? t.takeProfits.slice(0, 8).map((s) => ({ gainPct: Number(s?.gainPct), sellPct: Number(s?.sellPct) }))
        : [],
    };
    const r = templateStore.upsert(clean);
    return r.ok ? ok(r.message, templatesPayload()) : fail(r.message);
  });
  ipcMain.handle('templates:delete', (_e, id: unknown) => {
    if (typeof id !== 'string') return fail('Invalid template');
    const r = templateStore.remove(id);
    return r.ok ? ok(r.message, templatesPayload()) : fail(r.message);
  });
  ipcMain.handle('templates:setActive', (_e, id: unknown) => {
    if (id !== null && typeof id !== 'string') return fail('Invalid template');
    const r = templateStore.setActive(id);
    return r.ok ? ok(r.message, templatesPayload()) : fail(r.message);
  });

  ipcMain.handle('orders:create', async (_e, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return fail('Invalid order');
    const req = raw as NewOrderRequest;
    // `validateOrder` covers the kind, the amount and the trigger value; it
    // has never covered these three, and each one is persisted:
    //  · a mint passed on `length < 32` alone, so a 10,000-character
    //    non-base58 string was stored and re-serialised on every save;
    //  · an unknown basis was copied verbatim and then behaved as
    //    `price_sol` — the order fires on a number the user never meant;
    //  · `Number(req.expiresAt)` turned a non-numeric into NaN, which
    //    `?? null` happily kept, and every expiry comparison against NaN is
    //    false — the order simply never expired.
    if (!isAddress(req.mint)) return fail('Invalid mint address');
    if (!TRIGGER_BASES.includes(req.triggerBasis)) {
      return fail(`Trigger basis must be one of ${TRIGGER_BASES.join(', ')}`);
    }
    const expiresAtRaw = req.expiresAt === null || req.expiresAt === undefined ? null : Number(req.expiresAt);
    const clean: NewOrderRequest = {
      mint: req.mint,
      symbol: String(req.symbol ?? '').slice(0, 32),
      kind: req.kind,
      triggerValue: req.triggerValue === null || req.triggerValue === undefined ? null : Number(req.triggerValue),
      triggerBasis: req.triggerBasis,
      amount: Number(req.amount),
      // Unknown is null — never a NaN that quietly means "never expires".
      expiresAt: expiresAtRaw !== null && Number.isFinite(expiresAtRaw) ? expiresAtRaw : null,
    };
    if (expiresAtRaw !== null && !Number.isFinite(expiresAtRaw)) return fail('Expiry is not a valid time');
    const v = validateOrder(clean);
    if (!v.ok) return fail(v.message);
    const r = await getEngine().createOrder(clean);
    return r.ok ? ok(r.message, getEngine().ordersSnapshot()) : fail(r.message);
  });

  ipcMain.handle('orders:cancel', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid order id');
    const r = getEngine().cancelOrder(id);
    return r.ok ? ok(r.message, getEngine().ordersSnapshot()) : fail(r.message);
  });

  ipcMain.handle('orders:resume', () => {
    const r = getEngine().resumeOrders();
    return ok(r.message, getEngine().ordersSnapshot());
  });

  ipcMain.handle('orders:clearCompleted', () => {
    const r = getEngine().clearCompletedOrders();
    return ok(r.message, getEngine().ordersSnapshot());
  });

  // ── alerts (term.txt §17) ────────────────────────────────────────
  /**
   * Send a test post to this chain's runner webhook.
   *
   * A webhook nobody has tested is a webhook nobody knows is working, and the
   * failure mode is silence — indistinguishable from "no flags yet". The URL
   * is NOT taken from the renderer: it is read from the store, so this cannot
   * be used to make the app POST to an arbitrary host.
   */
  ipcMain.handle('runners:testWebhook', async (_e, chain: unknown) => {
    const c = chain === 'solana' || chain === 'robinhood' || chain === 'bnb' ? chain : null;
    if (!c) return fail('Unknown chain');
    const cur = store.load();
    const url = c === 'solana' ? (cur.strategy.runnerAlerts.webhookUrl ?? '') : (cur.evm[c]?.runnerAlerts?.webhookUrl ?? '');
    if (!url.trim()) return fail('No webhook saved for this chain yet.');
    const label = c === 'solana' ? 'Solana' : EVM_CHAIN_META[c].name;
    const res = await postFlag(url, {
      title: `Test from Krypto Bot — ${label} runner alerts`,
      body:
        `This is what a flagged runner will look like. Real posts carry the launch's buyer count, net inflow, ` +
        `curve progress and the graduation rate that bucket actually achieved, plus a link to the token.`,
      mint: '(test)',
      chainLabel: label,
      url: null,
    });
    return res.ok ? ok('Posted — check your Discord channel.') : fail(res.message);
  });

  /**
   * Measure the real round-trip friction of a pair. Two Jupiter quotes; no
   * wallet, no signing, nothing spent. The farming page refuses to show a
   * cost until this has answered — the guessed version of this number was
   * wrong by two orders of magnitude in the flattering direction.
   */
  ipcMain.handle('farming:probe', async (_e, mint: unknown, sizeSol: unknown) => {
    if (typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return fail('Invalid mint');
    const n = Number(sizeSol);
    if (!Number.isFinite(n) || n <= 0 || n > 1000) return fail('Size must be between 0 and 1000 SOL');
    const r = await probeRoundTrip(mint, n);
    return r.ok ? ok(r.message, r) : fail(r.message);
  });

  ipcMain.handle('alerts:list', () => ok('ok', getEngine().alertsSnapshot()));

  ipcMain.handle('alerts:create', (_e, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return fail('Invalid alert');
    const r = raw as NewAlertRequest;
    const clean: NewAlertRequest = {
      kind: r.kind,
      mint: String(r.mint ?? ''),
      symbol: String(r.symbol ?? '').slice(0, 32),
      threshold: r.threshold === null || r.threshold === undefined ? null : Number(r.threshold),
      repeat: r.repeat === true,
    };
    const v = validateAlert(clean);
    if (!v.ok) return fail(v.message);
    const res = getEngine().createAlert(clean);
    return res.ok ? ok(res.message, getEngine().alertsSnapshot()) : fail(res.message);
  });

  ipcMain.handle('alerts:remove', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid alert id');
    const r = getEngine().removeAlert(id);
    return r.ok ? ok(r.message, getEngine().alertsSnapshot()) : fail(r.message);
  });

  ipcMain.handle('alerts:mute', (_e, id: unknown, muted: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid alert id');
    const r = getEngine().muteAlert(id, muted === true);
    return r.ok ? ok(r.message, getEngine().alertsSnapshot()) : fail(r.message);
  });

  ipcMain.handle('alerts:clearFired', () => {
    const r = getEngine().clearFiredAlerts();
    return ok(r.message, getEngine().alertsSnapshot());
  });

  // ── portfolio (term.txt §13/§14) ─────────────────────────────────
  ipcMain.handle('portfolio:summary', async (_e, opts: unknown) => {
    try {
      // `stale: true` = the page wants to paint NOW: the last build for this
      // wallet, marked, with the fresh one following as a 'portfolio' event.
      // A fill-driven reload or the bots leave it off and await the rebuild.
      const wantStale = typeof opts === 'object' && opts !== null && (opts as { stale?: unknown }).stale === true;
      if (wantStale) {
        const fast = getEngine().portfolioSummaryFast();
        if (fast) return ok('ok', { ...fast.summary, stale: fast.stale, generatedAt: fast.generatedAt });
      }
      return ok('ok', await getEngine().portfolioSummary());
    } catch (err) {
      return fail(`Portfolio failed: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('portfolio:history', () => ok('ok', getEngine().tradeHistory()));

  // ── Share-card files (2026-09-06) ─────────────────────────────────────
  //
  // An animated card cannot be copied as an IMAGE — no clipboard carries an
  // animated image that way — so it travels as a FILE. The renderer encodes
  // the GIF; main writes it and either saves it where the user chose or
  // puts the file itself on the clipboard (Windows and macOS carry file
  // references; Linux falls back to a save). Bytes are validated, the name
  // is ours, and nothing here reads a path from the renderer.
  const CARD_MAX_BYTES = 25 * 1024 * 1024;
  const cardBytes = (raw: unknown): Buffer | null => {
    if (raw instanceof Uint8Array) return raw.byteLength > 0 && raw.byteLength <= CARD_MAX_BYTES ? Buffer.from(raw) : null;
    if (raw instanceof ArrayBuffer) return raw.byteLength > 0 && raw.byteLength <= CARD_MAX_BYTES ? Buffer.from(raw) : null;
    return null;
  };
  const cardName = (raw: unknown, ext: 'gif'): string => {
    const base = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) : '';
    return (base || 'krypt-card') + '.' + ext;
  };

  ipcMain.handle('card:saveFile', async (_e, name: unknown, bytes: unknown) => {
    const buf = cardBytes(bytes);
    if (!buf) return fail('Nothing to save');
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save animated card',
      defaultPath: path.join(app.getPath('downloads'), cardName(name, 'gif')),
      filters: [{ name: 'GIF', extensions: ['gif'] }],
    });
    if (res.canceled || !res.filePath) return fail('Save cancelled');
    try {
      fs.writeFileSync(res.filePath, buf);
      shell.showItemInFolder(res.filePath);
      return ok('Saved ' + path.basename(res.filePath));
    } catch (err) {
      return fail('Save failed: ' + (err as Error).message);
    }
  });

  ipcMain.handle('card:copyFile', (_e, name: unknown, bytes: unknown) => {
    const buf = cardBytes(bytes);
    if (!buf) return fail('Nothing to copy');
    const dir = path.join(app.getPath('temp'), 'krypto-bot-cards');
    let filePath: string;
    try {
      fs.mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, cardName(name, 'gif'));
      fs.writeFileSync(filePath, buf);
    } catch (err) {
      return fail('Could not write the file: ' + (err as Error).message);
    }
    try {
      if (process.platform === 'win32') {
        // CFSTR_FILENAMEW: a UTF-16 path with a terminating NUL. Explorer,
        // Discord, Telegram and Slack accept it as a pasted file.
        clipboard.writeBuffer('FileNameW', Buffer.from(filePath + '\0', 'ucs2'));
      } else if (process.platform === 'darwin') {
        clipboard.writeBuffer('public.file-url', Buffer.from('file://' + encodeURI(filePath)));
      } else {
        // No portable file clipboard on Linux; hand the user the file instead.
        shell.showItemInFolder(filePath);
        return ok('Animated GIF saved and shown in your file manager — this system has no file clipboard, so drag it in from there.', { path: filePath, clipboard: false });
      }
      return ok('Animated GIF copied as a file — paste it into Discord, Telegram, Slack or a folder. For X, use Save GIF and upload it.', { path: filePath, clipboard: true });
    } catch (err) {
      shell.showItemInFolder(filePath);
      return fail('Copy failed (' + (err as Error).message + '); the GIF was saved and shown in your file manager instead.');
    }
  });


  ipcMain.handle('portfolio:export', async (_e, format: unknown) => {
    const fmt = format === 'json' ? 'json' : 'csv';
    const rows = getEngine().tradeHistory();
    if (!rows.length) return fail('No trades to export');
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export trade history',
      defaultPath: `krypt-trades.${fmt}`,
      filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
    });
    if (res.canceled || !res.filePath) return fail('Export cancelled');
    try {
      const body = fmt === 'json' ? JSON.stringify(rows, null, 2) : toCsv(rows);
      fs.writeFileSync(res.filePath, body, 'utf8');
      return ok(`Exported ${rows.length} trade${rows.length === 1 ? '' : 's'}`);
    } catch (err) {
      return fail(`Export failed: ${(err as Error).message}`);
    }
  });

  // ── copy trading (term.txt §11) ──────────────────────────────────
  //
  // A config can arrange for future real trades, so the shape is cleaned and
  // re-validated main-side with the same function the form uses.
  ipcMain.handle('copy:list', () => ok('ok', getEngine().copySnapshot()));

  // ── Copy trading on the EVM chains ─────────────────────────────────
  //
  // The engine stays free of the rail; this is the bridge it copies through
  // on Robinhood Chain and BNB. Prices come from what the Observatory last
  // saw (its feed is the leader watcher on these chains), facts from the
  // rail's summary, and the gate is the chain's own arm switch.
  // The $KRYPTO fee waiver covers the EVM rails too. Injected here because
  // `evm/trade.ts` is kept free of the Solana half of the app.
  evmTrade.setFeeWaiver(() => kryptoHolding.feeWaived());

  getEngine().setEvmCopy({
    buy: async (chain, token, amountNative, walletId) => {
      const r = await evmRail.buy(chain, token, amountNative, false, { walletId });
      return { ok: r.ok, message: r.message, signature: r.hash ?? undefined, pending: r.stage === 'pending', spentSol: r.amountIn ? Number(BigInt(r.amountIn)) / 1e18 : undefined };
    },
    // `amountRaw` wins over the percent in the rail, which is the point: a
    // mirrored copy sell is sized from the base units the copy holds, not
    // from a share of a balance that also contains hand-bought bags.
    sell: async (chain, token, pct, walletId, amountRaw) => {
      const r = await evmRail.sell(chain, token, pct, false, { walletId, amountRaw });
      return { ok: r.ok, message: r.stage === 'pending' ? `broadcast but not confirmed in time — check Trades (${r.message})` : r.message, signature: r.hash ?? undefined };
    },
    // The three reads copy trading settles a position with: what this wallet
    // holds, what a confirmed transaction moved, and — for a copy opened
    // before quantities were tracked — the ledger's record of its buy.
    tokensOf: (chain, token, walletId) => evmRail.tokensOf(chain, token, walletId),
    fillTokens: (chain, hash) => evmRail.fillTokens(chain, hash),
    buyFill: async (chain, token, atMs, walletId) => evmRail.buyFill(chain, token, atMs, walletId),
    // A followed wallet on an EVM chain is seen ONLY through that chain's
    // scanner poll — there is no per-wallet subscription here the way Solana
    // has one. An armed copy config on a stopped scanner therefore watched
    // nothing, silently (2026-09-15). Enabling one starts the feed it needs;
    // `start` is idempotent and this never stops one the user started.
    leaderFeed: (chain) => {
      const st = evmScanner.status(chain);
      return { running: st.running, lastPollAt: st.lastPollAt || null };
    },
    ensureLeaderFeed: (chain) => {
      const r = evmScanner.start(chain);
      return r.ok ? null : r.message;
    },
    // A leader's balance, so an EVM sell whose size the log did not carry can
    // still be recovered exactly (`recoverFraction`). The bridge has declared
    // this since the rail was generalised; nothing ever implemented it, so
    // every such sell went unmirrored on both EVM chains.
    holdingOf: (chain, owner, token) => evmRail.holdingOf(chain, owner, token),
    blocked: (chain) => {
      const s = store.load();
      if (!s.evm[chain].enabled) return `${EVM_CHAIN_META[chain].name} is switched off in Settings`;
      if (!evmRail.armed(chain)) return `${EVM_CHAIN_META[chain].name} is in Paper — arm it on its wallet page`;
      return null;
    },
    maxLive: () => null,
    price: (chain, token) => evmScanner.lastPriceNative(chain, token),
    facts: async (chain, token) => {
      const sum = await evmRail.summary(chain, token);
      return { liquidityUsd: sum.liquidityUsd, marketCapUsd: sum.marketCapUsd, kryptScore: null, isPumpfun: false };
    },
    // The chain's own wallet, so a script's `walletSol` is that chain's coin
    // and not the Solana balance. balanceWei is a cached read; null stays null
    // so an unknown balance renders as an em dash and satisfies no rule.
    wallet: (chain) => {
      const addr = evmWallet.address(chain);
      if (!addr) return null;
      const wei = evmWallet.balanceWei(chain, addr);
      return { native: wei === null ? null : Number(wei) / 1e18, address: addr };
    },
    // Positions WITH basis, from the EVM ledger, so a script on that chain
    // can reason about its own PnL the way a Solana script does.
    positions: async (chain) => {
      const p = await evmRail.portfolio(chain);
      return p.positions.map((x) => ({
        token: x.token,
        symbol: x.symbol,
        amount: x.amount,
        priceNative: x.priceNative,
        basisKnown: x.basisKnown,
        costNative: x.costNative,
        avgEntryPriceNative: x.avgEntryPriceNative,
        unrealizedPnlNative: x.unrealizedPnlNative,
        unrealizedPnlPct: x.unrealizedPnlPct,
        firstBuyAt: x.firstBuyAt,
      }));
    },
    // What this install holds on the chain, so a live script on it lists its
    // OWN positions rather than the Solana wallet's.
    holdings: async (chain) => {
      const rows = await evmRail.holdings(chain);
      return rows.map((h) => ({ token: h.token, symbol: h.symbol, amount: h.amount, priceNative: h.priceNative }));
    },
  });
  evmScanner.setCurveLookup((chain, curve) => evmDiscover.tokenForCurve(chain, curve));

  ipcMain.handle('copy:save', (_e, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return fail('Invalid config');
    const r = raw as CopyConfig;
    // The chain decides which wallets are ours and what an address looks like.
    const copyChain: ChainKind = r.chain === 'robinhood' || r.chain === 'bnb' ? r.chain : 'solana';
    // The wallet the copies sign with: one of this install's ON THAT CHAIN,
    // or null for the active one. Checked here, where the wallet lists live.
    if (r.walletId !== undefined && r.walletId !== null) {
      const ours = copyChain === 'solana' ? wallet.list().some((w) => w.id === r.walletId) : evmWallet.list(copyChain).some((w) => w.id === r.walletId);
      if (typeof r.walletId !== 'string' || !ours) return fail('The wallet to copy with is not one of yours on that chain');
    }
    // The address is handed to the wallet watcher to open a live
    // subscription on, so it has to BE an address — `validateConfig` only
    // asks for 32 characters, and `copy:resetStats` 30 lines below has
    // always tested the real thing. Checked here rather than in
    // shared/copytrade.ts so the renderer's form and this handler cannot
    // disagree about what an address is (see the report: validateConfig is
    // the right long-term home).
    const walletAddr = String(r.wallet ?? '').trim();
    if (copyChain === 'solana' ? !isAddress(walletAddr) : !isEvmAddress(walletAddr)) return fail(`Enter a valid wallet address for ${copyChain === 'solana' ? 'Solana' : EVM_CHAIN_META[copyChain].name}`);
    const clean = {
      id: typeof r.id === 'string' && r.id ? r.id : undefined,
      // Both of these were checked above and then left out of the rebuild,
      // so neither survived a save. Without the chain, `validateConfig`
      // judged a 0x leader by Solana’s rules and refused a valid address:
      // following a leader on Robinhood or BNB was impossible from the form
      // that offers it. Without walletId, the wallet the user picked to copy
      // with fell back to the active signer.
      chain: copyChain,
      walletId: r.walletId ?? null,
      wallet: walletAddr,
      label: String(r.label ?? '').slice(0, 40),
      enabled: r.enabled === true,
      mode: r.mode === 'live' ? ('live' as const) : ('paper' as const),
      sizing: r.sizing === 'proportional' ? ('proportional' as const) : ('fixed' as const),
      sizeValue: Number(r.sizeValue),
      maxTradeSol: Number(r.maxTradeSol),
      minLiquidityUsd: r.minLiquidityUsd === null || r.minLiquidityUsd === undefined ? null : Number(r.minLiquidityUsd),
      maxMarketCapUsd: r.maxMarketCapUsd === null || r.maxMarketCapUsd === undefined ? null : Number(r.maxMarketCapUsd),
      minKryptScore: r.minKryptScore === null || r.minKryptScore === undefined ? null : Number(r.minKryptScore),
      onlyPumpfun: r.onlyPumpfun === true,
      delayMs: Number(r.delayMs) || 0,
      maxSlippagePct: Number(r.maxSlippagePct),
      copySells: r.copySells !== false,
      dailyLossLimitSol: Number(r.dailyLossLimitSol),
      dailyTradeLimit: Number(r.dailyTradeLimit),
      // The per-minute burst wall (shared/copytrade.ts). It was NOT carried
      // here, so the field never survived a save: every config silently ran
      // on DEFAULT_COPIES_PER_MINUTE and the user had no way to change it.
      // Absent stays absent — the engine reads that as the default — but a
      // value that is present is validated, never coerced to one.
      maxCopiesPerMinute:
        r.maxCopiesPerMinute === undefined || r.maxCopiesPerMinute === null ? null : Number(r.maxCopiesPerMinute),
    };
    const v = validateConfig(clean);
    if (!v.ok) return fail(v.message);
    const res = getEngine().upsertCopyConfig(clean);
    return res.ok ? ok(res.message, getEngine().copySnapshot()) : fail(res.message);
  });

  ipcMain.handle('copy:remove', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid id');
    const r = getEngine().removeCopyConfig(id);
    return r.ok ? ok(r.message, getEngine().copySnapshot()) : fail(r.message);
  });

  // Start a followed wallet's OWN record over (the configs and copies stay).
  ipcMain.handle('copy:resetStats', (_e, wallet: unknown) => {
    if (typeof wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return fail('Invalid wallet');
    const r = getEngine().resetCopyLeader(wallet);
    return r.ok ? ok(r.message, getEngine().copySnapshot()) : fail(r.message);
  });

  // Clear PAPER results only. Deliberately separate from `copy:remove`,
  // which deletes the config, its live history and the leader's record —
  // three things that were only ever bundled because there was no other
  // button (user report, 2026-09-13). Takes effect immediately; no restart.
  ipcMain.handle('copy:resetPaper', (_e, configId: unknown) => {
    if (configId !== undefined && configId !== null && typeof configId !== 'string') return fail('Invalid id');
    const id = typeof configId === 'string' && configId ? configId : undefined;
    const r = getEngine().resetCopyPaper(id);
    return r.ok ? ok(r.message, getEngine().copySnapshot()) : fail(r.message);
  });

  // ── user automation: rules and scripts ───────────────────────────
  ipcMain.handle('automation:list', () => ok('ok', automation.snapshot()));

  ipcMain.handle('automation:save', (_e, raw: unknown) => {
    // The renderer's object is a claim. Rebuild it field by field so a
    // script cannot arrive with a shape the validator never saw.
    if (typeof raw !== 'object' || raw === null) return fail('Invalid script');
    const r = raw as Record<string, unknown>;
    const budgetIn = (typeof r.budget === 'object' && r.budget !== null ? r.budget : {}) as Record<string, unknown>;
    const rulesIn = (typeof r.rules === 'object' && r.rules !== null ? r.rules : {}) as Record<string, unknown>;
    const conditions = Array.isArray(rulesIn.conditions)
      ? rulesIn.conditions.slice(0, MAX_CONDITIONS).map((c) => {
          const x = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
          return {
            field: String(x.field ?? '') as RuleCondition['field'],
            op: String(x.op ?? '') as RuleCondition['op'],
            value: typeof x.value === 'number' ? x.value : String(x.value ?? '').slice(0, 80),
          };
        })
      : [];
    const actions: RuleAction[] = [];
    if (Array.isArray(rulesIn.actions)) {
      for (const a of rulesIn.actions.slice(0, MAX_ACTIONS)) {
        const x = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
        const basis = x.basis === 'price_sol' ? ('price_sol' as const) : ('mcap_usd' as const);
        switch (x.type) {
          case 'buy':
            actions.push({ type: 'buy', sol: Number(x.sol) });
            break;
          case 'sell':
            actions.push({ type: 'sell', pct: Number(x.pct) });
            break;
          case 'sell_all':
          case 'cancel_orders':
          case 'watch':
          case 'unwatch':
          case 'disable_self':
            actions.push({ type: x.type });
            break;
          case 'stop_loss':
          case 'trailing_stop':
            actions.push({ type: x.type, pct: Number(x.pct) });
            break;
          case 'take_profit':
            actions.push({ type: 'take_profit', gainPct: Number(x.gainPct), sellPct: Number(x.sellPct) });
            break;
          case 'limit_buy':
            actions.push({ type: 'limit_buy', basis, value: Number(x.value), sol: Number(x.sol) });
            break;
          case 'limit_sell':
            actions.push({ type: 'limit_sell', basis, value: Number(x.value), pct: Number(x.pct) });
            break;
          case 'apply_template':
            actions.push({ type: 'apply_template', templateId: String(x.templateId ?? '').slice(0, 80) });
            break;
          case 'alert':
            actions.push({ type: 'alert', kind: String(x.kind ?? '') as RuleAction extends { type: 'alert'; kind: infer K } ? K : never, threshold: Number(x.threshold) });
            break;
          case 'notify':
          case 'log':
            actions.push({ type: x.type, message: String(x.message ?? '').slice(0, 200) });
            break;
          default:
            break;
        }
      }
    }
    const clean = {
      id: typeof r.id === 'string' && r.id ? r.id : undefined,
      name: String(r.name ?? '').trim().slice(0, 60),
      // The chain is the script's most consequential field: it decides which
      // events it hears and, live, which coin it spends. Rebuilding `clean`
      // without it silently filed every script under Solana - a new BNB
      // script became a Solana one, and the in-editor Chain picker could not
      // move a script at all (user report, 2026-09-18).
      chain: (r.chain === 'robinhood' || r.chain === 'bnb' ? r.chain : 'solana') as ChainKind,
      kind: r.kind === 'code' ? ('code' as const) : ('rules' as const),
      enabled: false, // arming is its own act (automation:setEnabled)
      mode: r.mode === 'live' ? ('live' as const) : ('paper' as const),
      code: typeof r.code === 'string' ? r.code : '',
      rules: {
        trigger: String(rulesIn.trigger ?? 'launch_update') as RuleSet['trigger'],
        conditions,
        actions,
        oncePerMint: rulesIn.oncePerMint !== false,
        cooldownSec: Number(rulesIn.cooldownSec) || 0,
        atHHMM: typeof rulesIn.atHHMM === 'string' ? rulesIn.atHHMM.slice(0, 5) : undefined,
      },
      budget: {
        maxSolPerTrade: Number(budgetIn.maxSolPerTrade),
        maxBuysPerDay: Number(budgetIn.maxBuysPerDay),
        maxLossSolPerDay: Number(budgetIn.maxLossSolPerDay),
        maxOpenPositions: Number(budgetIn.maxOpenPositions),
        maxActionsPerMinute: Number(budgetIn.maxActionsPerMinute),
      },
    };
    // An edit keeps the script's current armed state; the store decides.
    const existing = clean.id ? automation.all().find((s) => s.id === clean.id) : undefined;
    const res = automation.upsert({ ...clean, enabled: existing?.enabled ?? false });
    return res.ok ? ok(res.message, automation.snapshot()) : fail(res.message);
  });

  ipcMain.handle('automation:remove', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid id');
    const r = automation.remove(id);
    return r.ok ? ok(r.message, automation.snapshot()) : fail(r.message);
  });

  ipcMain.handle('automation:setEnabled', (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid id');
    const r = automation.setEnabled(id, enabled === true);
    return r.ok ? ok(r.message, automation.snapshot()) : fail(r.message);
  });

  ipcMain.handle('automation:killSwitch', (_e, on: unknown) => {
    const r = automation.setKillSwitch(on === true);
    return r.ok ? ok(r.message, automation.snapshot()) : fail(r.message);
  });

  // ── information hub ───────────────────────────────
  //
  // Paid placement and fresh token profiles, from a host the app already
  // contacts. The RAIL half of the hub needs no channel of its own: the
  // page assembles it from `market:providers` and the engine snapshot it
  // already reads, so nothing new is polled to draw it.
  ipcMain.handle('wire:boosts', async () => {
    const rows = await dexMeta.boostedTokens();
    return rows ? ok('ok', rows) : fail('DexScreener is not answering right now');
  });

  ipcMain.handle('wire:profiles', async () => {
    const rows = await dexMeta.tokenProfiles();
    return rows ? ok('ok', rows) : fail('DexScreener is not answering right now');
  });

  // ── pump.fun callouts (read-only intel) ──────────────────
  //
  // Nothing here trades, arms anything or spends a lamport, and no URL
  // crosses this boundary in either direction: the renderer asks for
  // callouts, main owns the host. A failed fetch is `fail(...)` so the panel
  // can say the feed is unreachable instead of showing an empty list, which
  // would read as "nobody is calling anything".
  ipcMain.handle('callouts:feed', async () => {
    const rows = await callouts.calloutFeed();
    return rows ? ok('ok', rows) : fail('pump.fun callouts are not answering right now');
  });

  ipcMain.handle('callouts:forMint', async (_e, mint: unknown, chain: unknown) => {
    const c = chain === 'robinhood' || chain === 'bnb' ? chain : 'solana';
    const m = typeof mint === 'string' ? mint.trim() : '';
    // Solana mints are base58 addresses; the EVM chains are 0x addresses.
    // Checked here so a malformed string never becomes a path segment.
    if (c === 'solana' ? !isAddress(m) : !isEvmAddress(m)) return fail('Invalid token address');
    const rows = await callouts.calloutsForMint(m, c);
    return rows ? ok('ok', rows) : fail('pump.fun callouts are not answering right now');
  });
  // ── log ──────────────────────────────────────────────────────────
  ipcMain.handle('log:recent', () => ok('ok', logger.recent()));
}

/**
 * Make the engine's armed state match the persisted trading mode.
 *
 * Live is the default mode, so at boot — and the moment a wallet exists —
 * the engine arms itself; the user never has to "go live" to trade. The
 * reverse direction is handled by engine.onDisarm (main.ts): any disarm,
 * whether the user's or a safety breaker's, persists liveEnabled=false so the
 * top bar shows Paper only when the app is actually in Paper.
 */
export function syncLiveMode(): void {
  const s = store.load();
  const eng = getEngine();
  if (!s.execution.liveEnabled) return;
  if (!wallet.exists()) return; // no signer yet — stays Paper until one exists
  if (eng.liveState().armed) return;
  const r = eng.arm(true);
  logger.info(r.ok ? 'trading mode: LIVE (default)' : `trading mode: could not arm — ${r.message}`);
}
