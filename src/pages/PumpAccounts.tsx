// pump.fun accounts — all of them, in one place.
//
// The per-wallet section on the Wallet page is still where a single account is
// made and edited. This is the page for having SEVERAL: signing several
// in at once, naming them from a list, seeing which sessions are about to
// lapse, and asking pump what it thinks of you as a caller.
//
// ─── Sessions lapse quietly ──────────────────────────────────────────────
//
// A session lasts about 30 days and nothing announces the end of one. Left
// alone, the first sign is a script's callouts starting to fail. So the age of
// every session is on screen, anything close to the edge says so, and one
// button renews all of them.
//
// The thirty days is an OBSERVATION, not a promise pump publishes — so
// nothing here expires a session on its own. A 401 from their server is the
// only authority, and `refreshProfile` already turns one into a sign-out.
//
// ─── Accounts that already exist ─────────────────────────────────────────
//
// Someone arriving with a pump.fun account they already use (followers, past
// calls) brings it by importing that wallet's key. pump ties the account to
// the address, so signing in with the key IS logging in to it; nothing about
// the account changes and nothing is created. "Bring an existing account"
// does the import and the sign-in in one step, and pump's public profile read
// tells the lists below which unsigned wallets already have an account (Sign
// in) and which do not (Make).
//
// An account with an email or social login is the exception: since
// 2026-10-23 pump refuses a wallet sign-in for it (409, Privy), key or no key.
// "Sign in with browser" opens the user's own Chrome or Edge on pump.fun and
// keeps the session once the window is closed (system/pumpBrowserSignIn.ts).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BadgeCheck, Globe, Heart, HeartOff, KeyRound, Loader2, LogIn, LogOut, Pencil, PlayCircle, RefreshCw, UserMinus, UserPlus, Users, X } from 'lucide-react';
import {
  PUMP_SESSION_DAYS,
  isWebOnlyAccount,
  sessionDaysLeft,
  sessionStale,
  type PumpAuthStatus,
  type PumpSessionView,
} from '@shared/pumpAuth';
import { namesFromList, nameListProblem, STATS_WINDOWS, STATS_WINDOW_LABEL, type CallerStats } from '@shared/pumpStats';
import { BIO_WATERMARK, type PumpAccountLookup } from '@shared/pumpProfile';
import type { SocialAction } from '@shared/pumpSocial';
import { REFERRAL_NOTICE } from '@shared/pumpReferral';
import { LookupNote, ProfileEditor } from '../components/terminal/PumpAccountsSection';
import { Card, GhostButton, Page, PrimaryButton, Section, TextInput } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { PUMP_QUICKSTART_URL } from '../guideVideos';
import { cls, fmtAgo, shortAddr } from '../utils/format';
import type { WalletSummary } from '@shared/types';
import { loadPumpStatus } from '../state/pumpStatus';
import { CalloutRewards } from '../components/terminal/CalloutRewards';

