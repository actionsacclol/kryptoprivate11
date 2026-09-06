// Single bundle entry so the tests exercise ONE instance of the ledger.
//
// `portfolio.ts` imports `ledger.ts`. Bundling them as two separate esbuild
// outputs gives each bundle its own private copy of the ledger's module
// state, so `ledger._load()` in a test would populate a store that
// `portfolio.build()` never reads — producing failures that look like real
// bugs and are not. Re-exporting both from one entry keeps them wired.
export * as ledger from '../electron/engine/ledger';
export * as portfolio from '../electron/engine/portfolio';
