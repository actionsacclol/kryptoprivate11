// Scripted stand-in for electron/evm/fourmeme.ts. `script` is mutated by
// the test; `infos` answers for every token asked (or none) with the same
// verdict and quote asset, and records how many it was asked about per call.
const NATIVE = '0x0000000000000000000000000000000000000000';
export const script = {
  answer: true,
  liquidityAdded: false,
  /** Quote asset the helper reports: NATIVE for BNB, anything else otherwise. */
  quote: NATIVE,
  calls: [],
  launches: [],
  trades: [],
  reset() {
    this.answer = true;
    this.liquidityAdded = false;
    this.quote = NATIVE;
    this.calls = [];
    this.launches = [];
    this.trades = [];
  },
};
export const isNativeQuote = (info) => info.quote === NATIVE;
export async function fetchLaunches() { const r = script.launches; script.launches = []; return r; }
export async function fetchTrades() { const r = script.trades; script.trades = []; return r; }
export async function infos(tokens) {
  script.calls.push(tokens.length);
  if (!script.answer) return new Map();
  return new Map(tokens.map((t) => [t.toLowerCase(), { liquidityAdded: script.liquidityAdded, quote: script.quote }]));
}
