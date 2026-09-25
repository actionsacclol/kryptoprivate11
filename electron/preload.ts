// contextBridge — expose specific functions only, never raw ipcRenderer
// (guidelines §4.4). Every event subscription returns a cleanup function.

import { contextBridge, ipcRenderer } from 'electron';
import type { LaunchDraft } from '@shared/launch';
import type { SwapDraft } from '@shared/swap';
import type { BridgeDraft } from '@shared/bridge';
import type { AppSettings, EngineEvent } from '@shared/types';
import type { CandleInterval, DiscoverColumn, StatsWindow } from '@shared/market';
import type { NewOrderRequest } from '@shared/orders';
import type { NewAlertRequest } from '@shared/alerts';
import type { CopyConfig } from '@shared/copytrade';
import type { ChainKind, EvmChainKind } from '@shared/evm';

const api = {
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    quit: () => ipcRenderer.invoke('app:quit'),
    openRecordingsFolder: () => ipcRenderer.invoke('app:openRecordingsFolder'),
    openLogs: () => ipcRenderer.invoke('app:openLogs'),
    logPaths: () => ipcRenderer.invoke('app:logPaths'),
    /** The support bundle (2026-09-21): one file a user can attach. Nothing
     *  is sent anywhere — these write a file or fill the clipboard. */
    logsPreview: () => ipcRenderer.invoke('logs:preview'),
    /** `note` = the user's own description, printed first in the file. */
    logsExport: (note?: string) => ipcRenderer.invoke('logs:export', note ?? ''),
    logsCopy: (note?: string) => ipcRenderer.invoke('logs:copy', note ?? ''),
    integrity: () => ipcRenderer.invoke('app:integrity'),
  },
    panels: {
      /** Open one panel in its own frameless window. */
      popout: (panelId: string) => ipcRenderer.invoke('panel:popout', panelId),
      /** Close the window this call comes from, when it is a panel window. */
      close: () => ipcRenderer.invoke('panel:close'),
      /** Open a coin in the MAIN window from a popped-out panel. */
      openToken: (mint: string, chain?: string) => ipcRenderer.invoke('panel:openToken', mint, chain),
    },
  legal: {
    status: () => ipcRenderer.invoke('legal:status'),
    accept: () => ipcRenderer.invoke('legal:accept'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  },
  engine: {
    start: () => ipcRenderer.invoke('engine:start'),
    stop: () => ipcRenderer.invoke('engine:stop'),
    kill: () => ipcRenderer.invoke('engine:kill'),
    snapshot: () => ipcRenderer.invoke('engine:snapshot'),
    execution: () => ipcRenderer.invoke('engine:execution'),
    onEvent: (cb: (ev: EngineEvent) => void): (() => void) => {
      const handler = (_e: unknown, ev: EngineEvent): void => cb(ev);
      ipcRenderer.on('engine:event', handler);
      return () => ipcRenderer.removeListener('engine:event', handler);
    },
  },
  creators: {
    blacklist: (creator: string) => ipcRenderer.invoke('creators:blacklist', creator),
    importBlocklist: (addresses: string[]) => ipcRenderer.invoke('creators:importBlocklist', addresses),
  },
  recorder: {
    stats: () => ipcRenderer.invoke('recorder:stats'),
  },
  history: {
    load: () => ipcRenderer.invoke('history:load'),
  },
  watchlist: {
    get: () => ipcRenderer.invoke('watchlist:get'),
    add: (address: string, label: string) => ipcRenderer.invoke('watchlist:add', address, label),
    remove: (address: string) => ipcRenderer.invoke('watchlist:remove', address),
  },
  backtest: {
    dataset: () => ipcRenderer.invoke('backtest:dataset'),
  },
  // $KRYPTO: what this install holds of it, and whether that waives Krypt's
  // fee. A cached reading unless `refresh` is true, which is the Hub card's
  // Scan button — a user action, never a poll. Until 2026-09-19 this entry
  // did not exist: main answered the channel and global.d.ts declared it,
  // but every renderer call threw on `window.krypt.krypto` before reaching
  // IPC, and the Hub card told holders their wallets were "not checked yet"
  // while their trades were already going out with the fee waived.
  krypto: {
    holding: (refresh?: boolean) => ipcRenderer.invoke('krypto:holding', refresh === true),
  },
  links: {
    /** What the Links panel read off a token's X page — kept in main for the scripts. */
    setXStats: (mint: string, stats: unknown) => ipcRenderer.invoke('links:xstats:set', mint, stats),
    xStats: (mint: string) => ipcRenderer.invoke('links:xstats:get', mint),
    /** Telegram members + the website's registry record, looked up by main from the token's own links. */
    intel: (mint: string, wait = true) => ipcRenderer.invoke('links:intel:get', mint, wait),
    /** What the Links panel read off the token's own website — kept in main for the scripts. */
    setSiteRead: (mint: string, read: unknown) => ipcRenderer.invoke('links:site:set', mint, read),
    siteRead: (mint: string) => ipcRenderer.invoke('links:site:get', mint),
  },
  rpc: {
    credits: () => ipcRenderer.invoke('rpc:credits'),
    health: () => ipcRenderer.invoke('rpc:health'),
    probe: () => ipcRenderer.invoke('rpc:probe'),
    resetCredits: () => ipcRenderer.invoke('rpc:resetCredits'),
  },
  bots: {
    status: () => ipcRenderer.invoke('bots:status'),
    pair: (kind: 'telegram' | 'discord') => ipcRenderer.invoke('bots:pair', kind),
    cancelPair: (kind: 'telegram' | 'discord') => ipcRenderer.invoke('bots:cancelPair', kind),
    unpair: (kind: 'telegram' | 'discord') => ipcRenderer.invoke('bots:unpair', kind),
    verify: (kind: 'telegram' | 'discord', token: string) => ipcRenderer.invoke('bots:verify', kind, token),
    test: (kind: 'telegram' | 'discord') => ipcRenderer.invoke('bots:test', kind),
  },
  wallet: {
    info: () => ipcRenderer.invoke('wallet:info'),
    generate: (label?: string) => ipcRenderer.invoke('wallet:generate', label ?? ''),
    list: () => ipcRenderer.invoke('wallet:list'),
    select: (id: string) => ipcRenderer.invoke('wallet:select', id),
    rename: (id: string, label: string) => ipcRenderer.invoke('wallet:rename', id, label),
    import: (secret: string, label?: string) => ipcRenderer.invoke('wallet:import', secret, label ?? ''),
    setHome: (addr: string) => ipcRenderer.invoke('wallet:setHome', addr),
    setMaxBalance: (sol: number) => ipcRenderer.invoke('wallet:setMaxBalance', sol),
    withdraw: (args: { walletId?: string; lamports: number | 'max' }) => ipcRenderer.invoke('wallet:withdraw', args),
    refreshBalance: () => ipcRenderer.invoke('wallet:refreshBalance'),
    refreshAll: () => ipcRenderer.invoke('wallet:refreshAll'),
    holdings: () => ipcRenderer.invoke('wallet:holdings'),
    backup: () => ipcRenderer.invoke('wallet:backup'),
    exportAll: () => ipcRenderer.invoke('wallet:export'),
    remove: (id?: string) => ipcRenderer.invoke('wallet:remove', id),
  },
  live: {
    state: () => ipcRenderer.invoke('live:state'),
    arm: () => ipcRenderer.invoke('live:arm'),
    disarm: () => ipcRenderer.invoke('live:disarm'),
    testTrade: (mint: string, sol: number, simulateOnly: boolean) =>
      ipcRenderer.invoke('live:testTrade', mint, sol, simulateOnly),
    sellToken: (mint: string, percent?: number) => ipcRenderer.invoke('live:sellToken', mint, percent),
    sellAll: () => ipcRenderer.invoke('live:sellAll'),
    setLive: (on: boolean) => ipcRenderer.invoke('live:setLive', on),
    sweepRent: () => ipcRenderer.invoke('live:sweepRent'),
  },
  // Wallet Lab (shared/lab.ts): creating and funding groups of the user's
  // OWN wallets. Ids only — never a URL, never a key.
  lab: {
    generateMany: (count: number, labelPrefix?: string) => ipcRenderer.invoke('lab:generateMany', count, labelPrefix ?? ''),
    fund: (targets: Array<{ walletId: string; sol: number }>, fromWalletId?: string) => ipcRenderer.invoke('lab:fund', targets, fromWalletId ?? null),
    collect: (walletIds: string[], toWalletId?: string) => ipcRenderer.invoke('lab:collect', walletIds, toWalletId ?? null),
  },
  card: {
    saveFile: (name: string, bytes: Uint8Array, kind?: 'gif' | 'mp4' | 'webm') =>
      ipcRenderer.invoke('card:saveFile', name, bytes, kind ?? 'gif'),
    copyFile: (name: string, bytes: Uint8Array, kind?: 'gif' | 'mp4' | 'webm') =>
      ipcRenderer.invoke('card:copyFile', name, bytes, kind ?? 'gif'),
    // A video background is far too big for localStorage, so main keeps the
    // one the user picked and hands the bytes back next time.
    saveBackground: (bytes: Uint8Array, type: string) => ipcRenderer.invoke('card:saveBackground', bytes, type),
    loadBackground: () => ipcRenderer.invoke('card:loadBackground'),
    clearBackground: () => ipcRenderer.invoke('card:clearBackground'),
  },
  ai: {
    analyze: (mint: string, force?: boolean) => ipcRenderer.invoke('ai:analyze', mint, force ?? false),
    cached: (mint: string) => ipcRenderer.invoke('ai:cached', mint),
    verify: (provider: 'openai' | 'anthropic', key: string, model: string) =>
      ipcRenderer.invoke('ai:verify', provider, key, model),
  },
  log: {
    recent: () => ipcRenderer.invoke('log:recent'),
  },
  // Krypto Bot market data. Note what is NOT here: no way to name a URL
  // or a host. The renderer picks a mint / column / interval and main
  // decides which of its hardcoded provider hosts to contact.
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    save: (t: unknown) => ipcRenderer.invoke('templates:save', t),
    remove: (id: string) => ipcRenderer.invoke('templates:delete', id),
    setActive: (id: string | null) => ipcRenderer.invoke('templates:setActive', id),
  },
  orders: {
    list: () => ipcRenderer.invoke('orders:list'),
    create: (req: NewOrderRequest) => ipcRenderer.invoke('orders:create', req),
    cancel: (id: string) => ipcRenderer.invoke('orders:cancel', id),
    resume: () => ipcRenderer.invoke('orders:resume'),
    clearCompleted: () => ipcRenderer.invoke('orders:clearCompleted'),
  },
  farming: {
    /** Measure a pair's real round-trip friction. Quotes only — spends nothing. */
    probe: (mint: string, sizeSol: number) => ipcRenderer.invoke('farming:probe', mint, sizeSol),
  },
  runners: {
    /** Post a test message to this chain's saved runner webhook. */
    testWebhook: (chain: string) => ipcRenderer.invoke('runners:testWebhook', chain),
  },
  alerts: {
    list: () => ipcRenderer.invoke('alerts:list'),
    create: (req: NewAlertRequest) => ipcRenderer.invoke('alerts:create', req),
    remove: (id: string) => ipcRenderer.invoke('alerts:remove', id),
    mute: (id: string, muted: boolean) => ipcRenderer.invoke('alerts:mute', id, muted),
    clearFired: () => ipcRenderer.invoke('alerts:clearFired'),
  },
  automation: {
    list: () => ipcRenderer.invoke('automation:list'),
    save: (script: unknown) => ipcRenderer.invoke('automation:save', script),
    remove: (id: string) => ipcRenderer.invoke('automation:remove', id),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('automation:setEnabled', id, enabled),
    killSwitch: (on: boolean) => ipcRenderer.invoke('automation:killSwitch', on),
    /** Reset one script's stats and saved state; no id = every script plus paper trades. */
    reset: (id?: string) => ipcRenderer.invoke('automation:reset', id),
    /** Pick a .js file; its text comes back as a draft, never a path. */
    openFile: () => ipcRenderer.invoke('automation:openFile'),
  },
  copy: {
    list: () => ipcRenderer.invoke('copy:list'),
    save: (config: Partial<CopyConfig>) => ipcRenderer.invoke('copy:save', config),
    remove: (id: string) => ipcRenderer.invoke('copy:remove', id),
    resetStats: (wallet: string) => ipcRenderer.invoke('copy:resetStats', wallet),
    resetPaper: (configId?: string) => ipcRenderer.invoke('copy:resetPaper', configId),
  },
  portfolio: {
    summary: (opts?: { stale?: boolean }) => ipcRenderer.invoke('portfolio:summary', opts),
    history: () => ipcRenderer.invoke('portfolio:history'),
    export: (format: 'csv' | 'json') => ipcRenderer.invoke('portfolio:export', format),
    resetPaper: () => ipcRenderer.invoke('paper:reset'),
  },
  gifs: {
    search: (provider: 'giphy' | 'tenor', query: string) => ipcRenderer.invoke('gifs:search', provider, query),
    pick: (provider: 'giphy' | 'tenor', id: string) => ipcRenderer.invoke('gifs:pick', provider, id),
  },
  // EVM chains — Robinhood Chain and BNB Smart Chain (shared/evm.ts). Every
  // call names the chain first; addresses, columns and amounts only — the
  // RPC endpoint is a setting, never an argument here. The wallet list is
  // shared across EVM chains (same key, same address); balances, arm state,
  // fills and positions are per chain.
  /** Wallet Scout — top traders per chain, over a window. `scan` reads past
   *  trades into the record; it spends nothing and can be cancelled. */
  scout: {
    top: (chain: string, window: string, sort: string, limit?: number) =>
      ipcRenderer.invoke('scout:top', chain, window, sort, limit ?? 50),
    saved: (chain: string, window: string) => ipcRenderer.invoke('scout:saved', chain, window),
    save: (chain: string, address: string, on: boolean) => ipcRenderer.invoke('scout:save', chain, address, on),
    scan: (chain: string, hours: number) => ipcRenderer.invoke('scout:scan', chain, hours),
    scanStatus: (chain: string) => ipcRenderer.invoke('scout:scanStatus', chain),
    scanCancel: (chain: string) => ipcRenderer.invoke('scout:scanCancel', chain),
    detail: (chain: string, address: string) => ipcRenderer.invoke('scout:detail', chain, address),
    clear: (chain: string) => ipcRenderer.invoke('scout:clear', chain),
    // A wallet's recent swaps read from the chain into the record (2026-09-21).
    readWallet: (chain: string, address: string) => ipcRenderer.invoke('scout:readWallet', chain, address),
    readWalletStatus: (chain: string, address: string) => ipcRenderer.invoke('scout:readWalletStatus', chain, address),
    readWalletCancel: (chain: string, address: string) => ipcRenderer.invoke('scout:readWalletCancel', chain, address),
  },

  /** The AI connection (MCP, 2026-09-21). The token and the access level are
   *  owned by main; this side asks, it never sets them in a settings patch. */
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    setEnabled: (on: boolean) => ipcRenderer.invoke('mcp:setEnabled', on),
    setAccess: (level: string) => ipcRenderer.invoke('mcp:setAccess', level),
    newToken: () => ipcRenderer.invoke('mcp:newToken'),
    setPort: (port: number) => ipcRenderer.invoke('mcp:setPort', port),
    setBudget: (budget: { maxBuySol: number; hourlyCapSol: number; maxTradesPerMinute: number }) => ipcRenderer.invoke('mcp:setBudget', budget),
  },

  // Creating a token. `pickImage` and `upload` touch no chain; `preview` asks
  // a chain and broadcasts nothing; `send` is the one that makes something
  // that cannot be unmade.
  // Cross-chain transfers. `state` is free; `quote` spends a scarce token;
  // `send` is the one that puts funds in a third party's hands.
  bridge: {
    state: () => ipcRenderer.invoke('bridge:state'),
    quote: (draft: BridgeDraft) => ipcRenderer.invoke('bridge:quote', draft),
    send: (draft: BridgeDraft, simulateOnly: boolean) => ipcRenderer.invoke('bridge:send', draft, simulateOnly),
    refresh: () => ipcRenderer.invoke('bridge:refresh'),
  },

  // Wallet Utilities swapper. `balance` and `quote` touch no key.
  swap: {
    balance: (mint: string, chain: string) => ipcRenderer.invoke('swap:balance', mint, chain),
    quote: (draft: SwapDraft) => ipcRenderer.invoke('swap:quote', draft),
    execute: (draft: SwapDraft, simulateOnly: boolean) => ipcRenderer.invoke('swap:execute', draft, simulateOnly),
  },

  update: {
    status: () => ipcRenderer.invoke('app:updateStatus'),
    check: () => ipcRenderer.invoke('app:checkForUpdate'),
  },

  // Splitting a buy across your own wallets, spaced over time. The renderer
  // asks; the cap and the gap floor are enforced in main.
  multiwallet: {
    accept: (accept: boolean) => ipcRenderer.invoke('multiwallet:accept', accept),
  },
  // pump.fun sign-in. The renderer names a wallet and learns who is signed
  // in; the session token itself never crosses this boundary.
  /** pump.fun callout rewards: what pump paid, its terms, and the USDC in
   *  each wallet (swap to SOL, or send to the CONFIRMED withdrawal address). */
  calloutRewards: {
    list: () => ipcRenderer.invoke('calloutRewards:list'),
    acceptTerms: (walletId: string) => ipcRenderer.invoke('calloutRewards:acceptTerms', walletId),
    swapUsdc: (walletId: string) => ipcRenderer.invoke('calloutRewards:swapUsdc', walletId),
    withdrawUsdc: (walletId: string, amountUsdc: number | 'max') => ipcRenderer.invoke('calloutRewards:withdrawUsdc', walletId, amountUsdc),
  },
  pump: {
    status: () => ipcRenderer.invoke('pump:status'),
    signIn: (walletId: string) => ipcRenderer.invoke('pump:signIn', walletId),
    /** One wallet's account, or every account when none is named. */
    signOut: (walletId?: string) => ipcRenderer.invoke('pump:signOut', walletId ?? ''),
    /** Follow/unfollow a pump user or like/unlike a callout, as this wallet's account. */
    social: (walletId: string, action: 'follow' | 'unfollow' | 'like' | 'unlike', target: string) =>
      ipcRenderer.invoke('pump:social', walletId, action, target),
    /** Whether each wallet's address already has a pump account. Public read. */
    lookup: (walletIds: string[]) => ipcRenderer.invoke('pump:lookup', walletIds),
    /** Import a key that already has a pump account, and sign in to it. */
    importAccount: (secret: string, label?: string) => ipcRenderer.invoke('pump:importAccount', secret, label ?? ''),
    /** Post ONE callout now, as this wallet. Real and public — only ever
     *  called from a button a person pressed. */
    callout: (walletId: string, mint: string, text: string) => ipcRenderer.invoke('pump:callout', walletId, mint, text),
    /** Reply to the callout this wallet already made on a coin. Public. */
    calloutReply: (walletId: string, mint: string, text: string) =>
      ipcRenderer.invoke('pump:calloutReply', walletId, mint, text),
    /** Post a TEST callout embed to the saved Auto-callout webhook. The URL
     *  is read in main; the mint only picks the sample's numbers. */
    testCalloutWebhook: (mint?: string) => ipcRenderer.invoke('pump:testCalloutWebhook', mint ?? ''),
    /** Sign several wallets in, one after another. Reports per wallet. */
    signInMany: (walletIds: string[]) => ipcRenderer.invoke('pump:signInMany', walletIds),
    /** Usernames from a list, one per account. Refused if a name repeats. */
    setUsernames: (pairs: Array<{ walletId: string; username: string }>) =>
      ipcRenderer.invoke('pump:setUsernames', pairs),
    /** What pump says about this account as a caller. */
    callerStats: (walletId: string) => ipcRenderer.invoke('pump:callerStats', walletId),
    /** The profile pump currently holds for this wallet's account. */
    profile: (walletId: string) => ipcRenderer.invoke('pump:profile', walletId),
    /** Write the changed parts of it. Public, under that account's name. */
    setProfile: (walletId: string, draft: { username?: string; bio?: string; profileImage?: string }) =>
      ipcRenderer.invoke('pump:setProfile', walletId, draft),
    /** Pin a picked image and get back the link `profileImage` points at.
     *  Takes the HANDLE from launch.pickImage — never a path. */
    pinImage: (handle: string) => ipcRenderer.invoke('pump:pinImage', handle),
  },
  launch: {
    pickImage: (purpose?: 'token' | 'profile') => ipcRenderer.invoke('launch:pickImage', purpose ?? 'token'),
    upload: (filePath: string, fields: Record<string, string>) => ipcRenderer.invoke('launch:upload', filePath, fields),
    /** Creator fees this install's launch wallet has accrued, across every
     *  coin it launched — the vault is per creator, not per token. */
    fees: () => ipcRenderer.invoke('launch:fees'),
    /** How the coins you launched are doing. Mints come from the caller —
     *  the chain is the truth and the local record is the map to it. */
    stats: (mints: string[]) => ipcRenderer.invoke('launch:stats', mints),
    claimFees: () => ipcRenderer.invoke('launch:claimFees'),
    preview: (draft: LaunchDraft) => ipcRenderer.invoke('launch:preview', draft),
    send: (draft: LaunchDraft) => ipcRenderer.invoke('launch:send', draft),
  },

  evm: {
    state: (chain: EvmChainKind) => ipcRenderer.invoke('evm:state', chain),
    // Per-chain Observatory. The chain is always an argument — there is no
    // "current chain" here, because the three are isolated.
    scan: {
      status: (chain: EvmChainKind) => ipcRenderer.invoke('evm:scan:status', chain),
      launches: (chain: EvmChainKind) => ipcRenderer.invoke('evm:scan:launches', chain),
      flagged: (chain: EvmChainKind) => ipcRenderer.invoke('evm:scan:flagged', chain),
      model: (chain: EvmChainKind) => ipcRenderer.invoke('evm:scan:model', chain),
      start: (chain: EvmChainKind) => ipcRenderer.invoke('evm:scan:start', chain),
      stop: (chain: EvmChainKind) => ipcRenderer.invoke('evm:scan:stop', chain),
    },
    arm: (chain: EvmChainKind) => ipcRenderer.invoke('evm:arm', chain),
    disarm: (chain: EvmChainKind) => ipcRenderer.invoke('evm:disarm', chain),
    wallet: {
      info: (chain: EvmChainKind) => ipcRenderer.invoke('evm:wallet:info', chain),
      list: (chain: EvmChainKind) => ipcRenderer.invoke('evm:wallet:list', chain),
      // The LIST of keys is shared by both EVM chains, but which one signs
      // is each chain's own choice (since 2026-09-11), and the INFO that comes
      // back is per chain (symbol, balance, active) — so every call names the
      // chain it is answering for, FIRST. main reads them in this order; the
      // ipccontract test pins it.
      generate: (chain: string, label?: string) => ipcRenderer.invoke('evm:wallet:generate', chain, label ?? ''),
      import: (chain: string, secret: string, label?: string) => ipcRenderer.invoke('evm:wallet:import', chain, secret, label ?? ''),
      select: (chain: string, id: string) => ipcRenderer.invoke('evm:wallet:select', chain, id),
      assign: (chain: string, id: string) => ipcRenderer.invoke('evm:wallet:assign', chain, id),
      rename: (chain: string, id: string, label: string) => ipcRenderer.invoke('evm:wallet:rename', chain, id, label),
      remove: (chain: string, id?: string) => ipcRenderer.invoke('evm:wallet:remove', chain, id),
      exportAll: () => ipcRenderer.invoke('evm:wallet:export'),
      refreshBalance: (chain: EvmChainKind) => ipcRenderer.invoke('evm:wallet:refreshBalance', chain),
      refreshAll: (chain: EvmChainKind) => ipcRenderer.invoke('evm:wallet:refreshAll', chain),
    },
    discover: (chain: EvmChainKind, column: DiscoverColumn, limit: number) => ipcRenderer.invoke('evm:discover', chain, column, limit),
    summary: (chain: EvmChainKind, address: string) => ipcRenderer.invoke('evm:summary', chain, address),
    token: (chain: EvmChainKind, address: string) => ipcRenderer.invoke('evm:token', chain, address),
    candles: (chain: EvmChainKind, address: string, interval: CandleInterval, limit: number) =>
      ipcRenderer.invoke('evm:candles', chain, address, interval, limit),
    quote: (chain: EvmChainKind, side: 'buy' | 'sell', address: string, amount: number) => ipcRenderer.invoke('evm:quote', chain, side, address, amount),
    buy: (chain: EvmChainKind, address: string, amountNative: number, simulateOnly: boolean) => ipcRenderer.invoke('evm:buy', chain, address, amountNative, simulateOnly),
    sell: (chain: EvmChainKind, address: string, pct: number, simulateOnly: boolean) => ipcRenderer.invoke('evm:sell', chain, address, pct, simulateOnly),
    /** Get out of everything on this chain. Never simulated. */
    sellAll: (chain: EvmChainKind) => ipcRenderer.invoke('evm:sellAll', chain),
    summaries: (chain: EvmChainKind, addresses: string[]) => ipcRenderer.invoke('evm:summaries', chain, addresses),
    holdings: (chain: EvmChainKind) => ipcRenderer.invoke('evm:holdings', chain),
    portfolio: (chain: EvmChainKind) => ipcRenderer.invoke('evm:portfolio', chain),
    fills: (chain: EvmChainKind) => ipcRenderer.invoke('evm:fills', chain),
    track: (chain: EvmChainKind, address: string, on: boolean) => ipcRenderer.invoke('evm:track', chain, address, on),
  },
  // Published reward campaigns (Merkl). A chain and nothing else: `wallet`
  // deliberately takes NO address — main resolves this install's own EVM
  // address from the wallet store, so the renderer never has to be trusted
  // with one, and no URL crosses this boundary in either direction.
  rewards: {
    opportunities: (chain: EvmChainKind) => ipcRenderer.invoke('rewards:opportunities', chain),
    /** Sends this wallet's address to Merkl. User-triggered only. */
    wallet: (chain: EvmChainKind) => ipcRenderer.invoke('rewards:wallet', chain),
  },
  // pump.fun Callouts — intel only. There is no create, like or reply here
  // and there will not be: this app reads the feed, it does not post to it.
  // The information hub. Read-only, and there is no 'news' here on purpose
  // - see shared/wire.ts for why a headline feed was not built.
  wire: {
    boosts: () => ipcRenderer.invoke('wire:boosts'),
    profiles: () => ipcRenderer.invoke('wire:profiles'),
  },
  callouts: {
    feed: () => ipcRenderer.invoke('callouts:feed'),
    forMint: (mint: string, chain: ChainKind) => ipcRenderer.invoke('callouts:forMint', mint, chain),
  },
  market: {
    providers: () => ipcRenderer.invoke('market:providers'),
    discover: (column: DiscoverColumn, limit: number, win: StatsWindow) =>
      ipcRenderer.invoke('market:discover', column, limit, win),
    token: (mint: string) => ipcRenderer.invoke('market:token', mint),
    summary: (mint: string) => ipcRenderer.invoke('market:summary', mint),
    summaries: (mints: string[]) => ipcRenderer.invoke('market:summaries', mints),
    candles: (mint: string, interval: CandleInterval, limit: number) =>
      ipcRenderer.invoke('market:candles', mint, interval, limit),
    candlesFull: (mint: string, interval: CandleInterval, limit: number) =>
      ipcRenderer.invoke('market:candlesFull', mint, interval, limit),
    candlesTail: (mint: string, interval: CandleInterval, sinceTime: number) =>
      ipcRenderer.invoke('market:candlesTail', mint, interval, sinceTime),
    holders: (mint: string, limit: number) => ipcRenderer.invoke('market:holders', mint, limit),
    trades: (mint: string, limit: number) => ipcRenderer.invoke('market:trades', mint, limit),
    holderGraph: (mint: string, limit: number) => ipcRenderer.invoke('market:holderGraph', mint, limit),
    analyseHolders: (mint: string, limit: number) => ipcRenderer.invoke('market:analyseHolders', mint, limit),
    traderScan: (mint: string) => ipcRenderer.invoke('market:traderScan', mint),
    launchIntel: (mint: string) => ipcRenderer.invoke('market:launchIntel', mint),
    creatorHistory: (creator: string) => ipcRenderer.invoke('market:creatorHistory', creator),
    search: (query: string) => ipcRenderer.invoke('market:search', query),
    watch: (mint: string) => ipcRenderer.invoke('market:watch', mint),
    unwatch: (mint: string) => ipcRenderer.invoke('market:unwatch', mint),
    solUsd: () => ipcRenderer.invoke('market:solUsd'),
    presets: () => ipcRenderer.invoke('market:presets'),
    clearCache: () => ipcRenderer.invoke('market:clearCache'),
  },
};

contextBridge.exposeInMainWorld('krypt', api);

export type KryptApi = typeof api;
