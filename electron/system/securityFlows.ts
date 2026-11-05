// What the Security page's buttons start. Everything secret happens in the
// security window; the page gets back a yes, a no and a sentence.

import { app, dialog, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_CONFIRM_PHRASE, IDLE_OPTIONS, type SecurityStatus } from '@shared/securityPolicy';
import { qrEncode } from '@shared/qr';
import * as evmWallet from '../evm/evmWallet';
import * as aioWallet from './aioWallet';
import { durableWrite } from './durableWrite';
import * as keyExport from './keyExport';
import { lockScreen } from './lockGate';
import { logger } from './logger';
import * as pumpAuth from './pumpAuth';
import { requireProof, windowOf } from './securityGate';
import { runPrompt, type PromptView } from './securityPrompt';
import * as securityState from './securityState';
import { otpauthUrl } from './totp';
import * as vault from './vault';
import { passwordProblem } from './vaultCrypto';
import * as vaultMigrate from './vaultMigrate';
import * as wallet from './wallet';

export type FlowResult = { ok: boolean; message: string; warnings?: string[] };

const cancelled: FlowResult = { ok: false, message: 'Cancelled' };

export function status(): SecurityStatus {
  const on = vault.isOn();
  const aioProblem = aioWallet.phraseProblem();
  return {
    password: on,
    twoFactor: on && securityState.problem() === null && securityState.totpOn(),
    backupCodesLeft: securityState.backupCodesLeft(),
    idleMinutes: securityState.idleMinutes(),
    resetDueAt: securityState.resetDueAt(),
    orphanKeys: vault.orphans().length,
    problem: securityState.problem(),
    unusableKeys: [...wallet.unusableKeys(), ...evmWallet.unusableKeys(), ...(aioProblem ? [`All-in-One wallet: ${aioProblem}`] : [])],
  };
}

const resealPump = (): void => pumpAuth.resealAll();

function passwordFields(firstLabel = 'Password'): PromptView['fields'] {
  return [
    { name: 'password', label: firstLabel, kind: 'password', hint: 'At least 12 characters. A short sentence works well, and length matters more than symbols.' },
    { name: 'confirm', label: `${firstLabel} again`, kind: 'password' },
  ];
}

function newPasswordError(values: Record<string, string>): string | null {
  if ((values.password ?? '') !== (values.confirm ?? '')) return 'The two passwords do not match.';
  return passwordProblem(values.password ?? '');
}

export const hasAnyKeys = (): boolean => wallet.list().length > 0 || evmWallet.list('robinhood').length > 0 || aioWallet.info().exists;

/**
 * The password is optional, but the moment there is a key worth protecting is
 * the moment to ask, once, in a window that has to be answered. Not at launch,
 * where it would be one more thing between a new user and the app.
 */
export async function offerPasswordAfterFirstKey(sender: WebContents, hadKeys: boolean): Promise<void> {
  if (hadKeys || vault.isOn()) return;
  const win = windowOf(sender);
  if (!win) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Not now', 'Set a password'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: 'Protect this wallet',
    message: 'Protect this wallet with a password?',
    detail: 'Right now your key is protected by your Windows account only, so any program running as you could open it, even while Krypto Bot is closed. A password encrypts it so that a copied file is useless. You can set one later on the Security page.',
  });
  if (response !== 1) return;
  const r = await setPassword(sender);
  if (!r.ok && r.message !== 'Cancelled') void dialog.showMessageBox(win, { type: 'error', title: 'Password not set', message: r.message });
}

// ── Setting the password ───────────────────────────────────────────────

