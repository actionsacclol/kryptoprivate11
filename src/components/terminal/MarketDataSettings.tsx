import { useEffect, useState } from 'react';

/** A whole number committed on blur/Enter and clamped to its bound. Saving
 *  on every keystroke rejected the first digit of "15" (below the floor),
 *  React snapped the field back, and the user ended up with "105". */
function BoundedInt({
  value,
  min,
  max,
  onCommit,
  className,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
  className: string;
}) {
  return (
    <input
      key={value}
      type="number"
      min={min}
      max={max}
      defaultValue={value}
      onBlur={(e) => {
        const n = Math.round(Number(e.target.value));
        if (!Number.isFinite(n) || e.target.value.trim() === '') {
          e.target.value = String(value);
          return;
        }
        const clamped = Math.min(max, Math.max(min, n));
        if (clamped !== value) onCommit(clamped);
        else e.target.value = String(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={className}
    />
  );
}
import { AlertCircle, CheckCircle2, MinusCircle } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { humanWait } from '@shared/market';
import type { ProviderId, ProviderStatus } from '@shared/market';
import { Card, GhostButton, Section, Switch } from '../common';
import { useTerminal } from '../../state/TerminalProvider';
import { useToast } from '../../state/ToastProvider';
import { cls, fmtAgo } from '../../utils/format';

// Market-data settings + the privacy panel.
//
// This is the screen that makes the local-first claim checkable rather than
// a slogan. It names EVERY host the terminal will contact, says exactly what
// each one is used for, shows a live call/error/latency count per provider,
// and has one switch that turns all of it off.
//
// With the master switch off the app still works: on-chain reads, the live
// WSS tape and everything the engine produces are unaffected, because none
// of that goes through a provider. What you lose is charts and any token the
// engine has not personally seen — which is the honest trade-off, stated.

function StatusDot({ p }: { p: ProviderStatus }) {
  if (!p.enabled) return <MinusCircle className="h-3.5 w-3.5 text-krypt-muted/40" />;
  if (!p.usable) return <AlertCircle className="h-3.5 w-3.5 text-arc-gold" />;
  if (p.errors > 0 && p.lastError) return <AlertCircle className="h-3.5 w-3.5 text-rose-400" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
}

export function MarketDataSettings({
  settings,
  updateSettings,
}: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const term = useTerminal();
  const toast = useToast();
  const [birdeyeKey, setBirdeyeKey] = useState(settings.data.birdeyeApiKey);
  const [jupiterKey, setJupiterKey] = useState(settings.data.jupiterApiKey);
  const [giphyKey, setGiphyKey] = useState(settings.data.giphyApiKey);
  const [tenorKey, setTenorKey] = useState(settings.data.tenorApiKey);

  useEffect(() => {
    setBirdeyeKey(settings.data.birdeyeApiKey);
  }, [settings.data.birdeyeApiKey]);
  useEffect(() => {
    setJupiterKey(settings.data.jupiterApiKey);
  }, [settings.data.jupiterApiKey]);
  useEffect(() => {
    setGiphyKey(settings.data.giphyApiKey);
    setTenorKey(settings.data.tenorApiKey);
  }, [settings.data.giphyApiKey, settings.data.tenorApiKey]);

  const setProvider = (id: ProviderId, on: boolean): void => {
    void updateSettings({
      data: { ...settings.data, providers: { ...settings.data.providers, [id]: on } },
    }).then(() => term.refreshProviders());
  };

  const anyOn = settings.data.networkDataEnabled;

  return (
    <Section
      title="Market data"
      description="Which third-party APIs the terminal is allowed to contact, and exactly what each one sees."
    >
      <Card className="space-y-4">
        <Switch
          label="Allow market data providers"
          description={
            anyOn
              ? 'On. The terminal can fetch prices, feeds and charts from the hosts listed below.'
              : 'Off. Nothing here is contacted. Discover and charts will be empty; on-chain reads, the live feed and the engine keep working.'
          }
          checked={settings.data.networkDataEnabled}
          onChange={(v) => {
            void updateSettings({ data: { ...settings.data, networkDataEnabled: v } }).then(() =>
              term.refreshProviders(),
            );
          }}
        />

        <Switch
          label="Load token images"
          description={
            settings.data.loadTokenImages
              ? 'On. Icons are fetched through Krypt’s own hardened handler — https only, no redirects, size-capped, no SVG — but the request still comes from your machine, so the token’s creator sees your IP.'
              : 'Off. Tokens show a letter avatar and no image host is ever contacted.'
          }
          disabled={!settings.data.networkDataEnabled}
          checked={settings.data.loadTokenImages}
          onChange={(v) => {
            void updateSettings({ data: { ...settings.data, loadTokenImages: v } });
          }}
        />

        <div className="rounded-lg border border-white/10 bg-black/25 p-3">
          <p className="text-body text-krypt-muted leading-relaxed">
            <span className="text-white font-semibold">What these providers learn.</span> Each one sees the mint
            addresses you look at and your IP, because your machine asks them directly — there is no Krypt server in
            between, so Krypt never sees any of it. A provider you switch off is never contacted at all. The
            keyless providers need no account and no sign-up.
          </p>
        </div>

        <div className="space-y-2">
          {term.providers.map((p) => {
            const on = settings.data.providers[p.id];
            return (
              <div
                key={p.id}
                className={cls(
                  'rounded-lg border px-3 py-2.5 transition',
                  on && p.usable ? 'border-white/12 bg-white/[0.03]' : 'border-white/8 bg-black/20',
                )}
              >
                <div className="flex items-center gap-2.5">
                  <StatusDot p={p} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-value font-semibold text-white">{p.label}</span>
                      <span className="font-mono text-label text-krypt-muted/70">{p.host}</span>
                      {!p.keyless && (
                        <span className="rounded border border-arc-gold/30 bg-arc-gold/10 px-1.5 text-micro font-bold text-arc-gold">
                          KEY
                        </span>
                      )}
                    </div>
                    <p className="text-body text-krypt-muted mt-0.5">{p.provides}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={on}
                    disabled={!settings.data.networkDataEnabled}
                    onClick={() => setProvider(p.id, !on)}
                    className={cls(
                      'relative h-5 w-9 rounded-full transition flex-shrink-0',
                      !settings.data.networkDataEnabled && 'opacity-40 cursor-not-allowed',
                      on ? 'bg-krypt-gradient shadow-[0_0_8px_rgba(139,124,232,0.45)]' : 'bg-white/10',
                    )}
                  >
                    <span
                      className={cls(
                        'absolute top-0.5 h-4 w-4 rounded-full bg-white transition',
                        on ? 'left-[18px]' : 'left-0.5',
                      )}
                    />
                  </button>
                </div>

                {on && (
                  <div className="flex items-center gap-4 mt-2 pt-2 border-t border-white/5 text-label font-mono text-krypt-muted">
                    <span>{p.calls} calls</span>
                    <span className={p.errors > 0 ? 'text-rose-400/80' : undefined}>{p.errors} errors</span>
                    <span>{p.latencyMs === null ? '—' : `${p.latencyMs}ms`}</span>
                    {p.lastCallAt && <span>{fmtAgo(p.lastCallAt)} ago</span>}
                    {p.cooldownMs > 0 && (
                      <span
                        className="text-arc-gold"
                        title={
                          p.cooldownIsQuota
                            ? 'The provider says its allowance is spent. Waiting will not clear it — top up the plan or switch it off.'
                            : 'The provider answered 429; nothing is sent to it until this runs out.'
                        }
                      >
                        {/* Seconds are unreadable once a park can be hours:
                            a spent allowance showed as "retrying in 21596s"
                            (reported 2026-09-16). */}
                        {p.cooldownIsQuota ? `no allowance left · paused ${humanWait(p.cooldownMs)}` : `rate limited · retrying in ${humanWait(p.cooldownMs)}`}
                      </span>
                    )}
                    {p.queued > 5 && <span title="Calls waiting in this provider&apos;s queue.">{p.queued} queued</span>}
                    {!p.usable && !p.keyless && <span className="text-arc-gold">needs an API key</span>}
                    {p.lastError && (
                      <span className="text-rose-400/70 truncate" title={p.lastError}>
                        {p.lastError}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Birdeye key */}
        <div>
          <label className="block text-body uppercase tracking-label text-krypt-muted mb-1.5">
            Birdeye API key (optional)
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={birdeyeKey}
              onChange={(e) => setBirdeyeKey(e.target.value)}
              placeholder="Paste a key to unlock 1s candles and full holder lists"
              spellCheck={false}
              className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
            />
            <GhostButton
              onClick={() => {
                void updateSettings({
                  data: {
                    ...settings.data,
                    birdeyeApiKey: birdeyeKey.trim(),
                    providers: { ...settings.data.providers, birdeye: birdeyeKey.trim().length > 0 },
                  },
                }).then(() => term.refreshProviders());
              }}
            >
              Save
            </GhostButton>
          </div>
          <p className="text-label text-krypt-muted/60 mt-1.5 leading-relaxed">
            Stored in your local settings file. Everything in the terminal works without it — a key only adds
            sub-minute candles for tokens the engine is not taping, full holder lists, and historical trades.
          </p>
        </div>

        {/* Jupiter key — a host switch, not a feature unlock. */}
        <div>
          <label className="block text-body uppercase tracking-label text-krypt-muted mb-1.5">
            Jupiter API key (optional)
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={jupiterKey}
              onChange={(e) => setJupiterKey(e.target.value)}
              placeholder="Paste a key to move off Jupiter’s retiring endpoint"
              spellCheck={false}
              className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
            />
            <GhostButton
              onClick={() => {
                void updateSettings({
                  data: { ...settings.data, jupiterApiKey: jupiterKey.trim() },
                }).then(() => term.refreshProviders());
              }}
            >
              Save
            </GhostButton>
          </div>
          <p className="text-label text-krypt-muted/60 mt-1.5 leading-relaxed">
            Jupiter unlocks no extra data — everything it serves is keyless today. What a key buys is the{' '}
            <span className="text-white/80">host</span>: without one the terminal uses{' '}
            <span className="font-mono">lite-api.jup.ag</span>, which Jupiter says will be throttled further “until
            it is fully retired”. A free key at portal.jup.ag moves every Jupiter call, including buy and sell
            quotes, to <span className="font-mono">api.jup.ag</span>. Its published budget is 1 request per second,
            so the terminal deliberately slows Jupiter down to match — bursts take longer, and the endpoint does not
            disappear underneath you.
          </p>
        </div>

        {/* GIF backgrounds — nothing else in the app uses these. */}
        <div>
          <label className="block text-body uppercase tracking-label text-krypt-muted mb-1.5">
            GIF backgrounds (optional)
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex gap-2">
              <input
                type="password"
                value={giphyKey}
                onChange={(e) => setGiphyKey(e.target.value)}
                placeholder="GIPHY API key"
                spellCheck={false}
                className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
              />
              <GhostButton onClick={() => void updateSettings({ data: { ...settings.data, giphyApiKey: giphyKey.trim() } })}>
                Save
              </GhostButton>
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                value={tenorKey}
                onChange={(e) => setTenorKey(e.target.value)}
                placeholder="Tenor API key"
                spellCheck={false}
                className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
              />
              <GhostButton onClick={() => void updateSettings({ data: { ...settings.data, tenorApiKey: tenorKey.trim() } })}>
                Save
              </GhostButton>
            </div>
          </div>
          <p className="text-label text-krypt-muted/60 mt-1.5 leading-relaxed">
            Only used when you search a GIF for the background of a share card or a trade replay. Both providers give a
            key away free; without one, that search is simply not offered. A chosen GIF is downloaded once and baked
            into the image, so the finished card is not linked to anyone's server.
          </p>
        </div>

        {/* Cadence */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-body uppercase tracking-label text-krypt-muted mb-1.5">
              Discover refresh
            </label>
            <div className="flex items-center rounded-lg border border-white/10 bg-black/40 overflow-hidden">
              <BoundedInt
                value={settings.data.discoverRefreshSec}
                min={2}
                max={300}
                onCommit={(n) => void updateSettings({ data: { ...settings.data, discoverRefreshSec: n } })}
                className="flex-1 bg-transparent px-3 py-2 text-sm font-mono text-white outline-none"
              />
              <span className="px-3 text-body uppercase text-krypt-muted">sec</span>
            </div>
          </div>
          <div>
            <label className="block text-body uppercase tracking-label text-krypt-muted mb-1.5">
              Rows per column
            </label>
            <div className="flex items-center rounded-lg border border-white/10 bg-black/40 overflow-hidden">
              <BoundedInt
                value={settings.data.discoverLimit}
                min={5}
                max={80}
                onCommit={(n) => void updateSettings({ data: { ...settings.data, discoverLimit: n } })}
                className="flex-1 bg-transparent px-3 py-2 text-sm font-mono text-white outline-none"
              />
              <span className="px-3 text-body uppercase text-krypt-muted">rows</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <GhostButton
            onClick={() => {
              void window.krypt.market.clearCache().then((r) => {
                if (r.ok) toast.success(r.message);
                term.refreshNow();
              });
            }}
          >
            Clear market cache
          </GhostButton>
          <span className="text-label text-krypt-muted/55">
            Drops every cached response so the next refresh is a fresh fetch.
          </span>
        </div>
      </Card>
    </Section>
  );
}
