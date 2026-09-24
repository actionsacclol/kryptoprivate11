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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Check, Loader2, Play, Plus, Search, SlidersHorizontal, Square, Trash2, Trophy, Users } from 'lucide-react';
import { EVM_CHAIN_META } from '@shared/evm';
import { defaultConfig } from '@shared/copytrade';
import { useToast } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';
import { FLAG_TEXT, WalletDrawer } from '../components/WalletDrawer';
import { scoreTone } from '@shared/walletScore';
import {
  MIN_TRIPS_FOR_RANK,
  SCOUT_CHAINS,
  SCOUT_SCAN_HOURS,
  SCOUT_SCAN_HOURS_LABEL,
  SOLANA_SCAN_GAP_MS,
  SOLANA_SCAN_MAX_PAGES,
  SOLANA_SCAN_MAX_TOKENS,
  SCOUT_SORTS,
  SCOUT_SORT_LABEL,
  SCOUT_WINDOW_LABEL,
  SCOUT_FILTERS,
  SCOUT_FILTER_TEXT,
  applyScoutFilters,
  anyScoutFilter,
  scoutFiltersAllOff,
  scoutFiltersAllOn,
  type ScoutChain,
  type ScoutFilter,
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
const SORTS: ScoutSort[] = SCOUT_SORTS;

/** The Copy score as a chip. Null is a dash, never a colour. */
function ScoreChip({ score }: { score: number | null }) {
  const tone = scoreTone(score);
  return (
    <span
      className={`inline-flex min-w-[2.25rem] justify-center rounded-md border px-1.5 py-0.5 font-mono text-label ${
        tone === 'good'
          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
          : tone === 'mid'
            ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
            : tone === 'bad'
              ? 'border-rose-400/30 bg-rose-400/10 text-rose-300'
              : 'border-white/10 bg-white/5 text-krypt-muted'
      }`}
      title={score === null ? `No score: fewer than ${MIN_TRIPS_FOR_RANK} closed trips, or too few checks measured.` : 'Copy score — how a copier would have done, not how they did. Click the row for the checks.'}
    >
      {score === null ? '—' : score}
    </span>
  );
}

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
    ? `Reads the last ${SCOUT_SCAN_HOURS_LABEL[hours]} of trades on the pump.fun tokens Discover is showing — up to ${SOLANA_SCAN_MAX_TOKENS} tokens, ${SOLANA_SCAN_MAX_PAGES * 100} trades each, one request every ${SOLANA_SCAN_GAP_MS / 1000} s because pump.fun blocks faster readers for half a minute. Usually about two minutes. Other Solana rails have no history route.`
    : `Reads the last ${SCOUT_SCAN_HOURS_LABEL[hours]} of curve trades from the chain's RPC, in block chunks. Spends nothing.`;
}

