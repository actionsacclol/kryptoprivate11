// ALL ipcMain.handle() channels live in this ONE file (guidelines §4.3) —
// the greppable contract between main and renderer. Handlers never throw
// across IPC; they return { ok, message, data? }.

import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, session, shell } from 'electron';
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
import { KRYPTO_HOLDER_TOKENS } from '@shared/krypto';
import * as store from './system/settings-store';
import { validateSettingsPatch } from './system/settingsValidation';
import type { AiAnalysis } from '@shared/ai';
import * as wallet from './system/wallet';
import { evmPrivateKeyAtPath, normaliseSeedPhrase, seedPhraseProblem, solanaSeedAtPath } from './system/seedPhrase';
import { base58Decode } from './chain/base58';
import { Keypair } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import * as aioWallet from './system/aioWallet';
import { aioBalances } from './engine/aioBalances';
import * as solanaSend from './engine/send';
import * as evmSend from './evm/send';
import { sendRequestOf, type SendRequest, type SendResult, type SendReview } from '@shared/send';
import * as sendBook from './system/sendBook';
import { checkRecipient, cleanLabel, familyOf, recipientWarnings } from '@shared/sendBook';
import { FLOAT_COOLDOWN_MS, FLOAT_MAX_FAILURES, FLOAT_MAX_PER_DAY, nextFloatRefill } from '@shared/aioFloat';
import { KNOWN_MINTS } from '@shared/swap';
import * as fund from './engine/fund';
import * as lab from '@shared/lab';
import { getAccountInfo, getBalance, getMultipleAccountInfo, getTokenBalanceForMint } from './chain/rpcClient';
import * as kryptoMode from './engine/kryptoMode';
import * as kryptoTrader from './engine/kryptoTrader';
import type { TraderEvmHost, TraderLedgerFill, TraderMarket } from './engine/kryptoTrader';
import { EMPTY_MARKET_FACTS, TRADER_ID_RE, TRADER_OWN_COIN_MESSAGE, TRADER_OWN_COIN_MESSAGE_EVM, traderOptionsOf, type TraderFit, type TraderLimits, type TraderMarketFacts, type TraderParamsByPreset } from '@shared/kryptoTrader';
import * as evmLedger from './evm/ledger';
import { readTraderMarket } from './evm/traderMarket';
import { walletVisibleOn, type EvmFill } from '@shared/evm';
import { traderFit } from '@shared/botStrategy';
import { curveRegime } from '@shared/odds';
import * as pumpChain from './data/pumpChain';
import * as tape from './data/tape';
import * as advOrders from './engine/advOrders';
import * as copyTrade from './engine/copyTrade';
import * as ledger from './engine/ledger';
import { curveProgressTokenPct } from './engine/curve';
import { parseMintExtensions } from './engine/mintExtensions';
import { kryptoOptionsOf, withKryptoDisclosure } from '@shared/kryptoMode';
import * as bots from './system/bots';
import * as heliusBudget from './system/heliusBudget';
import * as integrityGuard from './system/integrityGuard';
import * as evmRail from './evm/rail';
import * as evmScanner from './evm/scanner';
import * as tokenDiscovery from './evm/tokenDiscovery';
import { resolveVenue } from './evm/venue';
import { CHAINS } from './evm/chains';

// ── EVM prices for scripts and paper (2026-10-03) ─────────────────────
// The chain scanner hears bonding-curve trades only: a graduated coin had no
// price at all, and a curve print never expired, so a coin that graduated
// kept its graduation price. The newer of the curve print and the market
// summary's price wins; the summary is cached here and refreshed in the
// background, so the synchronous read never waits on the network.
const evmPx = new Map<string, { price: number; at: number }>();
/** Symbol and name from the same read — identity only, never market facts. */
const evmIdentity = new Map<string, { symbol: string; name: string }>();
const evmPxBusy = new Set<string>();
const EVM_PX_REFRESH_MS = 15_000;
/** A summary price older than this is not a price (the curve print still is). */
const EVM_PX_MAX_AGE_MS = 120_000;
function evmPxKey(chain: string, token: string): string {
  return `${chain}:${token.toLowerCase()}`;
}
async function evmPxRefresh(chain: EvmChainKind, token: string): Promise<void> {
  const k = evmPxKey(chain, token);
  if (evmPxBusy.has(k)) return;
  evmPxBusy.add(k);
  try {
    const s = await evmRail.summary(chain, token);
    if (s.priceSol !== null && Number.isFinite(s.priceSol) && s.priceSol > 0) evmPx.set(k, { price: s.priceSol, at: Date.now() });
    if (s.symbol) {
      if (evmIdentity.size > 2_000) evmIdentity.clear();
      evmIdentity.set(k, { symbol: s.symbol, name: s.name || s.symbol });
    }
  } catch {
    /* unknown stays unknown */
  } finally {
    evmPxBusy.delete(k);
  }
}
/**
 * Is this curve quoted in the chain's own coin? Pons curves on Robinhood can
 * be quoted in USDG or a tokenised stock, and a print from one is not an ETH
 * price (v6 audit 2026-10-03). A launch's pair never changes, so this is
 * learned once per token; until it is known the print is not used.
 */
const curveNative = new Map<string, boolean>();
const curveNativeAsked = new Set<string>();
function curveQuoteNative(chain: EvmChainKind, token: string): boolean | null {
  if (chain !== 'robinhood') return true; // BNB prints are gated on quoteKind in the scanner
  const k = evmPxKey(chain, token);
  const v = curveNative.get(k);
  if (v !== undefined) return v;
  if (!curveNativeAsked.has(k)) {
    curveNativeAsked.add(k);
    void resolveVenue('robinhood', token as `0x${string}`)
      .then((ven) => {
        if (curveNative.size > 5_000) curveNative.clear();
        curveNative.set(k, !ven.record || ven.record.pairToken.toLowerCase() === NATIVE_ADDRESS.toLowerCase());
      })
      .catch(() => curveNativeAsked.delete(k));
  }
  return null;
}
function evmPriceNative(chain: EvmChainKind, token: string): number | null {
  const now = Date.now();
  const curve = curveQuoteNative(chain, token) === true ? evmScanner.lastPrint(chain, token) : null;
  const sum = evmPx.get(evmPxKey(chain, token)) ?? null;
  if (!sum || now - sum.at > EVM_PX_REFRESH_MS) void evmPxRefresh(chain, token);
  const live = sum && now - sum.at <= EVM_PX_MAX_AGE_MS ? sum : null;
  if (curve && live) return curve.at >= live.at ? curve.price : live.price;
  return curve?.price ?? live?.price ?? null;
}
async function evmPriceFresh(chain: EvmChainKind, token: string): Promise<number | null> {
  const sum = evmPx.get(evmPxKey(chain, token));
  if (!sum || Date.now() - sum.at > 30_000) await evmPxRefresh(chain, token);
  return evmPriceNative(chain, token);
}
const evmBalanceAsked = new Map<string, number>();
function evmBalanceKick(chain: EvmChainKind): void {
  const last = evmBalanceAsked.get(chain) ?? 0;
  if (Date.now() - last < 10_000) return;
  evmBalanceAsked.set(chain, Date.now());
  void evmWallet.refreshBalance(chain).catch(() => undefined);
}
import * as walletScout from './engine/walletScout';
import * as scoutScan from './engine/scoutScan';
import * as walletHistory from './engine/walletHistory';
import * as mcpServer from './system/mcpServer';
import * as diagnostics from './system/diagnostics';
import * as httpLayer from './data/http';
import * as mcpTools from './engine/mcpTools';
import { setTraderClaimCheck } from './engine/traderClaims';
import { MCP_ACCESS_LEVELS, MCP_PORT_MAX, MCP_PORT_MIN, mcpAddCommand, mcpJsonConfig, mcpServerNameFor, type McpAccess } from '@shared/mcp';
import * as profiles from './system/profiles';
import { sourceFor as scoutSourceFor } from './engine/scoutScanSources';
import * as evmWallet from './evm/evmWallet';
import { SCOUT_CHAINS, SCOUT_SCAN_HOURS, SCOUT_SORTS, applyScoutFilters, emptyRow, rankScout, scoutFiltersAllOn, summarise, type ScoutChain, type ScoutScanHours, type ScoutSort, type ScoutWindow } from '@shared/walletScout';
import * as evmDiscover from './evm/discover';
import * as evmMarket from './evm/market';
import * as merkl from './data/providers/merkl';
import * as callouts from './data/providers/pumpCallouts';
import { newestFirst } from '@shared/callouts';
import { REPLY_BUDGET, THESIS_BUDGET } from '@shared/calloutAuto';
import { nameListProblem } from '@shared/pumpStats';

/** Most accounts one bulk call may touch. A loop in main is still a loop. */
const MAX_BULK = 40;
import { looksLikeSolAddress } from '@shared/fees';
import * as dexMeta from './data/providers/dexscreenerMeta';
import { clearRpcRejection, client as evmClient } from './evm/client';
import { nativeUsd as evmNativeUsd } from './evm/prices';
import * as aioBuy from './engine/aioBuy';
import { AIO_CHAIN_LABEL, AIO_CHAINS, AIO_EVM_PATHS, AIO_SOLANA_PATHS, aioEvmPath, aioSolanaPath, isAioPathChoice, type AioChain, type AioScanRow } from '@shared/aio';
import { CHAIN_RESERVE, REFUEL_USD } from '@shared/aioConvert';
import { COMPRESS_COIN, COMPRESS_KEEP, describeCompress, excludeKey, planCompress, safeSymbol, type CompressPlan } from '@shared/aioCompress';
import { KRYPTO_TOKEN } from '@shared/krypto';
import { EVM_CHAINS, EVM_CHAIN_META, NATIVE_ADDRESS, isEvmAddress, isEvmChain, type EvmChainKind, type ChainKind } from '@shared/evm';
import * as launcher from './engine/launcher';
import type { LaunchDeps } from './engine/launcher';
import { MAX_DESCRIPTION, MAX_NAME, MAX_SYMBOL, type LaunchDraft } from '@shared/launch';
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, uploadLaunchMetadata, uploadProfileImage, type MetadataFields } from './system/launchMeta';
import * as updateCheck from './system/updateCheck';
import * as pumpFees from './engine/pumpFees';
import * as pumpAuth from './system/pumpAuth';
import * as pumpProfile from './system/pumpProfile';
import * as pumpSocial from './system/pumpSocial';
import * as swap from './engine/swap';
import * as usdcSweep from './engine/usdcSweep';
import { USDC_MINT } from './engine/tokenWithdraw';
import * as bridge from './engine/bridge';
import type { BridgeDraft, BridgeQuote } from '@shared/bridge';
import { HARD_FLOOR_USD } from '@shared/bridge';
import { WSOL_MINT, type SwapDraft } from '@shared/swap';

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
import { LOG_FILE, logger } from './system/logger';
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
import * as xStats from './data/xStats';
import { validateXStats } from '@shared/xStats';
import * as linkIntel from './data/linkIntel';
import * as siteReadStore from './data/siteRead';
import { validateSiteRead } from '@shared/siteRead';
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
import { cleanBlocklist, validateConfig, type CopyConfig, FOMO_WALLET, type FomoSource } from '@shared/copytrade';
import * as automation from './engine/automation';
import { MAX_ACTIONS, MAX_CONDITIONS, type RuleAction, type RuleCondition, type RuleSet } from '@shared/automation';
import { coerceInputs, parseInputs } from '@shared/scriptInputs';

let engine: SniperEngine | null = null;


/**
 * What a newly signed-in pump account needs before it is fully usable:
 * `/users/register` (follows and likes are refused without it — see
 * shared/pumpSocial.ts), then the bio line if the bio is empty. In that order,
 * because a profile write to an unregistered account is the thing most likely
 * to be refused.
 */
async function settlePumpAccount(walletId: string): Promise<void> {
  await pumpSocial.ensureRegistered(walletId);
  // Krypt's referral, inside pump's 24 h window (shared/pumpReferral.ts).
  // Disclosed in the terms and where accounts are made; not a setting.
  await pumpSocial.applyReferral(walletId);
  await pumpProfile.stampEmptyBio(walletId);
}
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
        // A tick for a mint only a SCRIPT follows (engine ticksWanted) is the
        // script's business: the window charts tape-subscribed mints only,
        // and forty watched runners at up to 8 ticks a second each is IPC the
        // renderer would route and throw away.
        if (ev.kind !== 'tick' || tape.isSubscribed(ev.mint)) broadcast(ev);
        // The window no longer pops most engine notices up (2026-09-29), so
        // the Console is where they are kept.
        if (ev.kind === 'toast') logger[ev.level === 'success' ? 'info' : ev.level](`[notice] ${ev.message}`);
        // A fill, real or paper, dates the kept portfolio build.
        if ((ev.kind === 'fill' && ev.state !== 'failed') || ev.kind === 'paper') engine?.markPortfolioDirty();
        // User scripts see the same events the UI does, after it.
        automation.onEngineEvent(ev);
        // The active wallet's token accounts changed — a USDC reward landing
        // is exactly that. The sweep looks soon rather than at its next poll.
        if (ev.kind === 'holdings') usdcSweep.kick();
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

/**
 * A native confirmation attached to the window that asked for it. Parentless,
 * Windows can open the box BEHIND the app: the page then waits on a dialog the
 * user never sees, and an edit they believe they saved was never saved
 * (user report 2026-10-03 — a withdrawal went to the old address).
 */
/**
 * On Linux with no keyring Chromium falls back to 'basic_text': "encrypted"
 * with a fixed built-in key, so a stored phrase would in effect be plain text
 * — and one phrase opens every chain. Refused there with a way out; unknown
 * is not fine either (v6 audit 2026-10-03). Windows and macOS always have a
 * real store (DPAPI, Keychain).
 */
function weakKeyStore(): string | null {
  if (process.platform !== 'linux') return null;
  let backend = 'unknown';
  try {
    backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.() ?? 'unknown';
  } catch {
    /* stays unknown */
  }
  if (backend === 'basic_text' || backend === 'unknown') {
    return 'This system has no secure key store (no keyring is running), so Krypto Bot will not save a recovery phrase it cannot really encrypt. Install or unlock GNOME Keyring or KWallet, restart Krypto Bot, and try again.';
  }
  return null;
}

function confirmNative(sender: Electron.WebContents, opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = BrowserWindow.fromWebContents(sender);
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

/** The address(es) a pasted secret would add — derived here, for the
 *  confirmation only. Null when it does not parse (the import itself then
 *  refuses it with its own message). Never logged. */
function solanaAddressOfSecret(input: string): string | null {
  try {
    const t = input.trim();
    let seed: Uint8Array;
    if (t.startsWith('[')) seed = new Uint8Array(JSON.parse(t) as number[]).slice(0, 32);
    else {
      const bytes = base58Decode(t);
      seed = bytes.length >= 64 ? bytes.slice(0, 32) : bytes;
    }
    return seed.length === 32 ? Keypair.fromSeed(seed).publicKey.toBase58() : null;
  } catch {
    return null;
  }
}
function evmAddressOfSecret(input: string): string | null {
  const bare = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(bare)) return null;
  try {
    return privateKeyToAccount(`0x${bare.toLowerCase()}`).address;
  } catch {
    return null;
  }
}
function addressesOfPhrase(input: string, paths?: { solana: string; evm: string }): string[] | null {
  try {
    if (seedPhraseProblem(input)) return null;
    const phrase = normaliseSeedPhrase(input);
    const seed = solanaSeedAtPath(phrase, aioSolanaPath(paths?.solana));
    const key = evmPrivateKeyAtPath(phrase, aioEvmPath(paths?.evm));
    const sol = Keypair.fromSeed(seed).publicKey.toBase58();
    const evm = privateKeyToAccount(`0x${Buffer.from(key).toString('hex')}`).address;
    seed.fill(0);
    key.fill(0);
    return [sol, evm];
  } catch {
    return null;
  }
}

/**
 * The gate on every key import (swarm 2026-10-03). Page content cannot press
 * a native dialog, so a compromised renderer can no longer slip in a key it
 * knows and then move funds to it as "your own wallet".
 */
