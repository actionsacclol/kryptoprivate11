import type { WalletWithdrawResult, AppSettings, BacktestTrade, EngineEvent, EngineSnapshot, ExecutionSnapshot, HistorySummary, IpcResult, LiveState, WalletHolding, WalletInfo, WalletGroupView, WalletSummary, WatchedWallet } from '@shared/types';
import type {
  CandleInterval,
  CandleSeries,
  DiscoverColumn,
  FilterPreset,
  HolderReport,
  ProviderStatus,
  StatsWindow,
  HolderGraph,
  TokenDetail,
  TokenSummary,
  TradeRow,
  TraderScanRow,
} from '@shared/market';
import type { CreatorHistory, LaunchIntelReport } from '@shared/launchintel';
import type { AiAnalysis } from '@shared/ai';
import type { FollowSettings, RandomSettings, RandomRunStatus } from '@shared/lab';
import type { BotKind } from '@shared/bots';
import type { CreditUsage } from '@shared/credits';
import type { BotStatus } from '../electron/system/bots';
import type { RecorderStats } from '../electron/engine/recorder';
import type { OrderTemplate } from '@shared/orderTemplates';
import type { NewOrderRequest, OrdersSnapshot } from '@shared/orders';
import type { AlertsSnapshot, NewAlertRequest } from '@shared/alerts';
import type { PortfolioSummary, TradeHistoryRow } from '@shared/portfolio';
import type { CopyConfig, CopySnapshot } from '@shared/copytrade';

interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  line: string;
}