// Every control on this page is at least 34 px tall and carries a word, not
// an icon on its own. The page is where a beginner starts, and the previous
// sizes (py-0.5 row buttons with 12 px icons, py-1 pills) were built for
// someone who already knew what each one did.
function Pill<T extends string | number>({ value, current, onPick, label, size = 'md' }: { value: T; current: T; onPick: (v: T) => void; label: string; size?: 'md' | 'lg' }) {
  return (
    <button
      onClick={() => onPick(value)}
      className={`rounded-lg border font-medium transition ${size === 'lg' ? 'flex-1 px-3 py-2.5 text-note' : 'px-3 py-2 text-note'} ${
        current === value ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white' : 'border-white/10 bg-krypt-panel text-krypt-muted hover:border-white/20 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

/** One filter switch: a tick when it is on, and the reason in its tooltip. */
function FilterChip({ on, label, why, onToggle }: { on: boolean; label: string; why: string; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={why}
      aria-pressed={on}
      data-testid="scout-filter"
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-note font-medium transition ${
        on ? 'border-krypt-purple/60 bg-krypt-purple/15 text-white' : 'border-white/10 bg-krypt-panel text-krypt-muted hover:border-white/20 hover:text-white'
      }`}
    >
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'border-krypt-purple/60 bg-krypt-purple/30' : 'border-white/15'}`}>
        {on && <Check className="h-3 w-3" />}
      </span>
      {label}
    </button>
  );
}

export function Scout() {
  const toast = useToast();
  const modal = useModal();
  const [chain, setChain] = useState<ScoutChain>('solana');
  const [section, setSection] = useState<Section>('top');
  const [window_, setWindow] = useState<ScoutWindow>('week');
  const [sort, setSort] = useState<ScoutSort>('copyScore');
  /** The wallet open in the drawer. */
  const [detail, setDetail] = useState<string | null>(null);
  /** Which rows the board hides (2026-09-21). All off: the board shows what
   *  was recorded until the user says otherwise, and the count line says how
   *  many are hidden. */
  const [filters, setFilters] = useState(scoutFiltersAllOff);
  const filtersOn = anyScoutFilter(filters);
  const toggleFilter = (k: ScoutFilter): void => setFilters((p) => ({ ...p, [k]: !p[k] }));
  /** A pasted address to open cold (2026-09-21) — its record if any, else an empty one the drawer can fill from the chain. */
  const [lookup, setLookup] = useState('');
  const lookupValid = chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(lookup.trim()) : /^0x[0-9a-fA-F]{40}$/.test(lookup.trim());
  const openLookup = (): void => {
    const a = lookup.trim();
    if (!lookupValid) {
      toast.error(chain === 'solana' ? 'Enter a valid Solana wallet address' : 'Enter a valid 0x address');
      return;
    }
    setDetail(chain === 'solana' ? a : a.toLowerCase());
  };

  /** Every row the record returned, before the switches above hide any. */
  const [allRows, setAllRows] = useState<ScoutRow[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [counts, setCounts] = useState<{ tracked: number; watching: number; cap: number } | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  /** Wallets already on the Copy Trading page, so Follow can say so. */
  const [followed, setFollowed] = useState<string[]>([]);
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

  // Which of these are already on the Copy Trading page. Read once and after a
  // follow, because it changes only when the user acts.
  const readFollowed = useCallback(async () => {
    const r = await window.krypt.copy.list();
    if (r.ok && r.data) setFollowed(r.data.configs.map((c) => c.wallet));
  }, []);
  useEffect(() => {
    void readFollowed();
  }, [readFollowed]);

  const copyAddress = useCallback(
    async (address: string) => {
      try {
        await navigator.clipboard.writeText(address);
        toast.success('Address copied');
      } catch {
        toast.error('Could not reach the clipboard');
      }
    },
    [toast],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [top, marks] = await Promise.all([
        // The handler ceiling, not fifty. The board hides rows AFTER ranking
        // (applyScoutFilters below), so a short list plus a filter is a screen
        // that looks empty while the record is not. Ranking runs over every
        // wallet either way - the limit only decides how much comes back.
        window.krypt.scout.top(chain, window_, sort, 200),
        window.krypt.scout.saved(chain, window_),
      ]);
      if (top.ok && top.data) {
        setCounts(top.data.counts);
        setFailure(top.data.failure);
        if (section === 'top') setAllRows(top.data.rows);
      }
      if (marks.ok && marks.data) {
        setSaved(marks.data.saved);
        if (section === 'saved') setAllRows(marks.data.rows);
      }
      await Promise.all([readCollecting(), readScan()]);
    } finally {
      setLoading(false);
    }
  }, [chain, window_, sort, section, readCollecting, readScan]);

  // What the table actually shows: ranked in main, hidden here. Filtering in
  // the renderer keeps every switch instant and leaves the record untouched —
  // nothing about what was RECORDED changes when a box is ticked.
  const rows = useMemo(() => applyScoutFilters(allRows, filters), [allRows, filters]);
  const hidden = allRows.length - rows.length;

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
    async (address: string, direction: 'copy' | 'reverse' = 'copy') => {
      const cfg = defaultConfig(address, `Scout ${address.slice(0, 4)}…${address.slice(-4)}`, 'solana', direction);
      const r = await window.krypt.copy.save(cfg);
      if (r.ok) {
        toast.success(direction === 'reverse' ? 'Added as a REVERSE copy — paper, and switched off until you arm it.' : 'Added to copy trading — paper, and switched off until you arm it.');
        // The row says "Following" from here on; a toast that fades was the
        // only feedback before, which read as the button doing nothing.
        void readFollowed();
      } else toast.error(r.message);
    },
    [toast, readFollowed],
  );

  const clearTracked = useCallback(async () => {
    const yes = await modal.confirm({
      title: 'Clear tracked wallets',
      message: `Forget every wallet ${CHAIN_LABEL[chain]} has on record? Saved wallets are kept, and the scanner starts finding new ones from the next trade it sees.`,
      confirmLabel: 'Clear them',
      destructive: true,
    });
    if (!yes) return;
    setClearBusy(true);
    const r = await window.krypt.scout.clear(chain);
    setClearBusy(false);
    if (r.ok) {
      toast.success(r.message);
      // `load()` re-reads the rows AND the counts together.
      void load();
    } else toast.error(r.message);
  }, [chain, modal, toast, load]);

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
      <aside data-testid="scout-panel" className="w-[248px] shrink-0 overflow-y-auto border-r border-white/10 bg-krypt-panel/40 px-3 py-4">
        <div className="mb-4 flex items-center gap-2 px-1">
          <Users className="h-4 w-4 text-krypt-pink" />
          <span className="text-value font-semibold text-white">Wallet Scout</span>
        </div>

        <div className="mb-1 px-1 text-micro uppercase tracking-label text-krypt-muted/60">Chain</div>
        <div className="mb-4 space-y-0.5">
          {SCOUT_CHAINS.map((c) => (
            <button
              key={c}
              onClick={() => setChain(c)}
              className={`block w-full rounded-lg border px-3 py-2.5 text-left text-note font-medium transition ${
                chain === c ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-transparent text-krypt-muted hover:bg-white/5 hover:text-white'
              }`}
            >
              {CHAIN_LABEL[c]}
            </button>
          ))}
        </div>

        <div className="mb-1 px-1 text-micro uppercase tracking-label text-krypt-muted/60">Lists</div>
        <div className="mb-4 space-y-1">
          <button
            onClick={() => setSection('top')}
            className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-note font-medium transition ${
              section === 'top' ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-transparent text-krypt-muted hover:bg-white/5 hover:text-white'
            }`}
          >
            <Trophy className="h-4 w-4 shrink-0" /> Top wallets
          </button>
          <button
            onClick={() => setSection('saved')}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-note font-medium transition ${
              section === 'saved' ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-transparent text-krypt-muted hover:bg-white/5 hover:text-white'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Bookmark className="h-4 w-4 shrink-0" /> Saved
            </span>
            {saved.length > 0 && <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-label">{saved.length}</span>}
          </button>
        </div>

        <div className="mb-1 px-1 text-micro uppercase tracking-label text-krypt-muted/60">Collecting</div>
        <button
          onClick={() => void toggleCollect()}
          disabled={busy}
          className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-3 text-note font-semibold transition disabled:opacity-50 ${
            collecting ? 'border-white/15 bg-krypt-panel text-white/90 hover:border-rose-400/40' : 'border-krypt-purple/60 bg-krypt-purple/20 text-white hover:bg-krypt-purple/30'
          }`}
        >
          {collecting ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {collecting === null ? 'Unknown' : collecting ? 'Stop recording' : 'Record live'}
        </button>
        <p className="mt-2 px-1 text-label leading-relaxed text-krypt-muted">
          {collecting === null
            ? 'Could not read the collector state.'
            : collecting
              ? `Recording ${CHAIN_LABEL[chain]} trades as they arrive.`
              : `Not recording. ${chain === 'solana' ? 'This starts the engine.' : `This starts the ${CHAIN_LABEL[chain]} Observatory.`}`}
        </p>
        {note && <p className="mt-2 px-1 text-label leading-relaxed text-amber-300">{note}</p>}

        <div className="mb-1 mt-4 px-1 text-micro uppercase tracking-label text-krypt-muted/60">Look up a wallet</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            openLookup();
          }}
          className="flex gap-2"
        >
          <input
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="Paste an address"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-note text-white outline-none focus:border-krypt-purple/50"
            data-testid="scout-lookup"
          />
          <button
            type="submit"
            disabled={!lookup.trim()}
            className="rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-note font-semibold text-white transition hover:bg-white/10 disabled:opacity-40"
          >
            Open
          </button>
        </form>
        <p className="mt-1 px-1 text-nano leading-relaxed text-krypt-muted">
          Opens its record — or an empty one{chain === 'solana' ? ' you can fill from the chain' : ''}.
        </p>

        {/* The scan is the button that fills an empty page, and it was the
            smallest thing on it. It is now a card: a real heading, hour pills
            that fill the width, a 44 px button, and — since it runs for about
            two minutes — a bar, because a number that creeps looks stuck and a
            bar that moves does not. */}
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Search className="h-4 w-4 text-krypt-purple" />
            <span className="text-note font-semibold text-white">Scan the past</span>
          </div>
          <div className="mb-2 flex gap-1.5">
            {SCOUT_SCAN_HOURS.map((h) => (
              <Pill key={h} value={h} current={hours} onPick={setHours} size="lg" label={SCOUT_SCAN_HOURS_LABEL[h].replace(' hours', 'h').replace(' hour', 'h')} />
            ))}
          </div>
          <button
            onClick={() => void (scanRunning ? cancelScan() : startScan())}
            disabled={scanBusy}
            data-testid="scout-scan"
            className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-3 text-note font-semibold transition disabled:opacity-50 ${
              scanRunning ? 'border-white/15 bg-krypt-panel text-white/90 hover:border-rose-400/40' : 'border-krypt-purple/60 bg-krypt-purple/20 text-white hover:bg-krypt-purple/30'
            }`}
            title={scanRunning ? 'Stop after the current step' : 'Read recent trades into the record now. Spends nothing.'}
          >
            {scanRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {scanRunning ? 'Stop the scan' : `Scan the last ${SCOUT_SCAN_HOURS_LABEL[hours]}`}
          </button>
          {scanRunning && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10" title="How far through the scan is">
              <div
                className="h-full rounded-full bg-krypt-purple transition-[width] duration-500"
                // No total yet means no claim about progress: an indeterminate
                // sliver, not a bar at 100 % that has done nothing.
                style={{ width: scan && scan.units > 0 ? `${Math.min(100, Math.round((scan.unitsDone / scan.units) * 100))}%` : '8%' }}
              />
            </div>
          )}
          <p className="mt-2 text-label leading-relaxed text-krypt-muted">{scanLine(chain, scan, hours)}</p>
          {scan?.message && <p className="mt-1 text-label leading-relaxed text-amber-300">{scan.message}</p>}
        </div>

        {counts && (
          <p className="mt-4 px-1 text-label leading-relaxed text-krypt-muted">
            {counts.tracked.toLocaleString()} wallet{counts.tracked === 1 ? '' : 's'} on record
            {counts.tracked >= counts.cap && ' — the cap; thin, quiet records are dropped first'}
            {counts.watching > 0 && `, ${counts.watching.toLocaleString()} more not active enough yet`}.
          </p>
        )}

        {/* The record only ever GROWS — the live feed and every scan add to it —
            so starting a fresh hunt meant deleting a file by hand. Saved wallets
            survive: saving is the one mark on this page the user put there. */}
        {counts && counts.tracked > 0 && (
          <button
            onClick={() => void clearTracked()}
            disabled={clearBusy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2.5 text-label font-medium text-krypt-muted transition hover:border-rose-400/40 hover:text-rose-200 disabled:opacity-50"
            title="Forget every tracked wallet on this chain and start the hunt over. Saved wallets are kept."
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear tracked wallets
          </button>
        )}
      </aside>

      {/* ── table ────────────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1 overflow-auto px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-value font-semibold text-white">
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

        {/* Filters (2026-09-21). Sorting cannot remove a three-trade record or
            a bot that was out in six seconds; only a filter can. One button
            turns on the five that matter, each chip explains itself, and the
            line underneath always says how many rows are hidden — a board that
            silently drops most of its rows is worse than one that never
            filtered. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setFilters(filtersOn ? scoutFiltersAllOff() : scoutFiltersAllOn())}
            data-testid="scout-worth-a-look"
            title="Turns on all five filters below: no bots, enough finished trades, trips a copier could have been inside, holds over a minute, and active on several days."
            className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-note font-semibold transition ${
              filtersOn ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-krypt-purple/40 bg-krypt-purple/10 text-white hover:bg-krypt-purple/20'
            }`}
          >
            <SlidersHorizontal className="h-4 w-4" />
            {filtersOn ? 'Show everything' : 'Only the ones worth a look'}
          </button>
          {SCOUT_FILTERS.map((k) => (
            <FilterChip key={k} on={filters[k]} label={SCOUT_FILTER_TEXT[k].label} why={SCOUT_FILTER_TEXT[k].why} onToggle={() => toggleFilter(k)} />
          ))}
        </div>
        {filtersOn && (
          <p className="mb-3 text-note text-krypt-muted">
            Showing <span className="text-white/90">{rows.length}</span> of {allRows.length} wallet{allRows.length === 1 ? '' : 's'} on record in this window.{' '}
            {hidden > 0 && `${hidden} hidden by the switches above.`} A wallet whose hold or reachable share was never measured is never hidden.
          </p>
        )}

        {failure && (
          <p className="mb-3 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-note text-amber-200">
            History is read-only this session — {failure}
          </p>
        )}

        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-note text-krypt-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading records…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 bg-krypt-panel/40 py-14 text-center">
            {/* Filtered everything away is a different problem from an empty
                record, and telling the user to go and scan when they have
                3,000 wallets and five switches on would be nonsense. */}
            <p className="text-value text-white/80">
              {allRows.length > 0
                ? `No wallet here passes all ${SCOUT_FILTERS.filter((k) => filters[k]).length} of your switches.`
                : section === 'saved'
                  ? 'No saved wallets on this chain.'
                  : `Nothing recorded for ${CHAIN_LABEL[chain]} in this window.`}
            </p>
            <p className="mt-1 text-note text-krypt-muted">
              {allRows.length > 0
                ? `${allRows.length} wallet${allRows.length === 1 ? ' is' : 's are'} on record in this window. Turn a switch off, or widen the window.`
                : section === 'saved'
                  ? 'Save a wallet from Top wallets and it will be kept here — and never dropped from the records.'
                  : collecting
                    ? 'Records build as trades arrive. Come back in a few minutes — or press Scan to read the last hours now.'
                    : 'Press Record live on the left, or Scan to read the last hours of trades now.'}
            </p>
            {allRows.length > 0 && (
              <button onClick={() => setFilters(scoutFiltersAllOff())} className="mt-3 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-note font-medium text-white transition hover:bg-white/10">
                Show everything
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full min-w-[900px] text-note">
              <thead className="bg-white/[0.03] text-label uppercase tracking-wider text-krypt-muted/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Wallet</th>
                  <th className="px-3 py-2 text-center font-medium" title="How a copier would have done mirroring this wallet — not how they did. Click a row for the checks.">
                    Copy score
                  </th>
                  <th className="px-3 py-2 text-right font-medium" title="Median net return per copied trip, both legs filled 2 s after theirs, costs on both sides.">
                    Copy / trip
                  </th>
                  <th className="px-3 py-2 text-right font-medium" title="Trips a copy could have been inside — the rest were over before a follower could land, or had nothing to fill at.">
                    Reachable
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Their profit ({UNIT[chain]})</th>
                  <th className="px-3 py-2 text-right font-medium">Their win rate</th>
                  <th className="px-3 py-2 text-right font-medium">Trips</th>
                  <th className="px-3 py-2 text-right font-medium">Median hold</th>
                  {/* Pinned to the right edge. The board is nine columns wide
                      and the panel is not, so Save and Follow — the two things
                      anyone actually does from this table — used to sit off
                      screen behind a horizontal scrollbar nobody found. */}
                  <th className="sticky right-0 border-l border-white/10 bg-krypt-panel px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isSaved = saved.includes(r.address);
                  return (
                    <tr
                      key={r.address}
                      className="cursor-pointer border-t border-white/5 transition hover:bg-white/[0.03]"
                      onClick={() => setDetail(r.address)}
                      data-testid="scout-row"
                    >
                      <td className="px-3 py-1.5">
                        <span className="font-mono text-white/90">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void copyAddress(r.address);
                            }}
                            className="-mx-1.5 rounded-md px-1.5 py-1.5 font-mono transition hover:bg-white/5 hover:text-krypt-purple"
                            // The full address in the tooltip as well as on the
                            // clipboard: a truncated string with no way to read
                            // or copy it is a wallet you cannot look up anywhere.
                            title={`${r.address} — click to copy`}
                          >
                            {r.address.slice(0, 6)}…{r.address.slice(-4)}
                          </button>
                        </span>
                        {r.looksAutomated && (
                          <span
                            className="ml-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 text-micro text-amber-300"
                            title="Holds for seconds and trades constantly. A bot wins on latency you do not have — copying one is not the same trade."
                          >
                            bot
                          </span>
                        )}
                        {!r.ranked && (
                          <span
                            className="ml-2 rounded-full border border-white/10 bg-white/5 px-1.5 text-micro text-krypt-muted"
                            title={`Fewer than ${MIN_TRIPS_FOR_RANK} closed round trips in this window — too small a sample to rank.`}
                          >
                            thin
                          </span>
                        )}
                        {r.flags
                          .filter((f) => f === 'concentrated' || f === 'partial' || f === 'unreachable')
                          .map((f) => (
                            <span
                              key={f}
                              className={`ml-2 rounded-full border px-1.5 text-micro ${f === 'unreachable' ? 'border-amber-400/30 bg-amber-400/10 text-amber-300' : 'border-white/10 bg-white/5 text-krypt-muted'}`}
                              title={FLAG_TEXT[f].title}
                            >
                              {FLAG_TEXT[f].label}
                            </span>
                          ))}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <ScoreChip score={r.copyScore} />
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono ${r.fMedianReturnPct === null ? 'text-krypt-muted' : r.fMedianReturnPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {pct(r.fMedianReturnPct)}
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono ${r.reachablePct !== null && r.reachablePct < 25 ? 'text-amber-300' : 'text-krypt-muted'}`}>
                        {r.reachablePct === null ? '—' : `${r.fTrips}/${r.judgedTrips}`}
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono ${r.pnl > 0 ? 'text-emerald-300' : r.pnl < 0 ? 'text-rose-300' : ''}`}>
                        {r.roundTrips === 0 && r.buys + r.sells === 0 ? '—' : amt(r.pnl)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">{pct(r.winRatePct)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{r.roundTrips}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-krypt-muted">{hold(r.medianHoldMs)}</td>
                      <td className="sticky right-0 border-l border-white/10 bg-krypt-panel px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                        {/* These were a 12 px icon in a 2 px box. They are the
                            two things a user does from this table, so they are
                            34 px tall, they say what they do, and they stay on
                            screen however far the table scrolls. */}
                        <span className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => void toggleSave(r.address)}
                            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-label font-medium transition ${
                              isSaved ? 'border-krypt-purple/50 bg-krypt-purple/10 text-krypt-purple' : 'border-white/10 bg-white/5 text-krypt-muted hover:border-white/20 hover:text-white'
                            }`}
                            title={isSaved ? 'Remove from saved — it can be dropped from the records again' : 'Keep this wallet. Saved wallets are never dropped when the record is full.'}
                            aria-label={isSaved ? 'Remove from saved' : 'Save this wallet'}
                          >
                            {isSaved ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
                            {isSaved ? 'Saved' : 'Save'}
                          </button>
                          {chain === 'solana' &&
                            // Following left no mark on the row, so the button
                            // looked like it had done nothing — it had quietly
                            // added a paper config and said so in a toast that
                            // was gone a moment later.
                            (followed.includes(r.address) ? (
                              <span
                                className="flex items-center gap-1.5 rounded-lg border border-krypt-purple/40 bg-krypt-purple/10 px-3 py-2 text-label font-medium text-krypt-purple"
                                title="Already on the Copy Trading page — paper, and switched off until you arm it"
                              >
                                <Check className="h-4 w-4" /> Following
                              </span>
                            ) : (
                              <button
                                onClick={() => void follow(r.address)}
                                className="flex items-center gap-1.5 rounded-lg border border-krypt-purple/50 bg-krypt-purple/10 px-3 py-2 text-label font-medium text-white transition hover:bg-krypt-purple/20"
                                title="Add to copy trading on PAPER — nothing is bought, and it stays switched off until you arm it yourself"
                              >
                                <Plus className="h-4 w-4" /> Follow
                              </button>
                            ))}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 space-y-1 text-body leading-relaxed text-krypt-muted">
          <p>
            <span className="text-white/80">Copy score</span> is how a copier would have done mirroring the wallet — filling 2 s after each of
            their trades, on both legs, paying costs on both — not how the wallet did. Measured across 9.3 million trades, ranking by
            what a follower realises beats ranking by the wallet's own profit at every level, and still no group of wallets was
            profitable to copy: the best lost a little per trade. The score ranks least-bad to follow. It is not an edge.
          </p>
          <p>
            Every number here is something that happened. Nothing on this page says a wallet will keep winning — ranking traders by
            past profit picks up luck as readily as skill, and this app has measured that twice before. A wallet with fewer than{' '}
            {MIN_TRIPS_FOR_RANK} closed round trips in the window is marked <span className="text-white/80">thin</span> and is not
            ranked. Click a row for the checks behind its score and its recent trips.
          </p>
          <p>
            Profit is realised only: it pairs sells against buys we watched. A sell with no buy behind it is counted but never
            priced, and open positions are not valued — so a wallet holding a large winner will look worse here than it is.
          </p>
        </div>
      </div>

      <WalletDrawer
        chain={chain}
        address={detail}
        window={window_}
        row={detail ? allRows.find((r) => r.address === detail) ?? null : null}
        saved={detail ? saved.includes(detail) : false}
        following={detail ? followed.includes(detail) : false}
        onClose={() => setDetail(null)}
        onToggleSave={(a) => void toggleSave(a)}
        onFollow={(a, direction) => void follow(a, direction)}
        onCopyAddress={(a) => void copyAddress(a)}
      />
    </div>
  );
}
