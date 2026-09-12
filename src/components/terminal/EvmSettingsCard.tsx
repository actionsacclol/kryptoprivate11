import { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { EVM_CHAIN_META, EVM_CHAINS, evmReferralProblem, evmRpcUrlProblem, type EvmChainKind, type EvmChainSettings } from '@shared/evm';
import { Card, GhostButton, NumberInput, PrimaryButton, Section, Switch } from '../common';
import { useToast } from '../../state/ToastProvider';
import { useEvmState } from '../../state/useEvmState';

// EVM chain settings: the shared slippage + referrer, then one block per
// chain (on/off, RPC endpoint, provider key where one is useful). Each
// block saves on its own; the enabled switch saves at once because it is a
// one-click decision.

function ChainBlock({
  chain,
  settings,
  updateSettings,
}: {
  chain: EvmChainKind;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const toast = useToast();
  const meta = EVM_CHAIN_META[chain];
  const cs = settings.evm[chain];
  const { evm } = useEvmState(chain);
  const [apiKey, setApiKey] = useState(cs.apiKey ?? '');
  const [rpcUrl, setRpcUrl] = useState(cs.rpcUrl ?? '');
  const keyed = chain === 'robinhood';
  // The rail's view of the endpoint: 'rejected' = the key / custom URL
  // answered 401/403 and the rail fell back to the public endpoint for a
  // while. A build whose state lacks the field reads as ok.
  // 'unreachable' has always been declared on EvmState but the rail could
  // never actually return it until 2026-09-09 (transport failures only counted
  // fetch() throws, so a host answering 5xx forever stayed 'ok'). It arrives
  // now, and narrowing it away here would render no message at all.
  const rpcStatus: 'ok' | 'rate-limited' | 'rejected' | 'unreachable' =
    (evm as { rpcStatus?: 'ok' | 'rate-limited' | 'rejected' | 'unreachable' } | null)?.rpcStatus ?? 'ok';

  // Keyed on the values, not the block object: a save elsewhere (the shared
  // card, the other chain) replaces the whole settings object and must not
  // wipe text typed here.
  useEffect(() => {
    setApiKey(cs.apiKey ?? '');
    setRpcUrl(cs.rpcUrl ?? '');
  }, [cs.apiKey, cs.rpcUrl]);

  const save = (): void => {
    let key = apiKey.trim();
    if (keyed) {
      // Accept a bare key or a pasted Alchemy URL.
      const fromUrl = key.match(/\/v2\/([A-Za-z0-9_-]+)/);
      if (fromUrl) key = fromUrl[1];
      if (key && !/^[A-Za-z0-9_-]{8,}$/.test(key)) {
        toast.error('That does not look like an Alchemy API key — paste the key from your dashboard');
        return;
      }
    }
    const urlProblem = evmRpcUrlProblem(rpcUrl);
    if (urlProblem) {
      toast.error(urlProblem);
      return;
    }
    const next: EvmChainSettings = { ...cs, apiKey: keyed ? key : '', rpcUrl: rpcUrl.trim() };
    void updateSettings({ evm: { ...settings.evm, [chain]: next } });
  };

  const inputCls =
    'w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60';

  return (
    <Card className="space-y-3">
      <Switch
        checked={cs.enabled}
        onChange={(v) => void updateSettings({ evm: { ...settings.evm, [chain]: { ...cs, enabled: v } } })}
        label={`Show ${meta.name}`}
        description={`The ${meta.shortName} segment of the chain switch, its wallet balance and its token pages. Off hides them; nothing on the other chains changes.`}
      />
      {keyed && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted">
              Alchemy API key <span className="text-krypt-purple">(recommended)</span>
            </div>
            <button
              onClick={() => void window.krypt.app.openExternal('https://dashboard.alchemy.com')}
              className="text-[11px] font-semibold text-krypt-purple hover:text-white transition-colors"
            >
              Get a free key at alchemy.com →
            </button>
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your Alchemy API key"
            spellCheck={false}
            autoComplete="off"
            className={inputCls}
          />
          <div className="text-[11px] text-krypt-muted/70 mt-1">
            Robinhood's docs recommend Alchemy; the public endpoint rate-limits a Discover-sized burst. The key stays on this machine.
          </div>
        </div>
      )}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">Own RPC URL (optional)</div>
        <input
          value={rpcUrl}
          onChange={(e) => setRpcUrl(e.target.value)}
          placeholder={keyed ? 'https://… (QuickNode, dRPC, your node). Empty = public endpoint.' : 'https://… (NodeReal, QuickNode, your node). Empty = public endpoint.'}
          spellCheck={false}
          className={inputCls}
        />
        <div className="text-[11px] text-krypt-muted/70 mt-1">
          {keyed ? 'Used only when no Alchemy key is set. ' : "BNB's public endpoints are generous; an own URL is optional. "}
          Must be https.
          {evm && (
            <span className="ml-1 font-mono text-krypt-muted">
              Connected to {evm.rpcHost}
              {evm.head ? ` · block ${evm.head.block.toLocaleString()}` : ' · unreachable'}
            </span>
          )}
        </div>
        {rpcStatus === 'unreachable' && (
          <div className="text-[11px] text-rose-300/90 mt-1">
            Your RPC URL is not answering — using the public endpoint. Check the address above.
          </div>
        )}
        {rpcStatus === 'rejected' && (
          <div className="text-[11px] text-rose-300/90 mt-1">Your key or RPC URL was rejected (401/403) — using the public endpoint until you fix it.</div>
        )}
        {rpcStatus === 'rate-limited' && (
          // Only Robinhood reads an Alchemy key; on BNB the key field does not
          // exist and `resolveEvmRpcUrl` ignores one, so the remedy there is
          // the RPC URL field above.
          <div className="text-[11px] text-arc-gold/90 mt-1">
            Rate limited by the public endpoint — {keyed ? 'add an Alchemy key' : 'set your own BNB RPC URL above (NodeReal, QuickNode, dRPC)'} for a steady feed.
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <PrimaryButton onClick={save}>Save {meta.shortName} settings</PrimaryButton>
        <GhostButton
          onClick={() => {
            setApiKey(cs.apiKey ?? '');
            setRpcUrl(cs.rpcUrl ?? '');
          }}
        >
          Reset
        </GhostButton>
      </div>
    </Card>
  );
}

export function EvmSettingsCard({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const toast = useToast();
  const { evm: hood } = useEvmState('robinhood');
  const [slippage, setSlippage] = useState(settings.evm.slippagePct);
  const [referrer, setReferrer] = useState(settings.evm.referrer ?? '');

  useEffect(() => {
    setSlippage(settings.evm.slippagePct);
    setReferrer(settings.evm.referrer ?? '');
  }, [settings.evm.slippagePct, settings.evm.referrer]);

  const saveShared = (): void => {
    const refProblem = evmReferralProblem(referrer, { self: hood?.wallet.address ?? null });
    if (refProblem) {
      toast.error(refProblem);
      return;
    }
    if (!(slippage >= 0 && slippage <= 50)) {
      toast.error('Slippage must be between 0 and 50 %');
      return;
    }
    void updateSettings({ evm: { ...settings.evm, slippagePct: slippage, referrer: referrer.trim() } });
  };

  const inputCls =
    'w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60';

  return (
    <Section
      title="EVM chains"
      description="Robinhood Chain (an Ethereum L2, chain id 4663, launchpad Pons) and BNB Smart Chain (chain id 56, launchpad four.meme). One wallet serves both — the same key is the same address on every EVM chain."
    >
      <Card className="space-y-3 mb-3">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">Slippage (both chains)</div>
            <NumberInput
              value={slippage}
              onChange={setSlippage}
              suffix="%"
              warn={(n) => (n < 0 ? 'Must be 0 or more' : n > 50 ? 'Max 50 %' : n < 2 ? 'Pons and four.meme charge 1 % per fill (Pons adds a creator tax); under 2 % most curve buys will revert' : null)}
            />
            <div className="text-[11px] text-krypt-muted/70 mt-1">
              Buys use this cap; sells use the wider of this and 15 %, so an exit is never refused over a tight cap. The Solana loss
              breakers (session loss cap, losses in a row) do not cover the EVM chains yet.
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">Referrer (optional)</div>
            <input
              value={referrer}
              onChange={(e) => setReferrer(e.target.value)}
              placeholder="0x… address of whoever referred you"
              spellCheck={false}
              className={inputCls}
            />
            <div className="text-[11px] text-krypt-muted/70 mt-1">
              They receive their share of the Krypt fee; it costs you nothing extra. Charged inside the same transaction on pool trades; on
              launchpad curves it is a separate transfer sent right after the fill. four.meme sells pay the whole fee to the treasury (no
              referral split there).
              {hood && !hood.feesEnabled && <span className="text-arc-gold/80"> No platform fee is charged on the EVM chains yet.</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <PrimaryButton onClick={saveShared}>Save shared settings</PrimaryButton>
          <GhostButton
            onClick={() => {
              setSlippage(settings.evm.slippagePct);
              setReferrer(settings.evm.referrer ?? '');
            }}
          >
            Reset
          </GhostButton>
        </div>
      </Card>
      <div className="grid xl:grid-cols-2 gap-3">
        {EVM_CHAINS.map((chain) => (
          <ChainBlock key={chain} chain={chain} settings={settings} updateSettings={updateSettings} />
        ))}
      </div>
    </Section>
  );
}
