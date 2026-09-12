import { useEffect, useState } from 'react';
import { Card, GhostButton, Page, PrimaryButton, Section, Switch } from '../components/common';
import { MarketDataSettings } from '../components/terminal/MarketDataSettings';
import { HotkeySettings } from '../components/terminal/HotkeySettings';
import { useAppState } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { BotsPanel } from '../components/terminal/BotsPanel';
import { AiSettingsPanel } from '../components/terminal/AiSettingsPanel';
import { CreditMeter } from '../components/terminal/CreditMeter';
import { RpcKeyWarning } from '../components/terminal/RpcKeyWarning';
import { EvmSettingsCard } from '../components/terminal/EvmSettingsCard';
import { feePctLabel, referralProblem, TREASURY_ADDRESS, feesEnabled } from '@shared/fees';
import type { RecorderStats } from '../../electron/engine/recorder';

// Measured 2026-08-30 by replaying E:/data/2026-07-25.jsonl (a 10 GB, 18.6 h
// firehose day) through the launch filter: 9.3 % of the bytes kept, 1.2 GB/day
// vs 12.9 GB/day (15 GB on the worst day seen). See
// scripts/analysis/estimate_launchtape.mjs and recorder.ts for the source.
const FIREHOSE_GB_PER_DAY = 15;
const LAUNCH_GB_PER_DAY = 1.2;

