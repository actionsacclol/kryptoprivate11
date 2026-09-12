// Wallet Scout — who is actually making money on each chain.
//
// A data tool. It reports what wallets did over a window you pick, so you can
// decide whether any of them is worth following. It does not predict, and the
// page says so rather than leaving the reader to assume otherwise.
//
// Three chains, one at a time, never merged — the same isolation the
// Observatories use. Ranking and windowing happen in main; this page renders
// the answer.
//
// The left panel is the navigation: which chain, which list, and the two
// controls that fill the record — Start, which turns the live feed on, and
// Scan, which reads the last hours of trades now. Records are built from
// trades; a page about records that could neither turn the feed on nor go and
// fetch any was a page that looked broken until the feed had run for a day.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Loader2, Play, Search, Square, Trophy, Users } from 'lucide-react';
import { EVM_CHAIN_META } from '@shared/evm';
import { defaultConfig } from '@shared/copytrade';
import { useToast } from '../state/ToastProvider';
import {
  MIN_TRIPS_FOR_RANK,
  SCOUT_CHAINS,
  SCOUT_SCAN_HOURS,
  SCOUT_SCAN_HOURS_LABEL,
  SCOUT_SORT_LABEL,
  SCOUT_WINDOW_LABEL,
  type ScoutChain,
  type ScoutRow,
  type ScoutScanHours,
  type ScoutScanStatus,
  type ScoutSort,
  type ScoutWindow,
} from '@shared/walletScout';

const CHAIN_LABEL: Record<ScoutChain, string> = {
  solana: 'Solana',
  robinhood: EVM_CHAIN_META.robinhood.shortName,
  bnb: EVM_CHAIN_META.bnb.shortName,
};

const UNIT: Record<ScoutChain, string> = { solana: 'SOL', robinhood: 'ETH', bnb: 'BNB' };

const WINDOWS: ScoutWindow[] = ['day', 'week', 'month', 'all'];
const SORTS: ScoutSort[] = ['pnl', 'returnPct', 'winRatePct', 'roundTrips', 'volume'];

type Section = 'top' | 'saved';

/** Unknown is an em dash. Never 0. */
const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(1)}%`);
const amt = (v: number): string => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 1 : 4)}`;
const hold = (ms: number | null): string => {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};

/** What a finished or running scan says about itself, in one line. */
function scanLine(chain: ScoutChain, s: ScoutScanStatus | null, hours: ScoutScanHours): string {
  const unit = chain === 'solana' ? 'tokens' : 'block chunks';
  if (s?.running) {
    return `Reading ${unit}… ${s.unitsDone}/${s.units || '?'} · ${s.fed.toLocaleString()} trades recorded`;
  }
  if (s?.finishedAt) {
    const delta = s.trackedAfter - s.trackedBefore;
    return `${s.cancelled ? 'Stopped early. ' : ''}Read ${s.read.toLocaleString()} trades: ${s.fed.toLocaleString()} recorded, ${s.duplicates.toLocaleString()} already on record · ${s.calls} calls · ${delta >= 0 ? '+' : '−'}${Math.abs(delta).toLocaleString()} wallets.`;
  }
  return chain === 'solana'
    ? `Reads the last ${SCOUT_SCAN_HOURS_LABEL[hours]} of trades on the pump.fun tokens Discover is showing — up to 60 tokens, 300 trades each. Other Solana rails have no history route.`
    : `Reads the last ${SCOUT_SCAN_HOURS_LABEL[hours]} of curve trades from the chain's RPC, in block chunks. Spends nothing.`;
}

