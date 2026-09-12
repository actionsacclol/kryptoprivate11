// Scripted stand-in for electron/evm/pons.ts. The scanner's real code runs
// against it — only the RPC is replaced. `script` is mutated by the test.
export const script = {
  launches: [],
  graduations: [],
  trades: [],
  recordPhase: 1,
  recordDelayMs: 0,
  recordCalls: [],
  recordThrow: false,
  reset() {
    this.launches = [];
    this.graduations = [];
    this.trades = [];
    this.recordPhase = 1;
    this.recordDelayMs = 0;
    this.recordCalls = [];
    this.recordThrow = false;
  },
};
export async function fetchLaunches() { const r = script.launches; script.launches = []; return r; }
export async function fetchGraduations() { const r = script.graduations; script.graduations = []; return r; }
export async function fetchAllCurveTrades() { const r = script.trades; script.trades = []; return r; }
export async function tokenMeta(tokens) {
  return new Map(tokens.map((t) => [t.toLowerCase(), { name: 'N', symbol: 'SYM', decimals: 18, totalSupply: 0n }]));
}
export async function curveStates() { return new Map(); }
export async function launchRecord(token) {
  script.recordCalls.push(token);
  if (script.recordDelayMs) await new Promise((r) => setTimeout(r, script.recordDelayMs));
  if (script.recordThrow) throw new Error('Pons factory read failed: 429');
  if (script.recordPhase === null) return null;
  return { token, phase: script.recordPhase, exists: true };
}

/** viem's short form of an error; the scanner logs it. */

export const shortError = (e) => (e && typeof e.message === 'string' ? e.message : String(e));
