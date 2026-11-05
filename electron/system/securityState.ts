// The 2FA secret, its counters and the idle setting, in `security.json`, sealed
// under the vault's key. Only exists with a password on.
//
// Created when the password is set, even with 2FA off, so a missing file means
// something happened to it rather than "2FA is off": that fails closed. Going
// back to an older copy of this file cannot be detected locally. A person who
// can replace files as this user is the malware case, which 2FA does not claim
// to stop (see the wording on the Security page).

import { app } from 'electron';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_CODE_COUNT, DEFAULT_IDLE_MINUTES, IDLE_OPTIONS, TOTP_RESET_WAIT_MS } from '@shared/securityPolicy';
import { durableWrite, overwriteAndRemove } from './durableWrite';
import { lockoutMs, matchStep, newTotpSecret } from './totp';
import * as vault from './vault';
import { aad, newBackupCode, normaliseCode } from './vaultCrypto';

interface TotpState {
  secret: string;
  lastStep: number;
  backupHashes: string[];
  enrolledAt: number;
}

interface SecurityState {
  version: 1;
  codeKey: string;
  totp: TotpState | null;
  failCount: number;
  lockUntil: number;
  resetRequestedAt: number | null;
  idleMinutes: number;
}

let cache: SecurityState | null = null;

const statePath = (): string => path.join(app.getPath('userData'), 'security.json');

const fresh = (): SecurityState => ({
  version: 1,
  codeKey: randomBytes(32).toString('hex'),
  totp: null,
  failCount: 0,
  lockUntil: 0,
  resetRequestedAt: null,
  idleMinutes: DEFAULT_IDLE_MINUTES,
});

function write(s: SecurityState): void {
  const blob = vault.seal(Buffer.from(JSON.stringify(s), 'utf8'), aad.securityState);
  durableWrite(statePath(), JSON.stringify({ version: 1, blob }, null, 2));
  cache = s;
}

function read(): { ok: true; state: SecurityState } | { ok: false; why: string } {
  if (cache) return { ok: true, state: cache };
  if (vault.isSealed()) return { ok: false, why: 'Wallets are locked.' };
  let text: string;
  try {
    text = fs.readFileSync(statePath(), 'utf8');
  } catch (e) {
    return { ok: false, why: `${statePath()} could not be read (${(e as Error).message}). Withdrawals and key exports are blocked until this is fixed; your recovery code resets it.` };
  }
  try {
    const { blob } = JSON.parse(text) as { blob: string };
    const parsed = JSON.parse(vault.open(blob, aad.securityState).toString('utf8')) as SecurityState;
    if (parsed.version !== 1 || typeof parsed.codeKey !== 'string') throw new Error('unknown format');
    cache = parsed;
    return { ok: true, state: parsed };
  } catch (e) {
    return { ok: false, why: `${statePath()} is damaged (${(e as Error).message}). Withdrawals and key exports are blocked until this is fixed; your recovery code resets it.` };
  }
}

/** Written during turn-on, inside the migration. */
export function initForNewVault(): void {
  cache = null;
  write(fresh());
}

export function removeFiles(): void {
  cache = null;
  overwriteAndRemove(statePath());
  overwriteAndRemove(`${statePath()}.bak`);
  overwriteAndRemove(`${statePath()}.tmp`);
}

/** The recovery code opens every key, so it may also clear 2FA and any damage. */
export function resetAfterRecovery(): void {
  const prev = read();
  const next = fresh();
  if (prev.ok) next.idleMinutes = prev.state.idleMinutes;
  cache = null;
  write(next);
}

export function problem(): string | null {
  if (!vault.isOn() || vault.isSealed()) return null;
  const r = read();
  return r.ok ? null : r.why;
}

export function totpOn(): boolean {
  if (!vault.isOn()) return false;
  const r = read();
  // Unreadable counts as ON: the gate then refuses, rather than waving through.
  return r.ok ? r.state.totp !== null : true;
}

export function backupCodesLeft(): number {
  if (!vault.isOn()) return 0;
  const r = read();
  return r.ok ? (r.state.totp?.backupHashes.length ?? 0) : 0;
}

export function idleMinutes(): number {
  if (!vault.isOn()) return 0;
  const r = read();
  return r.ok ? r.state.idleMinutes : DEFAULT_IDLE_MINUTES;
}

export function setIdleMinutes(m: number): boolean {
  if (!(IDLE_OPTIONS as readonly number[]).includes(m)) return false;
  const r = read();
  if (!r.ok) return false;
  write({ ...r.state, idleMinutes: m });
  return true;
}

export function resetDueAt(): number | null {
  if (!vault.isOn()) return null;
  const r = read();
  return r.ok && r.state.resetRequestedAt ? r.state.resetRequestedAt + TOTP_RESET_WAIT_MS : null;
}

