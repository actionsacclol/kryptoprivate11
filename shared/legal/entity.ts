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
// 2026-09-18: a governing-language clause (Terms 15) and two new flagged
// clickwrap points - the sanctions/eligibility representation, and that the
// documents are English-only. Material, so it re-prompts everyone, which is
// the point: the old acceptance hashed text that did not contain them.
// 2026-09-20: the Links panel shows a token's own X, website and launchpad
// pages INSIDE the software (privacy section 4). A new flow of the user's
// requests and cookies to third parties they did not choose one by one is
// material, so it re-prompts.
// Same day, .2: for a token someone opens, the software now fetches its
// Telegram link's public preview (t.me) and its website domain's registry
// record (RDAP, via data.iana.org). New hosts receive requests, so it
// re-prompts.
// Same day, .3: token metadata (the file with a coin's image and links) is
// fetched from ipfs.4everland.io and ipfs.filebase.io as well as ipfs.io;
// cloudflare-ipfs.com, which the policy named, no longer exists. Two new
// hosts receive requests, so it re-prompts.
// 2026-09-21.1: the fee section promised a referral share was sent "in the
// same transaction" with no exceptions. Three real ones exist in the code —
// a recipient that cannot receive it, a transaction already at its size
// limit, and an address that is unusable as a referral — so the terms now
// name them. Nothing about what the user pays changed.
// 2026-09-22.1: pump.fun accounts were never described — signing in, what
// pump then publishes under the account (callouts, profile, follows, likes).
// Same version, before release: every pump account is referred by Krypt's
// pump.fun account (terms › Fees, the summary's fee point, privacy).
export const TERMS_VERSION = '2026-09-22.1';

/** Shown as "Last updated" on every document. Keep in step with TERMS_VERSION. */
export const TERMS_EFFECTIVE_DATE = '22 September 2026';

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
