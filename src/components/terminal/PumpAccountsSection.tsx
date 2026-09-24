// pump.fun accounts, one per Solana wallet.
//
// pump ties an account to the address that signed in, so every wallet here can
// have its own account and all of them can be signed in at once. There is no
// "active pump account" to choose: whatever wallet an action is for, that
// wallet's account is the one used (see shared/pumpAuth.ts).
//
// Signing in with an address that has never signed in before IS the account
// creation — pump has no separate registration step — so the button says
// "Create account" for a wallet with no session and "Sign in" for one that had
// a session and lost it. Saying "Sign in" to someone who has no account yet
// would be asking them for something they do not have.
//
// An IMPORTED wallet may already have an account — made in Phantom, or on
// pump.fun itself. pump's public profile read says so before anything is
// signed, and then the row names the account (@name · followers) and the
// button says "Sign in": signing with that key logs in to the account that is
// already there, followers and past callouts included. Only a wallet pump has
// never heard of is offered "Create account". An unreadable lookup says
// neither — it falls back to "Sign in", which is true either way.
//
// It creates the account but does not NAME it: a fresh one has no username,
// bio or picture, which is why the row shows an address and why Edit profile
// exists below. See shared/pumpProfile.ts for the route that writes those.

import { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, LogIn, LogOut, Loader2, Pencil, RefreshCw, TriangleAlert, UserCheck } from 'lucide-react';
import { Card, GhostButton, PrimaryButton, Section, TextInput } from '../common';
import { useToast } from '../../state/ToastProvider';
import { sessionForWallet, type PumpAuthStatus } from '@shared/pumpAuth';
import {
  BIO_BUDGET,
  BIO_WATERMARK,
  EMPTY_PROFILE,
  MAX_USERNAME,
  profileProblem,
  stripBioWatermark,
  type PumpAccountLookup,
  type PumpProfileDraft,
} from '@shared/pumpProfile';
import { imageSrc } from '@shared/market';
import { REFERRAL_NOTICE } from '@shared/pumpReferral';
import type { WalletSummary } from '@shared/types';
import { cls, fmtAgo, shortAddr } from '../../utils/format';
import { loadPumpStatus } from '../../state/pumpStatus';

