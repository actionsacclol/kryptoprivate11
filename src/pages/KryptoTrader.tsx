// Automation → Krypto Trader (design: docs/krypto-trader-2026-09-25.md §1;
// its "Critic's corrections" override the design, and the user's 09-25
// decisions override both).
//
// One coin, one of the user's wallets, a budget and a preset — or an AI —
// trading the user's OWN position from the session's own book. There is no
// market-cap, volume or price-target goal anywhere on this page: on a coin
// somebody else launched that is manipulation (D1), and Krypto Mode's
// declared 'support' goal cannot reach a trader session.
//
// Paper first: "Start (paper)" is the only start button. Going live is a
// separate, confirmed action on a running session (the right column).
//
// Pacing is the user's (09-25): every limit is editable, 0 = off, and the
// anti-wash amber line appears the moment one of those is off.
//
// English only, like the other Automation pages (i18n.md: UI strings are
// translated where a page already is; money and legal wording stays English).
//
// Three chains (stage 4): Solana, Robinhood Chain and BNB. The chain picker
// drives the wallet list (only THAT chain's wallets — a wallet made for the
// other EVM chain is never offered, evm-wallet-home-chain), the coin address
// shape, the fit check, and every money label: the budget and the book are in
// the chain's own coin (SOL, ETH, BNB).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import {
  DEFAULT_TRADER_LIMITS,
  DEFAULT_TRADER_OPTIONS,
  DEFAULT_TRADER_PARAMS,
  TRADER_DRIVERS,
  TRADER_DRIVER_TEXT,
  TRADER_HONEST_STRIP,
  TRADER_PRESETS,
  TRADER_PRESET_TEXT,
  traderAiCostEstimate,
  traderAiModelFor,
  traderAntiWashOff,
  traderMoney,
  traderOptionProblems,
  type TraderDriver,
  type TraderFit,
  type TraderLimits,
  type TraderOptions,
  type TraderParamsByPreset,
  type TraderPreset,
} from '@shared/kryptoTrader';
import { TRADER_AI_MODELS } from '@shared/ai';
import { EVM_CHAIN_META, walletVisibleOn, type ChainKind } from '@shared/evm';
import { Card, Field, NumberInput, Page, PrimaryButton, Section, TextInput } from '../components/common';
import { FitCheck } from '../components/trader/FitCheck';
import { PresetCard } from '../components/trader/PresetCard';
import { AntiWashLine, TraderLimitsFields } from '../components/trader/LimitsFields';
import { EnvelopeFields, TraderSessions } from '../components/trader/TraderSessions';
import { useToast } from '../state/ToastProvider';
import { useAppState } from '../state/AppStateProvider';
import { clearTraderPrefill, peekTraderPrefill } from '../state/traderPrefill';
import { cls, shortAddr } from '../utils/format';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

const CHAINS: { id: ChainKind; label: string }[] = [
  { id: 'solana', label: 'Solana' },
  { id: 'robinhood', label: 'Robinhood Chain' },
  { id: 'bnb', label: 'BNB Chain' },
];

/** One wallet row, whichever chain's list it came from. */
interface TraderWallet {
  id: string;
  label: string;
  address: string;
  /** Balance in the chain's coin; null = not read (an em dash). */
  balance: number | null;
  active: boolean;
}

/** The chain's wallets as the session may use them: Solana's list, or THIS
 *  EVM chain's (made for it, pre-split, or its signer — walletVisibleOn). */
async function walletsFor(chain: ChainKind): Promise<TraderWallet[]> {
  if (chain === 'solana') {
    const r = await window.krypt.wallet.list();
    const list = r.ok && Array.isArray(r.data) ? r.data : [];
    return list.map((w) => ({ id: w.id, label: w.label || 'Wallet', address: w.publicKey, balance: w.balanceSol, active: w.active }));
  }
  const r = await window.krypt.evm.wallet.list(chain);
  const list = r.ok && Array.isArray(r.data) ? r.data : [];
  return list.filter((w) => walletVisibleOn(w, chain)).map((w) => ({ id: w.id, label: w.label || 'Wallet', address: w.address, balance: w.balanceNative, active: w.active }));
}

/** What each non-preset driver does, said before Start. Both stay inside the
 *  same limits and stops as the preset rules; the stops run whatever the
 *  driver says, or doesn't. */