function Pill<T extends string | number>({ value, current, onPick, label }: { value: T; current: T; onPick: (v: T) => void; label: string }) {
  return (
    <button
      onClick={() => onPick(value)}
      className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
        current === value ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white' : 'border-white/10 bg-krypt-panel text-krypt-muted hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

export function Scout() {
  const toast = useToast();
  const [chain, setChain] = useState<ScoutChain>('solana');
  const [section, setSection] = useState<Section>('top');
  const [window_, setWindow] = useState<ScoutWindow>('day');
  const [sort, setSort] = useState<ScoutSort>('pnl');

  const [rows, setRows] = useState<ScoutRow[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [counts, setCounts] = useState<{ tracked: number; watching: number; cap: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Null until read — an unknown collector state must not render as "off". */
  const [collecting, setCollecting] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [hours, setHours] = useState<ScoutScanHours>(6);
  /** Null until read; the chain's last scan this session once it is. */
  const [scan, setScan] = useState<ScoutScanStatus | null>(null);
  const [scanBusy, setScanBusy] = useState(false);

  /** Is the feed this chain's records come from actually running? */
  const readCollecting = useCallback(async () => {
    if (chain === 'solana') {
      const r = await window.krypt.engine.snapshot();
      setCollecting(r.ok && r.data ? r.data.status.running : null);
      return;
    }
    const r = await window.krypt.evm.scan.status(chain);
    setCollecting(r.ok && r.data ? r.data.running : null);
  }, [chain]);

  const readScan = useCallback(async () => {
    const r = await window.krypt.scout.scanStatus(chain);
    setScan(r.ok && r.data ? r.data : null);
  }, [chain]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [top, marks] = await Promise.all([
        window.krypt.scout.top(chain, window_, sort, 50),
        window.krypt.scout.saved(chain, window_),
      ]);
      if (top.ok && top.data) {
        setCounts(top.data.counts);
        setFailure(top.data.failure);
        if (section === 'top') setRows(top.data.rows);
      }
      if (marks.ok && marks.data) {
        setSaved(marks.data.saved);
        if (section === 'saved') setRows(marks.data.rows);
      }
      await Promise.all([readCollecting(), readScan()]);
    } finally {
      setLoading(false);
    }
  }, [chain, window_, sort, section, readCollecting, readScan]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  // While a scan runs, its counters move every second; the 15 s refresh
  // above would make the progress line look stuck.
  const scanRunning = scan?.running === true;
  useEffect(() => {
    if (!scanRunning) return;
    const id = setInterval(() => void readScan(), 1_000);
    return () => clearInterval(id);
  }, [scanRunning, readScan]);

  // The moment a scan finishes, the table it fed should show what it found.
  const wasScanning = useRef(false);
  useEffect(() => {
    if (wasScanning.current && !scanRunning) void load();
    wasScanning.current = scanRunning;
  }, [scanRunning, load]);

  const startScan = useCallback(async () => {
    setScanBusy(true);
    try {
      const r = await window.krypt.scout.scan(chain, hours);
      if (r.ok && r.data) setScan(r.data);
      else toast.error(r.message);
    } finally {
      setScanBusy(false);
    }
  }, [chain, hours, toast]);

  const cancelScan = useCallback(async () => {
    const r = await window.krypt.scout.scanCancel(chain);
    if (r.ok && r.data) setScan(r.data);
  }, [chain]);

  const toggleCollect = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      if (chain === 'solana') {
        const r = collecting ? await window.krypt.engine.stop() : await window.krypt.engine.start();
        if (!r.ok) setNote(r.message);
      } else {
        const r = collecting ? await window.krypt.evm.scan.stop(chain) : await window.krypt.evm.scan.start(chain);
        if (!r.ok) setNote(r.message);
      }
      await readCollecting();
    } finally {
      setBusy(false);
    }
  }, [chain, collecting, readCollecting]);

  /**
   * Follow a wallet: create a PAPER copy config, disabled, exactly as the copy
   * page's own default does. Never live and never armed from here — the house
   * rule is that copying starts on paper, and a leaderboard is the last place
   * to make an exception to it.
   *
   * Solana only, because copy trading watches Solana wallets; the button does
   * not appear on the EVM chains rather than appearing and failing.
   */
  const follow = useCallback(
    async (address: string) => {
      const cfg = defaultConfig(address, `Scout ${address.slice(0, 4)}…${address.slice(-4)}`);
      const r = await window.krypt.copy.save(cfg);
      if (r.ok) toast.success('Added to copy trading — paper, and switched off until you arm it.');
      else toast.error(r.message);
    },
    [toast],
  );

  const toggleSave = useCallback(
    async (address: string) => {
      const on = !saved.includes(address);
      const r = await window.krypt.scout.save(chain, address, on);
      if (r.ok && Array.isArray(r.data)) setSaved(r.data);
      if (section === 'saved') void load();
    },
    [chain, saved, section, load],
  );

  return (
    <div className="flex h-full min-h-0">
      {/* ── left panel ───────────────────────────────────────────────── */}
      <aside className="w-[200px] shrink-0 border-r border-white/10 bg-krypt-panel/40 px-3 py-4">
        <div className="mb-4 flex items-center gap-2 px-1">
          <Users className="h-4 w-4 text-krypt-pink" />
          <span className="text-[13px] font-semibold text-white">Wallet Scout</span>
        </div>

        <div className="mb-1 px-1 text-[9px] uppercase tracking-[0.18em] text-krypt-muted/60">Chain</div>
        <div className="mb-4 space-y-0.5">
          {SCOUT_CHAINS.map((c) => (
            <button
              key={c}
              onClick={() => setChain(c)}
              className={`block w-full rounded-lg px-2 py-1.5 text-left text-[12px] transition ${
                chain === c ? 'bg-krypt-purple/15 text-white' : 'text-krypt-muted hover:bg-white/5 hover:text-white'
              }`}
            >
              {CHAIN_LABEL[c]}
            </button>
          ))}
        </div>

        <div className="mb-1 px-1 text-[9px] uppercase tracking-[0.18em] text-krypt-muted/60">Lists</div>
        <div className="mb-4 space-y-0.5">
          <button
            onClick={() => setSection('top')}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition ${
              section === 'top' ? 'bg-krypt-purple/15 text-white' : 'text-krypt-muted hover:bg-white/5 hover:text-white'
            }`}
          >
            <Trophy className="h-3.5 w-3.5" /> Top wallets
          </button>
          <button
            onClick={() => setSection('saved')}
            className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12px] transition ${
              section === 'saved' ? 'bg-krypt-purple/15 text-white' : 'text-krypt-muted hover:bg-white/5 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-2">
              <Bookmark className="h-3.5 w-3.5" /> Saved
            </span>
            {saved.length > 0 && <span className="rounded-full border border-white/10 bg-white/5 px-1.5 text-[10px]">{saved.length}</span>}
          </button>
        </div>

        <div className="mb-1 px-1 text-[9px] uppercase tracking-[0.18em] text-krypt-muted/60">Collecting</div>
        <button
          onClick={() => void toggleCollect()}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-krypt-panel px-2 py-1.5 text-[12px] text-white/90 transition hover:border-krypt-purple/50 disabled:opacity-50"
        >
          {collecting ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {collecting === null ? 'Unknown' : collecting ? 'Stop' : 'Start'}
        </button>
        <p className="mt-2 px-1 text-[10px] leading-relaxed text-krypt-muted">
          {collecting === null
            ? 'Could not read the collector state.'
            : collecting
              ? `Recording ${CHAIN_LABEL[chain]} trades as they arrive.`
              : `Not recording. ${chain === 'solana' ? 'This starts the engine.' : `This starts the ${CHAIN_LABEL[chain]} Observatory.`}`}
        </p>
        {note && <p className="mt-2 px-1 text-[10px] leading-relaxed text-amber-300">{note}</p>}

        <div className="mb-1 mt-4 px-1 text-[9px] uppercase tracking-[0.18em] text-krypt-muted/60">Scan</div>
        <div className="mb-2 flex gap-1">
          {SCOUT_SCAN_HOURS.map((h) => (
            <Pill key={h} value={h} current={hours} onPick={setHours} label={SCOUT_SCAN_HOURS_LABEL[h].replace(' hours', 'h').replace(' hour', 'h')} />
          ))}
        </div>
        <button
          onClick={() => void (scanRunning ? cancelScan() : startScan())}
          disabled={scanBusy}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-krypt-panel px-2 py-1.5 text-[12px] text-white/90 transition hover:border-krypt-purple/50 disabled:opacity-50"
          title={scanRunning ? 'Stop after the current step' : 'Read recent trades into the record now. Spends nothing.'}
        >
          {scanRunning ? <Square className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}
          {scanRunning ? 'Cancel scan' : 'Scan recent trades'}
        </button>
        <p className="mt-2 px-1 text-[10px] leading-relaxed text-krypt-muted">{scanLine(chain, scan, hours)}</p>
        {scan?.message && <p className="mt-1 px-1 text-[10px] leading-relaxed text-amber-300">{scan.message}</p>}

        {counts && (
          <p className="mt-4 px-1 text-[10px] leading-relaxed text-krypt-muted">
            {counts.tracked.toLocaleString()} wallet{counts.tracked === 1 ? '' : 's'} on record
            {counts.tracked >= counts.cap && ' — the cap; thin, quiet records are dropped first'}
            {counts.watching > 0 && `, ${counts.watching.toLocaleString()} more not active enough yet`}.
          </p>
        )}
      </aside>

      {/* ── table ────────────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1 overflow-auto px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-[13px] font-semibold text-white">
            {section === 'top' ? 'Top wallets' : 'Saved wallets'} · {CHAIN_LABEL[chain]}
          </h2>
          <div className="flex gap-1.5">
            {WINDOWS.map((w) => (
              <Pill key={w} value={w} current={window_} onPick={setWindow} label={SCOUT_WINDOW_LABEL[w]} />
            ))}
          </div>
          {section === 'top' && (
            <div className="flex gap-1.5">
              {SORTS.map((s) => (
                <Pill key={s} value={s} current={sort} onPick={setSort} label={SCOUT_SORT_LABEL[s]} />
              ))}
            </div>
          )}
        </div>

        {failure && (
          <p className="mb-3 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-200">
            History is read-only this session — {failure}
          </p>
        )}

        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-krypt-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading records…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 bg-krypt-panel/40 py-14 text-center">
            <p className="text-[13px] text-white/80">
              {section === 'saved' ? 'No saved wallets on this chain.' : `Nothing recorded for ${CHAIN_LABEL[chain]} in this window.`}
            </p>
            <p className="mt-1 text-[12px] text-krypt-muted">
              {section === 'saved'
                ? 'Save a wallet from Top wallets and it will be kept here — and never dropped from the records.'
                : collecting
                  ? 'Records build as trades arrive. Come back in a few minutes — or press Scan to read the last hours now.'
                  : 'Press Start on the left to record live, or Scan to read the last hours of trades now.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full min-w-[820px] text-[12px]">
              <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-krypt-muted/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Wallet</th>
                  <th className="px-3 py-2 text-right font-medium">Profit ({UNIT[chain]})</th>
                  <th className="px-3 py-2 text-right font-medium">Return</th>
                  <th className="px-3 py-2 text-right font-medium">Win rate</th>
                  <th className="px-3 py-2 text-right font-medium">Trips</th>
                  <th className="px-3 py-2 text-right font-medium">Volume</th>
                  <th className="px-3 py-2 text-right font-medium">Median hold</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isSaved = saved.includes(r.address);
                  return (
                    <tr key={r.address} className="border-t border-white/5">
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-white/90">
                          {r.address.slice(0, 6)}…{r.address.slice(-4)}
                        </span>
                        {r.looksAutomated && (
                          <span
                            className="ml-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 text-[9px] text-amber-300"
                            title="Holds for seconds and trades constantly. A bot wins on latency you do not have — copying one is not the same trade."
                          >
                            bot
                          </span>
                        )}
                        {!r.ranked && (
                          <span
                            className="ml-2 rounded-full border border-white/10 bg-white/5 px-1.5 text-[9px] text-krypt-muted"
                            title={`Fewer than ${MIN_TRIPS_FOR_RANK} closed round trips in this window — too small a sample to rank.`}
                          >
                            thin
                          </span>
                        )}
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono ${r.pnl > 0 ? 'text-emerald-300' : r.pnl < 0 ? 'text-rose-300' : ''}`}>
                        {r.roundTrips === 0 && r.buys + r.sells === 0 ? '—' : amt(r.pnl)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">{pct(r.returnPct)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{pct(r.winRatePct)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.roundTrips}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-krypt-muted">{amt(r.volume)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-krypt-muted">{hold(r.medianHoldMs)}</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => void toggleSave(r.address)}
                            className={`rounded border px-1.5 py-0.5 transition ${
                              isSaved ? 'border-krypt-purple/50 text-krypt-purple' : 'border-white/10 text-krypt-muted hover:text-white'
                            }`}
                            title={isSaved ? 'Remove from saved' : 'Save this wallet'}
                            aria-label={isSaved ? 'Remove from saved' : 'Save this wallet'}
                          >
                            {isSaved ? <BookmarkCheck className="h-3 w-3" /> : <Bookmark className="h-3 w-3" />}
                          </button>
                          {chain === 'solana' && (
                            <button
                              onClick={() => void follow(r.address)}
                              className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-krypt-muted transition hover:text-white"
                              title="Add to copy trading — paper, and switched off until you arm it"
                            >
                              Follow
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 space-y-1 text-[11px] leading-relaxed text-krypt-muted">
          <p>
            Every number here is something that happened. Nothing on this page says a wallet will keep winning — ranking traders by
            past profit picks up luck as readily as skill, and this app has measured that twice before. A wallet with fewer than{' '}
            {MIN_TRIPS_FOR_RANK} closed round trips in the window is marked <span className="text-white/80">thin</span> and is not
            ranked.
          </p>
          <p>
            Profit is realised only: it pairs sells against buys we watched. A sell with no buy behind it is counted but never
            priced, and open positions are not valued — so a wallet holding a large winner will look worse here than it is.
          </p>
        </div>
      </div>
    </div>
  );
}