export async function setPassword(sender: WebContents): Promise<FlowResult> {
  const win = windowOf(sender);
  if (!win) return { ok: false, message: 'This can only be done from the app window.' };
  if (vault.isOn()) return { ok: false, message: 'A password is already set.' };
  if (!vault.osKeyStoreAvailable()) return { ok: false, message: 'This system has no secure key store running, so a password cannot be set up safely.' };
  const problem = vaultMigrate.preflight();
  if (problem) return { ok: false, message: problem };

  const solana = wallet.list().length;
  const evm = evmWallet.list('robinhood').length;
  const hasAio = aioWallet.info().exists;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'I understand, continue'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Set a password',
    message: 'If you lose both your password and your recovery code, nobody can open these keys, including Krypt.',
    detail:
      `Money in these wallets would be gone for good. There is no server and no reset.\n\n` +
      `This covers ${solana} Solana wallet${solana === 1 ? '' : 's'}, ${evm} EVM wallet${evm === 1 ? '' : 's'}${hasAio ? ' and your All-in-One wallet' : ''} in this profile. Other profiles, and copies you made earlier, stay as they are.\n\n` +
      'After a crash or a reboot, nothing can sell until you unlock the app.\n\n' +
      'Your password encrypts your keys on disk. It does not protect you from malware running while the app is open.',
  });
  if (response !== 1) return cancelled;

  const first: PromptView = {
    title: 'Set a password',
    lines: ['You will enter this every time Krypto Bot opens. It is only ever asked for in this small separate window, never inside the app’s page.'],
    fields: passwordFields(),
    submit: 'Continue',
    cancel: 'Cancel',
  };
  const held: { prepared: vault.PreparedVault | null; result: FlowResult } = { prepared: null, result: cancelled };
  const codeView = (code: string, error?: string): PromptView => ({
    title: 'Write down your recovery code',
    lines: ['This is the only way back in if you forget your password. Write it on paper and keep it somewhere safe and offline. It is shown once, and it cannot be copied.'],
    secret: code,
    fields: [{ name: 'typed', label: 'Type it back to confirm', kind: 'code' }],
    submit: 'Encrypt my keys',
    cancel: 'Cancel',
    ...(error ? { error } : {}),
  });
  const outcome = await runPrompt({
    parent: win,
    first,
    onAction: async (_action, values) => {
      if (!held.prepared) {
        const error = newPasswordError(values);
        if (error) return { view: { ...first, error } };
        held.prepared = await vault.prepare(values.password);
        return { view: codeView(held.prepared.recoveryCode) };
      }
      if (!vault.sameRecoveryCode(values.typed ?? '', held.prepared.recoveryCode)) {
        return { view: codeView(held.prepared.recoveryCode, 'That does not match. Check each group.') };
      }
      const r = vaultMigrate.enable(held.prepared, resealPump);
      held.result = r;
      if (!r.ok) return { view: codeView(held.prepared.recoveryCode, r.message) };
      return { done: true };
    },
  });
  if (!outcome.done) {
    held.prepared?.key.fill(0);
    return cancelled;
  }
  return held.result;
}

// ── Changing it, removing it ───────────────────────────────────────────

export async function changePassword(sender: WebContents): Promise<FlowResult> {
  const win = windowOf(sender);
  if (!win) return { ok: false, message: 'This can only be done from the app window.' };
  if (!vault.isOn()) return { ok: false, message: 'No password is set.' };
  const proof = await requireProof(sender, { kind: 'security', title: 'Change your password', detail: ['Your recovery code stays the same.'] });
  if (!proof.ok) return proof;
  const view: PromptView = { title: 'Choose a new password', lines: ['Your keys stay as they are. Only the lock on them changes.'], fields: passwordFields('New password'), submit: 'Change password', cancel: 'Cancel' };
  const outcome = await runPrompt({
    parent: win,
    first: view,
    onAction: async (_a, values) => {
      const error = newPasswordError(values);
      if (error) return { view: { ...view, error } };
      await vault.changePassword(values.password);
      return { done: true };
    },
  });
  if (!outcome.done) return cancelled;
  logger.warn('security: password changed');
  return { ok: true, message: 'Password changed.' };
}

export async function removePassword(sender: WebContents): Promise<FlowResult> {
  if (!vault.isOn()) return { ok: false, message: 'No password is set.' };
  const win = windowOf(sender);
  if (!win) return { ok: false, message: 'This can only be done from the app window.' };
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Remove password'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Remove your password',
    message: 'Remove your password and go back to Windows protection only?',
    detail: 'Any program running as your Windows user will be able to open your keys again, and authenticator codes will turn off.',
  });
  if (response !== 1) return cancelled;
  const proof = await requireProof(sender, { kind: 'security', title: 'Remove your password', detail: ['Your keys go back to being protected by your Windows account only.'] });
  if (!proof.ok) return proof;
  return vaultMigrate.disable(resealPump);
}