const DRIVER_NOTE: Record<'ai' | 'mcp', string> = {
  ai: 'Your AI key is asked when something changes (a real price move, a fill, a new high or low, near the stop) and at least every 5 minutes, within your AI pacing below. It proposes hold, buy or sell; the app checks every proposal against your limits. Each ask spends your key. The stops keep running if the AI pauses.',
  mcp: 'An AI connected over MCP (Settings → AI connection) reads the session with get_trader_session and proposes moves with trader_act. It cannot start, fund, resume or change a session, and a paper connection cannot act for a live one. The stops keep running whether it calls or not.',
};

/** A limit in seconds as the collapsed summary says it: under a minute (or
 *  not a whole minute) in seconds, never rounded to "0 min" (review #23). */
const secsOrMins = (sec: number): string => (sec < 60 || sec % 60 !== 0 ? `${sec} s` : `${sec / 60} min`);

const usd = (v: number): string => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

export function KryptoTraderPage() {
  const toast = useToast();
  const { settings } = useAppState();
  const keys = { anthropic: !!settings.ai.anthropicKey.trim(), openai: !!settings.ai.openaiKey.trim() };
  // Read on the first render, cleared only once mounted: "Open in Krypto
  // Trader" from the Token or Runners page (Solana or EVM — the prefill
  // carries the chain). A transition render React throws away must not use
  // it up (review #20).
  const [prefill] = useState(() => peekTraderPrefill());
  useEffect(() => {
    clearTraderPrefill(prefill);
  }, [prefill]);
  const [chain, setChain] = useState<ChainKind>(prefill?.chain ?? 'solana');
  const [mint, setMint] = useState<string>(prefill?.mint ?? '');
  const [wallets, setWallets] = useState<TraderWallet[] | null>(null);
  const [walletId, setWalletId] = useState('');
  const money = traderMoney(chain);
  const [budget, setBudget] = useState<number>(() => traderMoney(prefill?.chain ?? 'solana').defaultBudget);
  const [preset, setPreset] = useState<TraderPreset>(DEFAULT_TRADER_OPTIONS.preset);
  const [paramsBy, setParamsBy] = useState<TraderParamsByPreset>(() => structuredClone(DEFAULT_TRADER_PARAMS));
  const [driver, setDriver] = useState<TraderDriver>('strategy');
  const [aiModel, setAiModel] = useState('');
  const [aiCap, setAiCap] = useState<number>(DEFAULT_TRADER_OPTIONS.aiDailyUsdCap);
  const [env, setEnv] = useState<Pick<TraderOptions, 'maxLossPct' | 'timeLimitH' | 'atExpiry' | 'reinvest' | 'thesis'>>({
    maxLossPct: DEFAULT_TRADER_OPTIONS.maxLossPct,
    timeLimitH: DEFAULT_TRADER_OPTIONS.timeLimitH,
    atExpiry: DEFAULT_TRADER_OPTIONS.atExpiry,
    reinvest: DEFAULT_TRADER_OPTIONS.reinvest,
    thesis: '',
  });
  const [limits, setLimits] = useState<TraderLimits>({ ...DEFAULT_TRADER_LIMITS });
  const [showLimits, setShowLimits] = useState(false);
  const [fit, setFit] = useState<TraderFit | null>(null);
  const [fitLoading, setFitLoading] = useState(false);
  const [fitError, setFitError] = useState<string | null>(null);
  const [ackNotice, setAckNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // The wallet list follows the chain; switching chains starts the wallet
  // pick over (a Solana wallet id means nothing on BNB).
  useEffect(() => {
    let alive = true;
    setWallets(null);
    setWalletId('');
    void walletsFor(chain).then((list) => {
      if (!alive) return;
      setWallets(list);
      setWalletId(list.find((w) => w.active)?.id || list[0]?.id || '');
    });
    return () => {
      alive = false;
    };
  }, [chain]);

  const pickChain = (c: ChainKind) => {
    if (c === chain) return;
    setChain(c);
    setBudget(traderMoney(c).defaultBudget);
    setFit(null);
  };

  const options: TraderOptions = useMemo(
    () => ({
      chain,
      mint: mint.trim(),
      walletId,
      preset,
      params: paramsBy[preset],
      driver,
      budgetSol: budget,
      ...env,
      limits,
      aiModel: aiModel.trim() || null,
      aiDailyUsdCap: aiCap,
    }),
    [chain, mint, walletId, preset, paramsBy, driver, budget, env, limits, aiModel, aiCap],
  );
  const mintOk = chain === 'solana' ? MINT_RE.test(options.mint) : EVM_RE.test(options.mint);

  // The fit check follows every input that changes it — the coin, the size,
  // the preset and its settings, the limits, the wallet (M9: your own coin).
  // Debounced, and only the latest answer lands.
  const fitKey = JSON.stringify([chain, options.mint, budget, preset, paramsBy[preset], limits, walletId]);
  const seq = useRef(0);
  useEffect(() => {
    if (!mintOk) {
      // Drop any answer still in flight for the coin that was there (review #21).
      ++seq.current;
      setFit(null);
      setFitError(null);
      setFitLoading(false);
      return;
    }
    const my = ++seq.current;
    setFitLoading(true);
    const t = window.setTimeout(() => {
      void window.krypt.kryptoTrader
        .fit(options.mint, { chain, budgetSol: budget, preset, params: paramsBy[preset], limits, walletId })
        .then((r) => {
          if (my !== seq.current) return;
          if (r.ok && r.data) {
            setFit(r.data);
            setFitError(null);
          } else {
            setFit(null);
            setFitError(r.message || 'Could not check this coin.');
          }
        })
        .catch((e: unknown) => {
          if (my !== seq.current) return;
          setFit(null);
          setFitError(`Could not check this coin: ${(e as Error).message}`);
        })
        .finally(() => {
          if (my === seq.current) setFitLoading(false);
        });
    }, 450);
    return () => window.clearTimeout(t);
    // fitKey carries every input the call reads.
  }, [fitKey, mintOk]);

  // A new coin starts on a fresh fit: the old one must not grey this coin's presets.
  useEffect(() => {
    setFit(null);
  }, [options.mint]);

  const problems = traderOptionProblems(options);
  // The AI driver needs a key for the model it asks (the default = the first
  // model of a provider that has one).
  const aiPick = traderAiModelFor(options.aiModel, keys);
  const aiCost = aiPick ? traderAiCostEstimate(aiPick.model, limits) : null;
  if (driver === 'ai' && !aiPick) {
    problems.push(options.aiModel ? `No key for ${options.aiModel} — add it under Settings → AI, or pick another model.` : 'The AI driver needs an OpenAI or Anthropic key — add one under Settings → AI.');
  }
  const notice = fit?.entryBlockingNotice ?? null;
  const acked = notice === null || ackNotice === notice;
  const greyedNow = fit?.greyed[preset] ?? null;
  const blockers: string[] = [
    ...problems,
    ...(mintOk && !fit && !fitLoading && fitError ? [fitError] : []),
    ...(fit ? fit.refusals : []),
    ...(greyedNow ? [`${TRADER_PRESET_TEXT[preset].label} does not fit this coin: ${greyedNow}`] : []),
  ];
  const canStart = !starting && blockers.length === 0 && fit !== null && !fitLoading && acked;

  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    try {
      const r = await window.krypt.kryptoTrader.open(options);
      if (r.ok) {
        toast.success(r.message);
        setMint('');
        setAckNotice(null);
      } else toast.error(r.message);
    } finally {
      setStarting(false);
    }
  };

  const clipped = fit && fit.clippedBudgetSol !== null && fit.clippedBudgetSol < budget ? fit.clippedBudgetSol : null;

  return (
    <Page title="Krypto Trader" subtitle="Trade one coin from one wallet with a preset or an AI. Paper first.">
      <div data-honest-strip className="mb-6 rounded-lg border border-arc-gold/25 bg-arc-gold/[0.06] p-3 text-body leading-relaxed text-white/85">
        {TRADER_HONEST_STRIP}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* ── Left: a new session ─────────────────────────────────────── */}
        <div className="min-w-0">
          <Section title="New session">
            <Card className="space-y-5">
              <div>
                <div className="mb-1.5 text-label uppercase tracking-label text-krypt-muted/70">Chain</div>
                <div data-chain-picker className="grid grid-cols-3 gap-1.5">
                  {CHAINS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => pickChain(c.id)}
                      className={cls('rounded-lg border px-3 py-2 text-body transition', chain === c.id ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/[0.02] text-krypt-muted hover:bg-white/5')}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-label leading-relaxed text-krypt-muted/70">
                  {chain === 'solana'
                    ? 'pump.fun coins, on the curve or on PumpSwap. Money in SOL.'
                    : `${EVM_CHAIN_META[chain].launchpadLabel} curves and ${money.symbol} pools this app can route, ${money.symbol}-quoted only. Money in ${money.symbol}. Nothing here has been run on this chain with real funds yet — paper first.`}
                </p>
              </div>

              <Field
                label="Coin"
                hint={
                  chain === 'solana'
                    ? 'Paste a pump.fun coin address, or press “Open in Krypto Trader” on a token or a runner.'
                    : `Paste a ${EVM_CHAIN_META[chain].name} token address (0x…), or press “Open in Krypto Trader” on its token page.`
                }
              >
                <TextInput value={mint} onChange={setMint} placeholder={chain === 'solana' ? 'Coin address' : '0x… token address'} />
              </Field>

              <FitCheck fit={fit} loading={fitLoading} error={fitError} budgetSol={budget} />

              <Field label="Wallet" hint="Trades only from this wallet. Coins it already holds are not the session’s and are never sold by it.">
                {wallets === null ? (
                  <div className="text-body text-krypt-muted">Loading wallets…</div>
                ) : wallets.length === 0 ? (
                  <div className="text-body text-krypt-muted">
                    {chain === 'solana' ? 'No wallet yet — make one on the Sol Wallet page.' : `No ${EVM_CHAIN_META[chain].name} wallet yet — make one on its wallet page. A wallet made for the other chain is not used here.`}
                  </div>
                ) : (
                  <select
                    value={walletId}
                    onChange={(e) => setWalletId(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60"
                  >
                    {wallets.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label} · {shortAddr(w.address, 4)} · {w.balance === null ? '—' : `${w.balance.toFixed(chain === 'solana' ? 3 : 4)} ${money.symbol}`}
                        {w.active ? ' · active' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label={`Budget (${money.symbol})`} hint={`The most this session may have at risk, ${money.minBudget}–${money.maxBudget} ${money.symbol}. Smallest buy ${money.minBuy} ${money.symbol}.`}>
                <NumberInput value={budget} onChange={setBudget} min={money.minBudget} max={money.maxBudget} suffix={money.symbol} />
                {clipped !== null && <div className="mt-1 text-label text-amber-200/90">Clipped to {clipped.toFixed(chain === 'solana' ? 3 : 5)} {money.symbol}: a full exit would move price more than 10%.</div>}
              </Field>

              <div>
                <div className="mb-1.5 text-label uppercase tracking-label text-krypt-muted/70">Preset</div>
                <div className="space-y-2">
                  {TRADER_PRESETS.map((p) => (
                    <PresetCard
                      key={p}
                      preset={p}
                      selected={preset === p}
                      greyed={fit?.greyed[p] ?? null}
                      params={paramsBy[p]}
                      chain={chain}
                      onSelect={() => setPreset(p)}
                      onParams={(next) => setParamsBy((cur) => ({ ...cur, [p]: next }))}
                    />
                  ))}
                </div>
                <p className="mt-1.5 text-label leading-relaxed text-krypt-muted/70">
                  Every preset trades your own position from the session’s own book. None aims at the coin’s price, market cap or volume.
                </p>
              </div>

              <div>
                <div className="mb-1.5 text-label uppercase tracking-label text-krypt-muted/70">Who drives it</div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                  {TRADER_DRIVERS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDriver(d)}
                      className={cls('rounded-lg border px-3 py-2 text-left transition', driver === d ? 'border-krypt-purple/60 bg-krypt-purple/15' : 'border-white/10 bg-white/[0.02] hover:bg-white/5')}
                    >
                      <span className="block text-body font-semibold text-white/90">{TRADER_DRIVER_TEXT[d].label}</span>
                      <span className="block text-label leading-relaxed text-krypt-muted">{TRADER_DRIVER_TEXT[d].help}</span>
                    </button>
                  ))}
                </div>
                {driver !== 'strategy' && <p data-driver-note className="mt-1.5 rounded-md border border-white/10 bg-white/[0.03] p-2 text-label leading-relaxed text-krypt-muted">{DRIVER_NOTE[driver]}</p>}
                {driver === 'ai' && (
                  <div className="mt-2 space-y-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Field label="Model" hint="Only models whose provider has a key under Settings → AI.">
                        <select
                          data-ai-model
                          value={aiModel}
                          onChange={(e) => setAiModel(e.target.value)}
                          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60"
                        >
                          <option value="">Default{aiPick && !options.aiModel ? ` (${aiPick.model})` : ''}</option>
                          {TRADER_AI_MODELS.filter((m) => keys[m.provider]).map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="AI spend cap per day (USD)" hint="Counted from what each ask actually cost. When reached, the AI pauses until tomorrow (UTC); the stops keep running. 0 = no cap.">
                        <NumberInput value={aiCap} onChange={setAiCap} min={0} max={50} suffix="USD" />
                      </Field>
                    </div>
                    {aiCost && aiPick && (
                      <div data-ai-cost className="text-label leading-relaxed text-krypt-muted">
                        {aiPick.model}: about <span className="font-mono text-white/90">{usd(aiCost.perAskUsd)}</span> an ask · typically{' '}
                        <span className="font-mono text-white/90">{usd(aiCost.typicalPerHourUsd)}/hour</span> and{' '}
                        <span className="font-mono text-white/90">{usd(aiCost.typicalPerDayUsd)}/day</span> ({aiCost.asksTypical} asks an hour); at most{' '}
                        <span className="font-mono text-white/90">{usd(aiCost.maxPerHourUsd)}/hour</span> and{' '}
                        <span className="font-mono text-white/90">{usd(aiCost.maxPerDayUsd)}/day</span> at your AI pacing ({aiCost.asksMax} asks an hour)
                        {aiCap > 0 ? `, and never much over your ${usd(aiCap)} daily cap` : ' — no daily cap set'}.
                        {aiCost.estimate && <span className="text-amber-200/80"> Estimate: this provider’s price is not confirmed.</span>}
                      </div>
                    )}
                    {aiCap === 0 && <p className="text-label text-amber-200/85">No daily AI spend cap: the AI is asked as often as your pacing allows, all day.</p>}
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1.5 text-label uppercase tracking-label text-krypt-muted/70">Envelope</div>
                <EnvelopeFields v={env} onChange={(p) => setEnv((cur) => ({ ...cur, ...p }))} />
              </div>

              <div>
                <button type="button" onClick={() => setShowLimits((x) => !x)} className="text-label uppercase tracking-label text-krypt-muted/70 hover:text-white">
                  {showLimits ? '▾' : '▸'} Pacing limits (yours to set)
                </button>
                {!showLimits && (
                  <p className="mt-1 text-label leading-relaxed text-krypt-muted/70">
                    {limits.minGapSec} s between trades · max {limits.maxTradesPerHour}/hour · no buy-back within {secsOrMins(limits.noRebuySec)} of a sell · sells ≥ {limits.minSellPctOfBag}% of
                    the bag · each buy ≤ {limits.maxBuyDepthPct}% of pool depth · buys ≤ {limits.maxDailyBuysX}× budget per 24 h. 0 turns any of them off.
                  </p>
                )}
                {/* The amber line stays on screen with the section collapsed: it must be seen before Start (review #23). */}
                {!showLimits && traderAntiWashOff(limits).length > 0 && (
                  <div className="mt-2">
                    <AntiWashLine />
                  </div>
                )}
                {showLimits && (
                  <div className="mt-2">
                    <TraderLimitsFields limits={limits} driver={driver} onChange={setLimits} />
                  </div>
                )}
              </div>

              <div className="text-body text-krypt-muted">
                Each round trip costs about <span className="font-mono text-white/90">{fit?.roundTripCostPct != null ? `${fit.roundTripCostPct.toFixed(1)}%` : '—'}</span> (Krypt 0.5%/side + pool fee + your own price
                impact).
              </div>

              {notice && (
                <label data-entry-notice className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.08] p-3">
                  <input type="checkbox" checked={ackNotice === notice} onChange={(e) => setAckNotice(e.target.checked ? notice : null)} className="mt-0.5 accent-[rgb(var(--krypt-accent))]" />
                  <span className="text-body leading-relaxed text-amber-100/90">
                    {notice}
                    <span className="mt-1 block text-label text-amber-100/70">Tick to confirm you have read this.</span>
                  </span>
                </label>
              )}

              {blockers.length > 0 && mint.trim() !== '' && (
                <ul className="space-y-0.5 text-label text-rose-300/90">
                  {blockers.map((b) => (
                    <li key={b}>· {b}</li>
                  ))}
                </ul>
              )}

              <PrimaryButton onClick={() => void start()} disabled={!canStart} className="w-full">
                <Play className="h-4 w-4" />
                {starting ? 'Starting…' : 'Start (paper)'}
              </PrimaryButton>
              <p className="text-label leading-relaxed text-krypt-muted/70">
                Nothing real is bought on paper. Going live is a separate step on the running session, with its own confirmation.
              </p>
            </Card>
          </Section>
        </div>

        {/* ── Right: sessions ─────────────────────────────────────────── */}
        <div className="min-w-0">
          <Section title="Sessions">
            <TraderSessions />
          </Section>
        </div>
      </div>
    </Page>
  );
}
