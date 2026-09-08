// contextBridge — expose specific functions only, never raw ipcRenderer
// (guidelines §4.4). Every event subscription returns a cleanup function.

import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, EngineEvent } from '@shared/types';
import type { CandleInterval, DiscoverColumn, StatsWindow } from '@shared/market';
import type { NewOrderRequest } from '@shared/orders';
import type { NewAlertRequest } from '@shared/alerts';
import type { CopyConfig } from '@shared/copytrade';

const api = {
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    quit: () => ipcRenderer.invoke('app:quit'),
    openRecordingsFolder: () => ipcRenderer.invoke('app:openRecordingsFolder'),
    openLogs: () => ipcRenderer.invoke('app:openLogs'),
    logPaths: () => ipcRenderer.invoke('app:logPaths'),
    integrity: () => ipcRenderer.invoke('app:integrity'),
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
  rpc: {
    credits: () => ipcRenderer.invoke('rpc:credits'),
    health: () => ipcRenderer.invoke('rpc:health'),
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
    groups: () => ipcRenderer.invoke('wallet:groups'),
    createGroup: (name: string) => ipcRenderer.invoke('wallet:createGroup', name),
    renameGroup: (id: string, name: string) => ipcRenderer.invoke('wallet:renameGroup', id, name),
    deleteGroup: (id: string) => ipcRenderer.invoke('wallet:deleteGroup', id),
    setGroupMembers: (id: string, walletIds: string[]) => ipcRenderer.invoke('wallet:setGroupMembers', id, walletIds),
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
    fanoutBuy: (
      mint: string,
      walletIds: string[],
      sizing: { mode: 'same' | 'total'; amountSol: number; jitter?: number },
      opts?: { staggerMaxMs?: number },
    ) => ipcRenderer.invoke('live:fanoutBuy', mint, walletIds, sizing, opts ?? {}),
    fanoutSell: (mint: string, walletIds: string[], opts?: { staggerMaxMs?: number }) =>
      ipcRenderer.invoke('live:fanoutSell', mint, walletIds, opts ?? {}),
  },
  // Wallet Lab (shared/lab.ts): funding, following, random trading on groups
  // of the user's OWN wallets. Ids only — never a URL, never a key.
  lab: {
    generateMany: (count: number, labelPrefix?: string, groupId?: string) => ipcRenderer.invoke('lab:generateMany', count, labelPrefix ?? '', groupId ?? ''),
    setFollow: (groupId: string, cfg: unknown) => ipcRenderer.invoke('lab:setFollow', groupId, cfg),
    setRandom: (groupId: string, cfg: unknown) => ipcRenderer.invoke('lab:setRandom', groupId, cfg),
    fund: (targets: Array<{ walletId: string; sol: number }>) => ipcRenderer.invoke('lab:fund', targets),
    collect: (walletIds: string[]) => ipcRenderer.invoke('lab:collect', walletIds),
    randomStart: (groupId: string, walletIds?: string[]) => ipcRenderer.invoke('lab:randomStart', groupId, walletIds ?? null),
    randomStop: (groupId: string) => ipcRenderer.invoke('lab:randomStop', groupId),
    status: () => ipcRenderer.invoke('lab:status'),
  },
  card: {
    saveFile: (name: string, bytes: Uint8Array) => ipcRenderer.invoke('card:saveFile', name, bytes),
    copyFile: (name: string, bytes: Uint8Array) => ipcRenderer.invoke('card:copyFile', name, bytes),
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
  },
  copy: {
    list: () => ipcRenderer.invoke('copy:list'),
    save: (config: Partial<CopyConfig>) => ipcRenderer.invoke('copy:save', config),
    remove: (id: string) => ipcRenderer.invoke('copy:remove', id),
    resetStats: (wallet: string) => ipcRenderer.invoke('copy:resetStats', wallet),
  },
  portfolio: {
    summary: (opts?: { stale?: boolean }) => ipcRenderer.invoke('portfolio:summary', opts),
    history: () => ipcRenderer.invoke('portfolio:history'),
    export: (format: 'csv' | 'json') => ipcRenderer.invoke('portfolio:export', format),
  },
  gifs: {
    search: (provider: 'giphy' | 'tenor', query: string) => ipcRenderer.invoke('gifs:search', provider, query),
    pick: (provider: 'giphy' | 'tenor', id: string) => ipcRenderer.invoke('gifs:pick', provider, id),
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
    presets: () => ipcRenderer.invoke('market:presets'),
    clearCache: () => ipcRenderer.invoke('market:clearCache'),
  },
};

contextBridge.exposeInMainWorld('krypt', api);

export type KryptApi = typeof api;
