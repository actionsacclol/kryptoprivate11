// Live smoke test — NOT part of `npm test` (needs network). Runs the real
// engine headless against Solana mainnet for ~45s and reports what it saw.
// Usage: node test/smoke.live.mjs  (after: npx esbuild electron/engine/engine.ts
//   --bundle --format=esm --platform=node --external:ws --alias:@shared=./shared
//   --outfile=test/.engine.mjs)

import { SniperEngine } from './.engine.mjs';

const settings = {
  rpc: {
    wssUrl: 'wss://api.mainnet-beta.solana.com',
    httpUrl: 'https://api.mainnet-beta.solana.com',
    commitment: 'processed',
  },
  strategy: {
    evalWindowSec: 15,
    minUniqueBuyers: 5,
    minNetInflowSol: 1,
    maxTopBuyerShare: 0.4,
    minScore: 58,
    maxSellsInWindow: 0,
    maxSellVolumeSol: 0.4,
    entryCurveMinPct: 4,
    entryCurveMaxPct: 22,
    maxUniqueBuyers: 11,
    maxNetInflowSol: 18,
    maxTopHolderShare: 0.25,
    maxEarlyBuyerShare: 0.45,
    earlyBuyerWindowMs: 2000,
    positionSizeSol: 0.1,
    maxOpenPositions: 3,
    stopLossPct: 0.35,
    takeProfit1Pct: 0.6,
    takeProfit2Pct: 1.5,
    trailingPct: 0.25,
    timeStopSec: 90,
    exitOnCreatorSell: true,
    exitOnFlowReversal: true,
    maxSessionLossSol: 0.5,
    maxConsecutiveLosses: 4,
  },
  execution: {
    feeUrgency: 'competitive',
    useJito: true,
    jitoTipPercentile: 75,
    useHeliusSender: true,
    computeUnitLimit: 120000,
    liveEnabled: false,
    autoLive: false,
    maxLiveSol: 0.05,
    liveSlippagePct: 12,
    maxLiveSessionLossSol: 0.03,
    maxLiveConsecutiveLosses: 2,
  },
  recorderEnabled: false,
  recorderDir: '',
  recordFirehose: false,
  discordRpcEnabled: false,
  autoStartEngine: false,
  shadowMode: true,
};

let launches = 0;
let trades = 0;

const engine = new SniperEngine(
  () => settings,
  (ev) => {
    if (ev.kind === 'log') console.log(`[log] ${ev.line}`);
    if (ev.kind === 'launch') {
      launches++;
      console.log(`[launch] ${ev.launch.symbol} "${ev.launch.name}" mint=${ev.launch.mint.slice(0, 8)} slot=${ev.launch.slot}`);
    }
    if (ev.kind === 'launchUpdate' && ev.launch.phase !== 'detected') {
      trades++;
      if (trades % 25 === 0)
        console.log(`[update] ${ev.launch.symbol} phase=${ev.launch.phase} buyers=${ev.launch.flow.uniqueBuyers} net=${ev.launch.flow.netInflowSol.toFixed(2)} score=${ev.launch.score?.total ?? '—'}`);
    }
    if (ev.kind === 'toast') console.log(`[toast:${ev.level}] ${ev.message}`);
  },
);

console.log(engine.start());
setTimeout(() => {
  const s = engine.status();
  console.log('--- 45s summary ---');
  console.log(`feed=${s.feed} slot=${s.slot} events/s=${s.eventsPerSec} decodeLat=${s.decodeLatencyMs}ms`);
  console.log(`seen=${s.launchesSeen} evaluated=${s.launchesEvaluated} entered=${s.launchesEntered} rejected=${s.launchesRejected}`);
  engine.stop();
  process.exit(0);
}, 45_000);
