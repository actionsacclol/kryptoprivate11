// The Send address book (2026-10-03). Pure: shape, parsing, and the checks
// that warn before money goes somewhere unexpected.
//
// Address poisoning is the attack this exists for: someone sends you dust
// from an address that starts and ends like one you use, hoping you copy it
// from your history next time. The middle is what differs. So a recipient
// that shares the first AND last four characters with a known address but is
// NOT that address is warned about in words — in the review and in the
// native confirmation.

export type AddressFamily = 'solana' | 'evm';

export interface SendContact {
  id: string;
  label: string;
  family: AddressFamily;
  address: string;
  addedAt: number;
}

export interface SendHistoryRow {
  at: number;
  /** The chain the send was on. */
  chain: 'solana' | 'bnb' | 'robinhood';
  to: string;
  token: string | null;
  amountText: string;
  txid: string | null;
  ok: boolean;
}

export interface SendBook {
  contacts: SendContact[];
  history: SendHistoryRow[];
}

export const MAX_CONTACTS = 200;
export const MAX_HISTORY = 200;

export const familyOf = (chain: 'solana' | 'bnb' | 'robinhood'): AddressFamily => (chain === 'solana' ? 'solana' : 'evm');

/** EVM addresses compare case-blind (the case is only a checksum); Solana's exactly. */
export function sameAddress(family: AddressFamily, a: string, b: string): boolean {
  return family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A label as typed, made safe to show: no control/bidi characters, one line, short. */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  return t.length > 40 ? t.slice(0, 40) : t;
}

export function parseSendBook(raw: unknown): SendBook | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.contacts) || !Array.isArray(o.history)) return null;
  const contacts: SendContact[] = [];
  for (const c of o.contacts as Array<Record<string, unknown>>) {
    const label = cleanLabel(c?.label);
    if (!label || typeof c.id !== 'string' || typeof c.address !== 'string' || (c.family !== 'solana' && c.family !== 'evm')) continue;
    contacts.push({ id: c.id, label, family: c.family, address: c.address, addedAt: typeof c.addedAt === 'number' ? c.addedAt : 0 });
  }
  const history: SendHistoryRow[] = [];
  for (const h of o.history as Array<Record<string, unknown>>) {
    if (typeof h?.to !== 'string' || typeof h.at !== 'number') continue;
    if (h.chain !== 'solana' && h.chain !== 'bnb' && h.chain !== 'robinhood') continue;
    history.push({
      at: h.at,
      chain: h.chain,
      to: h.to,
      token: typeof h.token === 'string' ? h.token : null,
      amountText: typeof h.amountText === 'string' ? h.amountText.slice(0, 80) : '',
      txid: typeof h.txid === 'string' ? h.txid : null,
      ok: h.ok === true,
    });
  }
  return { contacts: contacts.slice(0, MAX_CONTACTS), history: history.slice(0, MAX_HISTORY) };
}

/** What the book knows about a recipient — and what it fears. */
export interface RecipientCheck {
  /** The saved name for exactly this address, if any. */
  contact: SendContact | null;
  /** Sent to before (a successful send, from the history). */
  knownRecipient: boolean;
  /** A KNOWN address this one imitates: same first and last 4, different middle. */
  lookalike: { address: string; label: string | null } | null;
  /** Exactly one of the app's OWN addresses (a wallet, a withdrawal address). */
  own: { address: string; label: string | null } | null;
}

/**
 * `own`: the app's own addresses in this family — every wallet it holds a
 * key for, and the withdrawal addresses the user saved. The address most
 * likely to be imitated is the one a user has been withdrawing to for months,
 * and before v6 audit (2026-10-03) the check never looked at it.
 *
 * A saved contact alone no longer makes an address "known": the page can
 * write the book, so only a send that actually went through clears the
 * first-time line (the native dialog is the one place that must not be
 * talked into trusting an address).
 */
export function checkRecipient(book: SendBook, family: AddressFamily, to: string, ownAddresses: Array<{ address: string; label: string | null }> = []): RecipientCheck {
  const contact = book.contacts.find((c) => c.family === family && sameAddress(family, c.address, to)) ?? null;
  const sentBefore = book.history.some((h) => h.ok && familyOf(h.chain) === family && sameAddress(family, h.to, to));
  const norm = (a: string): string => (family === 'evm' ? a.toLowerCase() : a);
  const t = norm(to);
  const own = ownAddresses.find((o) => norm(o.address) === t) ?? null;
  let lookalike: RecipientCheck['lookalike'] = null;
  const known: Array<{ address: string; label: string | null }> = [
    ...ownAddresses,
    ...book.contacts.filter((c) => c.family === family).map((c) => ({ address: c.address, label: c.label })),
    ...book.history.filter((h) => h.ok && familyOf(h.chain) === family).map((h) => ({ address: h.to, label: null })),
  ];
  for (const k of known) {
    const a = norm(k.address);
    if (a === t || a.length < 10) continue;
    if (a.slice(0, 4) === t.slice(0, 4) && a.slice(-4) === t.slice(-4)) {
      lookalike = k;
      break;
    }
  }
  return { contact, knownRecipient: sentBefore || own !== null, lookalike, own };
}

/** The review / dialog lines for a recipient check. */
export function recipientWarnings(c: RecipientCheck): string[] {
  const out: string[] = [];
  if (c.lookalike) {
    out.push(
      `CAREFUL: this address looks like ${c.lookalike.label ? `“${c.lookalike.label}” ` : ''}${c.lookalike.address} — same start and end, DIFFERENT middle. That is how address poisoning works. Check every character.`,
    );
  }
  if (c.own) out.push(`This is your own ${c.own.label ?? 'address'}.`);
  if (!c.knownRecipient) out.push('You have not sent to this address before.');
  return out;
}
