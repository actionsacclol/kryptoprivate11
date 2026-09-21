// The on-chain pump reader against MAINNET (manual; costs two public RPC
// calls and one DexScreener call). Reads $KRYPTO — a graduated Token-2022
// coin, so it exercises the pool pass and the extension-metadata path — and
// any extra mints given on the command line, then checks the chain price
// against DexScreener's for the graduated one: the virtual-quote rule has to
// land within a few percent of what the market says, or the rule is wrong.
//
//   npm run test:pumpchain:live
//   node test/pumpchain.live.mjs <mint> [<mint>…]
//   RPC=https://… to use another endpoint
import { KRYPTO_TOKEN } from './.krypto.mjs';
import { readMany, toSummary } from './.pumpchain.mjs';

const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com';
const extra = process.argv.slice(2);
const mints = [KRYPTO_TOKEN.mint, ...extra].filter(Boolean);
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const t0 = Date.now();
const out = await readMany(RPC, mints);
console.log(`read ${mints.length} mint(s) in ${Date.now() - t0} ms via ${new URL(RPC).host}\n`);
for (const mint of mints) {
  const c = out.get(mint);
  if (!c) {
    console.log(`${mint}: not a pump coin, or the RPC did not answer`);
    if (mint === KRYPTO_TOKEN.mint) failures++;
    continue;
  }
  const s = toSummary(c, null);
  console.log(`${mint}`);
  console.log(`  ${c.name ?? '—'} (${c.symbol ?? '—'})  token2022=${c.isToken2022}  decimals=${c.decimals}  supply=${s.totalSupply}`);
  console.log(`  curve: complete=${c.curve.complete} vSol=${Number(c.curve.vSol) / 1e9} vTok=${Number(c.curve.vTok) / 10 ** c.decimals} realSol=${Number(c.curve.realSol) / 1e9} creator=${c.curve.creator} mayhem=${c.curve.mayhem}`);
  if (c.pool) console.log(`  pool: ${c.pool.address} quote=${Number(c.pool.quoteLamports) / 1e9} SOL virtual=${Number(c.pool.virtualQuote) / 1e9} SOL base=${Number(c.pool.baseRaw) / 10 ** c.decimals}`);
  console.log(`  priceSol=${c.priceSol}  liquiditySol=${c.liquiditySol}  progress=${s.bondingCurvePct}%  dexId=${s.dexId}`);
}

const k = out.get(KRYPTO_TOKEN.mint);
if (k) {
  check('$KRYPTO is named from its Token-2022 metadata', k.name === KRYPTO_TOKEN.name && k.symbol === KRYPTO_TOKEN.symbol, `${k.name} / ${k.symbol}`);
  check('$KRYPTO has graduated and its pool was read', k.curve.complete && k.pool !== null && k.priceSol !== null);
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${KRYPTO_TOKEN.mint}`, { headers: { accept: 'application/json' } });
    const pairs = r.ok ? await r.json() : [];
    const ps = pairs.find((p) => /pump/i.test(p.dexId ?? '')) ?? pairs[0];
    const ref = ps ? Number(ps.priceNative) : NaN;
    if (Number.isFinite(ref) && k.priceSol) {
      const diff = Math.abs(k.priceSol - ref) / ref;
      check('the chain price agrees with DexScreener within 5 %', diff < 0.05, `chain ${k.priceSol.toExponential(4)} vs ${ref.toExponential(4)} (${(diff * 100).toFixed(2)} %)`);
    } else console.log('(DexScreener had no native price to compare against)');
  } catch (err) {
    console.log(`(DexScreener not reached: ${err.message})`);
  }
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall live checks passed');
process.exit(failures ? 1 : 0);
