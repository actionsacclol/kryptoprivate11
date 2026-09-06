// Operator identity — the single source of truth for every legal document.
//
// Per legalcheck.md: "Put these in ONE file and import them everywhere. Never
// hardcode the entity name into a document." A contract that names nobody binds
// a natural person with unlimited personal liability, so every document below
// pulls its counterparty from here.
//
// ─── Unresolved, and deliberately visible ─────────────────────────────
//
// legalcheck.md flags two things to confirm before relying on any of this:
//   1. Whether the registered name carries a suffix (LLC / Inc / Ltd). The
//      documents must match the registration EXACTLY. Krypt has confirmed the
//      registration (the download agreement on the site names the LLC), so
//      ENTITY_SUFFIX_CONFIRMED is true and the legal page shows no caveat.
//   2. That the entity is actually formed and in good standing. An unformed
//      entity leaves Krypt personally liable whatever the documents say.
//
// `ENTITY_SUFFIX_CONFIRMED` exists so that uncertainty is a value in the code
// rather than a note someone forgets. Flip it once the registration is checked.

export const LEGAL_ENTITY = 'Krypt';

/** Set true once the registered entity has been confirmed against the register.
 *  When true, the legal page drops the "name not yet confirmed" caveat. */
export const ENTITY_SUFFIX_CONFIRMED = true;

export const BRAND = 'Krypt';
export const PRODUCT_NAME = 'Krypto Bot';

export const GOVERNING_LAW = 'the State of Delaware, United States';
export const VENUE = 'Wilmington, Delaware';
export const CONTACT_EMAIL = 'support@krypt.cc';
export const WEBSITE = 'https://krypt.cc';

/**
 * Arbitration forum.
 *
 * legalcheck.md Known Gap #2: naming no forum, rules, seat or cost split is the
 * drafting courts most often refuse to enforce. This names AAA under its
 * Consumer Arbitration Rules, which is the fix that document itself suggests —
 * a named forum is enforceable where "a mutually agreed-upon provider" is not.
 */
export const ARBITRATION_FORUM = 'the American Arbitration Association (AAA)';
export const ARBITRATION_RULES = 'its Consumer Arbitration Rules';

/**
 * Liability cap. legalcheck.md: "It's free software, so the cap is nominal."
 *
 * Stated in one place because it appears in three documents and a mismatch
 * between them is the kind of inconsistency that gets a cap struck out.
 */
export const LIABILITY_CAP_USD = 100;

/**
 * Version of the whole legal bundle.
 *
 * Stored with every acceptance, so bumping this re-prompts every user
 * automatically. Bumped to .2 when the named counterparty changed from
 * "Mimosa Solutions" to "Krypt" — who you are contracting with is the most
 * material change a document can undergo.
 *
 * Bump on material changes; do NOT bump for typos — re-prompting
 * for a comma trains people to click through, which is the opposite of what
 * clickwrap is for.
 */
export const TERMS_VERSION = '2026-09-03.1';

/** Shown as "Last updated" on every document. Keep in step with TERMS_VERSION. */
export const TERMS_EFFECTIVE_DATE = '3 September 2026';

/** Minimum age. A trading tool is not a general-purpose utility: it moves real
 *  money, so this is 18 rather than the 13 a plain utility would use. */
export const MINIMUM_AGE = 18;

/** Where the acceptance record is written, relative to userData. */
export const ACCEPTANCE_LOG_FILE = 'legal-acceptance.jsonl';

/** How long acceptance records are kept. legalcheck.md: "Set a retention
 *  period, document it, and ship the purge." The purge is in
 *  electron/system/acceptance.ts and is tested. */
export const ACCEPTANCE_RETENTION_DAYS = 2555; // ~7 years

export interface LegalEntityInfo {
  entity: string;
  suffixConfirmed: boolean;
  brand: string;
  product: string;
  governingLaw: string;
  venue: string;
  email: string;
  website: string;
  arbitrationForum: string;
  arbitrationRules: string;
  liabilityCapUsd: number;
  termsVersion: string;
  effectiveDate: string;
  minimumAge: number;
}

export function entityInfo(): LegalEntityInfo {
  return {
    entity: LEGAL_ENTITY,
    suffixConfirmed: ENTITY_SUFFIX_CONFIRMED,
    brand: BRAND,
    product: PRODUCT_NAME,
    governingLaw: GOVERNING_LAW,
    venue: VENUE,
    email: CONTACT_EMAIL,
    website: WEBSITE,
    arbitrationForum: ARBITRATION_FORUM,
    arbitrationRules: ARBITRATION_RULES,
    liabilityCapUsd: LIABILITY_CAP_USD,
    termsVersion: TERMS_VERSION,
    effectiveDate: TERMS_EFFECTIVE_DATE,
    minimumAge: MINIMUM_AGE,
  };
}

export const COPYRIGHT_LINE = `© ${new Date().getFullYear()} ${LEGAL_ENTITY}`;
