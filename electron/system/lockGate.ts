// The lock. Two different things share this file on purpose:
//
// STARTUP is a complete lock. `run()` is the first line of bootstrap, so before
// the password goes in, no IPC handler exists, no engine has been built, and the
// data key is not in memory, so nothing can sign.
//
// IDLE is a screen lock, and only that. The windows hide and the password is
// asked for, but the engine, orders, stops and scripts keep running, because
// they were authorised while unlocked and a stop-loss that waits for a person is
// not a stop-loss (order-safety-rules). The data key stays in memory: this stops
// a person at the keyboard, not malware reading memory.
//
// The honest cost, stated on the setup screen: after a crash or a reboot nothing
// can sell until someone unlocks.

import { app, BrowserWindow, dialog, powerMonitor, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { durableWrite } from './durableWrite';
import { logger } from './logger';
import { cancelOpenPrompt, focusPrompt, runPrompt, type PromptStep, type PromptView } from './securityPrompt';
import * as securityState from './securityState';
import * as vault from './vault';
import { passwordProblem } from './vaultCrypto';

let booted = false;
let screenLocked = false;
let hiddenByLock: BrowserWindow[] = [];

export const isBooted = (): boolean => booted;
export const isScreenLocked = (): boolean => screenLocked;

/** Past the gate: the app's own startup may run. */
export function markBooted(): void {
  booted = true;
}

/** While locked, anything that would show a window shows the lock instead. */
export function focusIfLocked(): boolean {
  if (booted && !screenLocked) return false;
  focusPrompt();
  return true;
}

// ── Attempts ───────────────────────────────────────────────────────────
//
// Kept outside the vault, so editing the file resets it. It slows a person at
// the keyboard. Against a copied file the real limit is scrypt's cost.

const attemptsPath = (): string => path.join(app.getPath('userData'), 'unlock-attempts.json');

function readAttempts(): { fails: number; until: number } {
  try {
    const o = JSON.parse(fs.readFileSync(attemptsPath(), 'utf8')) as { fails?: unknown; until?: unknown };
    return { fails: typeof o.fails === 'number' ? o.fails : 0, until: typeof o.until === 'number' ? o.until : 0 };
  } catch {
    return { fails: 0, until: 0 };
  }
}

function noteAttempt(success: boolean): void {
  try {
    if (success) {
      fs.rmSync(attemptsPath(), { force: true });
      return;
    }
    const a = readAttempts();
    const fails = a.fails + 1;
    const wait = fails < 5 ? 0 : Math.min(15 * 60_000, 30_000 * 2 ** (fails - 5));
    durableWrite(attemptsPath(), JSON.stringify({ fails, until: wait ? Date.now() + wait : 0 }), { backup: 'none' });
  } catch {
    /* a counter that cannot be saved must never stop an unlock */
  }
}

function waitMessage(): string | null {
  const a = readAttempts();
  const ms = a.until - Date.now();
  if (ms <= 0) return null;
  const s = Math.ceil(ms / 1000);
  return `Too many wrong passwords. Try again in ${s < 60 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`}.`;
}

// ── The unlock window ──────────────────────────────────────────────────

function profileLine(): string {
  const dir = path.basename(app.getPath('userData'));
  return `Profile: ${dir}`;
}

function unlockView(allowQuit: boolean, error?: string): PromptView {
  return {
    title: 'Unlock Krypto Bot',
    lines: [allowQuit ? 'Your keys are encrypted. Enter your password to open the app.' : 'Krypto Bot is locked. Trading, orders and stop-losses are still running.', profileLine()],
    fields: [{ name: 'password', label: 'Password', kind: 'password' }],
    submit: 'Unlock',
    cancel: allowQuit ? 'Quit' : null,
    extra: [{ id: 'forgot', label: 'Forgot password?' }],
    ...(error ? { error } : {}),
  };
}

const recoveryView = (error?: string): PromptView => ({
  title: 'Use your recovery code',
  lines: ['Enter the recovery code you wrote down when you set your password, then choose a new password. You will get a new recovery code, because this one has now been used. This also turns authenticator codes off.'],
  fields: [
    { name: 'code', label: 'Recovery code', kind: 'code', hint: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' },
    { name: 'password', label: 'New password', kind: 'password' },
    { name: 'confirm', label: 'New password again', kind: 'password' },
  ],
  submit: 'Set new password',
  cancel: 'Back',
  extra: [{ id: 'neither', label: 'I have neither' }],
  ...(error ? { error } : {}),
});

const showNewCodeView = (code: string, error?: string): PromptView => ({
  title: 'Your new recovery code',
  lines: ['Write this down and keep it somewhere safe and offline. The new password and this code take effect when you confirm it. Nobody, including Krypt, can reset your password without it.'],
  secret: code,
  fields: [{ name: 'typed', label: 'Type it back to confirm', kind: 'code' }],
  submit: 'I wrote it down',
  cancel: null,
  ...(error ? { error } : {}),
});

const NEITHER_VIEW: PromptView = {
  title: 'Without the password or the code',
  lines: [
    'Nobody can open these keys, including Krypt. There is no server and no reset. Money in these wallets cannot be reached from here.',
    'If you have a key backup file, or a recovery phrase, you can start fresh and import it. Starting fresh deletes nothing: the locked files are set aside in a folder, and if you remember the password later they can be put back.',
  ],
  fields: [{ name: 'typed', label: 'Type START FRESH to continue', kind: 'text' }],
  submit: 'Start fresh',
  cancel: 'Back',
  danger: true,
};

/** Forgot-password handling, shared by the startup and idle locks. */
function makeUnlockHandler(allowQuit: boolean, onUnlocked: () => void): (action: string, values: Record<string, string>) => Promise<PromptStep> {
  let mode: 'unlock' | 'recovery' | 'neither' | 'newCode' = 'unlock';
  let newCode = '';
  let commitRecovery: (() => void) | null = null;
  return async (action, values) => {
    if (action === 'forgot') {
      mode = 'recovery';
      return { view: { ...recoveryView(), cancel: null, extra: [{ id: 'back', label: 'Back' }, ...(allowQuit ? [{ id: 'neither', label: 'I have neither' }] : [])] } };
    }
    if (action === 'back') {
      mode = 'unlock';
      return { view: unlockView(allowQuit) };
    }
    if (action === 'neither') {
      mode = 'neither';
      return { view: { ...NEITHER_VIEW, cancel: null, extra: [{ id: 'back', label: 'Back' }] } };
    }
    if (mode === 'neither') {
      if (values.typed?.trim() !== 'START FRESH') return { view: { ...NEITHER_VIEW, cancel: null, extra: [{ id: 'back', label: 'Back' }], error: 'Type START FRESH exactly.' } };
      const dir = vault.setAsideLockedVault(new Date().toISOString().slice(0, 10));
      securityState.__resetForTest();
      logger.warn(`lock: started fresh, the locked files are in ${dir}`);
      return { done: true };
    }
    if (mode === 'newCode') {
      if (!vault.sameRecoveryCode(values.typed ?? '', newCode)) return { view: showNewCodeView(newCode, 'That does not match. Check each group.') };
      commitRecovery?.();
      // The recovery code already opens every key: it may clear 2FA and any
      // damage to its file too.
      securityState.resetAfterRecovery();
      noteAttempt(true);
      logger.warn('lock: password reset with the recovery code');
      onUnlocked();
      return { done: true };
    }
    if (mode === 'recovery') {
      const extra = [{ id: 'back', label: 'Back' }, ...(allowQuit ? [{ id: 'neither', label: 'I have neither' }] : [])];
      const fail = (error: string): PromptStep => ({ view: { ...recoveryView(error), cancel: null, extra } });
      const wait = waitMessage();
      if (wait) return fail(wait);
      if ((values.password ?? '') !== (values.confirm ?? '')) return fail('The two passwords do not match.');
      const weak = passwordProblem(values.password ?? '');
      if (weak) return fail(weak);
      const r = await vault.prepareRecovery(values.code ?? '', values.password ?? '');
      if (!r.ok) {
        noteAttempt(false);
        return fail(r.message);
      }
      newCode = r.recoveryCode ?? '';
      commitRecovery = r.commit ?? null;
      mode = 'newCode';
      return { view: showNewCodeView(newCode) };
    }
    // Unlock.
    const wait = waitMessage();
    if (wait) return { view: unlockView(allowQuit, wait) };
    const r = screenLocked ? await vault.checkPassword(values.password ?? '') : await vault.unlock(values.password ?? '');
    if (!r.ok) {
      if (r.reason === 'wrong-password') noteAttempt(false);
      return { view: unlockView(allowQuit, r.message) };
    }
    noteAttempt(true);
    onUnlocked();
    return { done: true };
  };
}

/**
 * The startup gate. True: carry on starting the app. False: the user quit, or
 * the vault cannot be used. Nothing else in the app has run when this is called.
 */
export async function run(): Promise<boolean> {
  vault.init();
  const status = vault.status();
  if (status === 'none') return true;
  if (status === 'broken') {
    dialog.showErrorBox('Krypto Bot cannot open your keys', `${vault.brokenReason() ?? 'The vault could not be read.'}\n\nNothing has been changed. Restore vault.json from a backup of this folder, or contact support.`);
    return false;
  }
  const outcome = await runPrompt({ first: unlockView(true), onAction: makeUnlockHandler(true, () => undefined), closable: true });
  if (!outcome.done) {
    if (outcome.value === 'load-failed') dialog.showErrorBox('Krypto Bot could not start', 'The unlock window could not be opened. Reinstalling the app keeps your keys.');
    return false;
  }
  return true;
}

// ── The idle lock ──────────────────────────────────────────────────────

function appWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.session === session.defaultSession);
}

export function lockScreen(reason: string): void {
  if (!booted || screenLocked || !vault.isOn() || vault.isSealed()) return;
  screenLocked = true;
  logger.info(`lock: screen locked (${reason}); trading keeps running`);
  cancelOpenPrompt();
  hiddenByLock = appWindows().filter((w) => w.isVisible());
  for (const w of hiddenByLock) w.hide();
  const finish = (): void => {
    screenLocked = false;
    const back = hiddenByLock;
    hiddenByLock = [];
    for (const w of back) if (!w.isDestroyed()) w.show();
  };
  void runPrompt({ first: unlockView(false), onAction: makeUnlockHandler(false, finish), closable: false }).then((r) => {
    // The window cannot be closed by the user. Anything else that ended it must
    // not leave every window hidden with no way back.
    if (!r.done && screenLocked) {
      logger.error('lock: the lock window ended unexpectedly; showing the app again');
      finish();
    }
  });
}

let idleTimer: NodeJS.Timeout | null = null;

/** Started once the app is up. Reads the setting each time, so changing it on
 *  the Security page needs no restart. */
export function startIdleWatch(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const minutes = securityState.idleMinutes();
    if (minutes <= 0 || screenLocked) return;
    if (powerMonitor.getSystemIdleTime() >= minutes * 60) lockScreen(`idle for ${minutes} minutes`);
  }, 15_000);
  idleTimer.unref();
  const lockIfOn = (why: string): void => {
    if (securityState.idleMinutes() > 0) lockScreen(why);
  };
  powerMonitor.on('lock-screen', () => lockIfOn('the computer was locked'));
  powerMonitor.on('suspend', () => lockIfOn('the computer went to sleep'));
}