async function confirmImport(sender: Electron.WebContents, what: string, addresses: string[]): Promise<boolean> {
  const { response } = await confirmNative(sender, {
    type: 'warning',
    buttons: ['Cancel', 'Import'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Confirm import',
    message: `Add ${what} to Krypto Bot?`,
    detail:
      `${addresses.length > 1 ? 'Addresses' : 'Address'}:\n${addresses.join('\n')}\n\n` +
      'A wallet added here can sign trades, and money can be moved to it from your other wallets without asking again. ' +
      'Only import a key you control. If you did not just paste a key into Krypto Bot, press Cancel.',
  });
  if (response !== 1) logger.warn(`import of ${what} cancelled at the confirmation dialog`);
  return response === 1;
}

/**
 * The execution endpoint: the user's fast / Helius URL when they set one,
 * else the public one. `execHttpUrl` is DERIVED by resolveRpc() and never
 * stored, so `s.rpc.execHttpUrl` read straight off store.load() is ALWAYS
 * undefined — every IPC money path (Swap, Bridge and AIO moves, top-ups,
 * Send, launches, fund/collect, USDC withdraw, creator fees) ran on the
 * public RPC whatever the user configured (swarm 2026-10-03). Always resolve.
 */
export const execUrlOf = (rpc: Parameters<typeof resolveRpc>[0]): string => resolveRpc(rpc).execHttpUrl ?? rpc.httpUrl;

/** The Solana endpoint a bridge reads and sends on — the same one trades use. */
export function bridgeDeps(): bridge.BridgeDeps {
  const s = store.load();
  // The referrers ride along for Krypt's fee on a transfer (a fifth of it,
  // exactly as on a trade) — Solana's for a Solana source, the EVM one else.
  return { httpUrl: execUrlOf(s.rpc), referrer: s.referrer ?? '', evmReferrer: s.evm?.referrer ?? '', speed: s.aio?.speed ?? 'normal' };
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

/** Clears the float's failure stop (set inside registerIpc). */
let aioFloatReset: () => void = () => undefined;

/** The All-in-One recovery phrase has been on screen this session (created,
 *  or revealed through the native dialog). Only then can "backed up" be set. */
let aioPhraseShown = false;

export function registerIpc(): void {
  // Construct the engine eagerly. It is otherwise built on first use, and
  // the terminal's data layer gets its context from the engine constructor —
  // a Discover call before the engine existed would throw "context not
  // attached" on a cold start with the engine stopped.
  getEngine();
  // The Robinhood Chain rail beside it: its own wallet file, ledger and arm
  // state, sharing only the settings and the event stream.
  // Tokens SENT to a wallet on BNB / Robinhood, found from the chain's logs.
  tokenDiscovery.init(app.getPath('userData'), {
    onFound: (chain, owner) => broadcast({ kind: 'evmHoldings', chain, owner }),
    wrapped: { robinhood: CHAINS.robinhood.addr.wrapped, bnb: CHAINS.bnb.addr.wrapped },
  });
  evmRail.init({
    userData: app.getPath('userData'),
    getSettings: () => store.load(),
    // A live EVM fill reaches scripts too (2026-10-03): the rail's events went
    // to the window only, so a Robinhood/BNB script never heard its own fills.
    emit: (ev) => {
      broadcast(ev);
      if (ev.kind === 'evmFill') automation.onEngineEvent(ev);
    },
  });
  // A reconciled EVM SELL, priced against the wallet's own basis, for the
  // scripts' daily loss stop and cool-off (2026-10-03: only Solana and paper
  // exits counted, so a live EVM script could lose without limit).
  evmLedger.onSettled((f) => {
    if (f.side !== 'sell' || f.state !== 'reconciled' || f.nativeDeltaWei === null || f.tokenDeltaRaw === null) return;
    const sold = -BigInt(f.tokenDeltaRaw);
    const got = BigInt(f.nativeDeltaWei);
    if (sold <= 0n) return; // a follow-up fee leg, not an exit
    const b = evmLedger.basisByToken(f.chain, f.wallet).get(f.token);
    // Unknown basis = unknown result: never counted as a profit or a loss.
    // Only a BUY still pending makes the basis unknown. A curve sell's own
    // fee transfer (pending when the sell settles) and a reverted fill (it
    // moved no tokens) used to block it, so curve-venue losses never reached
    // the script's loss stop (v6 audit 2026-10-03).
    const buyPending = evmLedger.forWallet(f.chain, f.wallet).some((x) => x.token === f.token && x.side === 'buy' && x.state === 'pending');
    if (!b || b.tokensBought <= 0n || buyPending) return;
    const costWei = (b.spentWei * sold) / b.tokensBought;
    automation.onEvmFillSettled({ chain: f.chain, mint: f.token, side: 'sell', at: f.at, wallet: f.wallet, requested: f.requested, realizedSol: Number(got - costWei) / 1e18 });
  });
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
    // …and the chain's runner flags, as their runner event and bot.runners().
    onRunner: (chain, flag, launch) => automation.onEvmRunner(chain, flag, launch),
    // …the price prints, as the scripts' tick, and followed wallets' trades.
    onPrice: (chain, token, price) => {
      if (curveQuoteNative(chain, token) === true) automation.onEvmTick(chain, token, price);
    },
    onLeaderTrade: (chain, t) =>
      automation.onLeaderTrade({
        chain,
        mint: t.token,
        symbol: t.symbol,
        wallet: t.wallet,
        label: copyTrade.all().find((c) => (c.chain ?? 'solana') === chain && c.wallet.toLowerCase() === t.wallet)?.label ?? '',
        side: t.isBuy ? 'buy' : 'sell',
        sol: t.native,
        priceSol: curveQuoteNative(chain, t.token) === true ? t.priceNative : (evmPriceNative(chain, t.token) ?? 0),
        soldFraction: t.soldFraction,
      }),
  });
  automation.setEvmRunnerSource((chain) => evmScanner.flagged(chain));
  // What a Robinhood/BNB script reads that the engine host does not carry.
  automation.setEvmScriptHooks({
    launch: (chain, token) => evmScanner.launches(chain).find((l) => l.token.toLowerCase() === token.toLowerCase()) ?? null,
    ownsWholeBag: (chain, token, hashes) => {
      const mine = new Set(hashes.map((h) => h.toLowerCase()));
      const buys = evmRail.fills(chain).filter((f) => f.token === token && f.side === 'buy' && f.tokenDeltaRaw !== null && BigInt(f.tokenDeltaRaw) > 0n);
      if (!buys.length) return null;
      return buys.every((f) => mine.has(f.hash.toLowerCase()));
    },
    history: (chain, limit) =>
      evmRail
        .fills(chain)
        .slice()
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .map((f) => ({
          at: f.at,
          mint: f.token,
          symbol: f.symbol,
          side: f.side,
          hash: f.hash,
          requested: f.requested,
          // The chain's own coin; null until the fill is reconciled.
          nativeDelta: f.nativeDeltaWei === null ? null : Number(BigInt(f.nativeDeltaWei)) / 1e18,
          state: f.state,
        })),
    nativeUsd: async (chain) => (chain === 'solana' ? market.solUsd() : evmNativeUsd(chain as EvmChainKind)),
    identity: (chain, token) => evmIdentity.get(evmPxKey(chain, token)) ?? null,
    wallets: (chain) => {
      const active = evmWallet.address(chain)?.toLowerCase() ?? null;
      return evmWallet.list(chain).map((w) => ({ address: w.address, label: w.label, active: w.address.toLowerCase() === active, native: w.balanceNative }));
    },
    // One of the user's OTHER wallets on this chain, by address — the rules
    // Solana's engine.scriptWalletTrade applies: an address that is not the
    // user's own is refused (never the active wallet instead), and trading
    // several of their wallets needs the multi-wallet acknowledgement.
    walletTrade: async (chain, side, address, token, amount) => {
      const mine = evmWallet.list(chain).find((w) => w.address.toLowerCase() === address.toLowerCase());
      if (!mine) return { ok: false, message: `no wallet of yours has the address ${address.slice(0, 10)}…` };
      const { multiWalletProblem } = await import('@shared/multiWallet');
      const why = multiWalletProblem(1, store.load().multiWallet);
      if (why) return { ok: false, message: why };
      if (side === 'buy') {
        const r = await evmRail.buy(chain, token, amount, false, { walletId: mine.id });
        return { ok: r.ok, message: r.message };
      }
      const r = await evmRail.sell(chain, token, amount, false, { walletId: mine.id });
      return { ok: r.ok, message: r.stage === 'pending' ? `broadcast but not confirmed in time — check Trades (${r.message})` : r.message };
    },
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

  // ── Profiles (2026-09-26) ────────────────────────────────────────────
  // Isolated copies of the app, one userData folder each. The rules are in
  // shared/profiles.ts; the disk work in system/profiles.ts. Every handler
  // takes an ID (validated against the registry there), never a path.
  const retitle = (): void => {
    const t = profiles.title();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.webContents.session === session.defaultSession) w.setTitle(t);
    }
  };
  ipcMain.handle('profiles:list', () => ok('ok', profiles.view()));
  ipcMain.handle('profiles:create', (_e, name: unknown) => {
    const r = profiles.create(name);
    if (r.ok) {
      logger.info(`profiles: created ${r.id}`);
      retitle();
    }
    return r.ok ? ok(r.message, profiles.view()) : fail(r.message);
  });
  ipcMain.handle('profiles:duplicate', (_e, name: unknown, copyWallets: unknown) => {
    // The in-memory settings are the newest, but only when they were read: a
    // profile running on defaults because its file is unreadable would hand
    // the clone defaults dressed up as a copy.
    if (store.failure()) return fail('This profile’s settings could not be read, so there is nothing reliable to copy. Create a blank profile instead.');
    const r = profiles.duplicate(name, copyWallets === true, store.load());
    if (!r.ok) return fail(r.message);
    logger.info(`profiles: duplicated this profile as ${r.id}${copyWallets === true ? ' WITH wallets' : ''}${r.skipped?.length ? ` (skipped: ${r.skipped.join('; ')})` : ''}`);
    retitle();
    const note = r.skipped?.length ? ` Not copied: ${r.skipped.join('; ')}.` : '';
    return ok(`${r.message}${note}`, profiles.view());
  });
  ipcMain.handle('profiles:rename', (_e, id: unknown, name: unknown) => {
    const r = profiles.rename(id, name);
    if (r.ok) retitle();
    return r.ok ? ok(r.message, profiles.view()) : fail(r.message);
  });
  ipcMain.handle('profiles:remove', async (_e, id: unknown) => {
    const r = await profiles.remove(id, (p) => shell.trashItem(p));
    if (r.ok) {
      logger.info(`profiles: removed ${String(id)} (to the Recycle Bin)`);
      retitle();
    }
    return r.ok ? ok(r.message, profiles.view()) : fail(r.message);
  });
  ipcMain.handle('profiles:open', (_e, id: unknown) => {
    const r = profiles.open(id, app.isPackaged, app.getAppPath());
    if (r.ok) logger.info(`profiles: opening ${String(id)}`);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('profiles:shortcut', (_e, id: unknown) => {
    const r = profiles.shortcut(id, app.isPackaged, app.getAppPath(), app.getPath('desktop'), (lnk, o) => shell.writeShortcutLink(lnk, 'create', o));
    return r.ok ? ok(r.message) : fail(r.message);
  });

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

  // ── The support bundle (2026-09-21) ───────────────────────────────────
  //
  // Until now the only way to report a bug was "open the logs folder and
  // attach app.log", which asks a user to find a file, know which of two to
  // send, and understand what is in it. This builds ONE file: the log, the
  // settings with every key removed, what was switched on, the provider
  // board, and a list of the profile's files by name and size.
  //
  // Nothing is sent anywhere. The app has no telemetry and this does not
  // change that — it writes a file where the user chooses, and the user
  // decides what to do with it. `diagnostics.ts` carries the full reasoning
  // about what is and is not in it.

  /** What is switched on right now, in the words a reader needs. */
  const bundleState = (): string[] => {
    const s = store.load();
    const out: string[] = [];
    try {
      const st = getEngine().status();
      out.push(`trading mode    ${s.execution.liveEnabled ? 'LIVE — real funds' : 'paper'}`);
      out.push(`scanner         ${st.running ? 'running' : 'stopped'}, feed ${st.feed}`);
      out.push(`runners flagged ${st.runnersFlagged} this session`);
    } catch {
      out.push('engine          could not be read');
    }
    try {
      const copy = getEngine().copySnapshot();
      const live = copy.configs.filter((c) => c.mode === 'live').length;
      const armed = copy.configs.filter((c) => c.enabled).length;
      out.push(`copy trading    ${copy.configs.length} config(s), ${live} live, ${armed} armed${copy.liveBlockedReason ? ` — live blocked: ${copy.liveBlockedReason}` : ''}`);
    } catch {
      /* a missing copy snapshot is not worth a line */
    }
    try {
      const scripts = automation.all();
      out.push(`scripts         ${scripts.length}, ${scripts.filter((x: { enabled: boolean }) => x.enabled).length} armed, ${scripts.filter((x: { mode: string }) => x.mode === 'live').length} live`);
    } catch {
      /* same */
    }
    try {
      out.push(`advanced orders ${getEngine().ordersSnapshot().orders.filter((o) => o.state === 'armed').length} armed`);
    } catch {
      /* same */
    }
    {
      const p = profiles.currentProfile();
      out.push(`profile         ${p.id === null ? 'Default' : `"${p.name}" (${p.id})`}`);
    }
    out.push(`wallets         ${wallet.list().length} Solana, ${evmWallet.list('robinhood').length} Robinhood, ${evmWallet.list('bnb').length} BNB`);
    out.push(`AI connection   ${s.mcp.enabled ? `on, ${s.mcp.access}${mcpServer.isRunning() ? `, listening on ${mcpServer.status().port}` : ', NOT listening'}` : 'off'}`);
    out.push(`chat bots       telegram ${s.bots.telegram.enabled ? 'on' : 'off'}, discord ${s.bots.discord.enabled ? 'on' : 'off'}, trading ${s.bots.trading.enabled ? 'ON' : 'off'}`);
    out.push(`market data     ${s.data.networkDataEnabled ? 'on' : 'OFF — charts and prices stop'}`);
    out.push(`recorder        ${s.recorderEnabled ? 'on' : 'off'}`);
    return out;
  };

  /** Every file in the profile, by name and size. Contents are never read. */
  const bundleFiles = (problems: string[]): diagnostics.BundleFileInfo[] => {
    const dir = app.getPath('userData');
    const out: diagnostics.BundleFileInfo[] = [];
    const walk = (rel: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
      } catch (err) {
        problems.push(`${rel || 'the profile folder'} could not be listed (${(err as Error).message})`);
        return;
      }
      for (const e of entries) {
        const name = rel ? `${rel}/${e.name}` : e.name;
        // Only the app's own state. Chromium's caches are noise and the
        // wallet key files are never described, not even by size.
        if (e.isDirectory()) {
          if (rel === '' && (name === 'logs' || name === 'crashes' || name === 'diagnostics')) walk(name);
          continue;
        }
        if (/wallet-key|secrets|\.enc$/i.test(e.name)) continue;
        if (!/\.(json|jsonl|log|txt|bak)(\.\d+)?$/i.test(e.name)) continue;
        try {
          const st = fs.statSync(path.join(dir, name));
          out.push({ name, bytes: st.size, modifiedAt: st.mtimeMs });
        } catch {
          out.push({ name, bytes: 0, modifiedAt: null });
        }
      }
    };
    walk('');
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  // `note` is what the user typed in "What went wrong?" — their words, capped,
  // printed first in the file. Plain text; never a path, never a URL we act on.
  const buildSupportBundle = (note = ''): { text: string; truncatedBytes: number } => {
    const problems: string[] = [];
    const logsDir = logger.logsDir();
    const logs: Array<{ name: string; text: string }> = [];
    if (!logsDir) problems.push('the log file is not attached this session, so no log lines are included');
    else {
      // Oldest first, so the file reads forwards.
      for (const name of [`${LOG_FILE}.1`, LOG_FILE]) {
        try {
          logs.push({ name, text: fs.readFileSync(path.join(logsDir, name), 'utf8') });
        } catch (err) {
          // app.log.1 is simply absent on a fresh install; only say so when
          // the CURRENT log is the one missing.
          if (name === LOG_FILE) problems.push(`${name} could not be read (${(err as Error).message})`);
        }
      }
    }
    const crashDir = crashGuard.crashDir();
    let crashes: string[] = [];
    try {
      crashes = crashDir ? fs.readdirSync(crashDir).filter((f) => f.endsWith('.log')) : [];
    } catch (err) {
      problems.push(`the crash folder could not be listed (${(err as Error).message})`);
    }
    let providers: Array<{ id: string; host: string; enabled: boolean; usable: boolean; calls: number; errors: number; cooldownMs: number; lastError: string | null }> = [];
    try {
      providers = market.providerStatuses().map((p) => ({
        id: p.id,
        host: p.host,
        enabled: p.enabled,
        usable: p.usable,
        calls: p.calls,
        errors: p.errors,
        cooldownMs: p.cooldownMs,
        lastError: p.lastError,
      }));
    } catch (err) {
      problems.push(`the provider board could not be read (${(err as Error).message})`);
    }
    return diagnostics.buildBundle({
      now: Date.now(),
      app: {
        name: PRODUCT_NAME,
        version: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        packaged: app.isPackaged,
        locale: app.getLocale(),
      },
      uptimeMs: Math.round(process.uptime() * 1000),
      settings: store.load(),
      state: bundleState(),
      providers,
      files: bundleFiles(problems),
      crashes,
      logs,
      problems,
      note: note.slice(0, diagnostics.NOTE_MAX_CHARS),
    });
  };
  const noteOf = (raw: unknown): string => (typeof raw === 'string' ? raw.slice(0, diagnostics.NOTE_MAX_CHARS) : '');

  /** A preview, so the panel can say how big the file is before writing it. */
  ipcMain.handle('logs:preview', () => {
    try {
      const b = buildSupportBundle();
      return ok('ok', { bytes: Buffer.byteLength(b.text, 'utf8'), truncatedBytes: b.truncatedBytes, head: b.text.slice(0, 1200) });
    } catch (err) {
      return fail(`The support bundle could not be built: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('logs:export', async (_e, note: unknown) => {
    let bundle: { text: string; truncatedBytes: number };
    try {
      bundle = buildSupportBundle(noteOf(note));
    } catch (err) {
      logger.error(`support bundle failed to build: ${(err as Error).message}`);
      return fail(`The support bundle could not be built: ${(err as Error).message}`);
    }
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save logs to send',
      defaultPath: path.join(app.getPath('downloads'), diagnostics.bundleName(PRODUCT_NAME, Date.now())),
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return fail('Save cancelled');
    try {
      fs.writeFileSync(res.filePath, bundle.text, 'utf8');
      shell.showItemInFolder(res.filePath);
      logger.info(`support bundle written to ${path.basename(res.filePath)} (${Math.round(Buffer.byteLength(bundle.text, 'utf8') / 1024)} KB)`);
      return ok(`Saved ${path.basename(res.filePath)}`, { path: res.filePath, bytes: Buffer.byteLength(bundle.text, 'utf8'), truncatedBytes: bundle.truncatedBytes });
    } catch (err) {
      return fail(`Could not write the file: ${(err as Error).message}`);
    }
  });

  /** The same bundle on the clipboard, for a user who would rather paste. */
  ipcMain.handle('logs:copy', (_e, note: unknown) => {
    try {
      const b = buildSupportBundle(noteOf(note));
      clipboard.writeText(b.text);
      logger.info('support bundle copied to the clipboard');
      return ok('Copied — paste it wherever you are asking for help', { bytes: Buffer.byteLength(b.text, 'utf8') });
    } catch (err) {
      return fail(`The support bundle could not be built: ${(err as Error).message}`);
    }
  });

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
      // Switching the float on (again) clears a stop its failure breaker set.
      if (v.patch.aio?.floatEnabled === true && before.aio?.floatEnabled !== true) aioFloatReset();
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
      // WHAT CHANGED, not just what was refused (2026-09-21). Support's most
      // common question is "what is different between the run that worked and
      // the one that did not", and until now an accepted patch was silent.
      // Keys only for anything that could carry a secret; values for the
      // numbers and switches, which are the whole point of the line.
      const changed = Object.entries(v.patch as Record<string, unknown>).map(([section, block]) => {
        if (block === null || typeof block !== 'object') return `${section}=${String(block)}`;
        const fields = Object.entries(block as Record<string, unknown>)
          .filter(([, val]) => typeof val !== 'object' || val === null)
          .map(([k, val]) => (/key|token|secret|url|webhook/i.test(k) ? `${k}=<changed>` : `${k}=${String(val).slice(0, 40)}`));
        return fields.length ? `${section}{${fields.join(', ')}}` : section;
      });
      if (changed.length) logger.info(`settings changed: ${changed.join(' · ')}`);
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
    // Both kill switches pause every Krypto Trader session (critic #9).
    kryptoTrader.pauseAll('the kill switch');
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

  // Wallet lifecycle. `select`, `remove`, `setHome` and the withdrawals were
  // already logged; generate, import and rename were not, so "where did my
  // wallet go" had a gap exactly where it mattered (2026-09-21). No key, no
  // secret — the label and the public key, which is public.
  ipcMain.handle('wallet:generate', (_e, label: unknown) => {
    const r = wallet.generate(typeof label === 'string' ? label : '');
    if (r.ok) { syncLiveMode(); refreshScoutOwnership(); }
    logger.info(r.ok ? `wallet:generate — a new wallet was created (${wallet.list().length} now), active is ${wallet.publicKey()}` : `wallet:generate failed — ${r.message}`);
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  ipcMain.handle('wallet:import', async (e, secret: string, label: unknown) => {
    if (typeof secret !== 'string') return fail('Invalid key');
    const addr = solanaAddressOfSecret(secret);
    if (addr && !(await confirmImport(e.sender, 'this Solana wallet', [addr]))) return fail('Import cancelled');
    const r = wallet.importSecret(secret, typeof label === 'string' ? label : '');
    if (r.ok) { syncLiveMode(); refreshScoutOwnership(); }
    // A sign-in-only pump.fun account with this address moves onto the wallet.
    if (r.ok && r.publicKey) {
      const held = wallet.list().find((w) => w.publicKey === r.publicKey);
      if (held) pumpAuth.claimWebSession(r.publicKey, held.id);
    }
    // Never the secret, and never its length — only that one arrived.
    logger.info(r.ok ? `wallet:import — a wallet was imported (${wallet.list().length} now), active is ${wallet.publicKey()}` : `wallet:import failed — ${r.message}`);
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
  const switchSolanaWallet = (id: string): { ok: boolean; message: string } => {
    if (getEngine().liveState().armed) {
      return { ok: false, message: 'Disarm live execution before switching wallets.' };
    }
    const r = wallet.select(id);
    if (r.ok) logger.warn(`wallet:select — active wallet is now ${wallet.publicKey() ?? 'none'}`);
    if (r.ok) syncLiveMode();
    if (r.ok) {
      // Nothing kept for the old signer may show for the new one.
      getEngine().clearWalletCaches();
      broadcast({ kind: 'walletSwitched', publicKey: wallet.publicKey() ?? null });
      // Orders and engine positions sell the ACTIVE wallet: re-check Trader claims.
      kryptoTrader.onWalletSwitched(wallet.info().id ?? null);
    }
    return r;
  };
  ipcMain.handle('wallet:select', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid wallet id');
    const r = switchSolanaWallet(id);
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  ipcMain.handle('wallet:rename', (_e, id: unknown, label: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid wallet id');
    if (typeof label !== 'string') return fail('Invalid label');
    const r = wallet.rename(id, label);
    if (r.ok) logger.info(`wallet:rename — ${id.slice(0, 8)}… is now "${label.slice(0, 40)}"`);
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  ipcMain.handle('wallet:setHome', async (e, addr: string) => {
    // The withdrawal address is the ONE destination the signer will send the
    // full balance to. Changing it must require a human, not just a renderer
    // message — that link is what turned an unvalidated settings patch into a
    // drain. A native dialog cannot be actuated by page content.
    const next = String(addr).trim();
    const current = wallet.info().homeAddress;
    if (next === current) return ok('Withdrawal address unchanged', wallet.info());

    const { response } = await confirmNative(e.sender, {
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

  // ── Send: any coin or token, to any address (2026-10-03) ─────────────
  //
  // The page asks; main re-reads everything, and nothing is signed until the
  // NATIVE dialog — attached to the asking window, unpressable by page
  // content — has shown the exact address and amount and the user said yes.
  // The Solana signer then checks the bytes against an approval only this
  // handler can file; the EVM policy pins recipient and amount the same way.
  type PlannedSend =
    | { ok: true; review: SendReview; solana?: solanaSend.SolanaSendPlan; evm?: evmSend.EvmSendPlan }
    | { ok: false; message: string };
  /** The app's own addresses in one family, for the poisoning check: every
   *  wallet key it holds and every withdrawal address saved (v6 audit). */
  const ownSendAddresses = (family: 'solana' | 'evm'): Array<{ address: string; label: string | null }> => {
    const out: Array<{ address: string; label: string | null }> = [];
    if (family === 'solana') {
      for (const w of wallet.list()) {
        out.push({ address: w.publicKey, label: `wallet “${w.label}”` });
        if (w.homeAddress) out.push({ address: w.homeAddress, label: `withdrawal address (wallet “${w.label}”)` });
      }
    } else {
      const seen = new Set<string>();
      for (const c of ['bnb', 'robinhood'] as const) {
        for (const w of evmWallet.list(c)) {
          if (seen.has(w.address.toLowerCase())) continue;
          seen.add(w.address.toLowerCase());
          out.push({ address: w.address, label: `wallet “${w.label}”` });
        }
      }
    }
    return out;
  };
  const planSend = async (req: SendRequest): Promise<PlannedSend> => {
    const r = await planSendRaw(req);
    if (!r.ok) return r;
    // The address book's view of this recipient: a lookalike of an address
    // you use (address poisoning), a first-time recipient, the saved name.
    const chk = checkRecipient(sendBook.book(), familyOf(req.chain), r.review.to, ownSendAddresses(familyOf(req.chain)));
    r.review = { ...r.review, warnings: [...recipientWarnings(chk), ...r.review.warnings], contactLabel: chk.contact?.label ?? null };
    return r;
  };
  const planSendRaw = async (req: SendRequest): Promise<PlannedSend> => {
    if (req.chain === 'solana') {
      const owner = wallet.publicKey();
      if (!owner) return { ok: false, message: 'No Solana wallet.' };
      // The engine's metadata first, then the well-known list (USDC, USDT…):
      // a classic SPL mint carries no symbol of its own.
      const hint = req.token
        ? (getEngine().holdingsCached()?.data.find((h) => h.mint === req.token)?.symbol ?? KNOWN_MINTS.solana.find((m) => m.mint === req.token)?.symbol ?? null)
        : null;
      const held = getEngine().holdingsCached()?.data ?? null;
      const open = held ? held.filter((h) => h.mint !== 'So11111111111111111111111111111111111111112' && h.uiAmount > 0).length : null;
      const r = await solanaSend.plan(execUrlOf(store.load().rpc), owner, req, hint, open);
      return r.ok ? { ok: true, review: r.plan.review, solana: r.plan } : r;
    }
    if (!evmRail.enabled(req.chain)) return { ok: false, message: `${EVM_CHAIN_META[req.chain].name} is turned off in Settings.` };
    const r = await evmSend.plan(req.chain, req);
    return r.ok ? { ok: true, review: r.plan.review, evm: r.plan } : r;
  };

  ipcMain.handle('send:review', async (_e, raw: unknown) => {
    const req = sendRequestOf(raw);
    if (!req) return fail('Not a send request');
    try {
      const r = await planSend(req);
      return r.ok ? ok('ok', r.review) : fail(r.message);
    } catch (err) {
      return fail(`Could not check this send: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('send:execute', async (e, raw: unknown) => {
    const req = sendRequestOf(raw);
    if (!req) return fail('Not a send request');
    let planned: PlannedSend;
    try {
      // Fresh — never the review the page holds: balances move.
      planned = await planSend(req);
    } catch (err) {
      return fail(`Could not check this send: ${safeErr(err)}`);
    }
    if (!planned.ok) return fail(planned.message);
    const rv = planned.review;
    const chainName = req.chain === 'solana' ? 'Solana' : EVM_CHAIN_META[req.chain].name;
    const { response } = await confirmNative(e.sender, {
      type: 'warning',
      buttons: ['Cancel', `Send ${rv.amountText}`],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Confirm send',
      message: `Send ${rv.amountText} on ${chainName}?`,
      detail:
        `To:\n${rv.to}${rv.contactLabel ? `\n(in your address book as “${rv.contactLabel}”)` : ''}\n\nFrom:\n${rv.from}\n` +
        (rv.token ? `\nToken:\n${rv.token}\n` : '') +
        (rv.networkFeeText ? `\nNetwork fee: ${rv.networkFeeText}` : '') +
        (rv.extraCostText ? `\nAlso: ${rv.extraCostText}` : '') +
        (rv.warnings.length ? `\n\n${rv.warnings.map((w) => `• ${w}`).join('\n')}` : '') +
        '\n\nA send cannot be undone. Check the address character by character. If you did not just press Send in Krypto Bot, press Cancel.',
    });
    if (response !== 1) {
      logger.warn(`send: cancelled at the confirmation dialog (${rv.amountText} on ${req.chain})`);
      return fail('Send cancelled');
    }
    logger.warn(`send: confirmed — ${rv.amountText} on ${req.chain} from ${rv.from} to ${rv.to}`);
    let result: SendResult;
    try {
      if (planned.solana) {
        const p = planned.solana;
        const b = p.build;
        const approvalId = wallet.approveSend(p.owner, {
          to: p.review.to,
          mint: b.kind === 'sol' ? null : b.mint,
          tokenProgram: b.kind === 'sol' ? null : b.program,
          maxAmount: b.kind === 'sol' ? b.lamports : b.amount,
        });
        result = await getEngine().queueLive(() => solanaSend.execute(execUrlOf(store.load().rpc), p, approvalId));
        void wallet.refreshBalance(execUrlOf(store.load().rpc));
      } else if (planned.evm) {
        result = await evmSend.execute(planned.evm);
        void evmWallet.refreshBalance(planned.evm.chain);
      } else {
        return fail('Nothing to send');
      }
    } catch (err) {
      logger.warn(`send: error — ${safeErr(err)}`);
      return fail(`Send error: ${safeErr(err)}`);
    }
    logger.warn(`send: ${result.ok ? 'sent' : 'FAILED'} — ${result.message}${result.txid ? ` tx=${result.txid}` : ''}`);
    if (result.txid) sendBook.noteSend({ at: Date.now(), chain: req.chain, to: rv.to, token: rv.token, amountText: rv.amountText, txid: result.txid, ok: result.ok });
    return { ok: result.ok, message: result.message, data: result };
  });

  // ── The Send address book (2026-10-03) ───────────────────────────────
  ipcMain.handle('send:book', () => {
    const b = sendBook.book();
    return ok('ok', { contacts: b.contacts, history: b.history.slice(0, 50), failure: sendBook.failure() });
  });
  ipcMain.handle('send:saveContact', (_e, label: unknown, chain: unknown, address: unknown) => {
    const name = cleanLabel(label);
    if (!name) return fail('Give the address a name.');
    if (chain !== 'solana' && chain !== 'bnb' && chain !== 'robinhood') return fail('Unknown chain');
    if (typeof address !== 'string') return fail('Not an address');
    const family = familyOf(chain);
    const a = address.trim();
    if (family === 'solana' ? !isAddress(a) : !isEvmAddress(a)) return fail(`That is not a ${family === 'solana' ? 'Solana' : 'EVM'} address.`);
    // Only an address a send actually went to: the page can call this, and a
    // contact's name is printed in the native Send dialog (v6 audit).
    if (!sendBook.book().history.some((h) => h.ok && familyOf(h.chain) === family && (family === 'evm' ? h.to.toLowerCase() === a.toLowerCase() : h.to === a))) {
      return fail('Save an address after a send to it has gone through.');
    }
    const r = sendBook.saveContact({ label: name, family, address: a });
    return r.ok ? ok(`Saved as “${name}”`, sendBook.book().contacts) : fail(r.message);
  });
  ipcMain.handle('send:removeContact', (_e, id: unknown) => {
    if (typeof id !== 'string') return fail('Not a contact');
    const r = sendBook.removeContact(id);
    return r.ok ? ok('Removed', sendBook.book().contacts) : fail(r.message);
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

  const removeSolanaWallet = (id: unknown): { ok: boolean; message: string } => {
    // A Krypto Trader session's wallet cannot go while the session is not
    // stopped and empty — checked BEFORE the disarm below, so a refused
    // removal disarms nothing (critic #16).
    const traderBlock = kryptoTrader.walletRemoveBlocked(typeof id === 'string' && id ? id : (wallet.info().id ?? ''));
    if (traderBlock) return { ok: false, message: traderBlock };
    // Disarm FIRST and unconditionally. Removing any wallet can promote a
    // different one to active, and staying armed across that change is the
    // same hazard `wallet:select` refuses outright.
    getEngine().disarm('no_wallet');
    // The wallet being removed, resolved BEFORE removal so its pump.fun
    // session can be cleared too — otherwise an encrypted session for a
    // wallet that no longer exists is left orphaned in the store.
    const targetId = typeof id === 'string' && id ? id : wallet.info().id;
    const r = wallet.remove(typeof id === 'string' && id ? id : undefined);
    if (r.ok) {
      if (targetId) pumpAuth.signOut(targetId);
      logger.warn(`wallet:remove — active wallet is now ${wallet.publicKey() ?? 'none'}`);
      syncLiveMode(); // a promoted wallet re-arms; no wallet stays disarmed
    }
    return r;
  };
  ipcMain.handle('wallet:remove', (_e, id: unknown) => {
    const r = removeSolanaWallet(id);
    return r.ok ? ok(r.message, wallet.info()) : fail(r.message);
  });

  // ── All-in-One wallet (2026-10-01) ─────────────────────────────────────
  // One phrase, one Solana key + one EVM key, held in the ordinary stores
  // (shared/aio.ts). Nothing here signs; switching and removing go through
  // the same functions and interlocks as the per-chain pages.
  const armedChains = (): string[] => [
    ...(getEngine().liveState().armed ? ['Solana'] : []),
    ...EVM_CHAINS.filter((c) => evmRail.armed(c)).map((c) => EVM_CHAIN_META[c].shortName),
  ];
  const aioAnnounce = (): void => {
    broadcast({ kind: 'aioChanged' });
  };
  ipcMain.handle('aio:info', () => ok('ok', aioWallet.info()));
  // Everything both addresses hold, every chain, in dollars. Reads only.
  ipcMain.handle('aio:balances', async (_e, refresh: unknown) => {
    const i = aioWallet.info();
    if (!i.exists) return fail('No All-in-One wallet.');
    const b = await aioBalances({ httpUrl: resolveRpc(store.load().rpc).httpUrl, solanaAddress: i.solanaAddress, evmAddress: i.evmAddress, force: refresh === true });
    return ok('ok', b);
  });
  /** After a key was added: if it became the Solana signer (the first
   *  wallet on this install), everything a switch does must happen too —
   *  the live mode, the caches, the event, the Trader claims. */
  const afterAioKeysAdded = (solanaBefore: string | null): void => {
    refreshScoutOwnership();
    evmRail.wallet.announce();
    if (wallet.publicKey() !== solanaBefore) {
      syncLiveMode();
      getEngine().clearWalletCaches();
      broadcast({ kind: 'walletSwitched', publicKey: wallet.publicKey() ?? null });
      kryptoTrader.onWalletSwitched(wallet.info().id ?? null);
    }
    aioAnnounce();
  };
  ipcMain.handle('aio:create', async (e, label: unknown) => {
    const weak = weakKeyStore();
    if (weak) return fail(weak);
    // A NATIVE yes before a phrase exists: the reply carries it once, and page
    // content alone must never be able to mint a wallet whose keys it then
    // knows (v6 audit 2026-10-03 — the same rule as reveal and import).
    const { response } = await confirmNative(e.sender, {
      type: 'question',
      buttons: ['Cancel', 'Create and show the phrase'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Create an All-in-One wallet',
      message: 'Create an All-in-One wallet?',
      detail:
        'One recovery phrase for every chain. Its words are shown on the next screen — write them down; anyone who sees them can take everything in the wallet.\n\n' +
        'Make sure nobody is watching your screen and nothing is recording it. If you did not just ask for a new wallet in Krypto Bot, press Cancel.',
    });
    if (response !== 1) return fail('Cancelled');
    const before = wallet.publicKey();
    const r = aioWallet.create(label);
    if (r.ok) aioPhraseShown = true;
    // Announced on failure too when a record now exists (the phrase is saved
    // and the page must show Repair), not only on success.
    if (r.ok || aioWallet.info().exists) afterAioKeysAdded(before);
    // The phrase goes back ONCE, for the backup screen. Never logged.
    return r.ok ? ok(r.message, { info: aioWallet.info(), phrase: r.phrase }) : fail(r.message);
  });
  /**
   * Where does this phrase hold money? (2026-10-03.) Wallets derive different
   * paths — a Trust Wallet phrase read the Phantom way looked EMPTY. Read-only:
   * every catalogued address and its balance, nothing stored, nothing signed.
   */
  ipcMain.handle('aio:scanPhrase', async (_e, raw: unknown) => {
    if (typeof raw !== 'string') return fail('Enter the recovery phrase.');
    const problem = seedPhraseProblem(raw);
    if (problem) return fail(problem);
    const phrase = normaliseSeedPhrase(raw);
    const sol = AIO_SOLANA_PATHS.map((p) => {
      const seed = solanaSeedAtPath(phrase, p.path as number[]);
      const address = Keypair.fromSeed(seed).publicKey.toBase58();
      seed.fill(0);
      return { id: p.id, label: p.label, address };
    });
    const evm = AIO_EVM_PATHS.map((p) => {
      const key = evmPrivateKeyAtPath(phrase, p.path as string);
      const address = privateKeyToAccount(`0x${Buffer.from(key).toString('hex')}`).address;
      key.fill(0);
      return { id: p.id, label: p.label, address };
    });
    const evmChains = EVM_CHAINS.filter((c) => evmRail.enabled(c));
    const [solInfo, ...evmBals] = await Promise.all([
      getMultipleAccountInfo(execUrlOf(store.load().rpc), sol.map((r) => r.address)).catch(() => null),
      ...evmChains.map((c) =>
        Promise.all(evm.map((r) => evmClient(c).getBalance({ address: r.address as `0x${string}` }).then((w) => Number(w) / 1e18, () => null))),
      ),
    ]);
    // Unread stays null (honest null): never shown as an empty wallet.
    const solRows: AioScanRow[] = sol.map((r, i) => ({
      ...r,
      balances: { solana: solInfo && solInfo.ok && solInfo.data ? (solInfo.data[i] ? solInfo.data[i]!.lamports / 1e9 : 0) : null },
    }));
    const evmRows: AioScanRow[] = evm.map((r, i) => ({
      ...r,
      balances: Object.fromEntries(evmChains.map((c, k) => [c, (evmBals[k] as Array<number | null>)[i] ?? null])),
    }));
    return ok('ok', { solana: solRows, evm: evmRows });
  });
  ipcMain.handle('aio:import', async (e, phrase: unknown, label: unknown, choice: unknown) => {
    const weak = weakKeyStore();
    if (weak) return fail(weak);
    // A path choice from the scan, or the defaults. An unknown id is refused,
    // never "corrected": the user picked an address, not a guess at one.
    if (choice !== undefined && choice !== null && !isAioPathChoice(choice)) return fail('Unknown derivation path');
    const paths = isAioPathChoice(choice) ? { solana: choice.solana, evm: choice.evm } : undefined;
    const addrs = typeof phrase === 'string' ? addressesOfPhrase(phrase, paths) : null;
    if (addrs && !(await confirmImport(e.sender, 'this All-in-One wallet (every chain)', addrs))) return fail('Import cancelled');
    const before = wallet.publicKey();
    const r = aioWallet.importPhrase(phrase, label, paths);
    if (r.ok || aioWallet.info().exists) afterAioKeysAdded(before);
    return r.ok ? ok(r.message, aioWallet.info()) : fail(r.message);
  });
  /**
   * The phrase is every key on every chain, so it is decrypted only after a
   * NATIVE confirmation in main — page content cannot press it. A renderer
   * modal alone meant any renderer compromise could take the whole wallet
   * with one call (review 2026-10-02). Same pattern as wallet:setHome.
   */
  ipcMain.handle('aio:reveal', async (e) => {
    if (!aioWallet.info().exists) return fail('No All-in-One wallet.');
    const { response } = await confirmNative(e.sender, {
      type: 'warning',
      buttons: ['Cancel', 'Show recovery phrase'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Show recovery phrase',
      message: 'Show the All-in-One wallet\'s recovery phrase?',
      detail:
        'These words are every key in this wallet, on every chain. Anyone who sees them can take everything in it.\n\n' +
        'Make sure nobody is watching your screen and nothing is recording it. If you did not just ask to see the phrase in Krypto Bot, press Cancel.',
    });
    if (response !== 1) {
      logger.warn('aio wallet: recovery phrase NOT shown — cancelled at the confirmation dialog');
      return fail('Cancelled');
    }
    const r = aioWallet.reveal();
    if (r.ok) aioPhraseShown = true;
    if (r.ok) logger.warn('aio wallet: recovery phrase shown');
    return r.ok ? ok('ok', r.phrase) : fail(r.message);
  });
  ipcMain.handle('aio:backedUp', () => {
    // A bare claim from the page is not a backup: the phrase must have been
    // on screen this session (create, or a natively confirmed reveal) —
    // otherwise "backed up" unlocks Remove, which deletes the only copy
    // (swarm 2026-10-03).
    if (!aioPhraseShown) return fail('Show the recovery phrase and write it down first.');
    const r = aioWallet.markBackedUp();
    if (r.ok) aioAnnounce();
    return r.ok ? ok(r.message, aioWallet.info()) : fail(r.message);
  });
  ipcMain.handle('aio:repair', () => {
    const before = wallet.publicKey();
    const r = aioWallet.repair();
    afterAioKeysAdded(before);
    return r.ok ? ok(r.message, aioWallet.info()) : fail(r.message);
  });
  /**
   * Make it the signer on every chain. Refused while ANY chain is live —
   * the same rule as each page's own switcher, all at once, so it never
   * half-switches: either every chain moves or none does.
   */
  ipcMain.handle('aio:activate', () => {
    const live = armedChains();
    if (live.length) return fail(`Switch ${live.join(', ')} to Paper before making the All-in-One wallet the signer everywhere.`);
    const ids = aioWallet.walletIds();
    if (!ids.solana || !ids.evm) return fail('A key is missing from its wallet list — use Repair first.');
    // Each chain is switched in turn; there is no rollback (switching back
    // would be a second change the user did not ask for), so a failure part
    // way says EXACTLY which chains moved — never "did not switch" over a
    // half-switched state (review 2026-10-02).
    const switched: string[] = [];
    const fails = (why: string): ReturnType<typeof fail> => {
      aioAnnounce();
      return fail(switched.length ? `${why}. Already switched: ${switched.join(', ')} — the page shows where it signs now.` : why);
    };
    try {
      const sol = switchSolanaWallet(ids.solana);
      if (!sol.ok) return fails(`Solana did not switch: ${sol.message}`);
      switched.push('Solana');
      for (const c of EVM_CHAINS) {
        const r = evmRail.wallet.select(c, ids.evm);
        if (!r.ok) return fails(`${EVM_CHAIN_META[c].shortName} did not switch: ${r.message}`);
        switched.push(EVM_CHAIN_META[c].shortName);
      }
    } catch (err) {
      return fails(`Switching stopped: ${safeErr(err)}`);
    }
    logger.warn('aio wallet: now the signer on every chain');
    aioAnnounce();
    return ok('The All-in-One wallet now signs on every chain', aioWallet.info());
  });
  /**
   * Remove it: both keys from their stores, then the record. Refused until
   * the phrase is confirmed written down — removing deletes the only copy
   * this machine has, and the funds go with it if nothing else holds it.
   */
  ipcMain.handle('aio:remove', async (e) => {
    const i = aioWallet.info();
    if (!i.exists) return fail('No All-in-One wallet.');
    if (!i.backedUp) return fail('Write down the recovery phrase first (Show phrase, then confirm). Removing deletes the only copy on this machine.');
    const live = armedChains();
    if (live.length) return fail(`Switch ${live.join(', ')} to Paper before removing the All-in-One wallet.`);
    // Keys the phrase ADOPTED (they were in the lists before the wallet was
    // set up) stay: removing the All-in-One wallet must not delete a wallet
    // the user had on its own, with its label, withdrawal address and links.
    const adopted = aioWallet.adoptedKeys();
    const removeEvm = i.evmWalletId !== null && !adopted.evm;
    const removeSol = i.solanaWalletId !== null && !adopted.solana;
    // EVERY refusal is checked before ANYTHING is removed, so a Trader
    // session on one key can never leave the other already deleted.
    if (removeEvm) {
      const block = kryptoTrader.walletRemoveBlocked(i.evmWalletId!, 'evm');
      if (block) return fail(block);
    }
    if (removeSol) {
      const block = kryptoTrader.walletRemoveBlocked(i.solanaWalletId!);
      if (block) return fail(block);
    }
    // The last step before deleting the only copy of the phrase on this
    // profile: a native confirmation page content cannot press.
    const { response } = await confirmNative(e.sender, {
      type: 'warning',
      buttons: ['Cancel', 'Remove'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Remove the All-in-One wallet',
      message: 'Remove the All-in-One wallet from this profile?',
      detail:
        `Solana: ${i.solanaAddress ?? '—'}\nEVM: ${i.evmAddress ?? '—'}\n\n` +
        'Its recovery phrase and keys are deleted from this profile. Anything they hold stays on chain, and only your written-down phrase can bring it back. ' +
        'Copies made earlier with Duplicate profile keep their own keys.',
    });
    if (response !== 1) {
      logger.warn('aio wallet: remove cancelled at the confirmation dialog');
      return fail('Remove cancelled');
    }
    if (removeEvm) {
      const r = evmRail.wallet.remove(i.evmWalletId!);
      if (!r.ok) return fail(`EVM key not removed: ${r.message}`);
    }
    if (removeSol) {
      const r = removeSolanaWallet(i.solanaWalletId!);
      if (!r.ok) return fail(`Solana key not removed: ${r.message}. The EVM key was removed; the recovery phrase is kept so Repair can restore it.`);
    }
    const r = aioWallet.forget();
    refreshScoutOwnership();
    aioAnnounce();
    const kept = [adopted.solana ? 'Solana' : null, adopted.evm ? 'EVM' : null].filter(Boolean);
    return r.ok
      ? ok(kept.length ? `${r.message}. Your ${kept.join(' and ')} wallet from before stays in its list.` : r.message, aioWallet.info())
      : fail(r.message);
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
  // able to disagree, or the app would show "halved" and charge in full.
  // What the Links panel read off a token's X page (2026-09-20). The renderer
  // is the only writer, after a PERSON opened the page in the panel's browser
  // view; main never fetches an X page. The guest's reply is untrusted text
  // and is validated into a bounded record here, or refused.
  ipcMain.handle('links:xstats:set', (_e, mint: unknown, stats: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    const clean = validateXStats(stats);
    if (!clean) return fail('Not a readable X page record');
    const rec = xStats.set(mint, clean);
    return ok('kept', { stats: rec.stats, readAt: rec.readAt });
  });
  ipcMain.handle('links:xstats:get', (_e, mint: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    return ok('ok', xStats.get(mint));
  });
  // Telegram members and the website's registry record for a token's links
  // (2026-09-20): main derives the links from its own facts — the renderer
  // sends the mint and nothing else — and asks t.me and the registry, never
  // the token's site. wait = a person is looking: fetch now and answer.
  ipcMain.handle('links:intel:get', async (_e, mint: unknown, wait: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    try {
      return ok('ok', await linkIntel.intel(mint, wait === true));
    } catch (err) {
      return fail(`Lookup failed: ${(err as Error).message}`);
    }
  });
  // What the Links panel read off the token's own website — the X read's contract.
  ipcMain.handle('links:site:set', (_e, mint: unknown, read: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    const clean = validateSiteRead(read);
    if (!clean) return fail('Not a readable website record');
    const rec = siteReadStore.set(mint, clean);
    return ok('kept', { read: rec.read, readAt: rec.readAt });
  });
  ipcMain.handle('links:site:get', (_e, mint: unknown) => {
    if (!isMint(mint)) return fail('Invalid mint address');
    return ok('ok', siteReadStore.get(mint));
  });

  ipcMain.handle('krypto:holding', async (_e, refresh: unknown) => {
    if (refresh === true) await kryptoHolding.refresh();
    const h = kryptoHolding.current();
    return ok('ok', { ...h, halved: kryptoHolding.holderRateApplies(), thresholdTokens: KRYPTO_HOLDER_TOKENS });
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
    const by = SCOUT_SORTS.includes(sort as ScoutSort) ? (sort as ScoutSort) : 'copyScore';
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
      return rec ? summarise(rec, w) : emptyRow(chain as ScoutChain, address, w);
    });
    return ok('ok', { rows, saved: [...marks] });
  });

  // One wallet's whole record — every day bucket, its recent trips, whether it
  // is saved — for the detail drawer. The renderer windows and scores it with
  // the same shared functions the board uses, so the two cannot disagree.
  ipcMain.handle('scout:detail', (_e, chain: unknown, address: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    if (typeof address !== 'string' || !address) return fail('No wallet given');
    const key = address.toLowerCase();
    const rec = walletScout.wallets(chain as ScoutChain).find((x) => x.address === key) ?? null;
    return ok('ok', { wallet: rec, saved: walletScout.isSaved(chain as ScoutChain, key) });
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

  // Read one wallet's recent swaps from the chain into the Scout's record —
  // for an address the feed never saw (2026-09-21). Solana only: the EVM
  // Scouts read whole-chain curve logs by block range, and a per-wallet read
  // there is that scan narrowed, which the scan already covers. Spends
  // nothing; one job per wallet; the status is polled, never pushed. Reads
  // on the same endpoint trades use, through rpcClient's budgets.
  ipcMain.handle('scout:readWallet', (_e, chain: unknown, address: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    if (chain !== 'solana') return fail('Reading a wallet from the chain is Solana only — the Scan reads whole EVM chains by block range');
    if (!isAddress(address)) return fail('Enter a valid Solana wallet address');
    const r = walletHistory.start(address, bridgeDeps().httpUrl);
    return r.ok ? ok(r.message, walletHistory.status(address)) : fail(r.message);
  });

  ipcMain.handle('scout:readWalletStatus', (_e, chain: unknown, address: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    if (!isAddress(address)) return fail('Invalid wallet');
    return ok('ok', walletHistory.status(address));
  });

  ipcMain.handle('scout:readWalletCancel', (_e, chain: unknown, address: unknown) => {
    if (typeof chain !== 'string' || !SCOUT_CHAINS.includes(chain as ScoutChain)) return fail('Unknown chain');
    if (!isAddress(address)) return fail('Invalid wallet');
    const asked = walletHistory.cancel(address);
    return ok(asked ? 'Stopping after the current batch' : 'No read running', walletHistory.status(address));
  });

  // The Scout's two long jobs log where everything else does (2026-09-21).
  // They ran for minutes and spent hundreds of calls in total silence until a
  // logging audit found it.
  const toLog = (level: 'info' | 'warn' | 'error', line: string): void =>
    level === 'error' ? logger.error(line) : level === 'warn' ? logger.warn(line) : logger.info(line);
  scoutScan.attachLog(toLog);
  walletHistory.attachLog(toLog);
  // And the provider layer under everything (2026-09-21): a park is the most
  // common cause of "no price" and "the chart is empty", and it used to be
  // visible only in a live panel — a user who closed the app took the
  // evidence with them.
  httpLayer.attachLog(toLog);

  // ── The AI connection (MCP, 2026-09-21) ───────────────────────────────
  //
  // An agent reaches the app through the same doors its own buttons use.
  // `mcpTools` owns the meaning of each tool and the budget; `mcpServer`
  // owns the wire and the loopback / token / Origin guards. This block is
  // only the wiring between them and the engine — deliberately thin, because
  // a shortcut taken here would be a shortcut around the pipeline that
  // charges the fee and enforces the signer's outflow policy.
  //
  // Nothing below reaches a setting, a key, a withdrawal or a transaction.
  mcpTools.attach({
    access: () => store.load().mcp.access,
    budget: () => store.load().mcp.budget,
    // Solana when a call names no chain. The app's top-bar chain is renderer
    // state and main does not hold it, so there is nothing truer to read —
    // and a default guessed from settings would be wrong the moment the user
    // switched tabs. The tool schemas say Solana is the default.
    defaultChain: () => 'solana',
    walletInfo: async () => {
      const info = wallet.info();
      const s = store.load();
      return {
        address: info.publicKey,
        balanceSol: info.balanceSol,
        balanceCheckedAt: info.balanceCheckedAt,
        // The APP's own Paper/Live switch, which is a different thing from
        // this connection's mode and is worth an agent knowing: a paper
        // connection on a live app still cannot touch the real book.
        appMode: s.execution.liveEnabled ? 'live' : 'paper',
        liveBlockedReason: getEngine().copySnapshot().liveBlockedReason,
      };
    },
    positions: async (paper, chain) => {
      const p = ((await getEngine().portfolioSummary()) ?? {}) as {
        positions?: Array<{ chain?: string }>;
        paper?: { positions?: Array<{ chain?: string }>; realizedPnlSol?: number };
      };
      const onChain = <T extends { chain?: string }>(rows: T[]): T[] => rows.filter((r) => (r.chain ?? 'solana') === chain);
      return paper
        ? { chain, positions: onChain(p.paper?.positions ?? []), realizedPnlSol: p.paper?.realizedPnlSol ?? 0 }
        : { chain, positions: onChain(p.positions ?? []) };
    },
    token: async (mint, chain) => (chain === 'solana' ? await market.summary(mint) : await evmMarket.summary(chain, mint)),
    discover: async (list, limit, chain) => (chain === 'solana' ? await market.discover(list, limit) : (await evmDiscover.discover(chain, list, limit)).rows),
    chart: async (mint, interval, limit) => await market.candlesFast(mint, interval, limit),
    tokenLinks: async (mint) => getEngine().linksFor(mint, 'solana'),
    runnerAlerts: async (chain, limit) =>
      chain === 'solana'
        ? getEngine().runnersSnapshot().slice(0, limit)
        : evmScanner.flagged(chain).slice(0, limit),
    // Null rather than an empty list when pump is not answering: "no callouts"
    // and "we could not ask" are different answers and the tool says which.
    // The tool promises "newest first"; the feed arrives in pump's
    // recommendation rank, so it is sorted here (2026-09-26).
    callouts: async (limit) => {
      const rows = await callouts.calloutFeed();
      return rows ? newestFirst(rows).slice(0, limit) : null;
    },
    scoutBoard: async (chain, window, limit, onlyWorthALook) => {
      const rows = rankScout(
        walletScout
          .wallets(chain as ScoutChain)
          .map((x) => summarise(x, window))
          .filter((r) => r.buys + r.sells > 0),
        'copyScore',
      );
      const shown = onlyWorthALook ? applyScoutFilters(rows, scoutFiltersAllOn()) : rows;
      return { onRecord: rows.length, filtered: onlyWorthALook, rows: shown.slice(0, limit) };
    },
    scoutWallet: async (address, chain) => {
      const rec = walletScout.wallets(chain as ScoutChain).find((x) => x.address === address.toLowerCase()) ?? null;
      return rec ? { wallet: rec, saved: walletScout.isSaved(chain as ScoutChain, address.toLowerCase()) } : null;
    },
    copyConfigs: async () => {
      // The configs and their records, never the whole snapshot: `recent` is
      // thousands of rows and the agent asked for the setup.
      const snap = getEngine().copySnapshot();
      return { configs: snap.configs, stats: snap.stats, liveExecutable: snap.liveExecutable, liveBlockedReason: snap.liveBlockedReason };
    },
    orders: async () => getEngine().ordersSnapshot(),
    kryptoSessions: async () =>
      kryptoMode.list().map((s) => ({
        mint: s.mint,
        symbol: s.symbol,
        botWallet: s.address,
        driver: s.driver,
        strategy: s.driver === 'strategy' ? s.strategy : null,
        mode: s.mode,
        status: s.status,
        budgetSol: s.budgetSol,
        netSpentSol: s.netSpentSol,
        tokensHeld: s.tokensHeld,
        lastPriceSol: s.lastPriceSol,
        note: s.note,
        trades: s.trades.slice(0, 10).map((t) => ({ at: t.at, side: t.side, sol: t.sol, pct: t.pct, ok: t.ok, reason: t.reason, by: t.by })),
      })),
    kryptoTrade: (mint, side, amount, live) => kryptoMode.tradeFromMcp(mint, side, amount, live),
    // Krypto Trader: read the sessions, act for an MCP-driven one. Nothing
    // here creates, funds, starts, resumes or configures a session.
    traderSessions: async () => kryptoTrader.mcpList(),
    traderSession: async (id) => kryptoTrader.mcpDetail(id),
    traderGate: (id) => kryptoTrader.mcpGate(id),
    traderAct: (id, intent, expectedSeq) => kryptoTrader.submit(id, intent, 'mcp', expectedSeq),
    trades: async (limit) => getEngine().tradeHistory().slice(0, limit),
    // `hostBuy` / `hostSell` are the same pair user scripts reach, so the EVM
    // routing, the paper book and the live rails are one implementation with
    // two callers rather than two that drift.
    buy: async (mint, amount, paper, chain) => {
      const r = await getEngine().hostBuy(mint, amount, paper ? 'paper' : 'live', chain);
      return { ok: r.ok || r.pending === true, message: r.message };
    },
    sell: async (mint, percent, paper, chain) => {
      const r = await getEngine().hostSell(mint, percent, paper ? 'paper' : 'live', chain);
      return { ok: r.ok || r.pending === true, message: r.message };
    },
    placeOrder: async (req, paper) => {
      if (paper) return { ok: false, message: 'Advanced orders are live-only. This connection is in paper mode, so nothing was armed.' };
      const clean: NewOrderRequest = {
        mint: req.mint,
        symbol: '',
        kind: req.kind as NewOrderRequest['kind'],
        triggerValue: req.triggerValue,
        triggerBasis: req.triggerBasis as NewOrderRequest['triggerBasis'],
        amount: req.amount,
        expiresAt: null,
      };
      const v = validateOrder(clean);
      if (!v.ok) return { ok: false, message: v.message };
      const r = await getEngine().createOrder(clean);
      return { ok: r.ok, message: r.message };
    },
    cancelOrders: async (mint) => {
      const open = getEngine().ordersSnapshot().orders.filter((o) => o.mint === mint && o.state === 'armed');
      let cancelled = 0;
      for (const o of open) if (getEngine().cancelOrder(o.id).ok) cancelled += 1;
      return { ok: true, message: cancelled ? `Cancelled ${cancelled} order(s).` : 'No armed orders on that token.', cancelled };
    },
    log: (level, line) => (level === 'error' ? logger.error(line) : level === 'warn' ? logger.warn(line) : logger.info(line)),
  });

  const mcpHost: mcpServer.McpServerHost = {
    access: () => store.load().mcp.access,
    token: () => store.load().mcp.token,
    // EVERY tool call is logged, not just the ones that throw. An agent that
    // can spend money needs an audit trail, and "what did the AI actually do"
    // was unanswerable from the log until a logging audit asked (2026-09-21).
    // Arguments are included because they are the intent — they carry no
    // secret, by the design in shared/mcp.ts.
    callTool: async (name, args) => {
      const started = Date.now();
      const r = await mcpTools.call(name, args);
      const keys = Object.keys(args);
      const shown = keys.length ? ` ${keys.map((k) => `${k}=${String((args as Record<string, unknown>)[k]).slice(0, 44)}`).join(' ')}` : '';
      toLog(r.ok ? 'info' : 'warn', `AI called ${name}${shown} → ${r.ok ? 'ok' : 'REFUSED'} in ${Date.now() - started}ms${r.ok ? '' : `: ${r.text.slice(0, 160)}`}`);
      return r;
    },
    log: (level, line) => (level === 'error' ? logger.error(line) : level === 'warn' ? logger.warn(line) : logger.info(line)),
  };

  /**
   * Bring the listener in line with the settings.
   *
   * Called at boot and after every change, so switching the connection off
   * closes the port rather than leaving it open until a restart. A connection
   * with no token never listens: an empty bearer would authenticate nothing,
   * but it would still be an open port.
   */
  const syncMcp = async (): Promise<{ ok: boolean; message: string }> => {
    const m = store.load().mcp;
    if (!m.enabled || m.access === 'off' || !m.token) {
      mcpServer.stop();
      return { ok: true, message: 'The AI connection is off.' };
    }
    return await mcpServer.start(mcpHost, m.port);
  };
  void syncMcp();

  const mcpPayload = (): Record<string, unknown> => {
    const m = store.load().mcp;
    const server = mcpServer.status();
    // The port actually bound when listening, and a server name per profile:
    // two profiles side by side are two servers, and one name would make the
    // second `claude mcp add` overwrite the first in the client's config.
    const port = server.running && server.port ? server.port : m.port;
    const name = mcpServerNameFor(profiles.currentId());
    return {
      settings: m,
      server,
      command: m.token ? mcpAddCommand(port, m.token, name) : '',
      json: m.token ? mcpJsonConfig(port, m.token, name) : '',
    };
  };

  ipcMain.handle('mcp:status', () => ok('ok', mcpPayload()));

  ipcMain.handle('mcp:setEnabled', async (_e, on: unknown) => {
    const want = on === true;
    const m = store.load().mcp;
    // Switching it on mints a token when there is none, so the panel never
    // shows a listener with nothing to authenticate against.
    store.update({ mcp: { ...m, enabled: want, token: want && !m.token ? mcpServer.newToken() : m.token } });
    const r = await syncMcp();
    if (!r.ok) {
      store.update({ mcp: { ...store.load().mcp, enabled: false } });
      return fail(r.message);
    }
    logger.info(`MCP: the AI connection was switched ${want ? 'on' : 'off'}`);
    return ok(want ? r.message : 'The AI connection is off.', mcpPayload());
  });

  /**
   * The access level, on its own channel.
   *
   * Not a settings patch, for the reason `execution.liveEnabled` is not one:
   * this is the bit that decides whether an agent may spend real funds, and
   * it should be a deliberate act with a line in the log behind it rather
   * than a field riding along inside some other panel's save.
   */
  ipcMain.handle('mcp:setAccess', async (_e, level: unknown) => {
    if (typeof level !== 'string' || !MCP_ACCESS_LEVELS.includes(level as McpAccess)) return fail('Unknown access level');
    store.update({ mcp: { ...store.load().mcp, access: level as McpAccess } });
    // A level change is a new arrangement: the rolling caps start over rather
    // than letting a switch to live inherit an hour of paper "spending".
    mcpTools.resetBudget();
    await syncMcp();
    if (level === 'live') logger.warn('MCP: the AI connection was set to LIVE — an agent can now spend real funds within its budget');
    else logger.info(`MCP: the AI connection was set to ${level}`);
    const said = level === 'off' ? 'off' : level === 'read' ? 'read only' : level === 'paper' ? 'paper trading' : 'LIVE trading';
    return ok(`The AI connection is now ${said}.`, mcpPayload());
  });

  ipcMain.handle('mcp:newToken', async () => {
    store.update({ mcp: { ...store.load().mcp, token: mcpServer.newToken() } });
    // Every client holding the old one is refused from here; the listener is
    // restarted so nothing keeps a connection open under it.
    mcpServer.stop();
    await syncMcp();
    logger.info('MCP: a new token was generated — reconnect any AI client with the new command');
    return ok('A new token was generated. Reconnect your AI client with the new command.', mcpPayload());
  });

  ipcMain.handle('mcp:setPort', async (_e, port: unknown) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < MCP_PORT_MIN || p > MCP_PORT_MAX) return fail(`Port must be a whole number between ${MCP_PORT_MIN} and ${MCP_PORT_MAX}`);
    store.update({ mcp: { ...store.load().mcp, port: p } });
    const r = await syncMcp();
    return r.ok ? ok(r.message, mcpPayload()) : fail(r.message);
  });

  ipcMain.handle('mcp:setBudget', async (_e, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return fail('Invalid budget');
    const b = raw as Record<string, unknown>;
    const m = store.load().mcp;
    const next = {
      maxBuySol: Number(b.maxBuySol),
      hourlyCapSol: Number(b.hourlyCapSol),
      maxTradesPerMinute: Math.round(Number(b.maxTradesPerMinute)),
    };
    if (!(next.maxBuySol > 0) || next.maxBuySol > 25) return fail('Max per trade must be between 0 and 25');
    if (!(next.hourlyCapSol > 0) || next.hourlyCapSol > 100) return fail('The hourly cap must be between 0 and 100');
    if (next.maxBuySol > next.hourlyCapSol) return fail('Max per trade is above the hourly cap');
    if (!Number.isInteger(next.maxTradesPerMinute) || next.maxTradesPerMinute < 1 || next.maxTradesPerMinute > 60) return fail('Trades per minute must be between 1 and 60');
    store.update({ mcp: { ...m, budget: next } });
    return ok('Saved.', mcpPayload());
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
      holderRewards: d.holderRewards === true,
      creatorTaxBps: Math.round(Number(d.creatorTaxBps)),
      // Solana only; anywhere else it is off whatever was sent.
      krypto: d.chain === 'solana' ? kryptoOptionsOf(d.krypto) : kryptoOptionsOf(null),
    };
  };

  // ── $Krypto Mode ───────────────────────────────────────────────────
  // A launched coin's declared bot (electron/engine/kryptoMode.ts). The host
  // is the engine's ordinary trade path + the fund module; nothing here is a
  // shortcut around a gate.
  kryptoMode.init(app.getPath('userData'), {
    now: () => Date.now(),
    priceSol: (mint) => getEngine().botPrice(mint),
    market: (mint) => {
      const m = market.summaryIfCached(mint);
      return {
        symbol: m?.symbol ?? '',
        ageSec: m?.createdAt ? Math.max(0, (Date.now() - m.createdAt) / 1000) : null,
        marketCapUsd: m?.marketCapUsd ?? null,
        holders: m?.holders ?? null,
        change5mPct: m?.stats?.['5m']?.priceChangePct ?? null,
      };
    },
    liveBlocked: (side) => getEngine().botLiveBlocked(side ?? 'buy'),
    buy: (walletId, mint, sol) => getEngine().botBuy(walletId, mint, sol),
    sell: (walletId, mint, pct) => getEngine().botSell(walletId, mint, pct),
    balances: async (address, mint) => {
      const url = store.load().rpc.httpUrl;
      const [b, t] = await Promise.all([getBalance(url, address).catch(() => null), getTokenBalanceForMint(url, address, mint).catch(() => null)]);
      return {
        lamports: b && b.ok && typeof b.data === 'number' ? b.data : null,
        tokens: t && t.ok && typeof t.data === 'number' ? t.data : null,
      };
    },
    fund: async (fromWalletId, toAddress, lamports) => {
      const st = store.load();
      const r = await fund.fundWallets(execUrlOf(st.rpc), [{ publicKey: toAddress, lamports }], fromWalletId);
      return { ok: r.ok, message: r.message };
    },
    collect: async (walletId, toWalletId) => {
      const st = store.load();
      const [r] = await fund.collectToActive(execUrlOf(st.rpc), [walletId], toWalletId);
      return r ? { ok: r.ok, message: r.message } : { ok: false, message: 'nothing was collected' };
    },
    ask: async (facts, goal) => {
      const ai = store.load().ai;
      const { activeProvider, askKrypto } = await import('./data/aiAnalysis');
      if (!activeProvider(ai)) return null;
      return askKrypto(ai, facts, goal);
    },
    watch: (mint) => {
      try {
        getEngine().watchPumpMint(mint);
      } catch {
        /* the engine is not up yet; the loop's price read still works */
      }
    },
    emit: (sessions) => sendToWindows({ kind: 'krypto', sessions }),
    log: (level, line) => logger[level](line),
  });
  kryptoMode.startLoop();

  /** The bot wallet for a Krypto Mode upload: an unused declared one if there
   *  is one (so re-pinning an edited draft does not mint a new wallet each
   *  time), else a fresh wallet made for this coin. */
  const kryptoBotWallet = (symbol: string): { walletId: string; address: string } | { error: string } => {
    const reuse = kryptoMode.unusedDeclaredWallet();
    if (reuse && wallet.publicKeyOf(reuse.walletId) === reuse.address) return { walletId: reuse.walletId, address: reuse.address };
    const g = wallet.generate(`Krypto Mode · ${symbol || 'new coin'}`);
    if (!g.ok || !g.publicKey) return { error: `Could not make the Krypto Mode wallet: ${g.message}` };
    syncLiveMode();
    refreshScoutOwnership();
    const id = wallet.list().find((w) => w.publicKey === g.publicKey)?.id;
    if (!id) return { error: 'The Krypto Mode wallet was made but could not be found again.' };
    return { walletId: id, address: g.publicKey };
  };

  ipcMain.handle('kryptoMode:list', () => ok('ok', { sessions: kryptoMode.list(), failure: kryptoMode.failure() }));
  const kryptoId = (id: unknown): string | null => (typeof id === 'string' && /^km_[a-z0-9_]{1,40}$/.test(id) ? id : null);
  ipcMain.handle('kryptoMode:pause', (_e, id: unknown) => {
    const k = kryptoId(id);
    if (!k) return fail('Bad session id');
    const r = kryptoMode.setStatus(k, 'paused');
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoMode:resume', (_e, id: unknown) => {
    const k = kryptoId(id);
    if (!k) return fail('Bad session id');
    const r = kryptoMode.setStatus(k, 'running');
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoMode:goLive', async (_e, id: unknown) => {
    const k = kryptoId(id);
    if (!k) return fail('Bad session id');
    const r = await kryptoMode.goLive(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoMode:sellAll', async (_e, id: unknown) => {
    const k = kryptoId(id);
    if (!k) return fail('Bad session id');
    const r = await kryptoMode.sellAll(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoMode:withdraw', async (_e, id: unknown) => {
    const k = kryptoId(id);
    if (!k) return fail('Bad session id');
    const r = await kryptoMode.withdraw(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoMode:setLimits', (_e, id: unknown, patch: unknown) => {
    const k = kryptoId(id);
    if (!k) return fail('Bad session id');
    if (!patch || typeof patch !== 'object') return fail('Nothing to change');
    const r = kryptoMode.setLimits(k, patch as { limits?: unknown; goal?: unknown; budgetSol?: unknown });
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoMode:remove', (_e, id: unknown) => {
    const k = kryptoId(id);
    if (!k) return fail('Bad session id');
    const r = kryptoMode.remove(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });

  // ── Krypto Trader ──────────────────────────────────────────────────
  // One coin, one of the user's wallets, a preset or an AI
  // (electron/engine/kryptoTrader.ts). The host is the engine's ordinary
  // trade path; nothing here is a shortcut around a gate. The fit check is
  // computed HERE, in main (shared/botStrategy.ts traderFit), from the pump
  // chain read + the market summary — the renderer only shows it.
  /** One batched read for many mints: pump coins from the chain (4 s cache,
   *  33 mints per RPC call), anything else from the engine's timed price. */
  const traderMarkets = async (mints: string[]): Promise<Map<string, TraderMarket | null>> => {
    const url = store.load().rpc.httpUrl;
    const pump = mints.filter((m) => pumpChain.looksLikePumpMint(m));
    const read = pump.length ? await pumpChain.readMany(url, pump).catch(() => new Map<string, pumpChain.PumpChainCoin | null>()) : new Map<string, pumpChain.PumpChainCoin | null>();
    const out = new Map<string, TraderMarket | null>();
    for (const m of mints) {
      const c = read.get(m) ?? null;
      if (c) {
        const onCurve = !c.curve.complete;
        out.set(m, {
          priceSol: c.priceSol,
          priceAt: c.priceSol !== null ? c.readAt : null,
          venue: c.pool ? 'pool' : onCurve ? 'curve' : null,
          curvePct: onCurve ? curveProgressTokenPct(c.curve.vTok) : null,
          // R: the curve's virtual SOL, or the PumpSwap QUOTE VAULT — not the
          // event's poolQuoteReserves, which reads 0.793× on classic pools.
          depthSol: c.pool ? Number(c.pool.quoteLamports) / 1e9 : onCurve ? Number(c.curve.vSol) / 1e9 : null,
          decimals: c.decimals,
          // A complete curve whose pool could not be read is "unknown", not
          // gone: nothing here can tell those apart yet, so it never stops out.
          poolGone: false,
        });
        continue;
      }
      let p: { priceSol: number; at: number } | null = null;
      try {
        p = getEngine().priceSolWithAge(m);
      } catch {
        p = null;
      }
      out.set(m, p ? { priceSol: p.priceSol, priceAt: p.at, venue: null, curvePct: null, depthSol: null, decimals: null, poolGone: false } : null);
    }
    return out;
  };

  /** Numbers for the AI/MCP facts: the cached market summary + 5-minute
   *  candles. No text field — the facts never carry what a creator wrote. */
  const traderMarketFacts = async (mint: string): Promise<TraderMarketFacts> => {
    const sum = market.summaryIfCached(mint) ?? (await market.summary(mint).catch(() => null));
    if (!sum) return { ...EMPTY_MARKET_FACTS };
    const s5 = sum.stats?.['5m'];
    const h1 = sum.stats?.['1h'];
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    let closes: number[] = [];
    let lo: number | null = null;
    let hi: number | null = null;
    try {
      const series = await market.candlesFast(mint, '5m', 13);
      // Candles priced in USD are turned into SOL with the summary's own
      // ratio; with no ratio they are left out rather than mislabelled.
      const k = series.unit === 'sol' ? 1 : num(sum.priceSol) !== null && num(sum.priceUsd) ? (sum.priceSol as number) / (sum.priceUsd as number) : null;
      if (k !== null) {
        const bars = series.candles.slice(-12);
        closes = bars.map((c) => c.close * k).filter((x) => Number.isFinite(x) && x > 0);
        if (bars.length) {
          lo = Math.min(...bars.map((c) => c.low * k));
          hi = Math.max(...bars.map((c) => c.high * k));
        }
      }
    } catch {
      /* no candles: nulls */
    }
    const v5 = num(s5?.volumeUsd);
    const v1 = num(h1?.volumeUsd);
    return {
      marketCapUsd: num(sum.marketCapUsd),
      holders: num(sum.holders),
      top10Pct: num(sum.top10Pct),
      change5mPct: num(s5?.priceChangePct),
      change15mPct: null,
      change1hPct: num(h1?.priceChangePct),
      change6hPct: num(sum.stats?.['6h']?.priceChangePct),
      change24hPct: num(sum.stats?.['24h']?.priceChangePct),
      range1hLowSol: lo !== null && Number.isFinite(lo) && lo > 0 ? lo : null,
      range1hHighSol: hi !== null && Number.isFinite(hi) && hi > 0 ? hi : null,
      vol5mVs1hAvg: v5 !== null && v1 !== null && v1 > 0 ? v5 / (v1 / 12) : null,
      buys5m: num(s5?.buys),
      sells5m: num(s5?.sells),
      closes5mSol: closes,
    };
  };

  const userWalletAddresses = (): Set<string> => new Set(wallet.list().map((w) => w.publicKey));

  const traderFitFor = async (mint: string, o: { budgetSol: number; limits: TraderLimits; walletId: string | null; params?: unknown; preset?: string }): Promise<TraderFit> => {
    const url = store.load().rpc.httpUrl;
    const [mk] = [(await traderMarkets([mint])).get(mint) ?? null];
    const coin = pumpChain.readIfCached(mint);
    const sum = await market.summary(mint).catch(() => null);
    let transferFeeBps: number | null = null;
    let defaultFrozen: boolean | null = null;
    const acc = await getAccountInfo(url, mint).catch(() => null);
    if (acc && acc.ok && acc.data) {
      const ext = parseMintExtensions(acc.data.data);
      if (ext) {
        transferFeeBps = ext.transferFeeBps ?? 0;
        defaultFrozen = ext.defaultFrozen;
      }
    }
    const h1 = sum?.stats?.['1h'];
    const creator = coin?.curve.creator ?? sum?.creator ?? null;
    const regime = mk?.venue === 'curve' && coin ? curveRegime(Number(coin.curve.vSol), Number(coin.curve.vTok)) : mk?.venue === 'curve' ? 'unknown' : null;
    const supply = coin ? Number(coin.supplyRaw) / 10 ** coin.decimals : sum?.totalSupply ?? null;
    const tokenReserve = coin ? (coin.pool ? Number(coin.pool.baseRaw) : Number(coin.curve.vTok)) / 10 ** coin.decimals : null;
    const holderRate = kryptoHolding.holderRateApplies();
    const preset = (['trim', 'steps', 'dips', 'hold'] as const).find((p) => p === o.preset);
    let maxLive: number | null = null;
    try {
      maxLive = getEngine().maxLiveSol();
    } catch {
      maxLive = null;
    }
    const fitOut = traderFit({
      now: Date.now(),
      mint,
      venue: mk?.venue === 'curve' ? 'curve' : mk?.venue === 'pool' ? 'pumpswap' : null,
      regime,
      curvePct: mk?.curvePct ?? null,
      depthSol: mk?.depthSol ?? null,
      tokenReserve,
      supply,
      createdAt: sum?.createdAt ?? null,
      devPct: sum?.devHoldingPct ?? null,
      top10Pct: sum?.top10Pct ?? null,
      sniperPct: sum?.sniperPct ?? null,
      bundledPct: sum?.bundledPct ?? null,
      trades1h: h1 && h1.buys !== null && h1.sells !== null ? h1.buys + h1.sells : null,
      vol1hUsd: h1?.volumeUsd ?? null,
      vol6hUsd: sum?.stats?.['6h']?.volumeUsd ?? null,
      vol24hUsd: sum?.stats?.['24h']?.volumeUsd ?? null,
      organic1hUsd: h1?.organicVolumeUsd ?? null,
      creatorLaunches: sum?.audit?.devMints ?? null,
      creatorGraduations: sum?.audit?.devMigrations ?? null,
      creatorKnown: !!creator,
      kryptScore: sum?.kryptScore ?? null,
      notSellable: sum?.audit?.notSellable ?? null,
      transferFeeBps,
      defaultFrozen,
      ownCoin: o.walletId ? await traderOwnCoin(mint, o.walletId, creator, sum?.kryptoBot ?? null) : null,
      holderRate,
      maxLiveSol: maxLive,
      budgetSol: o.budgetSol,
      limits: o.limits,
      params: preset && o.params && typeof o.params === 'object' ? ({ [preset]: o.params } as Partial<TraderParamsByPreset>) : undefined,
    });
    if (o.walletId) fitOut.notes.push(...otherWalletNotes(mint, o.walletId));
    return fitOut;
  };

  /**
   * Critic #12: the wash pattern across the user's OWN wallets. A session
   * selling while another of the user's wallets holds or automates the same
   * coin is the round trip between one's own wallets the launchpad research
   * names. Shown on the fit card before Start (not a refusal: the claims
   * check refuses the session's own wallet; these are the others).
   * "Holds" is this app's own record (ledger fills per wallet), not an RPC
   * read per wallet on every keystroke.
   */
  const otherWalletNotes = (mint: string, walletId: string): string[] => {
    const own = wallet.publicKeyOf(walletId);
    const names = new Map(wallet.list().map((w) => [w.publicKey, w.label || `${w.publicKey.slice(0, 6)}…`]));
    const net = new Map<string, bigint>();
    for (const f of ledger.all()) {
      if (f.mint !== mint || !f.wallet || f.wallet === own || f.state !== 'reconciled' || f.tokenDeltaRaw === null || !names.has(f.wallet)) continue;
      try {
        net.set(f.wallet, (net.get(f.wallet) ?? 0n) + BigInt(f.tokenDeltaRaw));
      } catch {
        /* a malformed amount is not a holding */
      }
    }
    const out: string[] = [];
    for (const [addr, n] of net) if (n > 0n) out.push(`Your wallet ${names.get(addr)} holds this coin (from this app's trade records). A session selling while another of your wallets holds or buys the same coin trades against yourself — the wash pattern.`);
    for (const o of automation.openedOn(mint)) {
      if (o.wallet !== null && o.wallet !== own) out.push(`The script "${o.script}" holds this coin in another of your wallets (${names.get(o.wallet) ?? `${o.wallet.slice(0, 6)}…`}).`);
    }
    return out;
  };

  /** M9: the user's own coin. A Krypto Mode session on it, a creator or a
   *  declared bot that is one of the user's wallets, or a wallet Krypto Mode
   *  declared — a bot on your own coin must be declared, and only Krypto
   *  Mode declares one. */
  const traderOwnCoin = async (mint: string, walletId: string, creator: string | null, kryptoBot: string | null): Promise<string | null> => {
    if (kryptoMode.list().some((s) => s.mint === mint)) return TRADER_OWN_COIN_MESSAGE;
    const mine = userWalletAddresses();
    if (creator && mine.has(creator)) return TRADER_OWN_COIN_MESSAGE;
    if (kryptoBot && mine.has(kryptoBot)) return TRADER_OWN_COIN_MESSAGE;
    if (kryptoMode.declaredWallets().includes(walletId)) return TRADER_OWN_COIN_MESSAGE;
    return null;
  };

  // ── Krypto Trader on BNB and Robinhood Chain (stage 4) ─────────────
  // The EVM rail, chain-first on every call. The wallet is one of THAT
  // chain's (walletVisibleOn: made for it, pre-split, or its signer — never
  // one made for the other chain). Sells are EXACT base units (the rail's
  // amountRaw); fills come from the EVM ledger's receipt reconciliation.
  // A Solana ledger fill as a session reads it: only meta.err proves "did
  // not land" — "not found after N rounds" can be an RPC outage.
  const solTraderFill = (f: ledger.Fill): TraderLedgerFill => ({
    signature: f.signature,
    wallet: f.wallet,
    mint: f.mint,
    side: f.side,
    at: f.at,
    state: f.state,
    tokenDeltaRaw: f.tokenDeltaRaw,
    solDeltaLamports: f.solDeltaLamports,
    decimals: f.decimals,
    feeLamports: f.feeLamports,
    failed: f.state === 'unreconciled' && f.note === ledger.FAILED_ON_CHAIN_NOTE,
    note: f.note,
  });
  const evmTraderFill = (f: EvmFill): TraderLedgerFill => ({
    signature: f.hash,
    wallet: f.wallet,
    mint: f.token,
    side: f.side,
    at: f.at,
    state: f.state,
    tokenDeltaRaw: f.tokenDeltaRaw,
    solDeltaLamports: null,
    decimals: f.decimals,
    feeLamports: null,
    chain: f.chain,
    nativeDeltaWei: f.nativeDeltaWei,
    feeWei: f.feeWei,
    gasWei: f.gasWei,
    // Only a reverted receipt proves "did not land"; any other unreconciled
    // row (proceeds unreadable, receipt never found) is unprovable.
    failed: f.state === 'unreconciled' && f.note === evmLedger.REVERTED_NOTE,
    note: f.note,
  });
  const evmSymbols = new Map<string, string>();
  const evmTraderWallet = (chain: EvmChainKind, walletId: string): string | null => {
    const w = evmWallet.list(chain).find((x) => x.id === walletId);
    return w && walletVisibleOn(w, chain) ? w.address.toLowerCase() : null;
  };
  const evmTraderBlocked = (chain: EvmChainKind): string | null => {
    const s = store.load();
    if (!s.evm[chain].enabled) return `${EVM_CHAIN_META[chain].name} is switched off in Settings`;
    if (!evmRail.armed(chain)) return `${EVM_CHAIN_META[chain].name} is in Paper — arm it on its wallet page`;
    return null;
  };
  const evmTraderMarkets = async (chain: EvmChainKind, tokens: string[]): Promise<Map<string, TraderMarket | null>> => {
    const out = new Map<string, TraderMarket | null>();
    await Promise.all(
      tokens.map(async (t) => {
        const r = await readTraderMarket(chain, t).catch(() => null);
        out.set(
          t,
          r && !r.untradable
            ? { priceSol: r.priceNative, priceAt: r.priceAt, venue: r.venue, curvePct: r.curvePct, depthSol: r.depthNative, decimals: r.decimals, poolGone: false }
            : null,
        );
      }),
    );
    return out;
  };
  const evmTraderOwnCoin = (chain: EvmChainKind, deployer: string | null): string | null => {
    if (!deployer) return null;
    const mine = new Set(evmWallet.list(chain).map((w) => w.address.toLowerCase()));
    return mine.has(deployer.toLowerCase()) ? TRADER_OWN_COIN_MESSAGE_EVM : null;
  };
  /** Critic #12 on an EVM chain: the user's OTHER wallets on this chain that
   *  hold the coin, from the EVM ledger (this app's own record). */
  const evmOtherWalletNotes = (chain: EvmChainKind, token: string, own: string | null): string[] => {
    const net = new Map<string, bigint>();
    const mine = new Map(evmWallet.list(chain).map((w) => [w.address.toLowerCase(), w.label || `${w.address.slice(0, 8)}…`]));
    for (const f of evmLedger.all()) {
      if (f.chain !== chain || f.token !== token || f.state !== 'reconciled' || f.tokenDeltaRaw === null || f.wallet === own || !mine.has(f.wallet)) continue;
      try {
        net.set(f.wallet, (net.get(f.wallet) ?? 0n) + BigInt(f.tokenDeltaRaw));
      } catch {
        /* a malformed amount is not a holding */
      }
    }
    const out: string[] = [];
    for (const [addr, n] of net) if (n > 0n) out.push(`Your wallet ${mine.get(addr)} holds this coin (from this app's trade records). A session selling while another of your wallets holds or buys the same coin trades against yourself — the wash pattern.`);
    return out;
  };
  const evmTraderFit = async (chain: EvmChainKind, token: string, o: { budgetSol: number; limits: TraderLimits; walletId: string | null; params?: unknown; preset?: string }): Promise<TraderFit> => {
    const t = token.toLowerCase();
    const [read, sum] = await Promise.all([readTraderMarket(chain, t), evmRail.summary(chain, t).catch(() => null)]);
    if (sum?.symbol) evmSymbols.set(`${chain}:${t}`, sum.symbol);
    const h1 = sum?.stats?.['1h'];
    const preset = (['trim', 'steps', 'dips', 'hold'] as const).find((p) => p === o.preset);
    const sym = EVM_CHAIN_META[chain].nativeSymbol;
    const fitOut = traderFit({
      now: Date.now(),
      mint: t,
      chain,
      venue: read.untradable ? null : read.venue,
      venueLabel: read.venueLabel,
      venueRefusal: read.untradable
        ? /quoted in/i.test(read.untradable)
          ? `Not ${sym}-quoted: ${read.untradable} Krypto Trader sizes every trade against a ${sym} pool depth, so it cannot run here.`
          : read.untradable
        : null,
      regime: null,
      curvePct: read.curvePct,
      depthSol: read.depthNative,
      tokenReserve: read.tokenReserve,
      supply: read.supply,
      createdAt: read.createdAt ?? sum?.createdAt ?? null,
      devPct: sum?.devHoldingPct ?? null,
      top10Pct: sum?.top10Pct ?? null,
      sniperPct: null,
      bundledPct: null,
      trades1h: h1 && h1.buys !== null && h1.sells !== null ? h1.buys + h1.sells : null,
      vol1hUsd: h1?.volumeUsd ?? null,
      vol6hUsd: sum?.stats?.['6h']?.volumeUsd ?? null,
      vol24hUsd: sum?.stats?.['24h']?.volumeUsd ?? null,
      organic1hUsd: null,
      creatorLaunches: null,
      creatorGraduations: null,
      creatorKnown: !!read.deployer,
      kryptScore: null,
      notSellable: null,
      transferFeeBps: null,
      defaultFrozen: null,
      ownCoin: o.walletId ? evmTraderOwnCoin(chain, read.deployer) : null,
      holderRate: kryptoHolding.holderRateApplies(),
      maxLiveSol: null,
      budgetSol: o.budgetSol,
      limits: o.limits,
      params: preset && o.params && typeof o.params === 'object' ? ({ [preset]: o.params } as Partial<TraderParamsByPreset>) : undefined,
    });
    if (o.walletId) fitOut.notes.push(...evmOtherWalletNotes(chain, t, evmTraderWallet(chain, o.walletId)));
    return fitOut;
  };
  const evmTraderFacts = async (chain: EvmChainKind, token: string): Promise<TraderMarketFacts> => {
    const sum = await evmRail.summary(chain, token).catch(() => null);
    if (!sum) return { ...EMPTY_MARKET_FACTS };
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const s5 = sum.stats?.['5m'];
    const h1 = sum.stats?.['1h'];
    let closes: number[] = [];
    let lo: number | null = null;
    let hi: number | null = null;
    try {
      // EVM candles are USD; turned into the native coin with the summary's
      // own ratio, or left out rather than mislabelled.
      const series = await evmRail.candles(chain, token, '5m', 13);
      const k = series.unit === 'sol' ? 1 : num(sum.priceSol) !== null && num(sum.priceUsd) ? (sum.priceSol as number) / (sum.priceUsd as number) : null;
      if (k !== null) {
        const bars = series.candles.slice(-12);
        closes = bars.map((c) => c.close * k).filter((x) => Number.isFinite(x) && x > 0);
        if (bars.length) {
          lo = Math.min(...bars.map((c) => c.low * k));
          hi = Math.max(...bars.map((c) => c.high * k));
        }
      }
    } catch {
      /* no candles: nulls */
    }
    const v5 = num(s5?.volumeUsd);
    const v1 = num(h1?.volumeUsd);
    return {
      marketCapUsd: num(sum.marketCapUsd),
      holders: num(sum.holders),
      top10Pct: num(sum.top10Pct),
      change5mPct: num(s5?.priceChangePct),
      change15mPct: null,
      change1hPct: num(h1?.priceChangePct),
      change6hPct: num(sum.stats?.['6h']?.priceChangePct),
      change24hPct: num(sum.stats?.['24h']?.priceChangePct),
      range1hLowSol: lo !== null && Number.isFinite(lo) && lo > 0 ? lo : null,
      range1hHighSol: hi !== null && Number.isFinite(hi) && hi > 0 ? hi : null,
      vol5mVs1hAvg: v5 !== null && v1 !== null && v1 > 0 ? v5 / (v1 / 12) : null,
      buys5m: num(s5?.buys),
      sells5m: num(s5?.sells),
      closes5mSol: closes,
    };
  };
  const traderEvmHost: TraderEvmHost = {
    markets: evmTraderMarkets,
    fit: evmTraderFit,
    symbol: (chain, token) => evmSymbols.get(`${chain}:${token.toLowerCase()}`) ?? '',
    buyBlocked: evmTraderBlocked,
    // EVM has no loss breakers: only "switched off" and "not armed" hold a sell.
    exitBlocked: evmTraderBlocked,
    // The EVM rails have no app-wide per-trade cap (copy's bridge answers
    // null too); the session's budget, depth cap and room are the caps.
    maxLive: () => null,
    walletAddress: evmTraderWallet,
    buy: async (chain, walletId, token, amountNative) => {
      if (!evmTraderWallet(chain, walletId)) return { ok: false, message: `not one of your ${EVM_CHAIN_META[chain].name} wallets`, signature: null, stage: 'route', sentSol: null };
      const r = await evmRail.buy(chain, token, amountNative, false, { walletId });
      // A disarmed chain SIMULATES and answers ok — that is not a buy.
      if (r.simulated) return { ok: false, message: `not sent — ${EVM_CHAIN_META[chain].name} is not armed (simulated only)`, signature: null, stage: r.stage, sentSol: null };
      return { ok: r.ok, message: r.message, signature: r.hash ?? null, stage: r.stage, sentSol: r.amountIn ? Number(BigInt(r.amountIn)) / 1e18 : null };
    },
    sellExact: async (chain, walletId, token, amountRaw) => {
      if (!evmTraderWallet(chain, walletId)) return { ok: false, message: `not one of your ${EVM_CHAIN_META[chain].name} wallets`, signature: null, stage: 'route', soldRaw: null };
      // `amountRaw` wins over the percent in the rail: EXACTLY these base
      // units (four.meme floors to its 1e9 quantum), refused above the balance.
      const r = await evmRail.sell(chain, token, 100, false, { walletId, amountRaw });
      if (r.simulated) return { ok: false, message: `not sent — ${EVM_CHAIN_META[chain].name} is not armed (simulated only)`, signature: null, stage: r.stage, soldRaw: null };
      return { ok: r.ok, message: r.message, signature: r.hash ?? null, stage: r.stage, soldRaw: r.amountIn ?? null };
    },
    fill: async (chain, hash) => {
      const f = await evmRail.settledFill(chain, hash);
      if (!f || f.state !== 'reconciled' || f.tokenDeltaRaw === null || f.nativeDeltaWei === null) return null;
      const raw = BigInt(f.tokenDeltaRaw);
      return { tokensRaw: (raw < 0n ? -raw : raw).toString(), decimals: f.decimals, nativeDeltaWei: f.nativeDeltaWei, feeWei: f.feeWei, gasWei: f.gasWei };
    },
    ledgerFill: (chain, hash) => {
      const f = evmLedger.all().find((x) => x.chain === chain && x.hash.toLowerCase() === hash.toLowerCase());
      return f ? evmTraderFill(f) : null;
    },
    tokenBalanceRaw: async (chain, walletId, token) => {
      if (!evmTraderWallet(chain, walletId)) return null;
      return (await evmRail.tokensOf(chain, token, walletId))?.raw ?? null;
    },
    // Reconcile after a crash: the EVM ledger records a fill the moment it is
    // broadcast, so the hash is there; its receipt settles it. On BNB the
    // receipt comes from the receipts endpoint — publicnode serves none.
    // The in-flight trade is the row on ITS side nearest its time, never a
    // hash the session already booked or called a hand trade — not the
    // newest row, which may be the user's own trade after the restart.
    findTrade: async (chain, walletId, token, sinceMs, match) => {
      const addr = evmTraderWallet(chain, walletId);
      if (!addr) return undefined;
      const skip = new Set(match.skip.map((x) => x.toLowerCase()));
      const rows = evmLedger
        .forWallet(chain, addr)
        .filter((f) => f.token === token.toLowerCase() && f.at >= sinceMs && f.side === match.side && !skip.has(f.hash.toLowerCase()))
        .sort((a, b) => Math.abs(a.at - match.near) - Math.abs(b.at - match.near));
      if (!rows.length) return null;
      const f = rows[0];
      if (f.state === 'unreconciled' && f.note === evmLedger.REVERTED_NOTE) return { signature: f.hash, side: f.side, tokensRaw: '0', nativeDeltaWei: '0', decimals: f.decimals, failed: true };
      if (f.state !== 'reconciled' || f.tokenDeltaRaw === null || f.nativeDeltaWei === null) return undefined;
      const raw = BigInt(f.tokenDeltaRaw);
      return { signature: f.hash, side: f.side, tokensRaw: (raw < 0n ? -raw : raw).toString(), nativeDeltaWei: f.nativeDeltaWei, decimals: f.decimals };
    },
    ownCoin: async (chain, token) => evmTraderOwnCoin(chain, (await readTraderMarket(chain, token).catch(() => null))?.deployer ?? null),
    claims: (chain, walletId, token) => {
      const out: string[] = [];
      const t = token.toLowerCase();
      if (copyTrade.openMints(chain).some((m) => m.toLowerCase() === t)) out.push('an open copy-trade position on this coin');
      const addr = evmTraderWallet(chain, walletId);
      const active = evmWallet.address(chain)?.toLowerCase() ?? null;
      for (const o of automation.openedOn(token).concat(t !== token ? automation.openedOn(t) : [])) {
        if (o.wallet === null ? addr !== null && addr === active : o.wallet.toLowerCase() === addr) out.push(`the script "${o.script}" holds this coin in this wallet`);
      }
      return out;
    },
    recentFills: (chain, token, sinceMs) => evmLedger.all().filter((f) => f.chain === chain && f.token === token.toLowerCase() && f.at >= sinceMs).map(evmTraderFill),
    // EVM prices are read on demand each tick (readTraderMarket); nothing to subscribe.
    watch: () => {},
    marketFacts: evmTraderFacts,
  };

  kryptoTrader.init(app.getPath('userData'), {
    now: () => Date.now(),
    markets: traderMarkets,
    fit: traderFitFor,
    symbol: (mint) => market.summaryIfCached(mint)?.symbol ?? pumpChain.readIfCached(mint)?.symbol ?? '',
    buyBlocked: () => getEngine().botLiveBlocked('buy'),
    exitBlocked: () => getEngine().botLiveBlocked('sell'),
    maxLiveSol: () => getEngine().maxLiveSol(),
    walletAddress: (walletId) => wallet.publicKeyOf(walletId),
    activeWalletId: () => wallet.list().find((w) => w.active)?.id ?? null,
    buy: async (walletId, mint, sol) => {
      const r = await getEngine().botBuy(walletId, mint, sol);
      return { ok: r.ok, message: r.message, signature: r.signature, stage: r.stage ?? null, sentSol: r.sentSol ?? null };
    },
    sellClaim: (walletId, mint, claimRaw) => getEngine().botSellClaim(walletId, mint, claimRaw),
    fill: (signature) => getEngine().botFill(signature),
    ledgerFill: (signature) => {
      const f = ledger.all().find((x) => x.signature === signature);
      return f ? solTraderFill(f) : null;
    },
    tokenBalanceRaw: (walletId, mint) => getEngine().tokenBalanceRaw(walletId, mint),
    findTrade: (walletId, mint, sinceMs, match) => getEngine().botFindTrade(walletId, mint, sinceMs, match),
    ownCoin: async (mint, walletId) => {
      const coin = pumpChain.readIfCached(mint);
      const sum = market.summaryIfCached(mint);
      return traderOwnCoin(mint, walletId, coin?.curve.creator ?? sum?.creator ?? null, sum?.kryptoBot ?? null);
    },
    claims: (walletId, mint) => {
      const out: string[] = [];
      const address = wallet.publicKeyOf(walletId);
      const active = wallet.list().find((w) => w.active)?.id ?? null;
      // Orders and the engine's own positions sell the ACTIVE wallet's
      // balance whatever wallet was active when they were placed (critic #6).
      if (walletId === active) {
        const orders = advOrders.all().filter((o) => o.mint === mint && (o.state === 'armed' || o.state === 'paused'));
        if (orders.length) out.push(`${orders.length} armed or paused order(s) on this coin sell the active wallet`);
        try {
          if (getEngine().holdsLiveMint(mint)) out.push('the engine holds an auto position on this coin in the active wallet');
        } catch {
          /* engine not up: no positions */
        }
      }
      // Conservative: an open copy row on this coin, whichever wallet.
      if (copyTrade.openMints('solana').includes(mint)) out.push('an open copy-trade position on this coin');
      for (const o of automation.openedOn(mint)) {
        if (o.wallet === null ? walletId === active : o.wallet === address) out.push(`the script "${o.script}" holds this coin in this wallet`);
      }
      if (kryptoMode.list().some((s) => s.mint === mint)) out.push('a Krypto Mode session on this coin');
      return out;
    },
    recentFills: (mint, sinceMs) => ledger.all().filter((f) => f.mint === mint && f.at >= sinceMs),
    watch: (mint) => {
      try {
        getEngine().watchPumpMint(mint);
      } catch {
        /* the engine is not up yet; the loop's chain read still works */
      }
    },
    marketFacts: (mint) => traderMarketFacts(mint),
    askTrader: async (facts, model, style) => {
      const ai = store.load().ai;
      const { askTrader } = await import('./data/aiAnalysis');
      const r = await askTrader(ai, facts, { model, style });
      // No key for the model: say so as "no key", which the session shows.
      if (r.provider === null) return null;
      return { ok: r.ok, message: r.message, text: r.text, model: r.model, usd: r.usd, refusal: r.refusal, cutOff: r.cutOff };
    },
    emit: (sessions) => sendToWindows({ kind: 'kryptoTrader', sessions }),
    log: (level, line) => logger[level](line),
    evm: traderEvmHost,
  });
  // Scripts, copy trading, orders and MCP buy_token ask this before they buy
  // a coin or arm an order on it (electron/engine/traderClaims.ts): a live
  // session's (wallet, coin) pair is its own. Manual buttons never ask.
  setTraderClaimCheck((ref, mint) => {
    const chain: ChainKind = ref.chain ?? 'solana';
    const address =
      chain === 'solana'
        ? (ref.address ?? (ref.walletId ? wallet.publicKeyOf(ref.walletId) : (wallet.list().find((w) => w.active)?.publicKey ?? null)))
        : (ref.address ?? (ref.walletId ? evmWallet.addressOf(ref.walletId) : evmWallet.address(chain)));
    if (!address) return null;
    const s = kryptoTrader.claimOn(address, mint, chain);
    return s
      ? `a live Krypto Trader session (${s.symbol || `${mint.slice(0, 6)}…`}, ${s.id}) trades this coin from wallet ${address.slice(0, 6)}…; pause it and sell its bag first, or trade this coin by hand`
      : null;
  });
  // Every settled fill: the session's own unsettled trades get booked, and a
  // trade on a session's (wallet, mint) that is not the session's pauses it.
  ledger.onSettled((f) => kryptoTrader.onLedgerFill(solTraderFill(f)));
  // The same on BNB / Robinhood, from the EVM ledger (tagged with its chain).
  evmLedger.onSettled((f) => kryptoTrader.onLedgerFill(evmTraderFill(f)));
  kryptoTrader.startLoop();

  const traderId = (id: unknown): string | null => (typeof id === 'string' && TRADER_ID_RE.test(id) ? id : null);
  ipcMain.handle('kryptoTrader:list', () => ok('ok', { sessions: kryptoTrader.list(), failure: kryptoTrader.failure() }));
  ipcMain.handle('kryptoTrader:fit', async (_e, mint: unknown, opts: unknown) => {
    const o = traderOptionsOf({ ...(opts && typeof opts === 'object' ? opts : {}), mint });
    if (o.chain === 'solana' ? typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) : !isEvmAddress(o.mint)) {
      return fail(o.chain === 'solana' ? 'Paste a valid Solana coin address.' : `Paste a valid ${EVM_CHAIN_META[o.chain].name} coin address (0x…).`);
    }
    try {
      const fo = { budgetSol: o.budgetSol, limits: o.limits, walletId: o.walletId || null, params: o.params, preset: o.preset };
      const f = o.chain === 'solana' ? await traderFitFor(o.mint, fo) : await evmTraderFit(o.chain, o.mint, fo);
      return ok('ok', f);
    } catch (err) {
      return fail(`Could not check this coin: ${(err as Error).message}`);
    }
  });
  ipcMain.handle('kryptoTrader:open', async (_e, raw: unknown) => {
    // traderOptionsOf rebuilds every field and drops the rest — including any
    // live flag or goal: a session always opens on paper.
    const r = await kryptoTrader.open(raw);
    return r.ok ? ok(r.message, r.session) : fail(r.message);
  });
  ipcMain.handle('kryptoTrader:pause', (_e, id: unknown) => {
    const k = traderId(id);
    if (!k) return fail('Bad session id');
    const r = kryptoTrader.pause(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoTrader:resume', async (_e, id: unknown) => {
    const k = traderId(id);
    if (!k) return fail('Bad session id');
    const r = await kryptoTrader.resume(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoTrader:goLive', async (_e, id: unknown) => {
    const k = traderId(id);
    if (!k) return fail('Bad session id');
    const r = await kryptoTrader.goLive(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoTrader:sellAll', async (_e, id: unknown) => {
    const k = traderId(id);
    if (!k) return fail('Bad session id');
    const r = await kryptoTrader.sellAll(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoTrader:setEnvelope', (_e, id: unknown, patch: unknown) => {
    const k = traderId(id);
    if (!k) return fail('Bad session id');
    const r = kryptoTrader.setEnvelope(k, patch);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoTrader:setLimits', (_e, id: unknown, patch: unknown) => {
    const k = traderId(id);
    if (!k) return fail('Bad session id');
    const r = kryptoTrader.setLimits(k, patch);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoTrader:remove', (_e, id: unknown) => {
    const k = traderId(id);
    if (!k) return fail('Bad session id');
    const r = kryptoTrader.remove(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoTrader:reconcile', async (_e, id: unknown) => {
    const k = traderId(id);
    if (!k) return fail('Bad session id');
    const r = await kryptoTrader.reconcile(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });
  ipcMain.handle('kryptoTrader:adopt', async (_e, id: unknown) => {
    const k = traderId(id);
    if (!k) return fail('Bad session id');
    const r = await kryptoTrader.adopt(k);
    return r.ok ? ok(r.message) : fail(r.message);
  });

  const launchDeps = (): LaunchDeps => {
    const s = store.load();
    return {
      cfg: s.launch,
      httpUrl: execUrlOf(s.rpc),
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
      httpUrl: execUrlOf(s.rpc),
      referrer: s.referrer,
      live: getEngine().liveState().armed && s.execution.liveEnabled,
    };
  };

  // Auto-swap USDC → SOL (2026-09-27). Every Solana wallet, on a slow timer
  // and sooner when the active wallet's holdings change; the SAME swap path
  // as the rewards panel's button below, so the fee is billed like on every
  // swap. Rules in shared/usdcSweep.ts; the setting on the Sol Wallet page.
  usdcSweep.attach({
    enabled: () => store.load().execution.autoSwapUsdc !== false,
    live: () => swapDeps().live,
    wallets: () => wallet.list().map((w) => ({ id: w.id, publicKey: w.publicKey, label: w.label })),
    usdcHeld: async (publicKey) => {
      const { usdcHeld } = await import('./engine/tokenWithdraw');
      return usdcHeld(swapDeps().httpUrl, publicKey);
    },
    swap: (walletId, usdc) =>
      swap.execute({ chain: 'solana', inputMint: USDC_MINT, outputMint: WSOL_MINT, amount: usdc, slippagePct: 1, speed: 'normal' }, swapDeps(), false, walletId),
    log: (level, line) => (level === 'warn' ? logger.warn(line) : logger.info(line)),
    announce: (line) => getEngine().announce('info', line),
  });
  usdcSweep.start();

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

  // ── pump.fun callout rewards (2026-09-23) ──────────────────────────
  //
  // Rewards arrive as USDC in each account's own wallet. These read what pump
  // says it paid, accept its reward terms (a button, one account), and turn
  // that USDC into SOL or send it to the wallet's CONFIRMED withdrawal
  // address — never anywhere else (see signPolicy 'withdraw-token').
  ipcMain.handle('calloutRewards:list', async () => {
    const httpUrl = resolveRpc(store.load().rpc).httpUrl;
    const { allRewards } = await import('./system/pumpRewards');
    const { usdcHeld } = await import('./engine/tokenWithdraw');
    const accounts = await allRewards();
    const wallets: Array<{ walletId: string; address: string; label: string; usdcRaw: string | null; homeAddress: string | null }> = [];
    for (const w of wallet.list()) {
      const held = await usdcHeld(httpUrl, w.publicKey).catch(() => null);
      wallets.push({ walletId: w.id, address: w.publicKey, label: w.label, usdcRaw: held === null ? null : held.toString(), homeAddress: w.homeAddress ?? null });
    }
    return ok('ok', { accounts, wallets });
  });

  ipcMain.handle('calloutRewards:acceptTerms', async (_e, walletId: unknown) => {
    if (typeof walletId !== 'string' || !walletId) return fail('Pick an account');
    const { acceptTerms } = await import('./system/pumpRewards');
    const r = await acceptTerms(walletId);
    return r.ok ? ok(r.message) : fail(r.message);
  });

  /** All of one wallet's USDC → SOL, through the ordinary swap path. */
  ipcMain.handle('calloutRewards:swapUsdc', async (_e, walletId: unknown) => {
    if (typeof walletId !== 'string' || !wallet.publicKeyOf(walletId)) return fail('That is not one of your wallets');
    const deps = swapDeps();
    if (!deps.live) return fail('Switch to Live and arm to swap — nothing was sent');
    const { usdcHeld, USDC_MINT } = await import('./engine/tokenWithdraw');
    const held = await usdcHeld(deps.httpUrl, wallet.publicKeyOf(walletId)!);
    if (held === null) return fail('Could not read that wallet’s USDC — nothing was sent');
    if (held <= 0n) return fail('That wallet holds no USDC');
    const r = await swap.execute(
      { chain: 'solana', inputMint: USDC_MINT, outputMint: WSOL_MINT, amount: Number(held) / 1e6, slippagePct: 1, speed: 'normal' },
      deps,
      false,
      walletId,
    );
    logger.info(`rewards: swap ${(Number(held) / 1e6).toFixed(2)} USDC → SOL in ${walletId}: ${r.message}`);
    return r.ok ? ok(r.message, r) : fail(r.message);
  });

  /** USDC to this wallet's confirmed withdrawal address, and nowhere else. */
  ipcMain.handle('calloutRewards:withdrawUsdc', async (_e, walletId: unknown, amountUsdc: unknown) => {
    if (typeof walletId !== 'string' || !wallet.publicKeyOf(walletId)) return fail('That is not one of your wallets');
    let amountRaw: bigint | 'max';
    if (amountUsdc === 'max') amountRaw = 'max';
    else if (typeof amountUsdc === 'number' && Number.isFinite(amountUsdc) && amountUsdc > 0 && amountUsdc < 1e9) amountRaw = BigInt(Math.floor(amountUsdc * 1e6));
    else return fail('Amount must be a positive number of USDC, or max');
    const { withdrawUsdc } = await import('./engine/tokenWithdraw');
    const s = store.load();
    const r = await withdrawUsdc(execUrlOf(s.rpc), { walletId, amountRaw });
    logger.warn(`rewards: USDC withdrawal from ${walletId} to ${r.dest ?? '(no address)'}: ${r.ok ? `sent ${r.amountRaw} base units as ${r.signature}` : r.message}`);
    return r.ok ? ok(r.message === 'confirmed' ? 'USDC sent to your withdrawal address.' : 'USDC sent — confirmation pending.', r) : fail(r.message);
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

  ipcMain.handle('bridge:send', async (_e, raw: unknown, simulateOnly: unknown, quoteId: unknown) => {
    if (!store.load().bridge.enabled) return fail('Bridging is switched off for this install.');
    const draft = bridgeDraftOf(raw);
    if (!draft) return fail('That is not a transfer');
    try {
      const r = await bridge.send(draft, bridgeDeps(), simulateOnly === true, typeof quoteId === 'string' ? quoteId : undefined);
      if (r.ok && simulateOnly !== true) logger.warn(`bridge: ${draft.amount} sent ${draft.from} to ${draft.to} (${r.txHash ?? 'no hash'})`);
      return r.ok ? ok(r.message, r) : fail(r.message);
    } catch (err) {
      return fail(`Transfer error: ${safeErr(err)}`);
    }
  });

  // ── All-in-One: move between chains (2026-10-01) ─────────────────────
  // The Bridge engine, unchanged, between the All-in-One wallet's own
  // addresses. Its own consent, not the Bridge switch: the wallet page is
  // where the user asked for it. Only while the All-in-One wallet signs on
  // every chain — otherwise 'its' addresses would be whichever wallets
  // happen to be active, and the money would go somewhere the page does
  // not show.
  const aioMoveBlocked = (draft?: { from: string; to: string } | null): string | null => {
    const i = aioWallet.info();
    if (!i.exists) return 'No All-in-One wallet.';
    if (!i.activeEverywhere) return 'Make the All-in-One wallet the signer on every chain first (Use it on every chain).';
    // A switched-off chain is not a destination: the Move card once showed
    // "Solana → Solana" and quoted to BNB (swarm 2026-10-03, UX-7).
    for (const c of draft ? [draft.from, draft.to] : []) {
      if (isEvmChain(c) && !evmRail.enabled(c)) return `${EVM_CHAIN_META[c].name} is turned off in Settings.`;
    }
    return null;
  };
  ipcMain.handle('aio:moveQuote', async (_e, raw: unknown) => {
    const draft = bridgeDraftOf(raw);
    if (!draft) return fail('That is not a transfer');
    const blocked = aioMoveBlocked(draft);
    if (blocked) return fail(blocked);
    try {
      const r = await bridge.quote(draft, bridgeDeps());
      return r.ok && r.quote ? ok(r.message, r.quote) : fail(r.message);
    } catch (err) {
      return fail(`Could not price that move: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('aio:moveSend', async (_e, raw: unknown, simulateOnly: unknown, quoteId: unknown) => {
    const draft = bridgeDraftOf(raw);
    if (!draft) return fail('That is not a transfer');
    const blocked = aioMoveBlocked(draft);
    if (blocked) return fail(blocked);
    try {
      const r = await bridge.send(draft, bridgeDeps(), simulateOnly === true, typeof quoteId === 'string' ? quoteId : undefined);
      if (r.ok && simulateOnly !== true) logger.warn(`aio move: ${draft.amount} sent ${draft.from} to ${draft.to} (${r.txHash ?? 'no hash'})`);
      return r.ok ? ok(r.message, r) : fail(r.message);
    } catch (err) {
      return fail(`Move error: ${safeErr(err)}`);
    }
  });

  // ── All-in-One: buy anywhere (phase 3, 2026-10-02) ───────────────────
  // When the chain a buy is on is short, top it up from another chain
  // (Relay, exact output, no Krypt fee — the buy pays it), wait until the
  // money is ON the chain, then the ordinary manual buy. Only in Live, only
  // while the All-in-One wallet signs on every chain. engine/aioBuy.ts.
  const aioChainOf = (v: unknown): AioChain | null => (v === 'solana' || v === 'bnb' || v === 'robinhood' ? v : null);
  const aioBuyHost: aioBuy.AioBuyHost = {
    offReason: (chain) => {
      const i = aioWallet.info();
      if (!i.exists) return 'No All-in-One wallet.';
      if (!i.activeEverywhere) return 'The All-in-One wallet is not the signer on every chain.';
      const live = chain === 'solana' ? getEngine().liveState().armed && store.load().execution.liveEnabled : evmRail.armed(chain);
      return live ? null : 'Paper mode — a paper buy needs no top-up.';
    },
    enabled: (c) => c === 'solana' || evmRail.enabled(c),
    nativeHeld: async (c) => {
      const i = aioWallet.info();
      try {
        if (c === 'solana') {
          if (!i.solanaAddress) return null;
          const r = await getBalance(bridgeDeps().httpUrl, i.solanaAddress);
          return r.ok && r.data !== undefined ? r.data / 1e9 : null;
        }
        if (!i.evmAddress) return null;
        const wei = await evmClient(c).getBalance({ address: i.evmAddress as `0x${string}` });
        return Number(wei) / 1e18;
      } catch {
        return null;
      }
    },
    priceUsd: async (c) => {
      try {
        return c === 'solana' ? await market.solUsd() : await evmNativeUsd(c);
      } catch {
        return null;
      }
    },
    quoteTopUp: (from, to, outRaw) => bridge.quoteTopUp({ from, to, outRaw }, bridgeDeps()),
    sendTopUp: (id) => bridge.sendTopUp(id, bridgeDeps()),
    buy: async (c, token, amount, heldNow) => {
      // The same calls the trade panels make, live: every guard, fee and
      // ledger rule of an ordinary manual buy applies.
      if (c === 'solana') {
        // The manual buy sizes itself from the engine's CACHED balance, which
        // refreshes every 8–30 s and has not seen a top-up that landed a
        // moment ago — the buy was refused or trimmed after the money had
        // arrived (swarm 2026-10-03, MS-1). Hand it the balance just read on
        // the execution endpoint (or read it now, for a buy needing none).
        const owner = aioWallet.info().solanaAddress;
        let lamports = heldNow !== null ? Math.floor(heldNow * 1e9) : null;
        if (lamports === null && owner) {
          const r = await getBalance(bridgeDeps().httpUrl, owner).catch(() => null);
          lamports = r && r.ok && r.data !== undefined ? r.data : null;
        }
        if (owner && lamports !== null) getEngine().noteWalletBalance(owner, lamports);
        const r = await getEngine().testTrade(token, amount, false, { manual: true });
        return { ok: r.ok, message: r.message, pending: r.stage === 'pending' };
      }
      const r = await evmRail.buy(c, token, amount, false);
      return { ok: r.ok, message: r.message, pending: r.stage === 'pending' };
    },
    chargeMoveFee: async (from, to, inAmount, outAmount) => {
      // Always on an EVM chain: one end of every top-up is one. The money now
      // sits on the destination, so that is where it is charged when it can
      // be; a Solana buy's top-up came FROM an EVM chain, which pays instead.
      const chain = to !== 'solana' ? to : from;
      if (chain === 'solana') return null;
      const basis = chain === to ? outAmount : inAmount;
      const owner = evmWallet.address(chain);
      if (!owner || !(basis > 0)) return null;
      const plan = evmTrade.evmFeePlan(BigInt(Math.floor(basis * 1e18)), store.load().evm?.referrer ?? '', owner);
      if (plan.totalWei <= 0n || !plan.treasury) return null;
      const h = await evmTrade.sendFeeLegs(chain, evmWallet.info(chain).id ?? undefined, owner, plan, 'top-up without a buy');
      if (!h) return null;
      logger.warn(`aio buy: top-up ${from}→${to} was not spent on a buy — billed as a move (${Number(plan.totalWei) / 1e18} on ${chain}, ${h})`);
      return { amount: Number(plan.totalWei) / 1e18, symbol: EVM_CHAIN_META[chain].nativeSymbol };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    speed: () => store.load().aio?.speed ?? 'normal',
    transferEnded: (txHash) => {
      const s = bridge.statusOf(txHash);
      return s === 'refunded' || s === 'failed' ? s : null;
    },
  };
  // ── The float (opt-in, 2026-10-03) ─────────────────────────────────
  // Keeps about settings.aio.floatUsd ready on each chain so a buy there
  // needs no conversion. shared/aioFloat.ts decides; this runs it: one
  // refill at a time, an ORDINARY move (Relay + Krypt's 0.5 %, like the
  // Move card), never on an unread balance, never while a top-up is in
  // flight, at most once per chain per cooldown and FLOAT_MAX_PER_DAY a day,
  // and it stops itself after FLOAT_MAX_FAILURES failures in a row.
  const floatState = { lastByChain: new Map<AioChain, number>(), day: [] as number[], failures: 0, stopped: false, running: false };
  /** Compress in progress, and a quiet spell after it: the float used to
   *  refill (and charge fees on) the chains Compress had just emptied. */
  let compressing = false;
  let floatPausedUntil = 0;
  const floatTick = async (): Promise<void> => {
    const s = store.load();
    if (!s.aio?.floatEnabled || floatState.stopped || floatState.running || aioBuy.isFunding()) return;
    // Unattended money stays still while the user is compressing, just after,
    // with the automation kill switch on, and with every chain in Paper —
    // the float only exists to make LIVE buys instant (v6 audit 2026-10-03).
    if (compressing || Date.now() < floatPausedUntil || automation.killSwitchOn()) return;
    if (!AIO_CHAINS.some((c) => aioLiveOn(c))) return;
    const i = aioWallet.info();
    if (!i.exists || !i.activeEverywhere) return;
    const now = Date.now();
    floatState.day = floatState.day.filter((t) => now - t < 24 * 3_600_000);
    if (floatState.day.length >= FLOAT_MAX_PER_DAY) return;
    floatState.running = true;
    try {
      const chains = AIO_CHAINS.filter((c) => aioBuyHost.enabled(c));
      const states = await Promise.all(
        chains.map(async (c) => ({ chain: c, held: await aioBuyHost.nativeHeld(c), priceUsd: await aioBuyHost.priceUsd(c), reserve: CHAIN_RESERVE[c] })),
      );
      const move = nextFloatRefill(states, s.aio.floatUsd);
      if (!move) return;
      if (now - (floatState.lastByChain.get(move.to) ?? 0) < FLOAT_COOLDOWN_MS) return;
      floatState.lastByChain.set(move.to, now);
      floatState.day.push(now);
      const draft = { from: move.from, to: move.to, amount: Number(move.amountFrom.toPrecision(6)) };
      const q = await bridge.quote(draft, bridgeDeps());
      const bad = q.ok && q.quote ? await unattendedQuoteProblem(draft, q.quote) : null;
      const r = q.ok && q.quote && !bad ? await bridge.send(draft, bridgeDeps(), false, q.quote.quoteId ?? undefined) : { ok: false, message: bad ?? q.message };
      if (r.ok) {
        floatState.failures = 0;
        const msg = `Float: moved about $${move.usd.toFixed(2)} from ${AIO_CHAIN_LABEL[move.from]} to ${AIO_CHAIN_LABEL[move.to]} (a normal move: Relay's cost + Krypt's 0.5%).`;
        logger.warn(`[notice] ${msg}`);
        getEngine().pushNotification('All-in-One float', msg);
      } else {
        floatState.failures += 1;
        logger.warn(`aio float: refill ${move.from}→${move.to} not done — ${r.message}`);
        if (floatState.failures >= FLOAT_MAX_FAILURES) {
          floatState.stopped = true;
          const msg = `Float stopped after ${FLOAT_MAX_FAILURES} failed refills in a row (last: ${r.message}). Turn it off and on again on the All-in-One page to restart it.`;
          logger.warn(`[notice] ${msg}`);
          getEngine().pushNotification('All-in-One float stopped', msg);
        }
      }
    } catch (err) {
      floatState.failures += 1;
      logger.warn(`aio float: tick failed — ${safeErr(err)}`);
    } finally {
      floatState.running = false;
    }
  };
  setInterval(() => void floatTick(), 60_000);
  /** Turning the float off and on again clears a stop. */
  aioFloatReset = () => {
    floatState.stopped = false;
    floatState.failures = 0;
  };

  /**
   * Nobody reads the quote of an UNATTENDED move (Compress, the float, refuel,
   * a script): bound it by the app's OWN prices, as top-ups are (MS-6). The
   * guaranteed minimum out must be worth what goes in, less a normal move's
   * cost; no price means no move — unknown is never fine (v6 audit 2026-10-03).
   */
  const UNATTENDED_MOVE_MAX_LOSS = 0.03;
  const UNATTENDED_MOVE_SLACK_USD = 0.25;
  const unattendedQuoteProblem = async (draft: { from: AioChain; to: AioChain; amount: number }, q: BridgeQuote): Promise<string | null> => {
    const [inPx, outPx] = await Promise.all([aioBuyHost.priceUsd(draft.from), aioBuyHost.priceUsd(draft.to)]);
    if (!inPx || !outPx) return 'no price right now to check the quote against — not moved';
    const inUsd = draft.amount * inPx;
    const outUsd = (Number(q.toAmountMinRaw) / 10 ** q.toDecimals) * outPx;
    // Relay's $5 no-refund floor, judged by OUR price: an unpriced quote waives it for a
    // person who sees the quote, never for a move nobody looks at (v6 audit).
    if (inUsd < HARD_FLOOR_USD) return `about $${inUsd.toFixed(2)} — under Relay's $${HARD_FLOOR_USD} minimum (a failed transfer that small is never refunded), not moved`;
    if (!(outUsd >= inUsd * (1 - UNATTENDED_MOVE_MAX_LOSS) - UNATTENDED_MOVE_SLACK_USD)) {
      return `the quote guarantees about $${outUsd.toFixed(2)} for $${inUsd.toFixed(2)} by the app's own prices — more than a normal move costs, not moved`;
    }
    return null;
  };

  /** A move between the All-in-One wallet's own chains, quoted and sent at
   *  once — the one path scripts and Compress share, with the Move card's
   *  blockers (signer everywhere, chain switched on) and Relay's own checks. */
  const aioMoveNow = async (from: AioChain, to: AioChain, amount: number, by: string): Promise<{ ok: boolean; message: string; txHash?: string }> => {
    const draft = { from, to, amount: Number(amount.toPrecision(9)) };
    const blocked = aioMoveBlocked(draft);
    if (blocked) return { ok: false, message: blocked };
    const q = await bridge.quote(draft, bridgeDeps());
    if (!q.ok || !q.quote) return { ok: false, message: `not quoted: ${q.message}` };
    const bad = await unattendedQuoteProblem(draft, q.quote);
    if (bad) return { ok: false, message: bad };
    const r = await bridge.send(draft, bridgeDeps(), false, q.quote.quoteId ?? undefined);
    if (r.ok) logger.warn(`aio move (${by}): ${draft.amount} ${from} → ${to} (${r.txHash ?? 'no hash'})`);
    return { ok: r.ok, message: r.message, ...(r.txHash ? { txHash: r.txHash } : {}) };
  };

  // ── All-in-One: Compress (2026-10-03) ─────────────────────────────
  // Everything into one coin on one chain, for a withdrawal: sell each token
  // for its chain's coin, then move each other chain's coin to the target.
  // Planned in shared/aioCompress (pure, tested); confirmed once, natively —
  // the dialog lists every sell and move; run here in order, step by step.
  // A chain in Paper never "sells" on paper: its tokens are listed as
  // waiting on Live and stay put.
  const aioLiveOn = (c: AioChain): boolean => (c === 'solana' ? getEngine().liveState().armed && store.load().execution.liveEnabled : evmRail.armed(c));
  const compressPlanNow = async (target: AioChain): Promise<{ plan: CompressPlan } | { error: string }> => {
    const i = aioWallet.info();
    if (!i.exists) return { error: 'No All-in-One wallet.' };
    const bal = await aioBalances({ httpUrl: resolveRpc(store.load().rpc).httpUrl, solanaAddress: i.solanaAddress, evmAddress: i.evmAddress, force: true });
    if (bal.totalUsd === null) return { error: 'No chain could be read just now — try again in a moment.' };
    // Left alone: the user's $KRYPTO (it halves their fees — selling it is a
    // decision of its own), and any coin a running bot holds (v6 audit).
    const exclude: Record<string, string> = {};
    if (KRYPTO_TOKEN.mint) exclude[excludeKey('solana', KRYPTO_TOKEN.mint)] = 'your $KRYPTO — holding it halves your fees; sell it on its own if you mean to';
    for (const a of bal.assets) {
      if (!a.token || (a.chain !== 'solana' && a.chain !== 'bnb' && a.chain !== 'robinhood')) continue;
      const c = a.chain;
      const owner = c === 'solana' ? i.solanaAddress : i.evmAddress;
      const bot =
        (owner && kryptoTrader.claimOn(owner, a.token, c) ? 'a Krypto Trader session holds it' : null) ??
        (automation.heldByScripts(c).has(c === 'solana' ? a.token : a.token.toLowerCase()) ? 'a running script holds it' : null);
      if (bot) exclude[excludeKey(c, a.token)] = `${bot} — stop that first to include it`;
    }
    const plan = planCompress({
      bal,
      target,
      signingOn: i.signingOn,
      live: { solana: aioLiveOn('solana'), bnb: aioLiveOn('bnb'), robinhood: aioLiveOn('robinhood') },
      enabled: { solana: true, bnb: evmRail.enabled('bnb'), robinhood: evmRail.enabled('robinhood') },
      exclude,
    });
    return { plan };
  };
  ipcMain.handle('aio:compressPlan', async (_e, raw: unknown) => {
    const t = aioChainOf(raw);
    if (!t) return fail('Pick SOL, ETH or BNB.');
    try {
      const r = await compressPlanNow(t);
      return 'error' in r ? fail(r.error) : ok('ok', r.plan);
    } catch (err) {
      return fail(`Could not plan that: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('aio:compress', async (e, raw: unknown) => {
    const t = aioChainOf(raw);
    if (!t) return fail('Pick SOL, ETH or BNB.');
    if (compressing) return fail('A compress is already running.');
    // Taken before the first await: checked-then-set after the plan read let
    // two clicks both pass (v6 audit 2026-10-03). Released on every exit.
    compressing = true;
    let ran = false;
    try {
    // Planned again here, from a fresh read: what the page showed may be a
    // minute old, and the dialog must describe what will actually happen.
    const first = await compressPlanNow(t);
    if ('error' in first) return fail(first.error);
    const plan = first.plan;
    if (plan.nothingToDo) return fail(plan.needsLive.length ? `Nothing can run yet — ${plan.needsLive.map((c) => AIO_CHAIN_LABEL[c]).join(' and ')} must be in Live to sell.` : `Nothing to sell or move — it is already all ${plan.coin}, or what is left is too small to move.`);
    const stays = plan.stays.length ? `\n\nStays where it is:\n${plan.stays.slice(0, 12).map((s) => `• ${safeSymbol(s.symbol)} on ${AIO_CHAIN_LABEL[s.chain]} — ${s.why}`).join('\n')}${plan.stays.length > 12 ? `\n• and ${plan.stays.length - 12} more` : ''}` : '';
    const { response } = await confirmNative(e.sender, {
      type: 'warning',
      buttons: ['Cancel', `Compress to ${plan.coin}`],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Compress the All-in-One wallet',
      message: `Turn everything into ${plan.coin} on ${AIO_CHAIN_LABEL[t]}?`,
      detail:
        describeCompress(plan) +
        stays +
        `\n\nThese are real transactions. Each sell pays Krypt's 0.5 %; each move pays Relay's cost plus Krypt's 0.5 %${plan.estCostUsd !== null ? ` — about $${plan.estCostUsd.toFixed(2)} in all` : ''}.` +
        (plan.estFinalUsd !== null ? ` About $${plan.estFinalUsd.toFixed(2)} of ${plan.coin} at the end${plan.unread.length ? ' — not counting what could not be read' : ''}.` : ''),
    });
    if (response !== 1) return fail('Cancelled — nothing was sold or moved.');
    ran = true;
    const steps: Array<{ step: string; ok: boolean; message: string }> = [];
    const note = (step: string, state: 'running' | 'done' | 'failed', message: string): void => {
      broadcast({ kind: 'aioCompress', step, state, message });
      if (state !== 'running') steps.push({ step, ok: state === 'done', message });
    };
    try {
      for (const s of plan.sells.filter((x) => !x.blocked)) {
        const step = `Sell ${safeSymbol(s.symbol)} on ${AIO_CHAIN_LABEL[s.chain]}`;
        note(step, 'running', 'selling…');
        // Live is checked again per step: a chain switched to Paper while
        // this ran would otherwise "sell" on paper and report it as done.
        if (!aioLiveOn(s.chain)) {
          note(step, 'failed', `${AIO_CHAIN_LABEL[s.chain]} left Live — not sold`);
          continue;
        }
        try {
          const r = s.chain === 'solana' ? await getEngine().manualSell(s.token, 100, { manual: true }) : await evmRail.sell(s.chain, s.token, 100, false);
          // Sent but not confirmed in time is not a failure: say so.
          if (!r.ok && r.stage === 'pending') note(step, 'done', `sent, not confirmed yet — check Trades (${r.message})`);
          else note(step, r.ok ? 'done' : 'failed', r.message);
        } catch (err) {
          note(step, 'failed', safeErr(err));
        }
      }
      // Let the sells' coin land before reading what there is to move.
      if (plan.sells.some((x) => !x.blocked) && plan.moves.some((x) => !x.blocked)) await new Promise((r) => setTimeout(r, 4_000));
      for (const m of plan.moves.filter((x) => !x.blocked)) {
        const step = `Move ${COMPRESS_COIN[m.from]} from ${AIO_CHAIN_LABEL[m.from]} to ${AIO_CHAIN_LABEL[m.to]}`;
        note(step, 'running', 'moving…');
        // What is there NOW, less what the chain keeps — never the estimate.
        const held = await aioBuyHost.nativeHeld(m.from);
        if (held === null) {
          note(step, 'failed', `could not read the ${COMPRESS_COIN[m.from]} balance — nothing moved`);
          continue;
        }
        const amount = held - COMPRESS_KEEP[m.from];
        if (!(amount > 0)) {
          note(step, 'failed', 'nothing left to move');
          continue;
        }
        try {
          const r = await aioMoveNow(m.from, m.to, amount, 'compress');
          note(step, r.ok ? 'done' : 'failed', r.message);
        } catch (err) {
          note(step, 'failed', safeErr(err));
        }
      }
    } finally {
      broadcast({ kind: 'aioChanged' });
    }
    const done = steps.filter((s) => s.ok).length;
    const msg = `${done} of ${steps.length} step${steps.length === 1 ? '' : 's'} done${done < steps.length ? ' — see each step below' : ''}.`;
    logger.warn(`aio compress to ${plan.coin}: ${msg}`);
    return ok(msg, { steps });
    } finally {
      compressing = false;
      // The float stays out of the way for half an hour after a run.
      if (ran) floatPausedUntil = Date.now() + 30 * 60_000;
    }
  });

  // ── All-in-One for scripts (2026-10-03) ───────────────────────────
  // The same quotes, signer rules and Krypt fee the AIO page uses.
  automation.setAioScriptHooks({
    active: () => {
      const i = aioWallet.info();
      return i.exists && i.activeEverywhere;
    },
    info: () => {
      const i = aioWallet.info();
      return { exists: i.exists, activeEverywhere: i.activeEverywhere, solanaAddress: i.solanaAddress, evmAddress: i.evmAddress };
    },
    balances: async () => {
      const i = aioWallet.info();
      if (!i.exists) return null;
      return aioBalances({ httpUrl: resolveRpc(store.load().rpc).httpUrl, solanaAddress: i.solanaAddress, evmAddress: i.evmAddress });
    },
    move: (from, to, amount) => aioMoveNow(from, to, amount, 'script'),
    fund: async (chain, amount) => {
      const r = await aioBuy.fundForBuy({ chain, amount }, aioBuyHost);
      // The script's buy then sizes from the engine's CACHED Solana balance,
      // which has not seen a top-up that landed a moment ago: the buy was
      // refused and the top-up billed as a move (v6 audit 2026-10-03, the
      // MS-1 fix the manual path already had). Hand it what arrived.
      if (r.ok && r.funded && chain === 'solana') {
        const owner = aioWallet.info().solanaAddress;
        if (owner) getEngine().noteWalletBalance(owner, Math.floor(r.funded.seen * 1e9));
      }
      return r;
    },
    bill: (funded) => aioBuy.billUnspentTopUp(funded as aioBuy.FundedTopUp, aioBuyHost),
  });

  // ── Gas refuel for exits (2026-10-03) ───────────────────────────────
  ipcMain.handle('aio:refuel', async (_e, raw: unknown) => {
    const chain = aioChainOf(raw);
    if (!chain) return fail('Unknown chain');
    const i = aioWallet.info();
    if (!i.exists || !i.activeEverywhere) return fail('Refuel needs the All-in-One wallet signing on every chain.');
    if (aioBuy.isFunding()) return fail('A top-up is already on its way — wait a few seconds.');
    const [held, px] = await Promise.all([aioBuyHost.nativeHeld(chain), aioBuyHost.priceUsd(chain)]);
    if (held === null || px === null) return fail('Could not read this chain right now — nothing moved.');
    // The source: the other chain with the most dollars to spare above its reserve.
    const others = AIO_CHAINS.filter((c) => c !== chain && aioBuyHost.enabled(c));
    const reads = await Promise.all(others.map(async (c) => ({ c, held: await aioBuyHost.nativeHeld(c), px: await aioBuyHost.priceUsd(c) })));
    const spare = reads
      .filter((r) => r.held !== null && r.px !== null)
      .map((r) => ({ c: r.c, px: r.px as number, usd: ((r.held as number) - CHAIN_RESERVE[r.c]) * (r.px as number) }))
      .sort((a, b) => b.usd - a.usd)[0];
    // A little over $5 leaves: Relay's cost and Krypt's 0.5 % come out of it.
    const sendUsd = REFUEL_USD * 1.1;
    if (!spare || spare.usd < sendUsd) return fail(`No other chain has $${sendUsd.toFixed(2)} to spare above its own reserve.`);
    const draft = { from: spare.c, to: chain, amount: Number((sendUsd / spare.px).toPrecision(6)) };
    const q = await bridge.quote(draft, bridgeDeps());
    if (!q.ok || !q.quote) return fail(`Refuel not quoted: ${q.message}`);
    // Nobody reads this quote: the same own-price bound as every unattended move.
    const bad = await unattendedQuoteProblem(draft, q.quote);
    if (bad) return fail(`Refuel not sent — ${bad}`);
    const sent = await bridge.send(draft, bridgeDeps(), false, q.quote.quoteId ?? undefined);
    if (!sent.ok) return fail(`Refuel not sent: ${sent.message}`);
    logger.warn(`aio refuel: ${draft.amount} ${spare.c} → ${chain} (${sent.txHash ?? 'no hash'})`);
    // Wait for the gas to land (a minute at most) — then the sell can go.
    const want = held + (Number(q.quote.toAmountMinRaw) / 10 ** q.quote.toDecimals) * 0.999;
    for (let n = 0; n < 200; n++) {
      await new Promise((r) => setTimeout(r, 300));
      const now = await aioBuyHost.nativeHeld(chain);
      if (now !== null && now >= want) return ok(`Refuelled — ${(now - held).toPrecision(3)} ${EVM_CHAIN_META[chain as EvmChainKind]?.nativeSymbol ?? 'SOL'} arrived from ${AIO_CHAIN_LABEL[spare.c]}. You can sell now.`, { arrived: true });
      const st = sent.txHash ? bridge.statusOf(sent.txHash) : null;
      if (st === 'refunded' || st === 'failed') return fail(`The refuel was ${st} by Relay — nothing arrived.`);
    }
    return ok('Refuel sent — it has not landed yet. Watch Recent transfers on the All-in-One page.', { arrived: false });
  });

  const aioBuyArgs = (raw: unknown): { chain: AioChain; amount: number; token?: string } | null => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const chain = aioChainOf(o.chain);
    const amount = typeof o.amount === 'number' && Number.isFinite(o.amount) && o.amount > 0 ? o.amount : null;
    if (!chain || amount === null) return null;
    if (chain !== 'solana' && amount > 50) return null; // the evm:buy ceiling
    return { chain, amount, ...(typeof o.token === 'string' ? { token: o.token } : {}) };
  };
  ipcMain.handle('aio:buyPlan', async (_e, raw: unknown) => {
    const a = aioBuyArgs(raw);
    if (!a) return fail('That is not a buy');
    try {
      return ok('ok', await aioBuy.plan({ chain: a.chain, amount: a.amount }, aioBuyHost));
    } catch (err) {
      return fail(`Could not plan the top-up: ${safeErr(err)}`);
    }
  });
  ipcMain.handle('aio:buy', async (_e, raw: unknown) => {
    const a = aioBuyArgs(raw);
    if (!a || !a.token) return fail('That is not a buy');
    const token = a.token;
    if (a.chain === 'solana' ? !isAddress(token) : !isEvmAddress(token)) return fail('Invalid token address');
    const o = (raw ?? {}) as Record<string, unknown>;
    try {
      const r = await aioBuy.execute(
        { chain: a.chain, token, amount: a.amount, quoteId: typeof o.quoteId === 'string' ? o.quoteId : null, acceptAsk: o.acceptAsk === true },
        aioBuyHost,
      );
      logger.warn(`aio buy on ${a.chain}: ${r.ok ? 'ok' : 'not done'} — ${r.message}`);
      return r.ok ? ok(r.message, r) : { ok: false, message: r.message, data: r };
    } catch (err) {
      return fail(`Buy error: ${safeErr(err)}`);
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
  ipcMain.handle('launch:pickImage', async (_e, purpose: unknown) => {
    const owner = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(owner!, {
      // One of two constant titles, picked by a flag. The renderer cannot
      // supply the string — a caller-named dialog title is a small thing to
      // hand a page that should not be writing UI chrome.
      title: purpose === 'profile' ? 'Choose your pump.fun profile picture' : 'Choose your token image',
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
  /**
   * How the coins you launched are doing.
   *
   * The mints come from the caller, because the record of what this install
   * launched lives in the renderer — the chain is the truth and that list is
   * the map to it. Everything here is READ: market cap, holders and price for
   * each, plus the creator vault, which is per creator wallet rather than per
   * coin (see pumpFees.ts).
   *
   * A number that could not be read comes back NULL, never 0. A creator being
   * told they have no holders because an RPC hiccuped is the failure worth
   * avoiding here.
   */
  ipcMain.handle('launch:stats', async (_e, mints: unknown) => {
    const list = Array.isArray(mints)
      ? [...new Set(mints.filter((m): m is string => typeof m === 'string' && m.length > 0))].slice(0, 40)
      : [];
    const s = store.load();
    const key = s.launch.walletId ? wallet.publicKeyOf(s.launch.walletId) : null;
    const fees = key ? await pumpFees.readCreatorFees(execUrlOf(s.rpc), key) : null;
    // `summaryMany` answers a Map keyed by mint. Walking the REQUESTED list
    // rather than the map's own keys keeps the order the user sees and gives
    // a row for a mint the providers could not answer for, with nulls in it
    // — a coin missing from the table would read as one that does not exist.
    const summaries = list.length ? await market.summaryMany(list, 4) : new Map();
    const coins = list.map((mint) => {
      const r = summaries.get(mint);
      return {
        mint,
        name: r?.name || null,
        symbol: r?.symbol || null,
        priceUsd: r?.priceUsd ?? null,
        marketCapUsd: r?.marketCapUsd ?? null,
        liquidityUsd: r?.liquidityUsd ?? null,
        holders: r?.holders ?? null,
      };
    });
    return ok('ok', {
      coins,
      creatorWallet: key,
      // Absent when no launch wallet is set — distinct from a vault holding
      // nothing, which is a real zero.
      feesLamports: fees && !fees.failure ? fees.balanceLamports : null,
      claimableLamports: fees && !fees.failure ? fees.claimableLamports : null,
      feesFailure: fees?.failure ?? null,
    });
  });

  ipcMain.handle('launch:upload', async (_e, handle: unknown, fields: unknown) => {
    const filePath = typeof handle === 'string' ? pickedImages.get(handle) : undefined;
    if (!filePath) return fail('No image chosen — pick one first');
    if (!store.load().launch.enabled) return fail('Launching is switched off for this install.');
    const f = fields as (Partial<MetadataFields> & { kryptoMode?: unknown }) | null;
    const str = (v: unknown, cap: number): string => (typeof v === 'string' ? v.slice(0, cap) : '');
    // The same caps the form enforces (shared/launch.ts), not looser ones.
    // The watermark is applied HERE, not taken from the renderer, so every
    // coin launched from this app carries it whatever the form sent. It is
    // idempotent, so a description the form already stamped is not doubled.
    // The form shows the stamped text, so this is a guarantee rather than a
    // surprise (shared/launch.ts).
    const { withWatermark } = await import('@shared/launch');
    // $Krypto Mode: the bot's wallet is named in the description HERE, in
    // main, before the pin — so a coin with a Krypto Mode bot always says so.
    const bot = f?.kryptoMode === true ? kryptoBotWallet(str(f?.symbol, MAX_SYMBOL)) : null;
    if (bot && 'error' in bot) return fail(bot.error);
    const words = str(f?.description, MAX_DESCRIPTION);
    const description = (bot ? withKryptoDisclosure(words, bot.address) : withWatermark(words)).slice(0, MAX_DESCRIPTION);
    const r = await uploadLaunchMetadata(filePath, {
      name: str(f?.name, MAX_NAME),
      symbol: str(f?.symbol, MAX_SYMBOL),
      description,
      twitter: str(f?.twitter, 300),
      telegram: str(f?.telegram, 300),
      website: str(f?.website, 300),
    });
    if ('error' in r) return fail(r.error);
    // Only a file this app stamped can start a bot (kryptoMode.start).
    if (bot) kryptoMode.declare(r.metadataUri, bot.walletId, bot.address);
    return ok('pinned', { ...r, description, kryptoAddress: bot ? bot.address : null });
  });

  /**
   * What this install's launch wallet has earned as a creator, and claiming
   * it. The vault is per creator, so one read and one claim cover every coin
   * that wallet ever launched.
   */

  // ── Multi-wallet trading (2026-09-22) ───────────────────────────────
  //
  // There is deliberately NO "split this buy across wallets" channel. It was
  // built and then removed the same day: nothing called it, and a money-
  // spending handler with no caller is a liability rather than a feature. A
  // user who wants to trade from several wallets writes a script that names
  // each one (bot.buy with an address) — one path instead of two.
  //
  // `fanoutBuy` and its gate stay in the engine, because the LAUNCHER uses
  // them for its single-wallet dev buy, and because the gate is the right
  // defence if a multi-wallet caller is ever added back.
  //
  // Recording the acknowledgement. Its WORDING version is stamped here in
  // main from the shared constant rather than taken from the renderer — a
  // caller that could name the version could claim consent to wording the
  // user never saw.
  ipcMain.handle('multiwallet:accept', async (_e, accept: unknown) => {
    const { MULTI_WALLET_CONSENT_VERSION } = await import('@shared/multiWallet');
    const on = accept === true;
    const next = store.update({
      multiWallet: on ? { acceptedAt: Date.now(), version: MULTI_WALLET_CONSENT_VERSION } : { acceptedAt: 0, version: '' },
    });
    logger.info(`multi-wallet trading ${on ? 'accepted' : 'turned off'}`);
    return ok(on ? 'Multi-wallet trading is on' : 'Multi-wallet trading is off', next);
  });

  // ── pump.fun sign-in (2026-09-22) ───────────────────────────────────
  //
  // The renderer names a wallet. It cannot supply a message, a timestamp, a
  // host or a body — all of those are built in main (system/pumpAuth.ts), so
  // there is no request shape reachable from here. The session token is never
  // returned over IPC either: `status` carries who is signed in, not what
  // proves it.
  ipcMain.handle('pump:status', () => {
    // Blank or stale usernames are re-read in the background; the page gets
    // the names on its next status call (pumpAuth.refreshNamesSoon).
    pumpAuth.refreshNamesSoon();
    return ok('ok', pumpAuth.status());
  });

  // The in-app pump.fun web sign-in window was removed 2026-09-23: Google
  // refuses OAuth in an embedded browser AND in a debug-port Chrome, so it
  // never worked for the login most people use. Accounts created on pump.fun
  // (email/social) come in through export-key → importAccount instead, which
  // signs in via pump's API login — the piece pump says the 25th does not
  // change. claimWebSession (used by importAccount) stays for a legacy web
  // session on disk; adoptWebSession is now unreachable — see its note.

  ipcMain.handle('pump:signIn', async (_e, walletId: unknown) => {
    const id = typeof walletId === 'string' ? walletId : '';
    if (!id) return fail('Pick a wallet to sign in with');
    const r = await pumpAuth.signIn(id);
    // Registered (follows and likes need it) and a bio-less account gets the
    // "Using krypt.cc/bot" line; not awaited, the sign-in answer does not wait.
    if (r.ok) void settlePumpAccount(id);
    return r.ok ? ok(r.message, pumpAuth.status()) : fail(r.message);
  });

  // No wallet named = sign every account out. One named = just that one, so a
  // user with three accounts can drop one without losing the others.
  ipcMain.handle('pump:signOut', (_e, walletId: unknown) => {
    const id = typeof walletId === 'string' && walletId ? walletId : undefined;
    const r = pumpAuth.signOut(id);
    pumpProfile.forgetLookup(id ? wallet.publicKeyOf(id) : null);
    return ok(r.message, pumpAuth.status());
  });

  // Follow / unfollow a pump user, like / unlike a callout, as the named
  // wallet's account. The target is checked against its shape in main
  // (shared/pumpSocial.ts); nothing here takes a URL or a path.
  ipcMain.handle('pump:social', async (_e, walletId: unknown, action: unknown, target: unknown) => {
    const id = typeof walletId === 'string' ? walletId : '';
    if (!id) return fail('Pick an account');
    const { SOCIAL_ACTIONS } = await import('@shared/pumpSocial');
    const act = SOCIAL_ACTIONS.find((a) => a === action);
    if (!act) return fail('Unknown action');
    const r = await pumpSocial.act(id, act, target);
    return r.ok ? ok(r.message) : fail(r.message);
  });



  // ── Accounts that already exist ─────────────────────────────────────
  //
  // Whether each named wallet's address already has a pump account, from
  // pump's PUBLIC profile read. Wallet ids in, never addresses: this is a
  // question about the user's own wallets, and main knows their addresses.
  // One after another, because the route allows 30 a minute and a cache sits
  // in front of it.
  ipcMain.handle('pump:lookup', async (_e, walletIds: unknown) => {
    const ids = Array.isArray(walletIds)
      ? [...new Set(walletIds.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, MAX_BULK)
      : [];
    const out: Record<string, import('@shared/pumpProfile').PumpAccountLookup> = {};
    for (const id of ids) {
      const address = wallet.publicKeyOf(id);
      if (address) out[id] = await pumpProfile.lookupAccount(address);
    }
    return ok('ok', out);
  });

  // Bring an existing pump.fun account in: import its key, then sign in.
  //
  // pump ties an account to the address, so signing with the key IS logging
  // in to that account — username, followers and past callouts come with it.
  // This is wallet:import followed by pump:signIn, done in main so the key is
  // handled by exactly the same code as any other import (and never logged),
  // and so a half-done run can say which half landed.
  ipcMain.handle('pump:importAccount', async (e, secret: unknown, label: unknown) => {
    if (typeof secret !== 'string' || !secret.trim()) return fail('Paste the wallet’s private key');
    const addr = solanaAddressOfSecret(secret);
    if (addr && !(await confirmImport(e.sender, 'this Solana wallet', [addr]))) return fail('Import cancelled');
    const r = wallet.importSecret(secret, typeof label === 'string' ? label : '');
    logger.info(r.ok ? `pump:importAccount — a wallet was imported (${wallet.list().length} now)` : `pump:importAccount — import failed: ${r.message}`);
    if (!r.ok || !r.publicKey) return fail(r.message);
    syncLiveMode();
    refreshScoutOwnership();
    const held = wallet.list().find((w) => w.publicKey === r.publicKey);
    if (!held) return fail('The wallet was imported but could not be found again — sign it in from the list below');
    const lookup = await pumpProfile.lookupAccount(r.publicKey);
    // Signed in on pump.fun already (an email account whose key was exported
    // and imported here): that session becomes this wallet's. A wallet
    // signature would likely be refused for a linked address anyway.
    if (pumpAuth.claimWebSession(r.publicKey, held.id)) {
      return ok('Imported — the pump.fun account you signed in to is now a full account on this wallet', {
        walletId: held.id, publicKey: r.publicKey, signedIn: true, lookup, status: pumpAuth.status(),
      });
    }
    const signed = await pumpAuth.signIn(held.id);
    if (signed.ok) void settlePumpAccount(held.id);
    const result = { walletId: held.id, publicKey: r.publicKey, signedIn: signed.ok, lookup, status: pumpAuth.status() };
    return signed.ok
      ? ok(lookup.kind === 'account' ? 'Imported and signed in to the existing account' : 'Imported and signed in', result)
      : ok(`The wallet was imported, but pump.fun sign-in failed: ${signed.message}`, result);
  });

  // ── Post one callout, by hand ───────────────────────────────────────
  //
  // The proof that the whole chain works: sign-in, the eligibility preflight,
  // the create call, the watermark. It posts a REAL, PUBLIC callout under the
  // named wallet's pump account, so it happens only when a person presses the
  // button — nothing schedules it and nothing retries it.
  //
  // The renderer names a wallet, a mint and the words. It cannot name a host,
  // a route or a body: those are built in main, and the watermark is applied
  // there too, so this path cannot post an unmarked call either.
  ipcMain.handle('pump:callout', async (_e, walletId: unknown, mint: unknown, text: unknown) => {
    const id = typeof walletId === 'string' ? walletId : '';
    const m = typeof mint === 'string' ? mint.trim() : '';
    const t = typeof text === 'string' ? text.trim().slice(0, THESIS_BUDGET) : '';
    if (!id) return fail('Pick the wallet to post as');
    if (!looksLikeSolAddress(m)) return fail('That does not look like a Solana token address');
    if (!t) return fail('Write what the callout should say');
    const { postNow } = await import('./engine/autoCallout');
    const r = await postNow(id, m, t, { likeOwn: store.load().autoCallout.likeOwn });
    logger.info(`manual callout on ${m.slice(0, 8)}…: ${r.ok ? 'posted' : `not posted — ${r.message}`}`);
    // A real call from this page goes to the page's Discord webhook too.
    const hook = store.load().autoCallout.discordWebhookUrl;
    if (r.ok && hook) void getEngine().postCalloutToDiscord(hook, m, r.thesis ?? t, r.calloutId ?? null);
    return r.ok ? ok(r.message, r) : fail(r.message);
  });

  // The Auto-callout page's "Send test" (2026-09-23). The URL is read from the
  // store, never taken from the renderer, so this cannot aim a POST anywhere
  // the user did not save. The coin is only for the sample's numbers and
  // image: the one typed in the test box, else the newest launch the app has.
  ipcMain.handle('pump:testCalloutWebhook', async (_e, mint: unknown) => {
    const hook = store.load().autoCallout.discordWebhookUrl;
    if (!hook) return fail('Save a Discord webhook first.');
    const typed = typeof mint === 'string' ? mint.trim() : '';
    const m = looksLikeSolAddress(typed) ? typed : getEngine().newestLaunchMint();
    if (!m) return fail('No coin to show in the sample yet — type a token address in the test box below.');
    const r = await getEngine().postCalloutToDiscord(hook, m, 'This is what your callouts will look like in Discord.', null, true);
    return r.ok ? ok('Posted — check your Discord channel.') : fail(r.message);
  });

  // ── Doing it to several accounts at once ────────────────────────────
  //
  // Sign-in and profile writes are per account, so the bulk versions are
  // loops in MAIN rather than the renderer firing N calls: main can space
  // them, stop at the first thing that looks systemic, and report per wallet.
  // A page that fired twenty requests itself would also be a page that could
  // fire two hundred.
  //
  // Each result names its wallet. A run where six of eight worked has to be
  // readable as exactly that — "6/8 done" tells nobody which two to retry.
  ipcMain.handle('pump:signInMany', async (_e, walletIds: unknown) => {
    const ids = Array.isArray(walletIds)
      ? [...new Set(walletIds.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, MAX_BULK)
      : [];
    if (ids.length === 0) return fail('Pick at least one wallet');
    const results: Array<{ walletId: string; ok: boolean; message: string }> = [];
    for (const id of ids) {
      const r = await pumpAuth.signIn(id);
      // Awaited here, unlike the single sign-in: fired all at once, a group
      // would burst pump's 30-per-120 s profile limit.
      if (r.ok) await settlePumpAccount(id);
      results.push({ walletId: id, ok: r.ok, message: r.message });
    }
    const done = results.filter((r) => r.ok).length;
    logger.info(`pump: signed in ${done}/${ids.length} account(s)`);
    return ok(`${done} of ${ids.length} signed in`, { results, status: pumpAuth.status() });
  });

  // Usernames from a list, one per account, in the order given. Refused
  // wholesale if the list repeats a name — pump wants them unique, and half a
  // rename leaves nobody able to say which half.
  ipcMain.handle('pump:setUsernames', async (_e, pairs: unknown) => {
    const list = Array.isArray(pairs) ? pairs.slice(0, MAX_BULK) : [];
    const jobs: Array<{ walletId: string; username: string }> = [];
    for (const p of list) {
      const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
      const walletId = typeof o.walletId === 'string' ? o.walletId : '';
      const username = typeof o.username === 'string' ? o.username.trim() : '';
      if (walletId && username) jobs.push({ walletId, username });
    }
    if (jobs.length === 0) return fail('Nothing to rename');
    const why = nameListProblem(jobs.map((j) => j.username), jobs.length);
    if (why) return fail(why);
    const results: Array<{ walletId: string; ok: boolean; message: string }> = [];
    for (const j of jobs) {
      // The username ONLY. Passing bio/profileImage as '' here used to delete
      // both on every account renamed (fixed 09-22).
      const r = await pumpProfile.writeProfile(j.walletId, { username: j.username });
      results.push({ walletId: j.walletId, ok: r.ok, message: r.message });
    }
    const done = results.filter((r) => r.ok).length;
    logger.info(`pump: renamed ${done}/${jobs.length} account(s)`);
    return ok(`${done} of ${jobs.length} renamed`, { results, status: pumpAuth.status() });
  });

  // What pump says about this account as a caller. Its route answered 401 to
  // everyone before there was a session; it has still never been seen
  // answering, so an unrecognised body says so rather than showing zeroes.
  ipcMain.handle('pump:callerStats', async (_e, walletId: unknown) => {
    const id = typeof walletId === 'string' ? walletId : '';
    if (!id) return fail('Pick a wallet');
    const r = await pumpProfile.callerStats(id);
    return 'error' in r ? fail(r.error) : ok('ok', r);
  });

  // Reply to the callout this wallet already made on a coin. A callout is one
  // per coin per account, so once it exists this is the only way to add to it
  // — and a thread that grows beats an edit that rewrites what people read.
  // The callout's id comes from pump's own preflight, never from here.
  ipcMain.handle('pump:calloutReply', async (_e, walletId: unknown, mint: unknown, text: unknown) => {
    const id = typeof walletId === 'string' ? walletId : '';
    const m = typeof mint === 'string' ? mint.trim() : '';
    const t = typeof text === 'string' ? text.trim().slice(0, REPLY_BUDGET) : '';
    if (!id) return fail('Pick the wallet to reply as');
    if (!looksLikeSolAddress(m)) return fail('That does not look like a Solana token address');
    if (!t) return fail('Write what the reply should say');
    const { replyNow } = await import('./engine/autoCallout');
    const r = await replyNow(id, m, t);
    logger.info(`callout reply on ${m.slice(0, 8)}…: ${r.ok ? 'posted' : `not posted — ${r.message}`}`);
    return r.ok ? ok(r.message, r) : fail(r.message);
  });

  // ── The pump.fun profile: username, bio, picture ────────────────────
  //
  // `POST /users`, one field per request, exactly as their own client sends
  // it (see shared/pumpProfile.ts). Signing in creates the account; this is
  // what gives it a name and a face.
  //
  // The renderer names a wallet and the three text fields. It cannot name a
  // host, a route or a token, and the picture it sends must already be an
  // https link — one this app pinned, through the handler below.
  ipcMain.handle('pump:profile', async (_e, walletId: unknown) => {
    const id = typeof walletId === 'string' ? walletId : '';
    if (!id) return fail('Pick a wallet');
    const r = await pumpProfile.readProfileForEditor(id);
    // Null is "could not read, and never seen", which is not the same as an
    // empty profile — the form must not offer to clear fields it never saw.
    // A cached answer says how old it is (cachedAt).
    return r ? ok(r.cachedAt ? 'cached' : 'ok', { ...r.profile, cachedAt: r.cachedAt }) : fail('Could not read that account’s profile from pump.fun');
  });

  ipcMain.handle('pump:setProfile', async (_e, walletId: unknown, draft: unknown) => {
    const id = typeof walletId === 'string' ? walletId : '';
    if (!id) return fail('Pick a wallet');
    const d = (draft && typeof draft === 'object' ? draft : {}) as Record<string, unknown>;
    // A missing field stays MISSING (undefined = keep what pump holds). Turning
    // it into '' would read as a deliberate delete.
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    // Rebuilt field by field. Every field of PumpProfileDraft is named here;
    // one forgotten is one silently never written.
    const r = await pumpProfile.writeProfile(id, {
      username: str(d.username),
      bio: str(d.bio),
      profileImage: str(d.profileImage),
    });
    return r.ok ? ok(r.message, { ...r, status: pumpAuth.status() }) : fail(r.message);
  });

  // Pin a picked image and hand back the gateway URL, so `profileImage` has
  // something to point at. The renderer passes the HANDLE from pickImage, not
  // a path — it has never seen one.
  ipcMain.handle('pump:pinImage', async (_e, handle: unknown) => {
    const file = typeof handle === 'string' ? pickedImages.get(handle) : undefined;
    if (!file) return fail('Pick an image first.');
    const r = await uploadProfileImage(file);
    return 'error' in r ? fail(r.error) : ok('pinned', r);
  });

  ipcMain.handle('launch:fees', async () => {
    const s = store.load();
    const id = s.launch.walletId;
    if (!id) return fail('No Solana launch wallet is set.');
    const key = wallet.publicKeyOf(id);
    if (!key) return fail('The launch wallet no longer exists.');
    try {
      return ok('ok', await pumpFees.readCreatorFees(execUrlOf(s.rpc), key));
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
      const r = await pumpFees.claimCreatorFees(execUrlOf(s.rpc), id);
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
      // Auto-callout after a Solana launch whose dev buy actually landed
      // (pump callouts are Solana only, and a call needs the account to hold
      // the coin). Gated + delayed inside the engine; fire-and-forget.
      if (r.ok && r.token && draft.chain === 'solana' && !r.buyFailed) {
        const { launchWalletId } = await import('@shared/launch');
        const wid = launchWalletId(store.load().launch, 'solana');
        if (wid) getEngine().calloutAfterLaunch(wid, r.token, draft.devBuy);
      }
      // $Krypto Mode starts once the coin exists — and only on a metadata
      // file this app stamped with the bot's wallet (start() refuses others).
      if (r.ok && r.token && draft.chain === 'solana' && draft.krypto.enabled) {
        const { launchWalletId } = await import('@shared/launch');
        const km = await kryptoMode.start({
          mint: r.token,
          symbol: draft.symbol.trim(),
          metadataUri: draft.metadataUri,
          launchWalletId: launchWalletId(store.load().launch, 'solana'),
          options: draft.krypto,
        });
        r.message = `${r.message} Krypto Mode: ${km.message}`;
      }
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
  ipcMain.handle('evm:wallet:import', async (e, chain: unknown, secret: unknown, label: unknown) => {
    const c = chainOf(chain);
    if (!c) return fail('Unknown chain');
    if (typeof secret !== 'string' || !secret.trim()) return fail('Paste a private key');
    const addr = evmAddressOfSecret(secret);
    if (addr && !(await confirmImport(e.sender, `this ${EVM_CHAIN_META[c].name} wallet`, [addr]))) return fail('Import cancelled');
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
    // Giving the All-in-One key a single home would quietly stop it signing
    // on the other chain — the one thing it exists to do.
    if (id === aioWallet.walletIds().evm) return fail('This is the All-in-One wallet\'s key — it belongs to every chain.');
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
    // A Krypto Trader session on BNB / Robinhood trades from this wallet:
    // refused BEFORE anything is removed or disarmed (critic #16).
    const traderBlock = kryptoTrader.walletRemoveBlocked(typeof id === 'string' && id ? id : (evmRail.wallet.info(c).id ?? ''), 'evm');
    if (traderBlock) return fail(traderBlock);
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

  // ── Wallet Lab ─────────────────────────────────────────────────
  ipcMain.handle('lab:generateMany', (_e, count: unknown, prefix: unknown) => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 15) return fail('Count must be 1–15');
    // The store stops at ten wallets in all, the main one included, and
    // says how many it made.
    const r = wallet.generateMany(n, typeof prefix === 'string' ? prefix : '');
    if (r.created > 0) syncLiveMode();
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
    const httpUrl = execUrlOf(store.load().rpc);
    const r = await fund.fundWallets(httpUrl, resolved, fromId);
    logger.info(`lab fund: ${r.message}${r.signature ? ` ${r.signature.slice(0, 12)}…` : ''}`);
    const data = { signature: r.signature ?? '', sentSol: r.sentLamports / 1e9, count: r.count };
    // A partial outcome carries what DID leave the wallet, with its signature.
    return r.ok ? ok(r.message, data) : { ok: false as const, message: r.message, data };
  });
  ipcMain.handle('lab:collect', async (_e, walletIds: unknown, toWalletId: unknown) => {
    if (!getEngine().liveState().armed || !store.load().execution.liveEnabled) return fail('Arm live execution first — collecting moves real SOL');
    if (!Array.isArray(walletIds) || walletIds.length === 0 || walletIds.length > 20 || !walletIds.every((x) => typeof x === 'string')) return fail('Pick 1–20 wallets');
    const httpUrl = execUrlOf(store.load().rpc);
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
      // The Sell button: a human, now — it follows the Execution fee mode.
      const res = await getEngine().manualSell(mint, pct, { manual: true });
      return res.ok ? ok(res.message, res) : { ok: false, message: res.message, data: res };
    } catch (err) {
      return fail(`Sell error: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('live:sellAll', () => {
    const r = getEngine().sellAllHeld('manual');
    return r.ok ? ok(r.message) : fail(r.message);
  });

  // Sell dust (2026-10-03): the plan (read-only), then the real thing —
  // which plans again in main before it sells anything.
  ipcMain.handle('live:dustPlan', async () => {
    try {
      const r = await getEngine().dustPlan();
      return r.ok ? ok('ok', r.plan) : fail(r.message);
    } catch (err) {
      return fail(`Could not plan that: ${(err as Error).message}`);
    }
  });
  ipcMain.handle('live:sellDust', async () => {
    try {
      const r = await getEngine().sellDust();
      return r.ok ? ok(r.message, r) : { ok: false, message: r.message, data: r };
    } catch (err) {
      return fail(`Sell dust error: ${(err as Error).message}`);
    }
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

  /**
   * SOL/USD, the one number the live chart cannot work without.
   *
   * The token page used to DERIVE it, by dividing a token's own USD price by
   * its SOL price - so a token no provider had priced yet, or any token at
   * all while the provider was throttled, left the page with no rate. And
   * with no rate a USD chart DROPS every live tick (it will not mix units)
   * and the header market cap freezes, while the tape underneath is running
   * perfectly. The rate was in main the whole time, memoised for 20 s by the
   * route Discover already calls.
   */
  ipcMain.handle('market:solUsd', async () => {
    const v = await market.solUsd();
    return v === null ? fail('No SOL price available') : ok('ok', v);
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
  // Raised from 25 MB when video export landed (2026-09-21): a 30 s card at
  // 6 Mbit/s is about 22 MB and was sitting right against the old ceiling.
  const CARD_MAX_BYTES = 120 * 1024 * 1024;
  const cardBytes = (raw: unknown, limit = CARD_MAX_BYTES): Buffer | null => {
    if (raw instanceof Uint8Array) return raw.byteLength > 0 && raw.byteLength <= limit ? Buffer.from(raw) : null;
    if (raw instanceof ArrayBuffer) return raw.byteLength > 0 && raw.byteLength <= limit ? Buffer.from(raw) : null;
    return null;
  };
  /** The kinds of file a card can leave as. The renderer asks for one; an
   *  unknown value falls back to GIF rather than writing an extension the
   *  bytes do not match. */
  type CardKind = 'gif' | 'mp4' | 'webm';
  const CARD_KINDS: Record<CardKind, { label: string; noun: string }> = {
    gif: { label: 'GIF', noun: 'Animated GIF' },
    mp4: { label: 'MP4 video', noun: 'Video' },
    webm: { label: 'WebM video', noun: 'Video' },
  };
  const cardKind = (raw: unknown): CardKind =>
    raw === 'mp4' || raw === 'webm' || raw === 'gif' ? raw : 'gif';
  const cardName = (raw: unknown, ext: CardKind): string => {
    const base = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) : '';
    return (base || 'krypt-card') + '.' + ext;
  };

  ipcMain.handle('card:saveFile', async (_e, name: unknown, bytes: unknown, kind: unknown) => {
    const buf = cardBytes(bytes);
    if (!buf) return fail('Nothing to save');
    const k = cardKind(kind);
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win!, {
      title: k === 'gif' ? 'Save animated card' : 'Save card video',
      defaultPath: path.join(app.getPath('downloads'), cardName(name, k)),
      filters: [{ name: CARD_KINDS[k].label, extensions: [k] }],
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

  ipcMain.handle('card:copyFile', (_e, name: unknown, bytes: unknown, kind: unknown) => {
    const buf = cardBytes(bytes);
    if (!buf) return fail('Nothing to copy');
    const k = cardKind(kind);
    const noun = CARD_KINDS[k].noun;
    const dir = path.join(app.getPath('temp'), 'krypto-bot-cards');
    let filePath: string;
    try {
      fs.mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, cardName(name, k));
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
        return ok(`${noun} saved and shown in your file manager — this system has no file clipboard, so drag it in from there.`, { path: filePath, clipboard: false });
      }
      return ok(`${noun} copied as a file — paste it into Discord, Telegram, Slack or a folder. For X, save it and upload the file.`, { path: filePath, clipboard: true });
    } catch (err) {
      shell.showItemInFolder(filePath);
      return fail(`Copy failed (${(err as Error).message}); the ${noun.toLowerCase()} was saved and shown in your file manager instead.`);
    }
  });

  // ── The remembered card background (2026-09-21) ───────────────────────
  //
  // An image background lives in localStorage as a data URL. A VIDEO cannot:
  // tens of megabytes would blow the storage quota, and the old code's answer
  // to an oversized background was to silently not remember it. A video the
  // user picked is kept as one file in userData instead, replaced each time,
  // and handed back as bytes the renderer turns into an object URL.
  //
  // Exactly one file, always our own path — nothing here takes a path from
  // the renderer, and the only thing stored is what the user chose.
  const BG_MAX_BYTES = 200 * 1024 * 1024;
  const BG_TYPES: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
  };
  const bgDir = (): string => path.join(app.getPath('userData'), 'card-background');
  const bgFiles = (): string[] => {
    try {
      return fs.readdirSync(bgDir()).filter((f) => f.startsWith('background.'));
    } catch {
      return []; // no directory yet is the same as no background
    }
  };
  const clearBackgroundFiles = (): void => {
    for (const f of bgFiles()) {
      try {
        fs.unlinkSync(path.join(bgDir(), f));
      } catch {
        /* a file we cannot remove is not worth failing the call over */
      }
    }
  };

  ipcMain.handle('card:saveBackground', (_e, bytes: unknown, type: unknown) => {
    const mime = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
    const ext = BG_TYPES[mime];
    if (!ext) return fail('That is not a video format this can keep');
    const buf = cardBytes(bytes, BG_MAX_BYTES);
    if (!buf) return fail('That video is empty or larger than 200 MB');
    try {
      fs.mkdirSync(bgDir(), { recursive: true });
      clearBackgroundFiles(); // one background, not a pile of old ones
      fs.writeFileSync(path.join(bgDir(), `background.${ext}`), buf);
      return ok('Background saved');
    } catch (err) {
      return fail(`Could not keep that background: ${(err as Error).message}`);
    }
  });

  ipcMain.handle('card:loadBackground', () => {
    const [file] = bgFiles();
    if (!file) return ok('No background', null);
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const mime = Object.keys(BG_TYPES).find((m) => BG_TYPES[m] === ext);
    if (!mime) return ok('No background', null);
    try {
      const buf = fs.readFileSync(path.join(bgDir(), file));
      if (!buf.byteLength) return ok('No background', null);
      return ok('Background', { bytes: new Uint8Array(buf), type: mime });
    } catch {
      // An unreadable file is NOT an empty one, but for a decoration the
      // honest answer is "there isn't one right now" rather than a failure
      // that blocks the card from opening.
      return ok('No background', null);
    }
  });

  ipcMain.handle('card:clearBackground', () => {
    clearBackgroundFiles();
    return ok('Background cleared');
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
  evmTrade.setHolderRate(() => kryptoHolding.holderRateApplies());

  getEngine().setEvmCopy({
    buy: async (chain, token, amountNative, walletId, opts) => {
      const r = await evmRail.buy(chain, token, amountNative, false, { walletId, ...(opts?.slippagePct !== undefined ? { slippagePct: opts.slippagePct } : {}) });
      return { ok: r.ok, message: r.message, signature: r.hash ?? undefined, pending: r.stage === 'pending', spentSol: r.amountIn ? Number(BigInt(r.amountIn)) / 1e18 : undefined };
    },
    // `amountRaw` wins over the percent in the rail, which is the point: a
    // mirrored copy sell is sized from the base units the copy holds, not
    // from a share of a balance that also contains hand-bought bags.
    sell: async (chain, token, pct, walletId, amountRaw, opts) => {
      const r = await evmRail.sell(chain, token, pct, false, { walletId, amountRaw, ...(opts?.slippagePct !== undefined ? { slippagePct: opts.slippagePct } : {}) });
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
    price: (chain, token) => evmPriceNative(chain, token),
    priceFresh: (chain, token) => evmPriceFresh(chain, token),
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
      // Unknown stays unknown, but is asked for: until something else read
      // the balance, a script's every bot.wallet() said null (2026-10-03).
      if (wei === null) evmBalanceKick(chain);
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
    // The chain's Discover column for a script on that chain — the same read
    // the MCP find_tokens tool makes (2026-09-27).
    discover: async (chain, column, limit) => (await evmDiscover.discover(chain, column, limit)).rows,
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
    const fomo = r.direction === 'fomo';
    const walletAddr = fomo ? FOMO_WALLET : String(r.wallet ?? '').trim();
    // A FOMO config follows a set of wallets, not an address (2026-09-20).
    if (!fomo && (copyChain === 'solana' ? !isAddress(walletAddr) : !isEvmAddress(walletAddr))) return fail(`Enter a valid wallet address for ${copyChain === 'solana' ? 'Solana' : EVM_CHAIN_META[copyChain].name}`);
    // Absent or null is OFF for every optional filter; a value present is
    // carried as a number and validated, never coerced to "off".
    const optNum = (v: unknown): number | null => (v === undefined || v === null ? null : Number(v));
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
      // The 2026-09-21 filters (docs/copy-trade-competitors-2026-09-21.md).
      // Every one of them is READ here because a field this rebuild forgets
      // is a field that never survives a save (ipccontract.test pins it).
      minMarketCapUsd: optNum(r.minMarketCapUsd),
      minLeaderSol: optNum(r.minLeaderSol),
      maxLeaderSol: optNum(r.maxLeaderSol),
      minTokenAgeSec: optNum(r.minTokenAgeSec),
      maxTokenAgeSec: optNum(r.maxTokenAgeSec),
      maxBuysPerToken: optNum(r.maxBuysPerToken),
      blockedMints: cleanBlocklist(r.blockedMints),
      blockedCreators: cleanBlocklist(r.blockedCreators),
      minLeaderSellPct: optNum(r.minLeaderSellPct),
      exitTrailingPct: optNum(r.exitTrailingPct),
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
      // Reverse copying (2026-09-20): the direction, and the position's own
      // exits. Absent stays null — the engine reads that as the default.
      direction: r.direction === 'reverse' ? ('reverse' as const) : r.direction === 'fomo' ? ('fomo' as const) : ('copy' as const),
      exitTakeProfitPct: r.exitTakeProfitPct === undefined || r.exitTakeProfitPct === null ? null : Number(r.exitTakeProfitPct),
      exitStopLossPct: r.exitStopLossPct === undefined || r.exitStopLossPct === null ? null : Number(r.exitStopLossPct),
      exitMaxHoldMin: r.exitMaxHoldMin === undefined || r.exitMaxHoldMin === null ? null : Number(r.exitMaxHoldMin),
      // FOMO (2026-09-20): the crowd rule. Absent stays null — the defaults.
      fomoSource: r.fomoSource === undefined || r.fomoSource === null ? null : (String(r.fomoSource) as FomoSource),
      fomoMinWallets: r.fomoMinWallets === undefined || r.fomoMinWallets === null ? null : Number(r.fomoMinWallets),
      fomoWindowSec: r.fomoWindowSec === undefined || r.fomoWindowSec === null ? null : Number(r.fomoWindowSec),
      fomoTopN: r.fomoTopN === undefined || r.fomoTopN === null ? null : Number(r.fomoTopN),
      fomoCrowdExitPct: r.fomoCrowdExitPct === undefined || r.fomoCrowdExitPct === null ? null : Number(r.fomoCrowdExitPct),
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

  // "Reset all paper trades": the paper book on every chain, then every paper
  // script's own registry and day, so neither points at the cleared record.
  // Copy trading keeps its own paper reset (copy:resetPaper); live is never
  // touched. No arguments — there is nothing for the renderer to choose.
  ipcMain.handle('paper:reset', () => {
    const r = getEngine().resetPaperBook();
    if (!r.ok) return fail(r.message);
    const scripts = automation.forgetPaper();
    return ok(scripts ? `${r.message} ${scripts} paper script${scripts === 1 ? '' : 's'} started over.` : r.message);
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
      // The answers to whatever the code asks for. Coerced against the
      // declaration in the code that is being SAVED, not the one on disk, so
      // editing the block and the answers in one go cannot leave the two
      // describing different things. A field the renderer forgets is a field
      // the script silently reads as empty — see the rebuild note above.
      inputs: coerceInputs(
        parseInputs(typeof r.code === 'string' ? r.code : '').specs,
        (typeof r.inputs === 'object' && r.inputs !== null ? r.inputs : {}) as Record<string, unknown>,
      ),
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
        // Optional: absent stays absent (the default applies), never NaN.
        ...(budgetIn.maxLossPctOfWallet === undefined || budgetIn.maxLossPctOfWallet === null || budgetIn.maxLossPctOfWallet === ''
          ? {}
          : { maxLossPctOfWallet: Number(budgetIn.maxLossPctOfWallet) }),
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

  // Reset one script's record, or — with no id — every script AND the paper
  // book: the Scripts page's "reset everything" (user ask, 2026-09-24). Live
  // scripts keep their open positions and today's budget either way
  // (automation.resetScript says why).
  ipcMain.handle('automation:reset', (_e, id: unknown) => {
    if (id !== undefined && id !== null && (typeof id !== 'string' || !id)) return fail('Invalid id');
    if (typeof id === 'string') {
      const r = automation.resetScript(id);
      return r.ok ? ok(r.message, automation.snapshot()) : fail(r.message);
    }
    const list = automation.all();
    for (const s of list) automation.resetScript(s.id);
    const paper = getEngine().resetPaperBook();
    const tail = paper.ok ? paper.message : `Paper trades were not reset: ${paper.message}`;
    return ok(`${list.length} script${list.length === 1 ? '' : 's'} reset (live scripts keep their open positions and today’s budget). ${tail}`, automation.snapshot());
  });

  // A shipped script back to the code this app version ships (bundledScripts.ts).
  ipcMain.handle('automation:resetBundled', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid id');
    const r = automation.resetBundled(id);
    return r.ok ? ok(r.message, automation.snapshot()) : fail(r.message);
  });

  ipcMain.handle('automation:setEnabled', (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || !id) return fail('Invalid id');
    const r = automation.setEnabled(id, enabled === true);
    return r.ok ? ok(r.message, automation.snapshot()) : fail(r.message);
  });

  // Open a script file off disk as a NEW DRAFT. Main shows the dialog and
  // reads the file; the renderer gets the text and a name, never a path, and
  // nothing is saved or enabled until the person saves it the normal way
  // (validateScript, paper by default). For scripts kept outside the app,
  // like the ones in private/scripts that are deliberately not shipped.
  ipcMain.handle('automation:openFile', async () => {
    const owner = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(owner!, {
      title: 'Open a script',
      properties: ['openFile'],
      filters: [{ name: 'Scripts', extensions: ['js', 'mjs', 'txt'] }],
    });
    const file = res.canceled ? null : res.filePaths[0] ?? null;
    if (!file) return ok('cancelled', null);
    try {
      const bytes = await readFile(file);
      const name = path.basename(file).replace(/\.(m?js|txt)$/i, '').slice(0, 60) || 'Script';
      return ok('opened', { name, code: bytes.toString('utf8').replace(/\r\n/g, '\n') });
    } catch (err) {
      return fail(`Could not read that file: ${safeErr(err)}`);
    }
  });

  ipcMain.handle('automation:killSwitch', (_e, on: unknown) => {
    const r = automation.setKillSwitch(on === true);
    if (on === true) kryptoTrader.pauseAll('the automation kill switch');
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
    return rows ? ok('ok', rows) : fail(dexMeta.lastWireError() ?? 'DexScreener is not answering right now');
  });

  ipcMain.handle('wire:profiles', async () => {
    const rows = await dexMeta.tokenProfiles();
    return rows ? ok('ok', rows) : fail(dexMeta.lastWireError() ?? 'DexScreener is not answering right now');
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
    return rows ? ok('ok', rows) : fail(callouts.lastCalloutError() ?? 'pump.fun callouts are not answering right now');
  });

  ipcMain.handle('callouts:forMint', async (_e, mint: unknown, chain: unknown) => {
    const c = chain === 'robinhood' || chain === 'bnb' ? chain : 'solana';
    const m = typeof mint === 'string' ? mint.trim() : '';
    // Solana mints are base58 addresses; the EVM chains are 0x addresses.
    // Checked here so a malformed string never becomes a path segment.
    if (c === 'solana' ? !isAddress(m) : !isEvmAddress(m)) return fail('Invalid token address');
    const rows = await callouts.calloutsForMint(m, c);
    return rows ? ok('ok', rows) : fail(callouts.lastCalloutError() ?? 'pump.fun callouts are not answering right now');
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
