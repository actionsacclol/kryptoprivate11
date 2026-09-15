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
import type { BotKind } from '@shared/bots';
import type { CreditUsage } from '@shared/credits';
import type { BotStatus } from '../electron/system/bots';
import type { RecorderStats } from '../electron/engine/recorder';
import type { MerklAnswer, RewardOpportunity, WalletReward } from '../electron/data/providers/merkl';
import type { OrderTemplate } from '@shared/orderTemplates';
import type { NewOrderRequest, OrdersSnapshot } from '@shared/orders';
import type { AlertsSnapshot, NewAlertRequest } from '@shared/alerts';
import type { PortfolioSummary, TradeHistoryRow } from '@shared/portfolio';
import type { CopyConfig, CopySnapshot } from '@shared/copytrade';
import type { EvmScanLaunch, EvmScanStatus } from '@shared/evmScan';
import type { EvmRunnerFlag } from '@shared/evmRunners';
import type { RunnerModel } from '@shared/evmRunners';
import type { LaunchDraft, LaunchOutcome } from '@shared/launch';
import type { UpdateStatus } from '@shared/version';
import type { SwapDraft, SwapQuote } from '@shared/swap';
import type { BridgeDraft, BridgeQuote, InFlight } from '@shared/bridge';
import type { ScoutChain, ScoutRow, ScoutScanHours, ScoutScanStatus, ScoutSort, ScoutWindow } from '@shared/walletScout';
import type {
  EvmChainKind,
  EvmFill,
  EvmHolding,
  EvmLiveState,
  EvmPortfolio,
  EvmQuote,
  EvmState,
  EvmTokenDetail,
  EvmTradeResult,
  EvmWalletInfo,
  EvmWalletSummary,
} from '@shared/evm';

interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  line: string;
}

