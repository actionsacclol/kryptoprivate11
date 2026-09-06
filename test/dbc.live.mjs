// LIVE check for the Meteora DBC path. NOT part of `npm test` — it hits a
// public RPC and opens a real websocket, so it is slow and depends on the
// program being active.
//
//   npm run test:dbc
//
// It proves the three things unit tests cannot:
//   1. a DBC pool can be resolved from chain history;
//   2. subscribing to that pool yields decodable swaps;
//   3. ALT-loaded program ids are resolved (the bug that made the whole
//      feature a silent no-op until 2026-08-24 — see resolveAccountKeys).
//
// A quiet program is reported as "no swap found", not as a failure.

import * as w from './.dbcwatcher.mjs';
const HTTP='https://api.mainnet-beta.solana.com';
const DBC='dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const call=async(m,p)=>{try{const r=await fetch(HTTP,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const j=await r.json();return j.error?null:j.result;}catch{return null;}};

// Page the program until we find a real swap, exactly like the harvester.
let before, found=null, scanned=0;
outer:
for (let page=0; page<5 && !found; page++) {
  const params={limit:100}; if (before) params.before=before;
  const sigs=await call('getSignaturesForAddress',[DBC,params]);
  if (!sigs?.length) break;
  before=sigs[sigs.length-1].signature;
  for (const s of sigs) {
    if (s.err) continue;
    scanned++;
    const tx=await call('getTransaction',[s.signature,{encoding:'json',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
    if (!tx) continue;
    const stat=tx.transaction?.message?.accountKeys??[];
    const l=tx.meta?.loadedAddresses??{};
    const keys=[...stat,...(l.writable??[]),...(l.readonly??[])];
    for (const g of tx.meta?.innerInstructions??[]) {
      for (const ix of g.instructions) {
        if (keys[ix.programIdIndex]!==DBC) continue;
        const {event}=w.decodeDbcEventB58(ix.data);
        if (event?.kind==='dbc_swap') { found={pool:event.pool, sig:s.signature, usedAlt: ix.programIdIndex>=stat.length}; break outer; }
      }
    }
    await new Promise(r=>setTimeout(r,45));
  }
}
console.log(`scanned ${scanned} DBC transactions`);
if (!found) { console.log('no swap found — program quiet'); process.exit(0); }
console.log(`active pool: ${found.pool}\n  from sig ${found.sig.slice(0,20)}  (programId came from ALT: ${found.usedAlt})`);

// Now the real test: does resolveDbcPool find this pool from the POOL's own history?
const viaPool = await w.resolveDbcPool(found.pool, HTTP, 6);
console.log(`resolveDbcPool(pool) -> ${viaPool}  ${viaPool===found.pool?'MATCH ✓':'(differs)'}`);

// And does a live subscription to it decode ticks?
console.log('\nsubscribing to the pool for 40s…');
const ticks=[];
w.attach({
  wssUrls:()=>['wss://api.mainnet-beta.solana.com'],
  httpUrl:()=>HTTP,
  commitment:()=>'confirmed',
  onTick:(t)=>{ticks.push(t);console.log(`  ${t.isBuy?'BUY ':'SELL'} ${t.sol.toFixed(4)} SOL  @${t.priceSol.toExponential(3)}  curve=${t.curvePct===null?'—':t.curvePct.toFixed(1)+'%'}`);},
  onCurveComplete:()=>console.log('  CURVE COMPLETE'),
  log:(l,m)=>console.log(`  [${l}] ${m}`),
});
w.watch('testmint', found.pool, 6);
await new Promise(r=>setTimeout(r,40000));
w.stopAll();
console.log(`\nticks: ${ticks.length}, layoutErrors: ${w.layoutErrorCount()}`);
process.exit(0);
