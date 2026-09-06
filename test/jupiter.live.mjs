// Live check of the Jupiter build route (2026-09-02): quote + build a swap
// for the trading wallet's PUBLIC key, run the exact signer policy the app
// applies before signing, and simulate on chain with signature verification
// off. No key is ever touched. `npm run test:jupiter`.
//
// Expect: a buy of a graduated pump token builds via "Pump.fun Amm", passes
// checkOutflow and simulates OK; a sell of the same token (sized from the buy
// quote) builds and passes checkOutflow, and its simulation fails ONLY on the
// wallet not holding the token.
import fs from 'node:fs';
import path from 'node:path';
import { VersionedTransaction } from '@solana/web3.js';
import { installNetAgent } from './.netagent.mjs';
import { buildJupiterSwap } from './.jupiter.mjs';
import { checkOutflow } from './.signpolicy.mjs';

installNetAgent();
const RPC = 'https://api.mainnet-beta.solana.com';
const wallets = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA ?? '', 'Krypt Terminal', 'wallets.json'), 'utf8'));
const PK = wallets.wallets[0].publicKey;
const GRADUATED = process.argv[2] ?? 'zeLMmPwEtLB6i4iH71QsTeSKPEkb3xvpEazQmFcpump';

const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const simulate = async (bytes) => {
  const r = await rpc('simulateTransaction', [Buffer.from(bytes).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }]);
  return r?.value ? { err: r.value.err, units: r.value.unitsConsumed, last: (r.value.logs ?? []).slice(-1)[0] } : { err: 'no result' };
};
const policy = (side, mint, lamports) => ({
  intent: 'trade',
  // Same shape liveSigner uses: tips are capped at 1.5 % + 0.0005 SOL of the
  // trade on a buy; sells at 0.02 SOL. The WSOL wrap is judged separately.
  maxTransferLamports: side === 'buy' ? Math.ceil(lamports * 0.015) + 500_000 : 20_000_000,
  trade: { side, mint },
});

// 1. Buy 0.01 SOL of a graduated pump token.
{
  const t0 = Date.now();
  const b = await buildJupiterSwap({ publicKey: PK, action: 'buy', mint: GRADUATED, amount: 0.01, slippagePct: 10, priorityFeeSol: 0.001 });
  console.log(`buy build: ${b.ok ? 'ok' : 'FAIL'} — ${b.message} | ${b.tx?.length ?? 0} bytes | quoted SOL ${b.solValueLamports} | ${Date.now() - t0} ms`);
  if (b.ok && b.tx) {
    const tx = VersionedTransaction.deserialize(b.tx);
    const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58() ?? '(alt)');
    console.log('  top-level programs:', programs.map((p) => p.slice(0, 8)).join(' '), '| ALTs:', tx.message.addressTableLookups.length);
    const pol = checkOutflow(tx, PK, null, policy('buy', GRADUATED, 10_000_000));
    console.log(`  signer policy: ${pol.ok ? 'ACCEPT' : 'REFUSE — ' + pol.message}`);
    const sim = await simulate(b.tx);
    console.log(`  simulate: ${sim.err ? 'ERR ' + JSON.stringify(sim.err) : 'OK'} | units ${sim.units} | ${sim.last ?? ''}`);
  }
}

// 2. Sell: the same graduated token, sized as the buy's quoted output. The
//    swap builds without holding the tokens (Jupiter does not check), which
//    is enough to run the signer policy over a real sell-shaped transaction;
//    the simulation is EXPECTED to fail on the missing balance.
{
  const q = await buildJupiterSwap({ publicKey: PK, action: 'buy', mint: GRADUATED, amount: 0.01, slippagePct: 10, priorityFeeSol: 0.001 });
  const rawOut = q.ok && q.outAmount ? BigInt(q.outAmount) : 0n;
  if (rawOut <= 0n) {
    console.log('sell: no buy quote to size the sell from');
  } else {
    const t0 = Date.now();
    const s = await buildJupiterSwap({ publicKey: PK, action: 'sell', mint: GRADUATED, amount: rawOut, slippagePct: 15, priorityFeeSol: 0.002 });
    console.log(`sell build (${rawOut} raw units): ${s.ok ? 'ok' : 'FAIL'} — ${s.message} | quoted SOL out ${s.solValueLamports} | ${Date.now() - t0} ms`);
    if (s.ok && s.tx) {
      const tx = VersionedTransaction.deserialize(s.tx);
      const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58() ?? '(alt)');
      console.log('  top-level programs:', programs.map((p) => p.slice(0, 8)).join(' '));
      const pol = checkOutflow(tx, PK, null, policy('sell', GRADUATED, 0));
      console.log(`  signer policy: ${pol.ok ? 'ACCEPT' : 'REFUSE — ' + pol.message}`);
      const sim = await simulate(s.tx);
      console.log(`  simulate: ${sim.err ? 'ERR ' + JSON.stringify(sim.err) + ' (expected: wallet does not hold the token)' : 'OK'} | ${sim.last ?? ''}`);
    }
  }
}
process.exit(0);