declare global {
  interface Window {
    krypt: {
      legal: {
        status: () => Promise<
          IpcResult<{
            version: string;
            accepted: boolean;
            acceptedAt: string | null;
            acceptedVersion: string | null;
            logPath: string;
          }>
        >;
        accept: () => Promise<IpcResult<{ version: string; acceptedAt: string; written: boolean }>>;
      };
      app: {
        version: () => Promise<IpcResult<string>>;
        openExternal: (url: string) => Promise<IpcResult>;
        quit: () => Promise<IpcResult>;
        openRecordingsFolder: () => Promise<IpcResult>;
        openLogs: () => Promise<IpcResult>;
        logPaths: () => Promise<IpcResult<{ logs: string | null; crashes: string | null }>>;
        integrity: () => Promise<IpcResult<{ seized: boolean; message: string }>>;
      };
      settings: {
        get: () => Promise<IpcResult<AppSettings>>;
        update: (patch: Partial<AppSettings>) => Promise<IpcResult<AppSettings>>;
      };
      engine: {
        start: () => Promise<IpcResult>;
        stop: () => Promise<IpcResult>;
        kill: () => Promise<IpcResult>;
        snapshot: () => Promise<IpcResult<EngineSnapshot>>;
        execution: () => Promise<IpcResult<ExecutionSnapshot>>;
        onEvent: (cb: (ev: EngineEvent) => void) => () => void;
      };
      creators: {
        blacklist: (creator: string) => Promise<IpcResult>;
        importBlocklist: (addresses: string[]) => Promise<IpcResult<{ added: number; total: number }>>;
      };
      recorder: {
        stats: () => Promise<IpcResult<RecorderStats>>;
      };
      history: {
        load: () => Promise<IpcResult<HistorySummary>>;
      };
      watchlist: {
        get: () => Promise<IpcResult<WatchedWallet[]>>;
        add: (address: string, label: string) => Promise<IpcResult<WatchedWallet[]>>;
        remove: (address: string) => Promise<IpcResult<WatchedWallet[]>>;
      };
      backtest: {
        dataset: () => Promise<IpcResult<BacktestTrade[]>>;
      };
      rpc: {
        credits: () => Promise<IpcResult<CreditUsage>>;
        health: () => Promise<IpcResult<{ rejected: { host: string; code: '401' | '403'; message: string } | null }>>;
        resetCredits: () => Promise<IpcResult<CreditUsage>>;
      };
      bots: {
        status: () => Promise<IpcResult<BotStatus[]>>;
        pair: (kind: BotKind) => Promise<IpcResult<{ code: string }>>;
        cancelPair: (kind: BotKind) => Promise<IpcResult<BotStatus[]>>;
        unpair: (kind: BotKind) => Promise<IpcResult<BotStatus[]>>;
        verify: (kind: BotKind, token: string) => Promise<IpcResult<{ username?: string }>>;
        test: (kind: BotKind) => Promise<IpcResult>;
      };
      wallet: {
        info: () => Promise<IpcResult<WalletInfo>>;
        list: () => Promise<IpcResult<WalletSummary[]>>;
        generate: (label?: string) => Promise<IpcResult<WalletInfo>>;
        import: (secret: string, label?: string) => Promise<IpcResult<WalletInfo>>;
        select: (id: string) => Promise<IpcResult<WalletInfo>>;
        rename: (id: string, label: string) => Promise<IpcResult<WalletInfo>>;
        setHome: (addr: string) => Promise<IpcResult<WalletInfo>>;
        setMaxBalance: (sol: number) => Promise<IpcResult<WalletInfo>>;
        /** SOL only, to that wallet's confirmed withdrawal address; 'max' leaves rent + fee behind. */
        withdraw: (args: { walletId?: string; lamports: number | 'max' }) => Promise<IpcResult<WalletWithdrawResult>>;
        refreshBalance: () => Promise<IpcResult<WalletInfo>>;
        /** Every wallet's SOL balance, read in parallel and noted in the store. */
        refreshAll: () => Promise<IpcResult<WalletSummary[]>>;
        holdings: () => Promise<IpcResult<WalletHolding[]>>;
        backup: () => Promise<IpcResult>;
        exportAll: () => Promise<IpcResult<{ count: number }>>;
        remove: (id?: string) => Promise<IpcResult<WalletInfo>>;
        groups: () => Promise<IpcResult<WalletGroupView[]>>;
        createGroup: (name: string) => Promise<IpcResult<WalletGroupView[]>>;
        renameGroup: (id: string, name: string) => Promise<IpcResult<WalletGroupView[]>>;
        deleteGroup: (id: string) => Promise<IpcResult<WalletGroupView[]>>;
        setGroupMembers: (id: string, walletIds: string[]) => Promise<IpcResult<WalletGroupView[]>>;
      };
      live: {
        state: () => Promise<IpcResult<LiveState>>;
        arm: () => Promise<IpcResult<LiveState>>;
        disarm: () => Promise<IpcResult<LiveState>>;
        testTrade: (mint: string, sol: number, simulateOnly: boolean) => Promise<IpcResult<{ ok: boolean; stage: string; message: string; signature?: string; simulatedLossSol?: number; simulatedTokensReceived?: number; simulatedCostSol?: number; decimalsKnown?: boolean }>>;
        sellToken: (mint: string, percent?: number) => Promise<IpcResult<{ ok: boolean; stage: string; message: string; signature?: string }>>;
        sellAll: () => Promise<IpcResult>;
        setLive: (on: boolean) => Promise<IpcResult<{ live: LiveState; liveEnabled: boolean }>>;
        sweepRent: () => Promise<IpcResult<{ closed: number; recoveredSolEst: number }>>;
        fanoutBuy: (
          mint: string,
          walletIds: string[],
          sizing: { mode: 'same' | 'total'; amountSol: number; jitter?: number },
          opts?: { staggerMaxMs?: number },
        ) => Promise<IpcResult<{ ok: boolean; message: string; results: Array<{ walletId: string; ok: boolean; stage: string; message: string; signature: string | null }> }>>;
        /** Every listed wallet sells 100 % of the mint. */
        fanoutSell: (mint: string, walletIds: string[], opts?: { staggerMaxMs?: number }) => Promise<IpcResult<{ ok: boolean; message: string; results: Array<{ walletId: string; ok: boolean; message: string; signature: string | null }> }>>;
      };
      lab: {
        /** Generate `count` wallets at once (labels "<prefix> 1", "<prefix> 2", …). Returns the full wallet list. */
        /** Creates `count` wallets; with `groupId` they join that group at once. Returns the full wallet list. */
        generateMany: (count: number, labelPrefix?: string, groupId?: string) => Promise<IpcResult<WalletSummary[]>>;
        setFollow: (groupId: string, cfg: FollowSettings) => Promise<IpcResult<WalletGroupView[]>>;
        setRandom: (groupId: string, cfg: RandomSettings) => Promise<IpcResult<WalletGroupView[]>>;
        /** One transaction from the ACTIVE wallet to the listed own wallets. */
        fund: (targets: Array<{ walletId: string; sol: number }>) => Promise<IpcResult<{ signature: string; sentSol: number; count: number }>>;
        /** Each listed wallet sends its spare SOL back to the ACTIVE wallet (one tx per wallet). */
        collect: (walletIds: string[]) => Promise<IpcResult<Array<{ walletId: string; ok: boolean; message: string; sol: number; signature: string | null }>>>;
        /** Warm the whole group, or only `walletIds` (a subset of its members). */
        randomStart: (groupId: string, walletIds?: string[]) => Promise<IpcResult<RandomRunStatus>>;
        randomStop: (groupId: string) => Promise<IpcResult<RandomRunStatus>>;
        status: () => Promise<IpcResult<RandomRunStatus[]>>;
      };
      card: {
        /** Save an encoded animated card through a save dialog. */
        saveFile: (name: string, bytes: Uint8Array) => Promise<IpcResult>;
        /** Put the encoded animated card on the clipboard AS A FILE. */
        copyFile: (name: string, bytes: Uint8Array) => Promise<IpcResult<{ path: string; clipboard: boolean }>>;
      };
      ai: {
        analyze: (mint: string, force?: boolean) => Promise<IpcResult<AiAnalysis>>;
        cached: (mint: string) => Promise<IpcResult<AiAnalysis | null>>;
        verify: (provider: 'openai' | 'anthropic', key: string, model: string) => Promise<IpcResult>;
      };
      log: {
        recent: () => Promise<IpcResult<LogLine[]>>;
      };
      templates: {
        list: () => Promise<IpcResult<{ templates: OrderTemplate[]; activeId: string | null }>>;
        save: (t: OrderTemplate) => Promise<IpcResult<{ templates: OrderTemplate[]; activeId: string | null }>>;
        remove: (id: string) => Promise<IpcResult<{ templates: OrderTemplate[]; activeId: string | null }>>;
        setActive: (id: string | null) => Promise<IpcResult<{ templates: OrderTemplate[]; activeId: string | null }>>;
      };
      orders: {
        list: () => Promise<IpcResult<OrdersSnapshot>>;
        create: (req: NewOrderRequest) => Promise<IpcResult<OrdersSnapshot>>;
        cancel: (id: string) => Promise<IpcResult<OrdersSnapshot>>;
        resume: () => Promise<IpcResult<OrdersSnapshot>>;
        clearCompleted: () => Promise<IpcResult<OrdersSnapshot>>;
      };
      alerts: {
        list: () => Promise<IpcResult<AlertsSnapshot>>;
        create: (req: NewAlertRequest) => Promise<IpcResult<AlertsSnapshot>>;
        remove: (id: string) => Promise<IpcResult<AlertsSnapshot>>;
        mute: (id: string, muted: boolean) => Promise<IpcResult<AlertsSnapshot>>;
        clearFired: () => Promise<IpcResult<AlertsSnapshot>>;
      };
      copy: {
        list: () => Promise<IpcResult<CopySnapshot>>;
        save: (config: Partial<CopyConfig>) => Promise<IpcResult<CopySnapshot>>;
        remove: (id: string) => Promise<IpcResult<CopySnapshot>>;
        /** Start a followed wallet's own record over; configs and copies stay. */
        resetStats: (wallet: string) => Promise<IpcResult<CopySnapshot>>;
      };
      automation: {
        list: () => Promise<IpcResult<import('@shared/automation').ScriptSnapshot>>;
        save: (script: Partial<import('@shared/automation').UserScript>) => Promise<IpcResult<import('@shared/automation').ScriptSnapshot>>;
        remove: (id: string) => Promise<IpcResult<import('@shared/automation').ScriptSnapshot>>;
        setEnabled: (id: string, enabled: boolean) => Promise<IpcResult<import('@shared/automation').ScriptSnapshot>>;
        killSwitch: (on: boolean) => Promise<IpcResult<import('@shared/automation').ScriptSnapshot>>;
      };
      portfolio: {
        /** `stale: true` answers at once from the engine's last build (marked
         *  `stale`, with `generatedAt`) and refreshes behind a 'portfolio'
         *  event; without it the call awaits a full rebuild. */
        summary: (opts?: { stale?: boolean }) => Promise<IpcResult<PortfolioSummary>>;
        history: () => Promise<IpcResult<TradeHistoryRow[]>>;
        export: (format: 'csv' | 'json') => Promise<IpcResult>;
      };
      gifs: {
        /** Search one provider. Returns preview URLs already proxied. */
        search: (
          provider: 'giphy' | 'tenor',
          query: string,
        ) => Promise<IpcResult<Array<{ id: string; title: string; preview: string | null; width: number; height: number }>>>;
        /** The bytes of one result from the last search, as a data: URL. */
        pick: (provider: 'giphy' | 'tenor', id: string) => Promise<IpcResult<{ dataUrl: string }>>;
      };
      market: {
        providers: () => Promise<IpcResult<ProviderStatus[]>>;
        discover: (column: DiscoverColumn, limit: number, win: StatsWindow) => Promise<IpcResult<TokenSummary[]>>;
        token: (mint: string) => Promise<IpcResult<TokenDetail>>;
        summary: (mint: string) => Promise<IpcResult<TokenSummary>>;
        /** Many at once; the Jupiter half is one batched call main-side. */
        summaries: (mints: string[]) => Promise<IpcResult<Record<string, TokenSummary>>>;
        candles: (mint: string, interval: CandleInterval, limit: number) => Promise<IpcResult<CandleSeries>>;
        /** The full merged series, awaited however long the provider walk
         *  takes — for one-shot callers that cannot take the `candles` push. */
        candlesFull: (mint: string, interval: CandleInterval, limit: number) => Promise<IpcResult<CandleSeries>>;
        candlesTail: (mint: string, interval: CandleInterval, sinceTime: number) => Promise<IpcResult<CandleSeries>>;
        holders: (mint: string, limit: number) => Promise<IpcResult<HolderReport>>;
        trades: (mint: string, limit: number) => Promise<IpcResult<{ rows: TradeRow[]; source: string; note: string | null }>>;
        holderGraph: (mint: string, limit: number) => Promise<IpcResult<HolderGraph>>;
        analyseHolders: (mint: string, limit: number) => Promise<IpcResult<HolderGraph>>;
        traderScan: (mint: string) => Promise<IpcResult<{ rows: TraderScanRow[]; note: string | null }>>;
        launchIntel: (mint: string) => Promise<IpcResult<LaunchIntelReport>>;
        creatorHistory: (creator: string) => Promise<IpcResult<CreatorHistory | null>>;
        search: (query: string) => Promise<IpcResult<TokenSummary[]>>;
        watch: (mint: string) => Promise<IpcResult>;
        unwatch: (mint: string) => Promise<IpcResult>;
        presets: () => Promise<IpcResult<FilterPreset[]>>;
        clearCache: () => Promise<IpcResult>;
      };
    };
  }
}

export {};