export async function newRecoveryCode(sender: WebContents): Promise<FlowResult> {
  const win = windowOf(sender);
  if (!win) return { ok: false, message: 'This can only be done from the app window.' };
  if (!vault.isOn()) return { ok: false, message: 'No password is set.' };
  const proof = await requireProof(sender, { kind: 'security', title: 'Replace your recovery code', detail: ['The old code stops working as soon as the new one is confirmed.'] });
  if (!proof.ok) return proof;
  const next = await vault.prepareNewRecovery();
  const view = (error?: string): PromptView => ({
    title: 'Your new recovery code',
    lines: ['Write this down and keep it somewhere safe and offline. It replaces the old code when you confirm it. If you close this window, the old code keeps working.'],
    secret: next.code,
    fields: [{ name: 'typed', label: 'Type it back to confirm', kind: 'code' }],
    submit: 'I wrote it down',
    cancel: 'Cancel',
    ...(error ? { error } : {}),
  });
  const outcome = await runPrompt({
    parent: win,
    first: view(),
    onAction: (_a, values) => {
      if (!vault.sameRecoveryCode(values.typed ?? '', next.code)) return { view: view('That does not match. Check each group.') };
      next.commit();
      return { done: true };
    },
  });
  if (!outcome.done) return cancelled;
  logger.warn('security: recovery code replaced');
  return { ok: true, message: 'Recovery code replaced. The old one no longer works.' };
}

// ── Authenticator codes ────────────────────────────────────────────────

export async function enable2fa(sender: WebContents): Promise<FlowResult> {
  const win = windowOf(sender);
  if (!win) return { ok: false, message: 'This can only be done from the app window.' };
  if (!vault.isOn()) return { ok: false, message: 'Set a password first. The authenticator secret is encrypted with it.' };
  if (securityState.totpOn()) return { ok: false, message: 'Authenticator codes are already on.' };
  const proof = await requireProof(sender, { kind: 'security', title: 'Turn on authenticator codes', detail: ['Every withdrawal, at any amount, will then need a code. So will exporting or importing a key.'] });
  if (!proof.ok) return proof;
  const secret = securityState.newSecretForEnrolment();
  const url = otpauthUrl(secret, path.basename(app.getPath('userData')));
  const homes = wallet.list().filter((w) => w.homeAddress).map((w) => `${w.label}: ${w.homeAddress}`);
  const scanView = (error?: string): PromptView => ({
    title: 'Scan this with your authenticator app',
    lines: [
      'Google Authenticator, Authy, 1Password and others all work. If you cannot scan, type this key in by hand:',
    ],
    qr: qrEncode(url),
    secret: secret.match(/.{1,4}/g)!.join(' '),
    fields: [{ name: 'code', label: 'Enter the six-digit code it shows', kind: 'code' }],
    submit: 'Turn on',
    cancel: 'Cancel',
    ...(error ? { error } : {}),
  });
  const enrol: { commit: (() => void) | null } = { commit: null };
  const outcome = await runPrompt({
    parent: win,
    first: scanView(),
    onAction: (_a, values) => {
      if (enrol.commit) {
        enrol.commit();
        return { done: true };
      }
      const r = securityState.prepareEnable(secret, values.code ?? '');
      if (!r.ok) return { view: scanView(r.message) };
      enrol.commit = r.commit;
      return {
        view: {
          title: 'Save your backup codes',
          lines: [
            'Each one works once, in place of a code from your phone. Write them down and keep them apart from your phone. Codes turn on when you press the button below.',
            ...(homes.length ? ['These withdrawal addresses were set before codes were on. Check they are yours:', ...homes] : []),
            'Authenticator codes are a check inside Krypto Bot. They stop someone using the app on your unlocked PC, or a fault in the app’s page, from moving money out or exporting keys. No server checks them, and they do not protect your keys from malware on this PC.',
          ],
          secret: r.backupCodes.join('\n'),
          fields: [],
          submit: 'I saved them',
          cancel: 'Cancel',
        },
      };
    },
  });
  if (!outcome.done) return cancelled;
  logger.warn('security: authenticator codes turned on');
  return { ok: true, message: 'Authenticator codes are on. Every withdrawal now needs one.' };
}

