// ALL ipcMain.handle() channels live in this ONE file (guidelines §4.3) —
// the greppable contract between main and renderer. Handlers never throw
// across IPC; they return { ok, message, data? }.

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRpc, type AppSettings, type EngineEvent, type IpcResult } from '@shared/types';
import * as store from './system/settings-store';
import { validateSettingsPatch } from './system/settingsValidation';
import type { AiAnalysis } from '@shared/ai';
import * as wallet from './system/wallet';
import * as fund from './engine/fund';
import * as randomLab from './engine/randomLab';
import * as lab from '@shared/lab';
import { getBalance } from './engine/rpcClient';
import * as bots from './system/bots';
import * as heliusBudget from './system/heliusBudget';
import * as integrityGuard from './system/integrityGuard';

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
import { validateOrder, type NewOrderRequest } from '@shared/orders';
import { validateAlert, type NewAlertRequest } from '@shared/alerts';
import { toCsv } from '@shared/portfolio';
import { validateConfig, type CopyConfig } from '@shared/copytrade';

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
      (ev) => broadcast(ev),
    );
  }
  return engine;
}

function broadcast(ev: EngineEvent): void {
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
    try {
      wc.send('engine:event', ev);
    } catch {
      /* frame disposed between the check and the send — drop this event */
    }
  }
  if (ev.kind === 'log') logger[ev.level](ev.line);
}

const ok = <T>(message: string, data?: T): IpcResult<T> => ({ ok: true, message, data });
const fail = (message: string): IpcResult<never> => ({ ok: false, message });

