// Bundle entry for the market call-count suite (test/marketcalls.test.mjs).
//
// The orchestrator and its providers are only meaningful together — the
// waste those tests pin lives in the seams between them (a list route that
// already answered a question a per-mint route is about to be asked again).
// So one bundle exports the whole layer and the suite counts requests
// against a stubbed `fetch`, with the real queues, gaps, windows and memos.

export * as market from '../electron/data/market';
export * as li from '../electron/data/launchIntel';
export * as http from '../electron/data/http';
export * as jup from '../electron/data/providers/jupiter';
export * as ds from '../electron/data/providers/dexscreener';
export * as pf from '../electron/data/providers/pumpfun';
export * as gt from '../electron/data/providers/geckoterminal';