export async function disable2fa(sender: WebContents): Promise<FlowResult> {
  if (!securityState.totpOn()) return { ok: false, message: 'Authenticator codes are not on.' };
  const proof = await requireProof(sender, { kind: 'security', title: 'Turn off authenticator codes', detail: ['Withdrawals will no longer need a code.'], nativeWhenNone: true });
  if (!proof.ok) return proof;
  if (!securityState.disable()) return { ok: false, message: securityState.problem() ?? 'Could not save that.' };
  logger.warn('security: authenticator codes turned off');
  return { ok: true, message: 'Authenticator codes are off.' };
}

/** Lost phone, no backup codes, and no recovery code. */
export async function requestReset2fa(sender: WebContents): Promise<FlowResult> {
  const win = windowOf(sender);
  if (!win) return { ok: false, message: 'This can only be done from the app window.' };
  const first: PromptView = {
    title: 'Lost your authenticator?',
    lines: [
      'A backup code works in place of a code, and your recovery code resets everything from the lock screen. Use those if you can.',
      'Otherwise, enter your password to start a 72-hour wait. Withdrawals stay blocked until it ends, and trading and selling are not affected. If this was not you, cancel it on this page.',
    ],
    fields: [{ name: 'password', label: 'Password', kind: 'password' }],
    submit: 'Start the 72-hour wait',
    cancel: 'Cancel',
  };
  const outcome = await runPrompt({
    parent: win,
    first,
    onAction: async (_a, values) => {
      const p = await vault.checkPassword(values.password ?? '');
      if (!p.ok) return { view: { ...first, error: p.reason === 'wrong-password' ? securityState.noteWrongPassword() : p.message } };
      return { done: true };
    },
  });
  if (!outcome.done) return cancelled;
  if (!securityState.requestReset()) return { ok: false, message: securityState.problem() ?? 'Could not save that.' };
  logger.warn('security: authenticator reset requested, 72 hour wait started');
  return { ok: true, message: 'The 72-hour wait has started.' };
}

export async function cancelReset2fa(sender: WebContents): Promise<FlowResult> {
  // Cancelling only keeps protection on, so it asks for nothing beyond a window.
  if (!windowOf(sender)) return { ok: false, message: 'This can only be done from the app window.' };
  logger.warn('security: authenticator reset cancelled');
  return securityState.cancelReset() ? { ok: true, message: 'Reset cancelled.' } : { ok: false, message: 'Could not save that.' };
}

export function finishReset2fa(): FlowResult {
  const r = securityState.finishReset();
  if (r.ok) logger.warn('security: authenticator reset finished');
  return r;
}

export async function setIdle(sender: WebContents, minutes: unknown): Promise<FlowResult> {
  if (typeof minutes !== 'number' || !(IDLE_OPTIONS as readonly number[]).includes(minutes)) return { ok: false, message: 'Pick one of the options.' };
  if (!vault.isOn()) return { ok: false, message: 'The idle lock needs a password.' };
  // Turning the lock off, or making it slower, loosens protection.
  if (minutes === 0 || minutes > securityState.idleMinutes()) {
    const proof = await requireProof(sender, { kind: 'security', title: minutes === 0 ? 'Turn off the idle lock' : 'Make the idle lock slower', detail: [minutes === 0 ? 'The app will stay open until you close it.' : `It will lock after ${minutes} minutes.`] });
    if (!proof.ok) return proof;
  }
  return securityState.setIdleMinutes(minutes) ? { ok: true, message: 'Saved.' } : { ok: false, message: securityState.problem() ?? 'Could not save that.' };
}

export function lockNow(): FlowResult {
  if (!vault.isOn()) return { ok: false, message: 'Set a password first.' };
  lockScreen('locked from the Security page');
  return { ok: true, message: 'Locked.' };
}

// ── Key backup file ────────────────────────────────────────────────────