export function PumpAccountsSection({ wallets }: { wallets: WalletSummary[] }) {
  const toast = useToast();
  const [status, setStatus] = useState<PumpAuthStatus | null>(null);
  /** The wallet a sign-in is running for, so only its row spins. */
  const [busy, setBusy] = useState<string | null>(null);
  /** The wallet whose profile editor is open. One at a time. */
  const [editing, setEditing] = useState<string | null>(null);
  /** What pump publicly says about each wallet that is not signed in. */
  const [lookups, setLookups] = useState<Record<string, PumpAccountLookup>>({});

  const refresh = useCallback(() => {
    void window.krypt.pump.status().then((r) => {
      if (r.ok && r.data) setStatus(r.data);
    });
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => loadPumpStatus(setStatus), []);

  // Only the wallets without a session need asking, and the key is their ids
  // joined — a new array from the parent with the same wallets asks nothing.
  const unsigned = status ? wallets.filter((w) => !sessionForWallet(status, w.id)).map((w) => w.id) : [];
  const unsignedKey = unsigned.join(',');
  useEffect(() => {
    if (!unsignedKey) return;
    let alive = true;
    void window.krypt.pump.lookup(unsignedKey.split(',')).then((r) => {
      if (alive && r.ok && r.data) setLookups((prev) => ({ ...prev, ...r.data }));
    });
    return () => {
      alive = false;
    };
  }, [unsignedKey]);

  const signIn = async (walletId: string): Promise<void> => {
    setBusy(walletId);
    try {
      const r = await window.krypt.pump.signIn(walletId);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      if (r.data) setStatus(r.data);
      else refresh();
      // The display name arrives a moment after the token, from pump's own
      // profile read, so the row is asked again rather than left blank.
      window.setTimeout(refresh, 1500);
    } finally {
      setBusy(null);
    }
  };

  const signOut = async (walletId: string): Promise<void> => {
    setBusy(walletId);
    try {
      const r = await window.krypt.pump.signOut(walletId);
      if (r.ok) toast.info(r.message);
      if (r.data) setStatus(r.data);
      else refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!status) return null;

  const signedInCount = status.sessions.length;

  return (
    <Section
      title="pump.fun accounts"
      description="One account per wallet, all signed in at once. The account is the wallet: import a wallet that already has a pump.fun account and signing in logs in to it, followers and all. A wallet pump has never seen gets its account made there and then."
    >
      <Card className="space-y-3">
        {!status.ready && (
          <div className="flex items-start gap-2 rounded-lg border border-arc-gold/35 bg-arc-gold/10 px-3 py-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-arc-gold" />
            <p className="text-body leading-relaxed text-arc-gold/90">
              This build cannot sign in to pump.fun — the message they ask a wallet to sign is not known to it, so a
              sign-in would be refused at their end. Nothing below will work until that is updated.
            </p>
          </div>
        )}

        {status.lastError && (
          <p className="text-body leading-relaxed text-rose-300">{status.lastError}</p>
        )}

        {/* Where accounts are made, so it is said here (shared/pumpReferral.ts). */}
        <p className="text-label leading-relaxed text-krypt-muted/80">{REFERRAL_NOTICE}</p>

        {wallets.length === 0 ? (
          <p className="text-body text-krypt-muted">Make a wallet first — a pump.fun account is a wallet.</p>
        ) : (
          <div className="space-y-1.5">
            {wallets.map((wal) => {
              const session = sessionForWallet(status, wal.id);
              const working = busy === wal.id;
              return (
                <div key={wal.id} className="space-y-1.5">
                <div
                  className={cls(
                    'flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 transition',
                    session ? 'border-emerald-400/30 bg-emerald-400/[0.06]' : 'border-white/8 bg-white/[0.02]',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-value font-semibold text-white">{wal.label || 'Wallet'}</span>
                      {wal.active && (
                        <span className="rounded border border-krypt-purple/40 px-1.5 py-0.5 text-label text-krypt-purple">
                          trading
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-label text-krypt-muted">{shortAddr(wal.publicKey)}</div>
                  </div>

                  <div className="min-w-0 text-body">
                    {session ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-300">
                        <UserCheck className="h-3.5 w-3.5 flex-shrink-0" />
                        {/* pump's display name once their profile read answers;
                            until then the address is what we honestly know. */}
                        <span className="truncate">{session.username || shortAddr(session.address)}</span>
                        <span className="text-krypt-muted/70">· {fmtAgo(session.at)}</span>
                      </span>
                    ) : (
                      <LookupNote lookup={lookups[wal.id]} />
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {session ? (
                      <>
                        <GhostButton onClick={() => setEditing(editing === wal.id ? null : wal.id)} disabled={working}>
                          <Pencil className="h-4 w-4" />
                          {editing === wal.id ? 'Close' : 'Edit profile'}
                        </GhostButton>
                        <GhostButton onClick={() => void signIn(wal.id)} disabled={working || !status.ready}>
                          {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                          Refresh
                        </GhostButton>
                        <GhostButton onClick={() => void signOut(wal.id)} disabled={working}>
                          <LogOut className="h-4 w-4" />
                          Sign out
                        </GhostButton>
                      </>
                    ) : (
                      <GhostButton onClick={() => void signIn(wal.id)} disabled={working || !status.ready}>
                        {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                        {lookups[wal.id]?.kind === 'none' ? 'Create account' : 'Sign in'}
                      </GhostButton>
                    )}
                  </div>
                </div>
                {session && editing === wal.id && <ProfileEditor walletId={wal.id} onSaved={refresh} />}
                </div>
              );
            })}
          </div>
        )}

        <p className="text-label leading-relaxed text-krypt-muted/70">
          Signing in proves you hold the wallet: the app signs a short message with the key, which never leaves your
          machine. It costs nothing and sends no transaction.{' '}
          {signedInCount > 0 && (
            <>
              {signedInCount} of {wallets.length} wallet{wallets.length === 1 ? '' : 's'} signed in.{' '}
            </>
          )}
          A session lasts about two weeks, then Refresh signs in again.
        </p>
      </Card>
    </Section>
  );
}

/**
 * What pump publicly says about a wallet that is not signed in here.
 *
 * `record` is an address pump keeps a profile for without anyone having signed
 * in (it auto-names them) — the account is there to be claimed, so it reads as
 * an account, not as nothing. `unknown` claims neither way.
 */
export function LookupNote({ lookup }: { lookup: PumpAccountLookup | undefined }) {
  if (!lookup) return <span className="text-krypt-muted/70">Checking pump.fun…</span>;
  if (lookup.kind === 'none') return <span className="text-krypt-muted">No account yet</span>;
  if (lookup.kind === 'unknown') return <span className="text-krypt-muted/70" title={lookup.why}>Not signed in</span>;
  const who = lookup.username ? `@${lookup.username}` : 'an account';
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-white">{lookup.kind === 'account' ? `Has ${who}` : `pump holds ${who} for it`}</span>
      {lookup.followers !== null && (
        <span className="text-krypt-muted/70">
          · {lookup.followers} follower{lookup.followers === 1 ? '' : 's'}
        </span>
      )}
      {lookup.banned && <span className="text-rose-300">· banned on pump — callouts will be refused</span>}
    </span>
  );
}

/**
 * The username, bio and picture of one account.
 *
 * Inline under its own row rather than a modal, so it is obvious WHICH account
 * is being edited — with five of them the dialog would be the one thing on
 * screen not saying whose profile it is.
 *
 * It opens by asking pump what the profile currently is. A read that fails
 * says so and leaves the fields blank rather than guessing, and main only ever
 * sends the fields that actually changed, so a blank one it never saw is not
 * written over anything.
 */
export function ProfileEditor({ walletId, onSaved }: { walletId: string; onSaved: () => void }) {
  const toast = useToast();
  /** The bio here is the user's own words; the last line is added in main. */
  const [draft, setDraft] = useState<PumpProfileDraft>(EMPTY_PROFILE);
  /** What was loaded, to send only what changed. Null when the read failed. */
  const [loaded, setLoaded] = useState<PumpProfileDraft | null>(null);
  /** Whether the bio pump holds already ends with the line. */
  const [bioMarked, setBioMarked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState<string | null>(null);
  /** Set when pump did not answer and this is the app's last copy. */
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [pinning, setPinning] = useState(false);
  /** What the picked file looks like, before anyone has to load the link. */
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void window.krypt.pump.profile(walletId).then((r) => {
      if (!alive) return;
      if (r.ok && r.data) {
        setCachedAt(r.data.cachedAt ?? null);
        const words = { username: r.data.username, bio: stripBioWatermark(r.data.bio), profileImage: r.data.profileImage };
        setDraft(words);
        setLoaded(words);
        setBioMarked(r.data.bio.trim().endsWith(BIO_WATERMARK));
      } else setReadFailed(r.message);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [walletId]);

  const pickPicture = async (): Promise<void> => {
    const picked = await window.krypt.launch.pickImage('profile');
    if (!picked.ok) {
      toast.error(picked.message);
      return;
    }
    if (!picked.data) return; // cancelled
    setPreview(picked.data.dataUrl);
    setPinning(true);
    try {
      // Pinned now rather than on save, so the link is real before anyone
      // presses a button that writes a public profile.
      const pin = await window.krypt.pump.pinImage(picked.data.handle);
      if (pin.ok && pin.data) setDraft((d) => ({ ...d, profileImage: pin.data!.imageUrl }));
      else {
        toast.error(pin.message);
        setPreview(null);
      }
    } finally {
      setPinning(false);
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      // Only what changed. The bio also goes when pump's copy lacks its last
      // line, so saving any field puts the line on — but only when the read
      // worked: a bio nobody could see is never replaced from a blank form.
      const base = loaded ?? EMPTY_PROFILE;
      const patch: Partial<PumpProfileDraft> = {};
      if (draft.username.trim() !== base.username.trim()) patch.username = draft.username;
      if (draft.profileImage.trim() !== base.profileImage.trim()) patch.profileImage = draft.profileImage;
      if (draft.bio.trim() !== base.bio.trim() || (loaded && !bioMarked)) patch.bio = draft.bio;
      const r = await window.krypt.pump.setProfile(walletId, patch);
      if (r.ok && patch.bio !== undefined) setBioMarked(true);
      if (r.ok) setLoaded({ ...draft });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const problem = profileProblem(draft);

  return (
    <div className="space-y-3 rounded-lg border border-white/8 bg-black/20 px-3 py-3">
      {loading ? (
        <p className="inline-flex items-center gap-2 text-body text-krypt-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the profile from pump.fun…
        </p>
      ) : (
        <>
          {cachedAt !== null && (
            <p className="text-body leading-relaxed text-krypt-muted">
              pump.fun did not answer just now, so this is the profile as this app last saw it ({fmtAgo(cachedAt)}).
            </p>
          )}
          {readFailed && (
            <p className="text-body leading-relaxed text-arc-gold/90">
              {readFailed} — anything you fill in below will still be written; nothing you leave blank is touched.
            </p>
          )}

          <div className="flex flex-wrap items-start gap-3">
            <div className="flex-shrink-0">
              {/* The pinned link goes through the app's OWN image handler, the
                  same one token icons use: img-src does not allow https:, so
                  that a remote host cannot learn this install's IP from a
                  picture. The freshly picked file is a data: URL and needs no
                  such trip. See electron/data/images.ts. */}
              {preview ?? imageSrc(draft.profileImage) ? (
                <img
                  src={preview ?? (imageSrc(draft.profileImage) as string)}
                  alt=""
                  className="h-16 w-16 rounded-full border border-white/10 object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-dashed border-white/15 text-krypt-muted/60">
                  <ImageIcon className="h-5 w-5" />
                </div>
              )}
            </div>
            <div className="min-w-[12rem] flex-1 space-y-2">
              <div className="space-y-1">
                <span className="text-label text-krypt-muted">Username</span>
                <TextInput
                  value={draft.username}
                  onChange={(v) => setDraft({ ...draft, username: v })}
                  placeholder="Not set"
                  mono={false}
                />
              </div>
              <GhostButton onClick={() => void pickPicture()} disabled={pinning}>
                {pinning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                {pinning ? 'Pinning…' : 'Choose picture'}
              </GhostButton>
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-label text-krypt-muted">Bio</span>
            <textarea
              value={draft.bio}
              onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
              rows={3}
              placeholder="e.g. I find and flag runners"
              className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-body text-white placeholder:text-krypt-muted/50 outline-none focus:border-krypt-purple/60"
            />
            {/* The last line, shown as it will read. Added in main on save. */}
            <p className="text-label text-krypt-muted">
              Last line, on its own: <span className="text-white/80">{BIO_WATERMARK}</span>
              <span className="text-krypt-muted/60"> · {Math.max(0, BIO_BUDGET - draft.bio.trim().length)} characters left</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton onClick={() => void save()} disabled={saving || !!problem}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
              Save to pump.fun
            </PrimaryButton>
            <span className="text-label text-krypt-muted/70">
              Public, under this account. Only what you changed is sent. Up to {MAX_USERNAME} characters of username and{' '}
              {BIO_BUDGET} of bio. pump has the final say on what it accepts.
            </span>
          </div>
          {problem && <p className="text-body text-rose-300">{problem}</p>}
        </>
      )}
    </div>
  );
}
