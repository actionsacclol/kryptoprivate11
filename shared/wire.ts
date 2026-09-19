// The Wire — what the information hub shows, and the rules it shows it under.
//
// ─── Why there is no news feed in here ───────────────────────────────────
//
// Researched 2026-09-19 before a line was written. Two findings, independent
// of each other, pointed the same way:
//
//   1. NOBODY SHIPS ONE. Not Axiom, GMGN, Photon, Birdeye, DexScreener, fomo
//      or Trojan. And no study could be found showing macro headlines move
//      sub-$1M memecoins; the research points the other way, with spillovers
//      running FROM memecoins TO large caps. The news that matters to this
//      audience is token-local.
//   2. THE LICENCES FORBID IT ANYWAY. The Block's terms: "you may not share
//      that feed or use it in any application other than an RSS feed reader."
//      CoinDesk: "personal, informational, and non-commercial purposes only."
//      Cointelegraph bans "creation of independent content pipelines". Several
//      others could not be verified at all, which is not the same as permitted.
//      EU DSM Art.15 can make a commercial aggregator owe press publishers a
//      licence for headline snippets.
//
// So this hub carries facts the app can stand behind: the state of the rails
// it trades on, and who is paying for placement. Both are things nobody else
// shows, which is the only reason worth adding a tab.
//
// ─── The presentation rules ──────────────────────────────────────────────
//
// Same family as the em-dash rule. Every row names its source. Nothing is
// re-ranked by engagement. Anything paid for is labelled as paid at the same
// visual weight as the thing it is selling. No app-generated sentiment score
// ever, because a number we invented about someone else's coin is the exact
// failure this codebase spends its comments preventing.

import type { ProviderStatus } from './market';

// ── Rail and venue health ────────────────────────────────────────────

/**
 * How a rail is doing, in the only three states worth a colour.
 *
 * `degraded` is the honest middle: working, but not the way it should be —
 * a parked provider, a stale feed, a scanner that stopped. It exists because
 * the alternative is calling a half-broken rail "up", which is the lie this
 * panel is built to prevent.
 */
export type RailState = 'ok' | 'degraded' | 'down' | 'unknown';

export interface RailRow {
  id: string;
  /** What it is, in the user's terms — not the module name. */
  label: string;
  state: RailState;
  /** One line. Says what is wrong, or what "fine" means here. */
  detail: string;
  /** Host or subsystem this is about, shown verbatim. */
  source: string;
  /** When the underlying reading was taken. Null = never read. */
  at: number | null;
}

/** Order matters: this is the order someone debugging a failed trade would
 *  ask the questions in. Execution first, then data, then the extras. */
const RAIL_ORDER = ['engine', 'providers'] as const;

/**
 * Turn the engine's status into the row a trader wants when a trade failed.
 *
 * `pauseReason` is the engine's own sentence when it has one — it is already
 * plain language ("Feed is not live", "Feed data is stale", a breaker name),
 * so it is passed through rather than re-worded. Re-wording it would create
 * two descriptions of one state that could drift apart.
 */
export function engineRail(
  status: { running: boolean; feed: string; slot: number; eventsPerSec: number; decodeLatencyMs: number } | null,
  pauseReason: string | null,
  at: number | null,
): RailRow {
  if (!status) {
    return { id: 'engine', label: 'Scanner', state: 'unknown', detail: 'Not read yet.', source: 'engine', at: null };
  }
  if (!status.running) {
    return {
      id: 'engine',
      label: 'Scanner',
      state: 'down',
      detail: 'Stopped. Manual trading still works; nothing is being watched.',
      source: 'engine',
      at,
    };
  }
  if (pauseReason) {
    return { id: 'engine', label: 'Scanner', state: 'degraded', detail: pauseReason, source: 'engine', at };
  }
  if (status.feed !== 'live') {
    return { id: 'engine', label: 'Scanner', state: 'degraded', detail: `Feed is ${status.feed}.`, source: 'engine', at };
  }
  return {
    id: 'engine',
    label: 'Scanner',
    state: 'ok',
    detail: `Live at slot ${status.slot.toLocaleString()} · ${status.eventsPerSec.toFixed(1)} events/s · ${Math.round(status.decodeLatencyMs)} ms decode.`,
    source: 'engine',
    at,
  };
}

/**
 * One row per market-data provider, from telemetry the app already keeps.
 *
 * A PARKED provider is the case this exists for: the app carries on, quietly
 * missing a source, and the only symptom a user sees is a number that stopped
 * moving. A spent ALLOWANCE is called out separately from a rate-limit park,
 * because waiting will not fix the first one.
 */