export async function exportBackup(sender: WebContents): Promise<FlowResult> {
  const win = windowOf(sender);
  if (!win) return { ok: false, message: 'This can only be done from the app window.' };
  const solana = wallet.list().length;
  const evm = evmWallet.list('robinhood').length;
  const hasAio = aioWallet.info().exists;
  if (!solana && !evm && !hasAio) return { ok: false, message: 'There are no keys to back up.' };
  const what = `${solana} Solana wallet${solana === 1 ? '' : 's'}, ${evm} EVM wallet${evm === 1 ? '' : 's'}${hasAio ? ' and your All-in-One recovery phrase' : ''}`;
  const proof = await requireProof(sender, { kind: 'keys', title: 'Back up your keys', detail: [`This writes ${what} to one encrypted file.`], nativeWhenNone: true });
  if (!proof.ok) return proof;

  const first: PromptView = {
    title: 'Choose a password for this file',
    lines: ['It protects this backup only, and can be different from your app password. Anyone with the file and this password has every key in it. Nobody can open the file without the password, including Krypt.'],
    fields: passwordFields('File password'),
    submit: 'Choose where to save',
    cancel: 'Cancel',
  };
  let password = '';
  const outcome = await runPrompt({
    parent: win,
    first,
    onAction: (_a, values) => {
      const error = newPasswordError(values);
      if (error) return { view: { ...first, error } };
      password = values.password;
      return { done: true };
    },
  });
  if (!outcome.done) return cancelled;

  const res = await dialog.showSaveDialog(win, {
    title: 'Save the encrypted key backup',
    defaultPath: `krypto-bot-${new Date().toISOString().slice(0, 10)}.${keyExport.BACKUP_EXTENSION}`,
    filters: [{ name: 'Krypto Bot key backup', extensions: [keyExport.BACKUP_EXTENSION] }],
  });
  if (res.canceled || !res.filePath) {
    password = '';
    return cancelled;
  }
  try {
    const text = await keyExport.encryptBackup(keyExport.collectPayload(), password, app.getVersion());
    durableWrite(res.filePath, text, { backup: 'none' });
    // Prove the file opens before saying it is safe to rely on.
    const back = await keyExport.decryptBackup(fs.readFileSync(res.filePath, 'utf8'), password);
    if (!back.ok) return { ok: false, message: `The file was written but did not open again (${back.message}). Do not rely on it.` };
    logger.warn(`security: encrypted key backup written (${what})`);
    const cloud = keyExport.cloudSyncedPath(res.filePath);
    return { ok: true, message: `Backed up ${what}.`, ...(cloud ? { warnings: [`That folder syncs to ${cloud}. The file is encrypted, but a copy now lives on someone else's computer.`] } : {}) };
  } catch (err) {
    return { ok: false, message: `Backup failed: ${(err as Error).message}` };
  } finally {
    password = '';
  }
}

export async function importBackup(sender: WebContents): Promise<FlowResult & { added?: number }> {
  const win = windowOf(sender);
  if (!win) return { ok: false, message: 'This can only be done from the app window.' };
  const res = await dialog.showOpenDialog(win, {
    title: 'Open a key backup',
    properties: ['openFile'],
    filters: [{ name: 'Krypto Bot key backup', extensions: [keyExport.BACKUP_EXTENSION] }],
  });
  if (res.canceled || !res.filePaths[0]) return cancelled;
  let text: string;
  try {
    // A key backup is small. Refusing a huge file keeps a wrong pick harmless.
    if (fs.statSync(res.filePaths[0]).size > 5_000_000) return { ok: false, message: 'That file is too large to be a key backup.' };
    text = fs.readFileSync(res.filePaths[0], 'utf8');
  } catch (err) {
    return { ok: false, message: `Could not read that file: ${(err as Error).message}` };
  }
  const first: PromptView = { title: 'Open the key backup', lines: ['Enter the password you chose for this file.'], fields: [{ name: 'password', label: 'File password', kind: 'password' }], submit: 'Open', cancel: 'Cancel' };
  let payload: keyExport.BackupPayload | null = null;
  const outcome = await runPrompt({
    parent: win,
    first,
    onAction: async (_a, values) => {
      const r = await keyExport.decryptBackup(text, values.password ?? '');
      if (!r.ok) return { view: { ...first, error: r.message } };
      payload = r.payload;
      return { done: true };
    },
  });
  if (!outcome.done || !payload) return cancelled;
  const opened: keyExport.BackupPayload = payload;
  const addresses = keyExport.addressesIn(opened);
  const proof = await requireProof(sender, {
    kind: 'keys',
    title: 'Import these keys',
    detail: [`${addresses.length} item${addresses.length === 1 ? '' : 's'} from the backup:`, ...addresses, 'A wallet added here can sign trades, and money can be moved to it from your other wallets. Only import keys you control. Withdrawal addresses are not restored.'],
    nativeWhenNone: true,
  });
  if (!proof.ok) return proof;
  const r = keyExport.importPayload(opened);
  logger.warn(`security: key backup imported, ${r.added} added, ${r.alreadyHeld} already held, ${r.failed.length} not added`);
  return {
    ok: r.failed.length === 0 || r.added > 0,
    message: `${r.added} added, ${r.alreadyHeld} already here.`,
    added: r.added,
    ...(r.failed.length ? { warnings: r.failed } : {}),
  };
}