function fmtGb(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function weekCost(gbPerDay: number): string {
  return `${(gbPerDay * 7).toFixed(gbPerDay * 7 < 10 ? 1 : 0)} GB`;
}

/** Live recorder counters: mode, bytes/hour → GB/day, kept vs dropped. */
function RecorderStatsPanel({ enabled }: { enabled: boolean }) {
  const [st, setSt] = useState<RecorderStats | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void window.krypt.recorder.stats().then((r) => {
        if (alive && r.ok && r.data) setSt(r.data);
      });
    };
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!st) return null;
  const perDay = st.bytesLastHour * 24;
  const kept = Object.values(st.keptByKind).reduce((a, b) => a + b, 0);
  const dropped = Object.values(st.droppedByKind).reduce((a, b) => a + b, 0);
  const topDropped = Object.entries(st.droppedByKind)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${k} ${n.toLocaleString()}`)
    .join(', ');
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] font-mono text-krypt-muted space-y-0.5">
      <div>
        <span className="text-white">{st.mode === 'launch' ? 'Launch tape' : 'Firehose'}</span>
        {' · '}
        {enabled && st.enabled ? 'recording' : 'idle'}
        {' · '}
        {st.files} day file{st.files === 1 ? '' : 's'} · {fmtGb(st.totalBytes)} on disk
      </div>
      <div>
        last hour {fmtGb(st.bytesLastHour)} → {st.bytesLastHour > 0 ? `~${fmtGb(perDay)}/day at this rate` : 'no writes yet'}
        {' · '}
        session {fmtGb(st.bytesSession)} / {st.recordsSession.toLocaleString()} records
      </div>
      {st.mode === 'launch' && st.launch && (
        <div>
          kept {kept.toLocaleString()} · dropped {dropped.toLocaleString()}
          {topDropped ? ` (${topDropped})` : ''}
          {' · '}
          {st.launch.mints.toLocaleString()} open windows
          {st.launch.cappedMints > 0 ? ` · ${st.launch.cappedMints} hit the 3,000-trade cap` : ''}
        </div>
      )}
      {st.bufferDropped > 0 && (
        <div className="text-amber-300">{st.bufferDropped.toLocaleString()} records lost — the disk could not keep up</div>
      )}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60"
    />
  );
}

export function SettingsPage() {
  const { settings, updateSettings, status } = useAppState();
  const toast = useToast();
  const [wss, setWss] = useState(settings.rpc.wssUrl);
  const [extraWss, setExtraWss] = useState((settings.rpc.extraWssUrls ?? []).join('\n'));
  const [heliusKey, setHeliusKey] = useState(settings.rpc.heliusApiKey ?? '');
  const [http, setHttp] = useState(settings.rpc.httpUrl);
  const [commitment, setCommitment] = useState(settings.rpc.commitment);
  const [dirInput, setDirInput] = useState(settings.recorderDir);

  const saveDir = (): void => {
    void updateSettings({ recorderDir: dirInput.trim() });
  };

  useEffect(() => {
    setWss(settings.rpc.wssUrl);
    setExtraWss((settings.rpc.extraWssUrls ?? []).join('\n'));
    setHeliusKey(settings.rpc.heliusApiKey ?? '');
    setHttp(settings.rpc.httpUrl);
    setCommitment(settings.rpc.commitment);
  }, [settings.rpc]);

  const saveRpc = (): void => {
    if (!wss.startsWith('wss://') && !wss.startsWith('ws://')) {
      toast.error('WebSocket URL must start with wss://');
      return;
    }
    const extras = extraWss
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const badExtra = extras.find((l) => !l.startsWith('wss://') && !l.startsWith('ws://'));
    if (badExtra) {
      toast.error(`Extra endpoint must start with wss:// — "${badExtra.slice(0, 40)}"`);
      return;
    }
    // Accept a bare key or a full pasted Helius URL — extract the key either way.
    let key = heliusKey.trim();
    const fromUrl = key.match(/api-key=([A-Za-z0-9-]+)/);
    if (fromUrl) key = fromUrl[1];
    if (key && !/^[A-Za-z0-9-]{8,}$/.test(key)) {
      toast.error('That does not look like a Helius API key — paste the key from your dashboard');
      return;
    }
    if (!http.startsWith('https://') && !http.startsWith('http://')) {
      toast.error('HTTP URL must start with https://');
      return;
    }
    void updateSettings({
      rpc: {
        // Preserve fields this form does not edit (block-feed standby etc.);
        // a full literal here silently reset them on every save.
        ...settings.rpc,
        wssUrl: wss.trim(),
        extraWssUrls: extras,
        heliusApiKey: key,
        heliusFeedSocket: settings.rpc.heliusFeedSocket ?? false,
        heliusMonthlyCredits: settings.rpc.heliusMonthlyCredits ?? 1_000_000,
        httpUrl: http.trim(),
        commitment,
      },
    });
  };

  return (
    <Page title="Settings" subtitle="Market data providers, RPC endpoints, recorder, presence.">
      <MarketDataSettings settings={settings} updateSettings={updateSettings} />
      <HotkeySettings settings={settings} updateSettings={updateSettings} />
      <Section
        title="Solana RPC"
        description="Works out of the box on free public endpoints. A free Helius key upgrades the calls that decide real trades; the feed itself races multiple free sockets."
      >
        <Card className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted">
                Helius API key <span className="text-krypt-purple">(recommended)</span>
              </div>
              <button
                onClick={() => void window.krypt.app.openExternal('https://dashboard.helius.dev')}
                className="text-[11px] font-semibold text-krypt-purple hover:text-white transition-colors"
              >
                Get a free key at helius.dev →
              </button>
            </div>
            <TextInput value={heliusKey} onChange={setHeliusKey} placeholder="Paste your Helius API key" />
            <RpcKeyWarning />
            <div className="text-[11px] text-krypt-muted/70 mt-1">
              Used where it matters — live trade simulation, sending, confirmation, send-time fee estimates,
              and the holder and token-account reads the free public RPC refuses outright (it answers those
              with HTTP 429). Launch scanning and plain account reads stay on the free public endpoints,
              which measured just as fast for that work. The free Helius plan allows about ten requests a
              second; the app paces itself under that. The key stays on this machine and is stripped from
              recordings.
            </div>
            <div className="mt-2">
              <CreditMeter
                limit={settings.rpc.heliusMonthlyCredits ?? 0}
                onLimit={(v) => void updateSettings({ rpc: { ...settings.rpc, heliusMonthlyCredits: v } })}
              />
              <Switch
                checked={settings.rpc.heliusFeedSocket ?? false}
                onChange={(v) => void updateSettings({ rpc: { ...settings.rpc, heliusFeedSocket: v } })}
                label="Helius feed socket"
                description="Adds the Helius websocket to the racing pool. MEASURED over 45s on the pump firehose: Helius delivered 92% of events FIRST, with the free sockets a median 150ms (mainnet-beta) and 578ms (publicnode) behind — decisive for sniping. It also costs ~800k credits/day at firehose rates, so it is a paid-plan switch, not a free-tier one."
              />
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">WebSocket (launch feed)</div>
            <TextInput value={wss} onChange={setWss} placeholder="wss://api.mainnet-beta.solana.com" />
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">
              Extra WebSocket endpoints (raced in parallel, one per line)
            </div>
            <textarea
              value={extraWss}
              onChange={(e) => setExtraWss(e.target.value)}
              placeholder={'wss://solana-rpc.publicnode.com'}
              spellCheck={false}
              rows={3}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60 resize-y"
            />
            <div className="text-[11px] text-krypt-muted/70 mt-1">
              All sockets subscribe at once; duplicates are dropped, first arrival wins. A single public socket
              silently loses ~20% of events under load — every extra free endpoint cuts that loss.
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">HTTP (account lookups)</div>
            <TextInput value={http} onChange={setHttp} placeholder="https://api.mainnet-beta.solana.com" />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-krypt-muted">Commitment</span>
              {(['processed', 'confirmed'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setCommitment(c)}
                  className={
                    commitment === c
                      ? 'rounded-lg border border-krypt-purple/50 bg-krypt-purple/15 px-3 py-1.5 text-xs font-semibold text-white'
                      : 'rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-krypt-muted hover:text-white'
                  }
                >
                  {c}
                </button>
              ))}
            </div>
            <PrimaryButton onClick={saveRpc}>Save RPC settings</PrimaryButton>
          </div>

          {/* ── the standby block feed ────────────────────────────────────
              It has been on by default since it was built and had no control
              anywhere in the app — `grep blockFeed src/` found nothing. It is
              the single largest thing this app downloads, and a user on a
              metered connection could not find it, let alone turn it off.
              The DEFAULT is unchanged; what changes is that it is now
              visible and switchable. */}
          <div className="space-y-1.5 border-t border-white/5 pt-3">
            <Switch
              checked={settings.rpc.blockFeed ?? true}
              onChange={(v) => void updateSettings({ rpc: { ...settings.rpc, blockFeed: v } })}
              label="Standby block feed"
              description={`Whole blocks over blockSubscribe, decoded from inner instructions. It loses every race while pump still emits log events and exists to take over the day those go quiet — measured 2026-09-09 at ~5.5 GB/h while scanning (~${(5.5 * 24).toFixed(0)} GB/day). Turn it off on a metered connection; nothing you do today depends on it.`}
            />
            {(settings.rpc.blockFeed ?? true) && (
              <div className="flex items-center gap-2 text-xs text-amber-300">
                <span>⚠</span> ~5.5 GB/h while the scanner runs. This is the largest thing the app downloads.
              </div>
            )}
            <Switch
              checked={settings.rpc.blockFeedAmm ?? false}
              onChange={(v) => void updateSettings({ rpc: { ...settings.rpc, blockFeedAmm: v } })}
              label="Standby block feed — post-graduation (pAMM)"
              description="The same standby for graduated tokens. Off by default because the host ignores a program filter there, so it pulls ~11 GB/h. Unmetered connections only."
            />
          </div>
          {status.running && (
            <div className="space-y-1.5 border-t border-white/5 pt-3">
              <p className="text-xs text-amber-300">Engine is running — RPC changes apply on next start.</p>
              <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted">Feed pool health</div>
              {status.feedSockets.map((s) => (
                <div key={s.url} className="flex items-center justify-between text-xs font-mono">
                  <span className="text-white/80">{s.host}</span>
                  <span
                    className={
                      s.state === 'live' ? 'text-emerald-300' : s.state === 'stopped' ? 'text-krypt-muted' : 'text-amber-300'
                    }
                  >
                    {s.state} · {s.events} events · {s.wins} first
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-white/80">estimated event loss (15m)</span>
                <span
                  className={
                    status.feedLossPct === null
                      ? 'text-krypt-muted'
                      : status.feedLossPct > 5
                        ? 'text-red-400'
                        : status.feedLossPct > 2
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                  }
                >
                  {status.feedLossPct === null ? 'measuring…' : `~${status.feedLossPct}%`}
                </span>
              </div>
            </div>
          )}
        </Card>
      </Section>

      <Section
        title="Chat bots"
        description="Telegram and Discord. Bring your own bot, pair it to your account, and query the terminal from your phone. Read-only — no command can trade."
      >
        <BotsPanel settings={settings} onSettings={(patch) => void updateSettings(patch)} />
      </Section>

      <Section
        title="AI analysis"
        description="Bring your own OpenAI or Anthropic key for an LLM second opinion on a token. Off by default; a local, on-demand feature that spends your own API credits."
      >
        <AiSettingsPanel settings={settings} onSettings={(patch) => void updateSettings(patch)} />
      </Section>

      <Section
        title="Fees and referral"
        description="What Krypt charges, and who gets credit for bringing you here."
      >
        <Card>
          <p className="text-[11px] leading-relaxed text-krypt-muted">
            {feesEnabled() ? (
              <>
                Krypt takes <span className="text-white">{feePctLabel()} of each trade</span>, both sides — about half
                what most memecoin terminals charge, where 1% is the going rate. It funds referral rewards and keeps
                Krypt in development, and is charged in the same transaction as the trade itself. The launchpad&apos;s
                own fee (about 1% per side on pump.fun) is separate and does not come to Krypt.
              </>
            ) : (
              <>This build has no fee address configured, so Krypt charges nothing on your trades.</>
            )}
          </p>
          <label className="mt-3 block text-[11px] text-krypt-muted">
            Referrer&apos;s SOL address — whoever sent you here is rewarded automatically as you trade, out of
            Krypt&apos;s share, never as an extra cost to you.
          </label>
          <input
            value={settings.referrer ?? ''}
            onChange={(e) => void updateSettings({ referrer: e.target.value })}
            spellCheck={false}
            placeholder="Nobody referred you"
            className="mt-1.5 w-full rounded bg-black/40 border border-white/15 px-3 py-2 font-mono text-[11px] text-white outline-none focus:border-krypt-purple/60"
          />
          {(() => {
            const why = referralProblem(settings.referrer ?? '', {
              ownAddresses: [],
              treasury: TREASURY_ADDRESS,
            });
            return why ? <p className="mt-1.5 text-[11px] text-rose-300">{why}</p> : null;
          })()}
        </Card>
      </Section>

      <EvmSettingsCard settings={settings} updateSettings={updateSettings} />
      <Section title="General">
        <div className="grid lg:grid-cols-2 gap-3">
          <Switch
            checked={settings.recorderEnabled}
            onChange={(v) => void updateSettings({ recorderEnabled: v })}
            label="Event recorder"
            description={`Write decoded events + decisions to JSONL day files. Off by default. On, it records the launch tape (~${LAUNCH_GB_PER_DAY} GB/day) unless Firehose is also on. Capped at ${settings.recorderMaxGb || '∞'} GB, oldest day pruned first — a ${settings.recorderMaxGb || '∞'} GB cap holds ${settings.recorderMaxGb ? `~${Math.floor(settings.recorderMaxGb / LAUNCH_GB_PER_DAY)} days of launch tape or ~${(settings.recorderMaxGb / FIREHOSE_GB_PER_DAY * 24).toFixed(0)} hours of firehose` : 'everything'}.`}
          />
          <Switch
            checked={settings.discordRpcEnabled}
            onChange={(v) => void updateSettings({ discordRpcEnabled: v })}
            label="Discord Rich Presence"
            description="Off by default. Publishes your engine state (launches watched, open positions, session PnL) to Discord and opens an outbound connection. Applies on restart."
          />
          <Switch
            checked={settings.watchOnBuy}
            onChange={(v) => void updateSettings({ watchOnBuy: v })}
            label="Watch what you buy"
            description="Pin a token to the Watchlist when you buy it by hand. Never unpins anything — selling leaves it there until you remove it."
          />
          <Switch
            checked={settings.autoStartEngine}
            onChange={(v) => void updateSettings({ autoStartEngine: v })}
            label="Auto-start engine"
            description="Begin scanning when the app opens"
          />
          <Switch
            checked={settings.shadowStratLab}
            onChange={(v) => void updateSettings({ shadowStratLab: v })}
            label="Strategy Lab"
            description="Run tandem paper strategies against the live feed (shadow-only, recorded per strategy)"
          />
          <Switch
            checked={settings.shadowMigration}
            onChange={(v) => void updateSettings({ shadowMigration: v })}
            label="Migration paper-test"
            description="Paper-trade the 5 SOL migration-block strategy on every graduation (shadow-only, per-lane records)"
          />
        </div>
      </Section>

      <Section title="Display" description="For a slow machine, or one whose graphics driver does not like the app: stutter, a blue screen mid-session, or a driver that keeps crashing.">
        <div className="grid lg:grid-cols-2 gap-3">
          <Switch
            checked={settings.reduceEffects}
            onChange={(v) => void updateSettings({ reduceEffects: v })}
            label="Lite mode (reduce effects)"
            description="Turns off every animation and transition, blur, glows and the star backdrop, and replaces the 3D observatory and vault scenes with a still — the app at its lightest. Same switch as the Hub's “Laggy?” button. Applies at once; the 3D scenes on the next visit to their page."
          />
          <Switch
            checked={settings.hardwareAcceleration}
            onChange={(v) => void updateSettings({ hardwareAcceleration: v })}
            label="Hardware acceleration"
            description="Render through the GPU. Turn it off if the graphics driver has crashed under the app or a blue screen followed a session: software rendering is slower but never touches the driver. Turns itself off after the GPU process dies twice in one run. Applies on restart."
          />
        </div>
      </Section>

      <Section title="Data collection" description="Where recordings are stored and how much of the chain we capture.">
        <Card className="space-y-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-krypt-muted mb-1.5">Store directory</div>
            <div className="flex gap-2">
              <TextInput value={dirInput} onChange={setDirInput} placeholder="Leave empty for default (userData). e.g. D:\memedata" />
              <GhostButton onClick={saveDir}>Save</GhostButton>
              <GhostButton onClick={() => void window.krypt.app.openRecordingsFolder()}>Open</GhostButton>
            </div>
            <div className="text-[11px] text-krypt-muted/70 mt-1">Point this at a big empty drive to mass-collect. Applies immediately.</div>
          </div>
          <div className="text-[11px] text-krypt-muted/80 leading-relaxed">
            <span className="text-white/80">Two modes.</span>{' '}
            <span className="text-white">Launch tape</span> (default) — every create, the first 30 minutes of each mint's trades
            (max 3,000 per mint), every graduation, metadata and feed-health rows; ~{LAUNCH_GB_PER_DAY} GB/day, a week is
            ~{weekCost(LAUNCH_GB_PER_DAY)}.{' '}
            <span className="text-white">Firehose</span> — everything, every trade of every token plus post-graduation AMM
            payloads; ~{FIREHOSE_GB_PER_DAY} GB/day, a week is ~{weekCost(FIREHOSE_GB_PER_DAY)}. Measured on a real 10 GB
            firehose day (2026-07-25): the launch filter kept 9.3 % of the bytes. Same file format either way; a day file
            says which mode wrote it.
          </div>
          <Switch
            checked={settings.recordFirehose}
            onChange={(v) => void updateSettings({ recordFirehose: v })}
            label="Firehose — record the entire Pump.fun tape"
            description={`Every trade of every token, all wallets, price ticks, AMM payloads. ~${FIREHOSE_GB_PER_DAY} GB/day (~${weekCost(FIREHOSE_GB_PER_DAY)}/week) — a ${settings.recorderMaxGb || '∞'} GB cap keeps only the last ${settings.recorderMaxGb ? `~${(settings.recorderMaxGb / FIREHOSE_GB_PER_DAY * 24).toFixed(0)} hours` : 'everything'}. Off = launch tape.`}
          />
          {settings.recordFirehose && (
            <div className="flex items-center gap-2 text-xs text-amber-300">
              <span>⚠</span> Firehose writes ~{FIREHOSE_GB_PER_DAY} GB/day. Make sure the store points at a drive with room, or raise the cap.
            </div>
          )}
          {settings.recorderEnabled && <RecorderStatsPanel enabled={settings.recorderEnabled} />}
          <Switch
            checked={settings.shadowDipBuy}
            onChange={(v) => void updateSettings({ shadowDipBuy: v })}
            label="Paper dip-buy detector"
            description="Watches for post-crash survivor bounces (the one strategy that survived the tape analysis at real latency) and records paper round-trips. Never trades — forward-testing only."
          />
        </Card>
      </Section>

      <Section title="Creator blocklist" description="Import known scam / drainer / sniper-ring addresses (one per line, or JSON array). Imported entries are hard-reject risk flags.">
        <BlocklistImporter />
      </Section>
    </Page>
  );
}

function BlocklistImporter() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const parse = (raw: string): string[] => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return arr.map(String);
      } catch {
        /* fall through to line parsing */
      }
    }
    return trimmed.split(/[\s,]+/).filter((s) => s.length >= 32);
  };

  const onImport = async (): Promise<void> => {
    const addrs = parse(text);
    if (addrs.length === 0) {
      toast.warn('No valid addresses found (need base58, ≥32 chars)');
      return;
    }
    setBusy(true);
    const r = await window.krypt.creators.importBlocklist(addrs);
    setBusy(false);
    if (r.ok) {
      toast.success(r.message);
      setText('');
    } else {
      toast.error(r.message);
    }
  };

  return (
    <Card className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Paste addresses — one per line, or a JSON array.\nSources: ScamSniffer scam-database, RED-COHORT sniper-ring catalogue.'}
        spellCheck={false}
        rows={4}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs font-mono text-white placeholder-krypt-muted/50 outline-none focus:border-krypt-purple/60 resize-y"
      />
      <div className="flex justify-end">
        <PrimaryButton onClick={onImport} disabled={busy}>{busy ? 'Importing…' : 'Import addresses'}</PrimaryButton>
      </div>
    </Card>
  );
}