const hashCode = (key: string, code: string): string => createHmac('sha256', Buffer.from(key, 'hex')).update(code).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Check a code, spend it, and save that BEFORE the action runs, so a crash
 * cannot leave a used code still valid. A backup code works here too.
 */
export function verifyCode(input: string, now = Date.now()): { ok: true } | { ok: false; message: string } {
  const r = read();
  if (!r.ok) return { ok: false, message: r.why };
  const s = r.state;
  if (!s.totp) return { ok: false, message: 'Authenticator codes are not set up.' };
  if (s.lockUntil > now) {
    const mins = Math.ceil((s.lockUntil - now) / 60_000);
    return { ok: false, message: `Too many wrong codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }
  const step = matchStep(s.totp.secret, input, now, s.totp.lastStep);
  if (step !== null) {
    write({ ...s, failCount: 0, lockUntil: 0, totp: { ...s.totp, lastStep: step } });
    return { ok: true };
  }
  const backup = normaliseCode(input, 10);
  if (backup) {
    const h = hashCode(s.codeKey, backup);
    const left = s.totp.backupHashes.filter((x) => !sameHash(x, h));
    if (left.length !== s.totp.backupHashes.length) {
      write({ ...s, failCount: 0, lockUntil: 0, totp: { ...s.totp, backupHashes: left } });
      return { ok: true };
    }
  }
  return { ok: false, message: noteFailure(s, now, 'Wrong code. If the code looks right, check that your PC clock is correct.') };
}

/** A wrong password in a proof window counts toward the same lockout. */
export function noteWrongPassword(now = Date.now()): string {
  const r = read();
  return r.ok ? noteFailure(r.state, now, 'Wrong password.') : r.why;
}

export function lockedOutMessage(now = Date.now()): string | null {
  const r = read();
  if (!r.ok || r.state.lockUntil <= now) return null;
  const mins = Math.ceil((r.state.lockUntil - now) / 60_000);
  return `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
}

function noteFailure(s: SecurityState, now: number, message: string): string {
  const failCount = s.failCount + 1;
  const wait = lockoutMs(failCount);
  write({ ...s, failCount, lockUntil: wait ? now + wait : 0 });
  return wait ? `${message} Locked for ${Math.round(wait / 60_000)} minutes after too many tries.` : message;
}

// ── Setting 2FA up and taking it down ──────────────────────────────────

export const newSecretForEnrolment = (): string => newTotpSecret();

/**
 * Check a code from the new secret, which proves the phone has it, and build the
 * backup codes. Nothing is saved until `commit`, which runs once the user has
 * seen those codes. Walking away leaves 2FA off rather than on with no fallback.
 */
export function prepareEnable(secret: string, code: string, now = Date.now()): { ok: true; backupCodes: string[]; commit: () => void } | { ok: false; message: string } {
  const r = read();
  if (!r.ok) return { ok: false, message: r.why };
  const step = matchStep(secret, code, now, -1);
  if (step === null) return { ok: false, message: 'That code does not match. Check that your PC clock is correct, then try the newest code.' };
  const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, () => newBackupCode());
  return {
    ok: true,
    backupCodes,
    commit: () => {
      const latest = read();
      if (!latest.ok) throw new Error(latest.why);
      write({
        ...latest.state,
        failCount: 0,
        lockUntil: 0,
        resetRequestedAt: null,
        totp: {
          secret,
          lastStep: step,
          backupHashes: backupCodes.map((c) => hashCode(latest.state.codeKey, normaliseCode(c, 10)!)),
          enrolledAt: now,
        },
      });
    },
  };
}

export function disable(): boolean {
  const r = read();
  if (!r.ok) return false;
  write({ ...r.state, totp: null, failCount: 0, lockUntil: 0, resetRequestedAt: null });
  return true;
}

/** Lost phone, no backup codes, no recovery code: a slow door, not no door. */
export function requestReset(now = Date.now()): boolean {
  const r = read();
  if (!r.ok || !r.state.totp) return false;
  write({ ...r.state, resetRequestedAt: r.state.resetRequestedAt ?? now });
  return true;
}

export function cancelReset(): boolean {
  const r = read();
  if (!r.ok) return false;
  write({ ...r.state, resetRequestedAt: null });
  return true;
}

export function finishReset(now = Date.now()): { ok: boolean; message: string } {
  const r = read();
  if (!r.ok) return { ok: false, message: r.why };
  const asked = r.state.resetRequestedAt;
  if (!asked) return { ok: false, message: 'No reset was requested.' };
  if (now - asked < TOTP_RESET_WAIT_MS) return { ok: false, message: 'The 72 hours are not up yet.' };
  disable();
  return { ok: true, message: 'Authenticator codes are off. Set them up again on your new phone.' };
}

export function __resetForTest(): void {
  cache = null;
}