// ── One plaintext key ──────────────────────────────────────────────────

/**
 * For moving ONE key to another wallet app, which needs the raw key. Separate
 * from the backup and deliberately slower: a warning, the proof, and typing the
 * phrase, so it cannot be done by reflex or by a stray click.
 */
export async function exportPlaintextKey(
  sender: WebContents,
  who: { label: string; address: string },
  defaultPath: string,
  filters: Electron.FileFilter[],
  write: (destPath: string) => { ok: boolean; message: string },
): Promise<FlowResult> {
  const win = windowOf(sender);
  if (!win) return { ok: false, message: 'This can only be done from the app window.' };
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Continue'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Export a private key',
    message: `Write the private key of "${who.label}" to an unencrypted file?`,
    detail: `${who.address}\n\nAnyone who gets this file can spend this wallet. To keep a backup, use the encrypted key backup on the Security page instead. This is for moving a key to another wallet app.`,
  });
  if (response !== 1) return cancelled;
  const proof = await requireProof(sender, { kind: 'keys', title: `Export the key of "${who.label}"`, detail: [who.address, 'It will be written to an unencrypted file.'] });
  if (!proof.ok) return proof;
  const first: PromptView = {
    title: 'Confirm the unencrypted export',
    lines: [`This will write the private key of "${who.label}" to a plain file.`, who.address],
    fields: [{ name: 'typed', label: `Type ${EXPORT_CONFIRM_PHRASE} to continue`, kind: 'text' }],
    submit: 'Choose where to save',
    cancel: 'Cancel',
    danger: true,
  };
  const typed = await runPrompt({
    parent: win,
    first,
    onAction: (_a, values) => (values.typed?.trim() === EXPORT_CONFIRM_PHRASE ? { done: true } : { view: { ...first, error: `Type ${EXPORT_CONFIRM_PHRASE} exactly.` } }),
  });
  if (!typed.done) return cancelled;
  const res = await dialog.showSaveDialog(win, { title: 'Save the private key (unencrypted)', defaultPath, filters });
  if (res.canceled || !res.filePath) return cancelled;
  const r = write(res.filePath);
  if (!r.ok) return r;
  logger.warn(`security: plaintext key export of ${who.address}`);
  const cloud = keyExport.cloudSyncedPath(res.filePath);
  return { ok: true, message: `Exported. Delete that file once you have imported the key.`, ...(cloud ? { warnings: [`That folder syncs to ${cloud}, so an unencrypted key is now on someone else's computer. Move this wallet's funds to a new wallet if you did not intend that.`] } : {}) };
}

/** Show a recovery phrase in the security window. It never reaches the page. */
export async function showPhrase(sender: WebContents, phrase: string, firstTime: boolean): Promise<boolean> {
  const win = windowOf(sender);
  if (!win) return false;
  const words = phrase.split(' ');
  const outcome = await runPrompt({
    parent: win,
    first: {
      title: firstTime ? 'Write down your recovery phrase' : 'Your recovery phrase',
      lines: [`These ${words.length} words ARE the wallet, on every chain. Write them on paper, in order, and keep them offline. They also open this wallet in Phantom and MetaMask. Anyone who sees them can take everything in it, and nobody, including Krypt, can recover it without them.`],
      secret: words.map((w, i) => `${String(i + 1).padStart(2, ' ')}. ${w}`).join('\n'),
      fields: [],
      submit: firstTime ? 'I wrote them down' : 'Close',
      cancel: firstTime ? 'Later' : null,
    },
    onAction: () => ({ done: true }),
  });
  return outcome.done;
}