export function registerIpc(): void {
  // Construct the engine eagerly. It is otherwise built on first use, and
  // the terminal's data layer gets its context from the engine constructor —
  // a Discover call before the engine existed would throw "context not
  // attached" on a cold start with the engine stopped.
  getEngine();
  // Recorder mode follows the firehose switch: off = launch tape (creates,
  // first 30 min of trades per mint, completions, health), on = everything.
  recorder.setMode(store.load().recordFirehose ? 'firehose' : 'launch');

  // ── app ──────────────────────────────────────────────────────────
  ipcMain.handle('app:version', () => ok('ok', app.getVersion()));

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
        void import('./engine/rpcClient').then((m) => m.clearRpcRejections());
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
    return r.ok ? ok(r.message) : fail(r.message);
  });

  ipcMain.handle('engine:snapshot', () => ok('ok', getEngine().snapshot()));

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
    if (r.ok) syncLiveMode();
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  ipcMain.handle('wallet:import', (_e, secret: string, label: unknown) => {
    if (typeof secret !== 'string') return fail('Invalid key');
    const r = wallet.importSecret(secret, typeof label === 'string' ? label : '');
    if (r.ok) syncLiveMode();
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
      return [
        `Engine: ${st.running ? 'running' : 'stopped'}`,
        `Feed: ${st.feed}`,
        `Live trading: ${live.armed ? 'ARMED' : 'disarmed'}`,
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

  ipcMain.handle('rpc:credits', () => ok('ok', heliusBudget.current()));

  // Whether an endpoint is currently refusing our key. Polled by the panel
  // the key is pasted into, so the answer appears where the fix is made.
  ipcMain.handle('rpc:health', async () => {
    const m = await import('./engine/rpcClient');
    return ok('ok', { rejected: m.rpcCredentialsRejected() });
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
  ipcMain.handle('lab:setFollow', (_e, groupId: unknown, cfg: unknown) => {
    if (typeof groupId !== 'string') return fail('Invalid group');
    const g = wallet.groups().find((x) => x.id === groupId);
    if (!g) return fail('No such group');
    const next = pickLab(lab.DEFAULT_FOLLOW, g.lab?.follow, cfg);
    const v = lab.validateFollow(next);
    if (!v.ok) return fail(v.message);
    const r = wallet.setGroupLab(groupId, { follow: next, random: g.lab?.random ?? { ...lab.DEFAULT_RANDOM } });
    return r.ok ? ok(r.message, wallet.groups()) : fail(r.message);
  });
  ipcMain.handle('lab:setRandom', (_e, groupId: unknown, cfg: unknown) => {
    if (typeof groupId !== 'string') return fail('Invalid group');
    const g = wallet.groups().find((x) => x.id === groupId);
    if (!g) return fail('No such group');
    const next = pickLab(lab.DEFAULT_RANDOM, g.lab?.random, cfg);
    const v = lab.validateRandom(next);
    if (!v.ok) return fail(v.message);
    const r = wallet.setGroupLab(groupId, { follow: g.lab?.follow ?? { ...lab.DEFAULT_FOLLOW }, random: next });
    return r.ok ? ok(r.message, wallet.groups()) : fail(r.message);
  });
  ipcMain.handle('lab:fund', async (_e, targets: unknown) => {
    if (!getEngine().liveState().armed || !store.load().execution.liveEnabled) return fail('Arm live execution first — funding moves real SOL');
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 20) return fail('Pick 1–20 wallets');
    const byId = new Map(wallet.list().map((w) => [w.id, w.publicKey]));
    const resolved: Array<{ publicKey: string; lamports: number }> = [];
    const seen = new Set<string>();
    let totalLamports = 0;
    for (const t of targets as Array<{ walletId?: unknown; sol?: unknown }>) {
      const pk = typeof t?.walletId === 'string' ? byId.get(t.walletId) : undefined;
      const sol = Number(t?.sol);
      if (!pk) return fail('A target is not one of your wallets');
      if (seen.has(pk)) return fail('A wallet is listed twice');
      seen.add(pk);
      if (!(sol > 0) || !Number.isFinite(sol) || sol > 50) return fail('Amount per wallet must be between 0 and 50 SOL');
      const lamports = Math.round(sol * 1e9);
      totalLamports += lamports;
      resolved.push({ publicKey: pk, lamports });
    }
    if (totalLamports > lab.MAX_FUND_BATCH_LAMPORTS) return fail(`Fund at most ${lab.MAX_FUND_BATCH_LAMPORTS / 1e9} SOL per batch`);
    const httpUrl = resolveRpc(store.load().rpc).heliusHttpUrl ?? store.load().rpc.httpUrl;
    const r = await fund.fundWallets(httpUrl, resolved);
    logger.info(`lab fund: ${r.message}${r.signature ? ` ${r.signature.slice(0, 12)}…` : ''}`);
    const data = { signature: r.signature ?? '', sentSol: r.sentLamports / 1e9, count: r.count };
    // A partial outcome carries what DID leave the wallet, with its signature.
    return r.ok ? ok(r.message, data) : { ok: false as const, message: r.message, data };
  });
  ipcMain.handle('lab:collect', async (_e, walletIds: unknown) => {
    if (!getEngine().liveState().armed || !store.load().execution.liveEnabled) return fail('Arm live execution first — collecting moves real SOL');
    if (!Array.isArray(walletIds) || walletIds.length === 0 || walletIds.length > 20 || !walletIds.every((x) => typeof x === 'string')) return fail('Pick 1–20 wallets');
    const httpUrl = resolveRpc(store.load().rpc).heliusHttpUrl ?? store.load().rpc.httpUrl;
    const r = await fund.collectToActive(httpUrl, walletIds as string[]);
    const landed = r.filter((x) => x.ok).length;
    logger.info(`lab collect: ${landed}/${r.length} wallet(s) sent back`);
    return ok(`${landed}/${r.length} collected`, r.map((x) => ({ walletId: x.walletId, ok: x.ok, message: x.message, sol: x.lamports / 1e9, signature: x.signature })));
  });
  ipcMain.handle('lab:randomStart', (_e, groupId: unknown, walletIds: unknown) => {
    if (typeof groupId !== 'string') return fail('Invalid group');
    if (walletIds !== undefined && walletIds !== null && !(Array.isArray(walletIds) && walletIds.every((x) => typeof x === 'string'))) return fail('Invalid wallet list');
    if (!getEngine().liveState().armed || !store.load().execution.liveEnabled) return fail('Arm live execution first — random trading spends real SOL');
    const r = randomLab.start(groupId, Array.isArray(walletIds) ? (walletIds as string[]) : undefined);
    return r.ok && r.status ? ok(r.message, r.status) : fail(r.message);
  });
  ipcMain.handle('lab:randomStop', (_e, groupId: unknown) => {
    if (typeof groupId !== 'string') return fail('Invalid group');
    const r = randomLab.stop(groupId);
    return r.ok && r.status ? ok(r.message, r.status) : fail(r.message);
  });
  ipcMain.handle('lab:status', () => ok('ok', getEngine().labStatus()));
  ipcMain.handle('wallet:refreshAll', async () => {
    const noted = await getEngine().refreshAllBalances();
    return ok(`${noted} balance(s) read`, wallet.list());
  });
  ipcMain.handle('live:fanoutSell', async (_e, mint: unknown, walletIds: unknown, opts: unknown) => {
    if (typeof mint !== 'string' || mint.length < 32) return fail('Invalid mint address');
    if (!Array.isArray(walletIds) || walletIds.length === 0 || walletIds.length > 20 || !walletIds.every((x) => typeof x === 'string')) return fail('Pick 1–20 wallets');
    const own = new Set(wallet.list().map((w) => w.id));
    if (!(walletIds as string[]).every((id) => own.has(id))) return fail('A wallet is not one of yours');
    const o = (opts && typeof opts === 'object' ? opts : {}) as { staggerMaxMs?: unknown };
    try {
      const res = await getEngine().fanoutSell(mint, walletIds as string[], { staggerMaxMs: typeof o.staggerMaxMs === 'number' ? o.staggerMaxMs : undefined });
      return res.ok ? ok(res.message, res) : { ok: false, message: res.message, data: res };
    } catch (err) {
      return fail(`Fan-out sell error: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('live:fanoutBuy', async (_e, mint: unknown, walletIds: unknown, sizing: unknown, opts: unknown) => {
    if (typeof mint !== 'string' || mint.length < 32) return fail('Invalid mint address');
    if (!Array.isArray(walletIds) || walletIds.length === 0 || walletIds.some((w) => typeof w !== 'string')) {
      return fail('Select at least one wallet');
    }
    const sz = sizing as { mode?: unknown; amountSol?: unknown; jitter?: unknown } | null;
    const mode = sz?.mode === 'total' ? 'total' : 'same';
    const amountSol = Number(sz?.amountSol);
    if (!Number.isFinite(amountSol) || amountSol <= 0) return fail('Amount must be positive');
    const jitter = Number(sz?.jitter);
    const staggerMaxMs = Number((opts as { staggerMaxMs?: unknown } | null)?.staggerMaxMs);
    try {
      const res = await getEngine().fanoutBuy(
        mint,
        walletIds as string[],
        { mode, amountSol, jitter: Number.isFinite(jitter) ? jitter : 0 },
        { staggerMaxMs: Number.isFinite(staggerMaxMs) ? staggerMaxMs : 0 },
      );
      return res.ok ? ok(res.message, res) : { ok: false, message: res.message, data: res };
    } catch (err) {
      return fail(`Fan-out error: ${(err as Error).message}`);
    }
  });

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
    const clean: NewOrderRequest = {
      mint: String(req.mint ?? ''),
      symbol: String(req.symbol ?? '').slice(0, 32),
      kind: req.kind,
      triggerValue: req.triggerValue === null || req.triggerValue === undefined ? null : Number(req.triggerValue),
      triggerBasis: req.triggerBasis,
      amount: Number(req.amount),
      expiresAt: req.expiresAt === null || req.expiresAt === undefined ? null : Number(req.expiresAt),
    };
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
  ipcMain.handle('portfolio:summary', async () => {
    try {
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

  ipcMain.handle('copy:save', (_e, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return fail('Invalid config');
    const r = raw as CopyConfig;
    const clean = {
      id: typeof r.id === 'string' && r.id ? r.id : undefined,
      wallet: String(r.wallet ?? '').trim(),
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
