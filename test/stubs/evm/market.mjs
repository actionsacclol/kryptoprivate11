// Stand-in for electron/evm/market.ts: the head block the test says it is.
export const head = { n: 1000n };
export async function headBlock() { return head.n; }