/** A number nobody could read is an em dash, never a zero. */
const n = (v: number | null | undefined, suffix = ''): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100) / 100}${suffix}` : '—';

export function PumpAccountsPage() {
  const toast = useToast();
  const [status, setStatus] = useState<PumpAuthStatus | null>(null);
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [names, setNames] = useState('');
  const [stats, setStats] = useState<Record<string, CallerStats | string>>({});
  const [lookups, setLookups] = useState<Record<string, PumpAccountLookup>>({});
  /** The account whose profile editor is open. One at a time, inline under
   *  its own row, so it is never unclear whose profile is being written. */
  const [editing, setEditing] = useState<string | null>(null);
  const [importKey, setImportKey] = useState('');
  const [importLabel, setImportLabel] = useState('');
  /** What the last import brought in, shown until the next one. */
  const [imported, setImported] = useState<{ walletId: string; lookup: PumpAccountLookup; signedIn: boolean; privy: boolean } | null>(null);

  const refresh = useCallback(() => {
    void window.krypt.pump.status().then((r) => r.ok && r.data && setStatus(r.data));
    void window.krypt.wallet.list().then((r) => r.ok && r.data && setWallets(r.data));
  }, []);
  useEffect(refresh, [refresh]);
  // Names main fills in after the first read (see state/pumpStatus.ts).
  useEffect(() => loadPumpStatus(setStatus), []);

  const sessions = status?.sessions ?? [];
  const byWallet = useMemo(() => new Map(sessions.map((s) => [s.walletId, s])), [sessions]);
  const signedIn = wallets.filter((w) => byWallet.has(w.id));
  /** Sessions that ended on their own — shown as invalid at the top, so they
   *  are not also listed below as plain "Sign in" rows. */
  const needs = (status?.needsSignIn ?? []).filter((n) => !byWallet.has(n.walletId));
  const needIds = new Set(needs.map((n) => n.walletId));
  const missing = wallets.filter((w) => !byWallet.has(w.id) && !needIds.has(w.id));
  // A browser sign-in has no key behind it, so "Renew" cannot sign it in
  // again — those are renewed with the browser button instead.
  const staleAll = sessions.filter((s) => sessionStale(s));
  const stale = staleAll.filter((s) => s.via !== 'web');
  const staleWeb = staleAll.length - stale.length;
  /** Accounts signed in through the browser whose wallet the app does not
   *  hold (a pump-held wallet). */
  const webOnly = sessions.filter((s) => isWebOnlyAccount(s.walletId));

  // Ask pump which unsigned wallets already have an account. Keyed on the ids,
  // so a refresh returning the same wallets asks nothing new (main caches the
  // answers besides).
  const missingKey = missing.map((w) => w.id).join(',');
  useEffect(() => {
    if (!missingKey) return;
    let alive = true;
    void window.krypt.pump.lookup(missingKey.split(',')).then((r) => {
      if (alive && r.ok && r.data) setLookups((prev) => ({ ...prev, ...r.data }));
    });
    return () => {
      alive = false;
    };
  }, [missingKey]);

  // A `record` is pump's own placeholder for an address; it is there to be
  // signed in to, so it goes with the existing accounts.
  const existing = missing.filter((w) => lookups[w.id]?.kind === 'account' || lookups[w.id]?.kind === 'record');
  const fresh = missing.filter((w) => !existing.includes(w));
  const unchecked = fresh.filter((w) => !lookups[w.id] || lookups[w.id].kind === 'unknown').length;

  const bringAccount = (): Promise<void> =>
    run('import', async () => {
      const r = await window.krypt.pump.importAccount(importKey.trim(), importLabel.trim());
      if (!r.ok || !r.data) {
        toast.error(r.message);
        return;
      }
      // The key leaves the page as soon as main has it, whatever the sign-in
      // did: the wallet is imported either way.
      setImportKey('');
      setImportLabel('');
      setImported({ walletId: r.data.walletId, lookup: r.data.lookup, signedIn: r.data.signedIn, privy: r.data.privy === true });
      if (r.data.signedIn) toast.success(r.message);
      else toast.error(r.message);
    });

  // Resolves only when the browser window is closed, so the page waits with a
  // Cancel button rather than a spinner nobody can stop.
  const openBrowser = async (): Promise<void> => {
    setBusy('browser');
    try {
      const r = await window.krypt.pump.browserSignIn();
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
      setImported(null);
      if (r.data?.walletId) setEditing(r.data.walletId);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const browserSignIn = (): Promise<void> => openBrowser();

  // Sign in with the wallet key; when pump answers that this account only
  // takes its email or social login (main then lists it as 'browser'), go
  // straight on to the browser sign-in rather than leaving a dead end.
  const signInOrBrowser = async (walletId: string): Promise<boolean> => {
    setBusy(`one:${walletId}`);
    let r: Awaited<ReturnType<typeof window.krypt.pump.signIn>>;
    try {
      r = await window.krypt.pump.signIn(walletId);
    } finally {
      setBusy(null);
    }
    if (r.ok) {
      toast.success(r.message);
      refresh();
      return true;
    }
    const st = await window.krypt.pump.status();
    if (st.ok && st.data) setStatus(st.data);
    if (st.data?.needsSignIn?.some((n) => n.walletId === walletId && n.reason === 'browser')) {
      toast.info('pump.fun wants this account’s email or social login — opening your browser. Sign in there, then close the window.');
      await openBrowser();
      return false;
    }
    toast.error(r.message);
    refresh();
    return false;
  };
  const cancelBrowser = (): void => void window.krypt.pump.browserSignInCancel();

  // Refused in main while live execution is armed, same as the Wallet page.
  const makeTrading = (walletId: string): Promise<void> =>
    run('select', async () => {
      const r = await window.krypt.wallet.select(walletId);
      if (r.ok) toast.success('That wallet trades now, so auto-callout posts from its account');
      else toast.error(r.message);
    });

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
      refresh();
    }
  };

  // One wallet at a time, so each account can be made and then given its own
  // name, bio and picture. A successful sign-in opens that account's editor:
  // a fresh account has none of the three, and doing it right away is the
  // point of making them one by one.
  const signInOne = async (walletId: string): Promise<void> => {
    if (await signInOrBrowser(walletId)) setEditing(walletId);
  };

  const signOutOne = (walletId: string): Promise<void> =>
    run(`out:${walletId}`, async () => {
      const r = await window.krypt.pump.signOut(walletId);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      refresh();
    });

  const signInMany = (ids: string[], label: string): Promise<void> =>
    run(label, async () => {
      const r = await window.krypt.pump.signInMany(ids);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
      // Name the ones that did not work. "6 of 8" tells nobody which two.
      for (const x of r.data?.results ?? []) {
        if (!x.ok) toast.error(`${shortAddr(wallets.find((w) => w.id === x.walletId)?.publicKey ?? x.walletId)}: ${x.message}`);
      }
    });

  const applyNames = (): Promise<void> =>
    run('names', async () => {
      const list = namesFromList(names, signedIn.length);
      const pairs = list.map((username, i) => ({ walletId: signedIn[i].id, username }));
      const r = await window.krypt.pump.setUsernames(pairs);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
      for (const x of r.data?.results ?? []) if (!x.ok) toast.error(x.message);
      setNames('');
    });

  // A toggle: open fetches fresh numbers, a second press closes them.
  const loadStats = (walletId: string): Promise<void> => {
    if (stats[walletId] !== undefined) {
      setStats((s) => {
        const next = { ...s };
        delete next[walletId];
        return next;
      });
      return Promise.resolve();
    }
    return run(`stats:${walletId}`, async () => {
      const r = await window.krypt.pump.callerStats(walletId);
      setStats((s) => ({ ...s, [walletId]: r.ok && r.data ? r.data : r.message }));
    });
  };

  const nameList = namesFromList(names, signedIn.length);
  const nameProblem = nameList.length > 0 ? nameListProblem(nameList, signedIn.length) : null;

  return (
    <Page
      title="pump.fun accounts"
      subtitle="Every wallet's account in one place — sign them in, name them, and see what pump says about your calls."
      actions={
        // Through main like every other link: the renderer never navigates.
        <span title="Watch the pump.fun quickstart on YouTube — opens in your browser">
          <GhostButton onClick={() => void window.krypt.app.openExternal(PUMP_QUICKSTART_URL)}>
            <PlayCircle className="h-3.5 w-3.5" />
            pump.fun quickstart
          </GhostButton>
        </span>
      }
    >
      {/* Disclosed where accounts are made, as the trade fee is before a trade
          (shared/pumpReferral.ts, terms › Fees). */}
      <p className="text-label leading-relaxed text-krypt-muted/80">
        {REFERRAL_NOTICE} Every account used here also keeps “{BIO_WATERMARK}” as the last line of its bio; the app
        adds it after sign-in and puts it back within the hour if it is removed.
      </p>
      {needs.length > 0 && (
        <Section
          title="Signed out — sign in again"
          description="These sessions ended on their own. Until they are signed in again, callouts, likes and follows from these accounts fail."
        >
          <Card className="space-y-1.5">
            {needs.map((n) => {
              const w = wallets.find((x) => x.id === n.walletId);
              const browser = n.reason === 'browser';
              return (
                <div key={n.walletId} className="flex flex-wrap items-center gap-3 rounded-lg border border-arc-gold/30 bg-arc-gold/[0.06] px-3 py-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-arc-gold" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-value font-semibold text-white">
                      {w?.label || 'Wallet'} <span className="text-arc-gold">· session invalid</span>
                    </div>
                    <div className="font-mono text-label text-krypt-muted">
                      {shortAddr(n.address)}
                      <span className="font-sans">
                        {' · '}
                        {browser
                          ? 'this account signs in with email or a social login, so it needs the browser'
                          : 'pump ended the session'}
                        {n.at > 0 && ` · ${fmtAgo(n.at)}`}
                      </span>
                    </div>
                  </div>
                  {browser || !w ? (
                    <PrimaryButton onClick={() => void browserSignIn()} disabled={busy !== null}>
                      {busy === 'browser' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
                      Sign in with browser
                    </PrimaryButton>
                  ) : (
                    <PrimaryButton onClick={() => void signInOrBrowser(n.walletId)} disabled={busy !== null}>
                      {busy === `one:${n.walletId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      Retry
                    </PrimaryButton>
                  )}
                  {busy === 'browser' && (
                    <GhostButton onClick={cancelBrowser}>
                      <X className="h-4 w-4" />
                      Cancel
                    </GhostButton>
                  )}
                </div>
              );
            })}
          </Card>
        </Section>
      )}

      {sessions.length === 0 && (
        <Section title="Nothing signed in yet">
          <Card>
            <p className="text-body leading-relaxed text-krypt-muted">
              An account IS a wallet — signing in with one that has never been used on pump creates its account there
              and then. Start below, or on the Wallet page for a single one.
            </p>
          </Card>
        </Section>
      )}

      <Section
        title="Sign in with email, Google or Apple"
        description="For an account you sign in to on pump.fun with email or a social login. pump no longer lets those in with a wallet key, so you sign in on pump.fun in your own browser and the app keeps the session."
      >
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton onClick={() => void browserSignIn()} disabled={busy !== null}>
              {busy === 'browser' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
              Sign in with browser
            </PrimaryButton>
            {busy === 'browser' && (
              <GhostButton onClick={cancelBrowser}>
                <X className="h-4 w-4" />
                Cancel
              </GhostButton>
            )}
            <span className="flex-1 text-label leading-relaxed text-krypt-muted/70">
              {busy === 'browser'
                ? 'Sign in on pump.fun in the window that opened, then CLOSE that window. The app reads the session when it closes.'
                : "Opens Chrome (or Edge) on pump.fun in a profile of its own. If the account's wallet is one of yours here, it trades and posts as usual; if pump holds the wallet, it can post and like but not trade. Sessions last about a month, then sign in the same way again."}
            </span>
          </div>
        </Card>
      </Section>

      <Section
        title="Bring an existing account"
        description="Already on pump.fun with followers? Import that wallet's private key and the app signs in to the SAME account. The username, followers and past calls come with it, and nothing on the account changes."
      >
        <Card className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
            <input
              type="password"
              value={importKey}
              onChange={(e) => setImportKey(e.target.value)}
              placeholder="Private key (base58, or a JSON byte array)"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white placeholder-krypt-muted/50 outline-none transition focus:border-krypt-purple/60"
            />
            <input
              value={importLabel}
              onChange={(e) => setImportLabel(e.target.value)}
              placeholder="Label (optional)"
              spellCheck={false}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder-krypt-muted/50 outline-none transition focus:border-krypt-purple/60"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton onClick={() => void bringAccount()} disabled={busy !== null || !importKey.trim() || !status?.ready}>
              {busy === 'import' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Import and sign in
            </PrimaryButton>
            <span className="flex-1 text-label leading-relaxed text-krypt-muted/70">
              Use the key of the wallet the account belongs to. Phantom or Solflare: export it there. Email, Google or
              Apple login: on pump.fun, profile icon → View Wallet → Export Wallet (app: Profile → menu → Settings →
              Export Wallet). It is stored encrypted like every wallet here and never leaves this machine.
            </span>
          </div>

          {imported && (
            <div className="space-y-2 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-2">
              <div className="text-body">
                <LookupNote lookup={imported.lookup} />
                {imported.lookup.kind === 'none' && imported.signedIn && (
                  <span className="text-krypt-muted"> (pump had no account for it, so signing in made a new one)</span>
                )}
                {!imported.signedIn && <span className="text-arc-gold"> · imported, but not signed in yet</span>}
              </div>
              {!imported.signedIn && imported.privy && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-label text-krypt-muted">
                    This account has an email or social login, so pump only lets it in through the browser.
                  </span>
                  <GhostButton onClick={() => void browserSignIn()} disabled={busy !== null}>
                    <Globe className="h-4 w-4" />
                    Sign in with browser
                  </GhostButton>
                </div>
              )}
              {imported.signedIn &&
                (wallets.find((w) => w.id === imported.walletId)?.active ? (
                  <p className="text-label text-krypt-muted">
                    This is the trading wallet, so Automation → Auto-callout posts from this account when it buys.
                  </p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-label text-krypt-muted">
                      Auto-callout posts from the trading wallet's account. Scripts can post as any signed-in account.
                    </span>
                    <GhostButton onClick={() => void makeTrading(imported.walletId)} disabled={busy !== null}>
                      {busy === 'select' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Make it the trading wallet
                    </GhostButton>
                  </div>
                ))}
            </div>
          )}
        </Card>
      </Section>

      {/* Rewards before sessions: an account that has not accepted pump's
          reward terms may never be paid, and that is the thing to see first. */}
      {sessions.length > 0 && <CalloutRewards />}

      <Section
        title="Sessions"
        description={`A session lasts about ${PUMP_SESSION_DAYS} days and nothing announces the end of one — left alone, the first sign is a script's callouts starting to fail.`}
      >
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body text-krypt-muted">
              {signedIn.length} of {wallets.length} wallet{wallets.length === 1 ? '' : 's'} signed in{webOnly.length > 0 ? ` · ${webOnly.length} sign-in-only` : ''}
              {staleAll.length > 0 && <span className="text-arc-gold"> · {staleAll.length} worth renewing</span>}
              {staleWeb > 0 && <span className="text-krypt-muted/70"> ({staleWeb} through Sign in with browser)</span>}
            </span>
            <div className="flex-1" />
            {stale.length > 0 && (
              <PrimaryButton
                onClick={() => void signInMany(stale.map((s) => s.walletId), 'renew')}
                disabled={busy !== null}
              >
                {busy === 'renew' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Renew {stale.length}
              </PrimaryButton>
            )}
          </div>

          {sessions.length > 0 && (
            <div className="space-y-1.5">
              {signedIn.map((w) => {
                const s = byWallet.get(w.id) as PumpSessionView;
                const left = sessionDaysLeft(s);
                const worn = sessionStale(s);
                const stat = stats[w.id];
                return (
                  <div key={w.id} className="space-y-1 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-value font-semibold text-white">
                          {s.username || shortAddr(s.address)}
                        </div>
                        <div className="font-mono text-label text-krypt-muted">
                          {w.label || 'Wallet'} · {shortAddr(w.publicKey)}
                          {s.via === 'web' && <span className="font-sans text-krypt-muted/70"> · via pump.fun sign-in</span>}
                        </div>
                      </div>
                      <span className={cls('text-body', worn ? 'text-arc-gold' : 'text-krypt-muted')}>
                        {left <= 0 ? 'past due' : `~${Math.floor(left)}d left`}
                        <span className="text-krypt-muted/60"> · signed in {fmtAgo(s.at)}</span>
                      </span>
                      <GhostButton onClick={() => setEditing(editing === w.id ? null : w.id)}>
                        <Pencil className="h-4 w-4" />
                        {editing === w.id ? 'Close' : 'Edit profile'}
                      </GhostButton>
                      <GhostButton onClick={() => void loadStats(w.id)} disabled={busy !== null}>
                        {busy === `stats:${w.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
                        {stat !== undefined ? 'Close stats' : 'Stats'}
                      </GhostButton>
                      <GhostButton onClick={() => void signOutOne(w.id)} disabled={busy !== null}>
                        {busy === `out:${w.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                        Sign out
                      </GhostButton>
                    </div>
                    {stat !== undefined && <StatsRow stat={stat} />}
                    {editing === w.id && <ProfileEditor walletId={w.id} onSaved={refresh} />}
                  </div>
                );
              })}
            </div>
          )}

          {/* Accounts signed in on pump.fun whose wallet the app does not hold
              (a pump-held wallet). They post, like and edit their profile;
              they never trade, and they sit outside the wallet cap. */}
          {webOnly.length > 0 && (
            <div className="space-y-1.5 border-t border-white/8 pt-3">
              <p className="text-label text-krypt-muted">
                Sign-in-only accounts · {webOnly.length} · no key held, so the app cannot trade them · no limit on how many
              </p>
              {webOnly.map((s) => {
                const left = sessionDaysLeft(s);
                return (
                  <div key={s.walletId} className="space-y-1 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-value font-semibold text-white">{s.username || shortAddr(s.address)}</div>
                        <div className="font-mono text-label text-krypt-muted">
                          {shortAddr(s.address)} <span className="font-sans text-krypt-muted/70">· pump.fun sign-in</span>
                        </div>
                      </div>
                      <span className={cls('text-body', sessionStale(s) ? 'text-arc-gold' : 'text-krypt-muted')}>
                        {left <= 0 ? 'past due' : `~${Math.floor(left)}d left`}
                      </span>
                      <GhostButton onClick={() => setEditing(editing === s.walletId ? null : s.walletId)}>
                        <Pencil className="h-4 w-4" />
                        {editing === s.walletId ? 'Close' : 'Edit profile'}
                      </GhostButton>
                      <GhostButton onClick={() => void signOutOne(s.walletId)} disabled={busy !== null}>
                        {busy === `out:${s.walletId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                        Sign out
                      </GhostButton>
                    </div>
                    {editing === s.walletId && <ProfileEditor walletId={s.walletId} onSaved={refresh} />}
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-label leading-relaxed text-krypt-muted/70">
            An account with an email or social login on pump.fun signs in with{' '}
            <span className="text-white/80">Sign in with browser</span> above — pump refuses a wallet sign-in for it.
            To also TRADE from it here, export its wallet key on pump.fun (profile → View Wallet → Export Wallet) and
            import it under <span className="text-white/80">Bring an existing account</span>; the browser session then
            moves onto that wallet.
          </p>
        </Card>
      </Section>

      {sessions.length > 0 && <SocialCard sessions={sessions} />}

      {existing.length > 0 && (
        <Section
          title="Already on pump.fun"
          description="These wallets already have a pump account. Signing in logs in to it as it is. Nothing is created or renamed."
        >
          <Card className="space-y-3">
            <div className="space-y-1.5">
              {existing.map((w) => (
                <div
                  key={w.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-value font-semibold text-white">{w.label || 'Wallet'}</div>
                    <div className="font-mono text-label text-krypt-muted">{shortAddr(w.publicKey)}</div>
                  </div>
                  <span className="text-body">
                    <LookupNote lookup={lookups[w.id]} />
                  </span>
                  <GhostButton onClick={() => void signInOne(w.id)} disabled={busy !== null || !status?.ready}>
                    {busy === `one:${w.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                    Sign in
                  </GhostButton>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <PrimaryButton
                onClick={() => void signInMany(existing.map((w) => w.id), 'existing')}
                disabled={busy !== null || !status?.ready}
              >
                {busy === 'existing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                {existing.length === 1 ? 'Sign in' : `Sign in all ${existing.length}`}
              </PrimaryButton>
            </div>
          </Card>
        </Section>
      )}

      {fresh.length > 0 && (
        <Section
          title="Accounts to make"
          description="Signing in with an address that has never been used on pump is what creates its account. It costs nothing and sends no transaction."
        >
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body text-krypt-muted">
                {fresh.length} wallet{fresh.length === 1 ? '' : 's'} without an account
                {unchecked > 0 && (
                  <span className="text-krypt-muted/70"> ({unchecked} could not be checked; signing in logs in if one exists)</span>
                )}
              </span>
              <div className="flex-1" />
              <PrimaryButton
                onClick={() => void signInMany(fresh.map((w) => w.id), 'all')}
                disabled={busy !== null || !status?.ready}
              >
                {busy === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                Make all {fresh.length}
              </PrimaryButton>
            </div>
            {/* Every wallet, each with its own button. Making one opens its
                profile editor in the Sessions list above, so each account can
                get its own name, bio and picture. */}
            <div className="space-y-1.5">
              {fresh.map((w) => (
                <div
                  key={w.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-value font-semibold text-white">{w.label || 'Wallet'}</div>
                    <div className="font-mono text-label text-krypt-muted">{shortAddr(w.publicKey)}</div>
                  </div>
                  <span className="text-body">
                    <LookupNote lookup={lookups[w.id]} />
                  </span>
                  <GhostButton onClick={() => void signInOne(w.id)} disabled={busy !== null || !status?.ready}>
                    {busy === `one:${w.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                    {lookups[w.id]?.kind === 'none' ? 'Create account' : 'Sign in'}
                  </GhostButton>
                </div>
              ))}
            </div>
          </Card>
        </Section>
      )}

      {signedIn.length > 0 && (
        <Section
          title="Names"
          description="One name per line, applied to the accounts above in the order they are listed. pump decides whether it accepts each one."
        >
          <Card className="space-y-2">
            <textarea
              value={names}
              onChange={(e) => setNames(e.target.value)}
              rows={5}
              placeholder={signedIn.slice(0, 3).map((w) => `name for ${w.label || shortAddr(w.publicKey)}`).join('\n')}
              className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-body text-white placeholder:text-krypt-muted/50 outline-none focus:border-krypt-purple/60"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-label text-krypt-muted">
                {nameList.length} name{nameList.length === 1 ? '' : 's'} for {signedIn.length} account
                {signedIn.length === 1 ? '' : 's'}
              </span>
              <div className="flex-1" />
              <PrimaryButton onClick={() => void applyNames()} disabled={busy !== null || nameList.length === 0 || !!nameProblem}>
                {busy === 'names' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Apply
              </PrimaryButton>
            </div>
            {nameProblem && <p className="text-body text-rose-300">{nameProblem}</p>}
            <p className="text-label leading-relaxed text-krypt-muted/70">
              Names are almost certainly unique on pump, so a repeat is refused before anything is sent — half a rename
              leaves nobody able to say which half.
            </p>
          </Card>
        </Section>
      )}
    </Page>
  );
}

/**
 * One account's caller standing.
 *
 * The route this comes from answered 401 to everyone until there was a session
 * to ask with, and it has still never been seen answering — so an unreadable
 * body says exactly that and shows what arrived. A grid of zeroes would be a
 * claim made on pump's behalf.
 */
/**
 * Follow a pump user or like a callout, by hand, as one chosen account. The
 * same four actions scripts have (bot.follow / unfollow / like / unlike),
 * through the API — which pump says its 09-25 web sign-in change leaves alone.
 */
function SocialCard({ sessions }: { sessions: PumpSessionView[] }) {
  const toast = useToast();
  const [who, setWho] = useState(sessions[0]?.walletId ?? '');
  const [user, setUser] = useState('');
  const [callout, setCallout] = useState('');
  const [busy, setBusy] = useState<SocialAction | null>(null);
  const account = sessions.some((x) => x.walletId === who) ? who : (sessions[0]?.walletId ?? '');

  const run = async (action: SocialAction, target: string) => {
    if (!account || !target.trim()) return;
    setBusy(action);
    try {
      const r = await window.krypt.pump.social(account, action, target.trim());
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  };
  const icon = (a: SocialAction, Icon: typeof Heart) =>
    busy === a ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />;

  return (
    <Section
      title="Follow or like"
      description="As one of your accounts. Public: a follow shows on their follower list and a like on the callout. Scripts can do the same with bot.follow and bot.like."
    >
      <Card className="space-y-3">
        <div className="space-y-1">
          <span className="text-label text-krypt-muted">As</span>
          <select
            value={account}
            onChange={(e) => setWho(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60"
          >
            {sessions.map((x) => (
              <option key={x.walletId} value={x.walletId}>
                {x.username ?? `${x.address.slice(0, 8)}…`}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <span className="text-label text-krypt-muted">User — wallet address or pump.fun/profile link</span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <TextInput value={user} onChange={setUser} placeholder="pump.fun/profile/…" />
            </div>
            <GhostButton onClick={() => void run('follow', user)} disabled={busy !== null || !user.trim()}>
              {icon('follow', UserPlus)}
              Follow
            </GhostButton>
            <GhostButton onClick={() => void run('unfollow', user)} disabled={busy !== null || !user.trim()}>
              {icon('unfollow', UserMinus)}
              Unfollow
            </GhostButton>
          </div>
        </div>
        <div className="space-y-1">
          <span className="text-label text-krypt-muted">Callout — its id, or a link that contains it</span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <TextInput value={callout} onChange={setCallout} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            </div>
            <GhostButton onClick={() => void run('like', callout)} disabled={busy !== null || !callout.trim()}>
              {icon('like', Heart)}
              Like
            </GhostButton>
            <GhostButton onClick={() => void run('unlike', callout)} disabled={busy !== null || !callout.trim()}>
              {icon('unlike', HeartOff)}
              Unlike
            </GhostButton>
          </div>
        </div>
      </Card>
    </Section>
  );
}

/** pump's callout stats for one account: every rolling window, as pump
 *  computed them. A window pump did not send is a dash, never zeros. */
function StatsRow({ stat }: { stat: CallerStats | string }) {
  if (typeof stat === 'string') {
    return <p className="text-label leading-relaxed text-arc-gold/90">{stat}</p>;
  }
  const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v)}%`);
  const mult = (v: number | null): string => (v === null ? '—' : `${v.toFixed(2)}×`);
  const mins = (v: number | null): string => (v === null ? '—' : v < 60_000 ? `${Math.round(v / 1000)}s` : `${Math.round(v / 60_000)}m`);
  return (
    <div className="overflow-x-auto rounded border border-white/8 bg-black/20">
      <table className="w-full font-mono text-label">
        <thead className="text-krypt-muted">
          <tr>
            <th className="px-2 py-1 text-left font-medium" />
            <th className="px-2 py-1 text-right font-medium">Calls</th>
            <th className="px-2 py-1 text-right font-medium" title="Share of calls whose peak reached 1.2×">≥1.2×</th>
            <th className="px-2 py-1 text-right font-medium" title="Share of calls whose peak reached 1.5×">≥1.5×</th>
            <th className="px-2 py-1 text-right font-medium" title="Share of calls whose peak reached 2×">≥2×</th>
            <th className="px-2 py-1 text-right font-medium" title="Average peak multiple">Avg peak</th>
            <th className="px-2 py-1 text-right font-medium" title="Median peak multiple">Median</th>
            <th className="px-2 py-1 text-right font-medium" title="Average time from the call to its peak">To peak</th>
          </tr>
        </thead>
        <tbody>
          {STATS_WINDOWS.map((k) => {
            const w = stat.windows[k];
            return (
              <tr key={k} className="border-t border-white/5 text-white/85">
                <td className="px-2 py-1 text-left text-krypt-muted">{STATS_WINDOW_LABEL[k]}</td>
                <td className="px-2 py-1 text-right">{n(w?.totalCallouts ?? null)}</td>
                <td className="px-2 py-1 text-right">{pct(w?.oneTwoXPct ?? null)}</td>
                <td className="px-2 py-1 text-right">{pct(w?.oneFiveXPct ?? null)}</td>
                <td className="px-2 py-1 text-right">{pct(w?.twoXPct ?? null)}</td>
                <td className="px-2 py-1 text-right">{mult(w?.averageMultiple ?? null)}</td>
                <td className="px-2 py-1 text-right">{mult(w?.medianMultiple ?? null)}</td>
                <td className="px-2 py-1 text-right">{mins(w?.averageTimeToPeakMs ?? null)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {stat.computedAt && <p className="px-2 py-1 text-label text-krypt-muted/70">pump computed these {fmtAgo(Date.parse(stat.computedAt))}</p>}
    </div>
  );
}
