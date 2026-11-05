import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, KeyRound, Lock, ShieldCheck, Upload } from 'lucide-react';
import { Card, GhostButton, Page, PrimaryButton, Section } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { DEFAULT_IDLE_MINUTES, IDLE_OPTIONS, type SecurityStatus } from '@shared/securityPolicy';

/**
 * The Security page (2026-11-04). Status and buttons only. Every password, code
 * and secret goes through the small separate security window, which this page
 * cannot read or press, so nothing here ever holds one.
 */
const idleLabel = (m: number): string => (m === 0 ? 'Never' : m === 60 ? '1 hour' : `${m} minutes`);

const dateOf = (ms: number): string => new Date(ms).toLocaleString();

export function SecurityPage() {
  const toast = useToast();
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await window.krypt.security.status();
    if (r.ok && r.data) setStatus(r.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (call: () => Promise<{ ok: boolean; message: string; data?: { warnings?: string[] } }>): Promise<void> => {
    setBusy(true);
    const r = await call();
    setBusy(false);
    if (r.ok) toast.success(r.message);
    else if (r.message !== 'Cancelled') toast.error(r.message);
    for (const w of r.data?.warnings ?? []) toast.warn(w);
    void load();
  };

  const s = window.krypt.security;
  const resetDue = status?.resetDueAt ?? null;
  const resetReady = resetDue !== null && Date.now() >= resetDue;

  return (
    <Page title="Security" subtitle="Your password, authenticator codes and key backups. Passwords and codes are only ever asked for in a small separate window, never inside this page.">
      {status?.problem && (
        <div className="mb-6 rounded-xl border border-rose-400/30 bg-rose-500/5 px-4 py-3 flex items-start gap-3 text-xs text-rose-200">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /> {status.problem}
        </div>
      )}
      {(status?.unusableKeys.length ?? 0) > 0 && (
        <div className="mb-6 rounded-xl border border-rose-400/30 bg-rose-500/5 px-4 py-3 text-xs text-rose-200">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" /> These wallets cannot sign on this computer. Do not send money to them.
          </div>
          <ul className="mt-2 space-y-1 break-all">
            {status?.unusableKeys.map((k) => <li key={k}>{k}</li>)}
          </ul>
        </div>
      )}
      {resetDue !== null && (
        <div className="mb-6 rounded-xl border border-amber-400/30 bg-amber-500/5 px-4 py-3 flex flex-wrap items-center gap-3 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{resetReady ? 'The 72 hours are up. You can finish the authenticator reset.' : `An authenticator reset was requested. It can finish after ${dateOf(resetDue)}. If this was not you, cancel it and change your password.`}</span>
          {resetReady && <GhostButton disabled={busy} onClick={() => void run(() => s.finishReset2fa())}>Finish reset</GhostButton>}
          <GhostButton disabled={busy} onClick={() => void run(() => s.cancelReset2fa())}>Cancel reset</GhostButton>
        </div>
      )}

      <Section title="App password">
        <Card className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-white">
            <Lock className="h-4 w-4" /> {status === null ? '—' : status.password ? 'On. Your keys are encrypted with your password.' : 'Off. Your keys are protected by your Windows account only.'}
          </div>
          <p className="text-xs text-krypt-muted leading-relaxed">
            Your password encrypts your keys on disk, so a copied file is useless without it, even to a program running as you while the app is closed. Krypt never sees it and cannot reset it. After a crash or a reboot, nothing can sell until you unlock. It does not protect you from malware running while the app is open.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {status && !status.password && (
              <PrimaryButton disabled={busy} onClick={() => void run(() => s.setPassword())}>
                <Lock className="h-4 w-4" /> Set a password
              </PrimaryButton>
            )}
            {status?.password && (
              <>
                <GhostButton disabled={busy} onClick={() => void run(() => s.lockNow())}>Lock now</GhostButton>
                <GhostButton disabled={busy} onClick={() => void run(() => s.changePassword())}>Change password</GhostButton>
                <GhostButton disabled={busy} onClick={() => void run(() => s.newRecoveryCode())}>Replace recovery code</GhostButton>
                <GhostButton destructive disabled={busy} onClick={() => void run(() => s.removePassword())}>Remove password</GhostButton>
              </>
            )}
          </div>
          {status?.password && (
            <label className="flex items-center gap-2 text-xs text-krypt-muted">
              Lock the screen when idle for
              <select
                className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-white"
                disabled={busy}
                value={status.idleMinutes}
                onChange={(e) => void run(() => s.setIdle(Number(e.target.value)))}
              >
                {IDLE_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {idleLabel(m)}
                    {m === DEFAULT_IDLE_MINUTES ? ' (default)' : ''}
                  </option>
                ))}
              </select>
              <span>Trading, orders and stop-losses keep running while locked.</span>
            </label>
          )}
        </Card>
      </Section>

      <Section title="Authenticator codes">
        <Card className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-white">
            <ShieldCheck className="h-4 w-4" /> {status === null ? '—' : status.twoFactor ? `On. ${status.backupCodesLeft} backup code${status.backupCodesLeft === 1 ? '' : 's'} left.` : 'Off.'}
          </div>
          <p className="text-xs text-krypt-muted leading-relaxed">
            When this is on, every withdrawal at any amount needs a code from your phone. So does exporting or importing a key, changing your withdrawal address, and turning on anything that moves money by itself. Trading and selling never need one.
          </p>
          <p className="text-xs text-krypt-muted leading-relaxed">
            Authenticator codes are a check inside Krypto Bot. They stop someone using the app on your unlocked PC, or a fault in the app’s page, from moving money out or exporting keys. No server checks them, and they do not protect your keys from malware on this PC.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {status && !status.twoFactor && (
              <PrimaryButton disabled={busy || !status.password} onClick={() => void run(() => s.enable2fa())}>
                <ShieldCheck className="h-4 w-4" /> Turn on
              </PrimaryButton>
            )}
            {status && !status.password && <span className="text-xs text-krypt-muted">Set a password first. The authenticator secret is encrypted with it.</span>}
            {status?.twoFactor && (
              <>
                <GhostButton disabled={busy} onClick={() => void run(() => s.disable2fa())}>Turn off</GhostButton>
                {resetDue === null && <GhostButton disabled={busy} onClick={() => void run(() => s.requestReset2fa())}>I lost my phone</GhostButton>}
              </>
            )}
          </div>
        </Card>
      </Section>

      <Section title="Key backup">
        <Card className="space-y-3">
          <p className="text-xs text-krypt-muted leading-relaxed">
            One encrypted file with every key in this profile, under a password you choose for that file. It is what gets you back in after a new PC or a Windows reset. To move a single key to another wallet app, use Export key on that wallet’s page.
          </p>
          {(status?.orphanKeys ?? 0) > 0 && (
            <p className="text-xs text-amber-200 leading-relaxed">
              {status?.orphanKeys} key{status?.orphanKeys === 1 ? '' : 's'} from an old wallet file {status?.orphanKeys === 1 ? 'is' : 'are'} kept in the vault and included in this backup.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton disabled={busy} onClick={() => void run(() => s.exportBackup())}>
              <Download className="h-4 w-4" /> Back up my keys
            </PrimaryButton>
            <GhostButton disabled={busy} onClick={() => void run(() => s.importBackup())}>
              <Upload className="h-4 w-4" /> Import a backup
            </GhostButton>
          </div>
        </Card>
      </Section>

      <Section title="What to do if this PC is ever exposed">
        <Card>
          <p className="text-xs text-krypt-muted leading-relaxed flex items-start gap-2">
            <KeyRound className="h-4 w-4 flex-shrink-0" />
            Move your funds to new wallets. Older copies of a file can survive in the Recycle Bin, in profile copies, and on the disk itself, and no setting here can reach those.
          </p>
        </Card>
      </Section>
    </Page>
  );
}