declare global {
  interface Window {
    krypt: {
      /** Popped-out panels — see src/panels/PanelWindow.tsx. Optional so a
       *  window whose preload predates it degrades to an inert control
       *  rather than throwing. */
      panels?: {
        popout: (panelId: string) => Promise<IpcResult<void>>;
        close: () => Promise<IpcResult<void>>;
        openToken: (mint: string, chain?: string) => Promise<IpcResult<void>>;
      };
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
        /** Every listed wallet sells 100 % of the mint. */
      };
      lab: {
        /** Generate `count` wallets at once (labels "<prefix> 1", "<prefix> 2", …). Returns the full wallet list. */
        /** Creates `count` wallets; with `groupId` they join that group at once. Returns the full wallet list. */
        generateMany: (count: number, labelPrefix?: string, groupId?: string) => Promise<IpcResult<WalletSummary[]>>;
        /** One transaction from the ACTIVE wallet to the listed own wallets. */
        fund: (targets: Array<{ walletId: string; sol: number }>, fromWalletId?: string) => Promise<IpcResult<{ signature: string; sentSol: number; count: number }>>;
        /** Each listed wallet sends its spare SOL back to the ACTIVE wallet (one tx per wallet). */
        collect: (walletIds: string[], toWalletId?: string) => Promise<IpcResult<Array<{ walletId: string; ok: boolean; message: string; sol: number; signature: string | null }>>>;
        /** Warm the whole group, or only `walletIds` (a subset of its members). */
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
      farming: {
        /** Measure a pair's real round-trip friction. Quotes only — spends nothing. */
        probe: (
          mint: string,
          sizeSol: number,
        ) => Promise<IpcResult<{ frictionPct: number | null; route: string; sizeSol: number }>>;
      };
      runners: {
        /** Post a test message to this chain's saved runner webhook. The URL
         *  is read from the store, never sent from here. */
        testWebhook: (chain: ChainKind) => Promise<IpcResult<void>>;
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
        /** Clear PAPER results — one config, or all when omitted. Settings,
         *  live history, leader records and real holdings are untouched. */
        resetPaper: (configId?: string) => Promise<IpcResult<CopySnapshot>>;
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
      /** EVM rail (shared/evm.ts): Robinhood Chain and BNB Smart Chain. Same
       *  row/candle shapes as `market`, tagged with `chain`. One wallet list
       *  for both chains (same key, same address); balances, arm state, fills
       *  and positions are per chain, so every call names the chain first. */
      scout: {
        top: (
          chain: ScoutChain,
          window: ScoutWindow,
          sort: ScoutSort,
          limit?: number,
        ) => Promise<IpcResult<{ rows: ScoutRow[]; counts: { tracked: number; watching: number; cap: number }; failure: string | null }>>;
        saved: (chain: ScoutChain, window: ScoutWindow) => Promise<IpcResult<{ rows: ScoutRow[]; saved: string[] }>>;
        save: (chain: ScoutChain, address: string, on: boolean) => Promise<IpcResult<string[]>>;
        scan: (chain: ScoutChain, hours: ScoutScanHours) => Promise<IpcResult<ScoutScanStatus>>;
        scanStatus: (chain: ScoutChain) => Promise<IpcResult<ScoutScanStatus>>;
        scanCancel: (chain: ScoutChain) => Promise<IpcResult<ScoutScanStatus>>;
        /** Forget every tracked wallet on a chain; saved ones survive. */
        clear: (chain: ScoutChain) => Promise<IpcResult<number>>;
      };
      bridge: {
        state: () => Promise<
          IpcResult<{
            enabled: boolean;
            routes: string[];
            inFlight: InFlight[];
            history: InFlight[];
            /** Non-null means the record could not be READ — never "none". */
            failure: string | null;
          }>
        >;
        quote: (draft: BridgeDraft) => Promise<IpcResult<BridgeQuote>>;
        send: (draft: BridgeDraft, simulateOnly: boolean) => Promise<IpcResult<{ ok: boolean; message: string; txHash?: string }>>;
        refresh: () => Promise<IpcResult<InFlight[]>>;
      };
      swap: {
        /** What the active wallet holds of one mint. Null amount = unknown. */
        balance: (
          mint: string,
          chain: SwapDraft['chain'],
        ) => Promise<IpcResult<{ mint: string; decimals: number | null; amount: number | null; raw: string | null }>>;
        /** Price a swap. Touches no key, builds nothing signable. */
        quote: (draft: SwapDraft) => Promise<IpcResult<SwapQuote>>;
        /** `simulateOnly` runs everything up to the broadcast and stops. */
        execute: (
          draft: SwapDraft,
          simulateOnly: boolean,
        ) => Promise<IpcResult<{ ok: boolean; message: string; signature?: string; outAmountRaw?: string }>>;
      };
      update: {
        /** What we already believe, from memory. Never leaves the machine. */
        status: () => Promise<IpcResult<UpdateStatus>>;
        /** Ask krypt.cc now. Downloads nothing, installs nothing. */
        check: () => Promise<IpcResult<UpdateStatus>>;
      };
      launch: {
        /** Open the app's own file dialog. The renderer never names a path. */
        pickImage: () => Promise<IpcResult<{ handle: string; name: string; dataUrl: string } | null>>;
        upload: (
          handle: string,
          fields: { name: string; symbol: string; description: string; twitter: string; telegram: string; website: string },
        ) => Promise<IpcResult<{ imageUrl: string; metadataUri: string }>>;
        /** Creator fees accrued by the launch wallet, across every coin it
         *  launched. `claimableLamports` is the balance ABOVE the vault's
         *  rent — null means unknown, never zero. */
        fees: () => Promise<IpcResult<{ vault: string; balanceLamports: number | null; claimableLamports: number | null; failure: string | null }>>;
        claimFees: () => Promise<IpcResult<{ ok: boolean; message: string; signature?: string; claimedLamports?: number }>>;
        preview: (draft: LaunchDraft) => Promise<IpcResult<LaunchOutcome>>;
        send: (draft: LaunchDraft) => Promise<IpcResult<LaunchOutcome>>;
      };
      evm: {
        state: (chain: EvmChainKind) => Promise<IpcResult<EvmState>>;
        /** Per-chain Observatory. Isolated: the chain is always an argument. */
        scan: {
          status: (chain: EvmChainKind) => Promise<IpcResult<EvmScanStatus>>;
          launches: (chain: EvmChainKind) => Promise<IpcResult<EvmScanLaunch[]>>;
          flagged: (chain: EvmChainKind) => Promise<IpcResult<EvmRunnerFlag[]>>;
          model: (chain: EvmChainKind) => Promise<IpcResult<RunnerModel>>;
          start: (chain: EvmChainKind) => Promise<IpcResult<EvmScanStatus>>;
          stop: (chain: EvmChainKind) => Promise<IpcResult<EvmScanStatus>>;
        };
        arm: (chain: EvmChainKind) => Promise<IpcResult<EvmLiveState>>;
        disarm: (chain: EvmChainKind) => Promise<IpcResult<EvmLiveState>>;
        wallet: {
          info: (chain: EvmChainKind) => Promise<IpcResult<EvmWalletInfo>>;
          list: (chain: EvmChainKind) => Promise<IpcResult<EvmWalletSummary[]>>;
          // One list of keys serves every EVM chain, but a wallet is MADE FOR
          // the chain whose page asked (generate/import), signs there when
          // that chain had no signer of its own, and is listed there. The info
          // that comes back is per chain (symbol, balance).
          generate: (chain: EvmChainKind, label?: string) => Promise<IpcResult<EvmWalletInfo>>;
          import: (chain: EvmChainKind, secret: string, label?: string) => Promise<IpcResult<EvmWalletInfo>>;
          select: (chain: EvmChainKind, id: string) => Promise<IpcResult<EvmWalletInfo>>;
          /** Say which chain a (pre-split) wallet belongs to. Refused while it signs elsewhere. */
          assign: (chain: EvmChainKind, id: string) => Promise<IpcResult<EvmWalletInfo>>;
          rename: (chain: EvmChainKind, id: string, label: string) => Promise<IpcResult<EvmWalletInfo>>;
          remove: (chain: EvmChainKind, id?: string) => Promise<IpcResult<EvmWalletInfo>>;
          exportAll: () => Promise<IpcResult<{ count: number }>>;
          refreshBalance: (chain: EvmChainKind) => Promise<IpcResult<EvmWalletInfo>>;
          refreshAll: (chain: EvmChainKind) => Promise<IpcResult<EvmWalletSummary[]>>;
        };
        discover: (chain: EvmChainKind, column: DiscoverColumn, limit: number) => Promise<IpcResult<TokenSummary[]>>;
        summary: (chain: EvmChainKind, address: string) => Promise<IpcResult<TokenSummary>>;
        token: (chain: EvmChainKind, address: string) => Promise<IpcResult<EvmTokenDetail>>;
        candles: (chain: EvmChainKind, address: string, interval: CandleInterval, limit: number) => Promise<IpcResult<CandleSeries>>;
        /** `amount` is native (ETH / BNB) for a buy, percent of the holding for a sell. */
        quote: (chain: EvmChainKind, side: 'buy' | 'sell', address: string, amount: number) => Promise<IpcResult<EvmQuote>>;
        /** Paper (simulateOnly, or the chain disarmed) estimates the real bytes and broadcasts nothing. */
        buy: (chain: EvmChainKind, address: string, amountNative: number, simulateOnly: boolean) => Promise<IpcResult<EvmTradeResult>>;
        sell: (chain: EvmChainKind, address: string, pct: number, simulateOnly: boolean) => Promise<IpcResult<EvmTradeResult>>;
        /** Sell every position on this chain, one at a time, never stopping
         *  on a failure. There is no dry-run panic button, so no flag. */
        sellAll: (chain: EvmChainKind) => Promise<
          IpcResult<{ ok: boolean; message: string; results: Array<{ token: string; symbol: string; ok: boolean; message: string; hash: string | null }> }>
        >;
        holdings: (chain: EvmChainKind) => Promise<IpcResult<EvmHolding[]>>;
        portfolio: (chain: EvmChainKind) => Promise<IpcResult<EvmPortfolio>>;
        fills: (chain: EvmChainKind) => Promise<IpcResult<EvmFill[]>>;
        track: (chain: EvmChainKind, address: string, on: boolean) => Promise<IpcResult<string[]>>;
      };
      /**
       * Published, funded reward campaigns and what this wallet has accrued
       * (Merkl). Note the shape of the payload: `rows` is `T[] | null`, and
       * `null` means we could not ask — it must render as an em dash. An
       * empty array is a real answer meaning none.
       */
      rewards: {
        /** Needs no address; discloses nothing. Safe to load on mount. */
        opportunities: (chain: EvmChainKind) => Promise<IpcResult<MerklAnswer<RewardOpportunity>>>;
        /** SENDS THIS WALLET'S ADDRESS TO MERKL. Explicit user action only —
         *  never on mount, never on a timer. Main resolves the address. */
        wallet: (chain: EvmChainKind) => Promise<IpcResult<MerklAnswer<WalletReward>>>;
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
