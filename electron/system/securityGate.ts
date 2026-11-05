// requireProof: the one check every gated IPC handler calls. Lives in main, and
// takes nothing from the page except who is asking, so there is no flag or code
// a compromised page can send to skip it.
//
// Scripts, the AI connection and chat bots have no window on the default session,
// so they can neither raise this prompt nor pass it.

import { BrowserWindow, dialog, session, type WebContents } from 'electron';
import { proofLevel, type ProofKind } from '@shared/securityPolicy';
import { logger } from './logger';
import { runPrompt, type PromptField } from './securityPrompt';
import * as securityState from './securityState';
import * as vault from './vault';

export type ProofResult = { ok: true } | { ok: false; message: string };

export interface ProofRequest {
  kind: ProofKind;
  /** "Withdraw 1.2 SOL". The action, in words main wrote. */
  title: string;
  /** The exact address and amount, so a code is bound to what the user read. */
  detail: string[];
  /** This handler has no native dialog of its own, so show one when no password
   *  or code is set. Without this a level of `none` passes straight through. */
  nativeWhenNone?: boolean;
}

export function windowOf(sender: WebContents): BrowserWindow | null {
  if (sender.getType() !== 'window' || sender.session !== session.defaultSession) return null;
  return BrowserWindow.fromWebContents(sender);
}

export async function requireProof(sender: WebContents, req: ProofRequest): Promise<ProofResult> {
  const win = windowOf(sender);
  if (!win) {
    logger.warn(`security: refused "${req.title}" from something that is not an app window`);
    return { ok: false, message: 'This can only be done from the app window.' };
  }
  const stateProblem = securityState.problem();
  if (stateProblem) return { ok: false, message: stateProblem };

  const level = proofLevel(req.kind, vault.isOn(), securityState.totpOn());
  if (level === 'none') {
    if (!req.nativeWhenNone) return { ok: true };
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Confirm'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: req.title,
      message: req.title,
      detail: `${req.detail.join('\n')}\n\nIf you did not just ask for this in Krypto Bot, press Cancel.`,
    });
    if (response !== 1) {
      logger.warn(`security: "${req.title}" cancelled at the confirmation dialog`);
      return { ok: false, message: 'Cancelled' };
    }
    return { ok: true };
  }

  const fields: PromptField[] = [];
  if (level === 'password' || level === 'password+code') fields.push({ name: 'password', label: 'App password', kind: 'password' });
  if (level === 'code' || level === 'password+code') {
    fields.push({ name: 'code', label: 'Authenticator code', kind: 'code', hint: 'Six digits from your authenticator app, or one of your backup codes.' });
  }
  const view = {
    title: req.title,
    lines: [...req.detail, 'If you did not just ask for this in Krypto Bot, press Cancel.'],
    fields,
    submit: 'Confirm',
    cancel: 'Cancel',
  };
  const outcome = await runPrompt({
    parent: win,
    first: view,
    onAction: async (_action, values) => {
      const locked = securityState.lockedOutMessage();
      if (locked) return { view: { ...view, error: locked } };
      if (level === 'password' || level === 'password+code') {
        const p = await vault.checkPassword(values.password ?? '');
        if (!p.ok) {
          const message = p.reason === 'wrong-password' ? securityState.noteWrongPassword() : p.message;
          return { view: { ...view, error: message } };
        }
      }
      if (level === 'code' || level === 'password+code') {
        const c = securityState.verifyCode(values.code ?? '');
        if (!c.ok) return { view: { ...view, error: c.message } };
      }
      return { done: true };
    },
  });
  if (outcome.done) {
    logger.warn(`security: proof given for "${req.title}"`);
    return { ok: true };
  }
  if (outcome.value === 'busy') return { ok: false, message: 'Finish the other security window first.' };
  if (outcome.value === 'load-failed') return { ok: false, message: 'The security window could not open, so this was not done.' };
  logger.warn(`security: "${req.title}" cancelled at the proof window`);
  return { ok: false, message: 'Cancelled' };
}