export function providerRails(providers: ProviderStatus[], at: number | null): RailRow[] {
  return providers
    .filter((p) => p.enabled)
    .map((p) => {
      const base = { id: `provider:${p.id}`, label: p.label, source: p.host, at };
      if (!p.usable) {
        return { ...base, state: 'down' as RailState, detail: 'Switched on, but it has no key to use.' };
      }
      if (p.cooldownMs > 0) {
        const secs = Math.ceil(p.cooldownMs / 1000);
        return {
          ...base,
          state: 'degraded' as RailState,
          detail: p.cooldownIsQuota
            ? `Allowance spent — parked ${secs}s. Waiting will not clear this; it needs a new billing window or a key.`
            : `Rate-limited — parked ${secs}s.`,
        };
      }
      if (p.lastError && p.errors > 0) {
        return { ...base, state: 'degraded' as RailState, detail: `${p.errors} error(s) this session. Last: ${p.lastError}` };
      }
      if (p.calls === 0) {
        return { ...base, state: 'unknown' as RailState, detail: 'Enabled, not called yet this session.' };
      }
      const lat = p.latencyMs === null ? '—' : `${Math.round(p.latencyMs)} ms`;
      // Headroom, when the app keeps a budget for this host. Shown as spent
      // over cap rather than a percentage: "44/50 this minute" tells you both
      // how close you are and what the ceiling actually is, and a provider
      // held by its gap alone simply has no such number to show.
      const budget =
        typeof p.minuteUsed === 'number' && typeof p.minuteCap === 'number'
          ? `, ${p.minuteUsed}/${p.minuteCap} this minute`
          : '';
      return {
        ...base,
        state: 'ok' as RailState,
        detail: `${p.calls} call(s), ${lat} median${budget}${p.queued > 0 ? `, ${p.queued} queued` : ''}.`,
      };
    })
    .sort((a, b) => severity(b.state) - severity(a.state) || a.label.localeCompare(b.label));
}

/** Worst first. Someone opens this panel because something is wrong. */
function severity(s: RailState): number {
  return s === 'down' ? 3 : s === 'degraded' ? 2 : s === 'unknown' ? 1 : 0;
}

export function worstState(rows: RailRow[]): RailState {
  return rows.reduce<RailState>((worst, r) => (severity(r.state) > severity(worst) ? r.state : worst), 'ok');
}

export { RAIL_ORDER };

// ── Paid placement ───────────────────────────────────────────────────

/**
 * A token someone is paying to promote.
 *
 * DexScreener sells "Boosts" — reported at roughly $3,999 for 24 hours, and
 * widely alleged to front-run exits, with prices commonly falling when the
 * boost ends. DexScreener's own FAQ says trending "is not for sale".
 *
 * The numbers are public on a keyless endpoint, so this app simply says out
 * loud what was bought. That is the whole feature: not a warning, not a score,
 * just the fact, attributed, next to the coin it was spent on.
 */
export interface BoostedToken {
  chainId: string;
  tokenAddress: string;
  /** Boosts bought in the most recent purchase. */
  amount: number | null;
  /** Boosts active in total. */
  totalAmount: number | null;
  description: string | null;
  icon: string | null;
  /** DexScreener's own page for the token — where the boost was bought. */
  url: string | null;
  links: Array<{ type: string | null; label: string | null; url: string }>;
}

/** A freshly-filled token profile: socials, and whether it is a CTO. */
export interface TokenProfile extends Omit<BoostedToken, 'amount' | 'totalAmount'> {
  /** Community takeover — the original dev is gone and holders took it over. */
  cto: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 300): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

/** Only the link types worth rendering, and only over https. A token's links
 *  are attacker-controlled text; anything else is dropped rather than shown. */
function links(v: unknown): Array<{ type: string | null; label: string | null; url: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ type: string | null; label: string | null; url: string }> = [];
  for (const raw of v.slice(0, 8)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const url = str(r.url, 400);
    if (!url || !url.startsWith('https://')) continue;
    out.push({ type: str(r.type, 24), label: str(r.label, 40), url });
  }
  return out;
}

/** `GET /token-boosts/latest/v1` — an array, not an envelope. */
export function parseBoosts(raw: unknown, chains: string[]): BoostedToken[] {
  if (!Array.isArray(raw)) return [];
  const want = new Set(chains);
  const out: BoostedToken[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const chainId = str(r.chainId, 24);
    const tokenAddress = str(r.tokenAddress, 64);
    if (!chainId || !tokenAddress || !want.has(chainId)) continue;
    out.push({
      chainId,
      tokenAddress,
      amount: num(r.amount),
      totalAmount: num(r.totalAmount),
      description: str(r.description, 300),
      icon: str(r.icon, 400),
      url: str(r.url, 400),
      links: links(r.links),
    });
  }
  // Biggest spend first: the point of the panel is who is paying most.
  return out.sort((a, b) => (b.totalAmount ?? 0) - (a.totalAmount ?? 0));
}

/** `GET /token-profiles/latest/v1` — same shape, no boost counts. */
export function parseProfiles(raw: unknown, chains: string[]): TokenProfile[] {
  if (!Array.isArray(raw)) return [];
  const want = new Set(chains);
  const out: TokenProfile[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const chainId = str(r.chainId, 24);
    const tokenAddress = str(r.tokenAddress, 64);
    if (!chainId || !tokenAddress || !want.has(chainId)) continue;
    out.push({
      chainId,
      tokenAddress,
      cto: r.cto === true,
      description: str(r.description, 300),
      icon: str(r.icon, 400),
      url: str(r.url, 400),
      links: links(r.links),
    });
  }
  return out;
}

/** DexScreener's chain ids for the chains this app trades. */
export const HUB_CHAINS = ['solana', 'bsc'] as const;

/** DexScreener id → this app's. Robinhood Chain is not indexed by them. */
export function hubChainLabel(chainId: string): string {
  return chainId === 'solana' ? 'SOL' : chainId === 'bsc' ? 'BNB' : chainId.toUpperCase();
}
