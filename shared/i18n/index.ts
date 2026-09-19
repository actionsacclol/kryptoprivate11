// Translation lookup. No dependencies, no I/O, no framework — `t()` is a pure
// function of (locale, key, values), which is what makes it testable and what
// lets main and the renderer share one implementation.
//
// Locales are BUNDLED, not fetched. This app has no backend and its whole
// trust story is that it does not phone home; downloading strings at runtime
// would be a network call that could be intercepted to rewrite what the app
// says about someone's money.

import { en, type Catalogue, type MessageKey } from './en';
import { zhCN } from './zh-CN';
import { ko } from './ko';
import { ru } from './ru';
import { es } from './es';
import { ptBR } from './pt-BR';
import { tr } from './tr';
import { vi } from './vi';

export type { MessageKey, Catalogue };
export { en };

/** `system` means "ask the OS", resolved once at startup. */
export type LocaleId = 'system' | 'en' | 'zh-CN' | 'ko' | 'ru' | 'es' | 'pt-BR' | 'tr' | 'vi';

export interface LocaleMeta {
  id: Exclude<LocaleId, 'system'>;
  /** The language's name IN that language — nobody looks for "Chinese" in a
   *  list they cannot read. */
  endonym: string;
  /** English name, for the settings row's second line. */
  english: string;
}

export const LOCALES: LocaleMeta[] = [
  { id: 'en', endonym: 'English', english: 'English' },
  { id: 'zh-CN', endonym: '简体中文', english: 'Chinese (Simplified)' },
  { id: 'ko', endonym: '한국어', english: 'Korean' },
  { id: 'ru', endonym: 'Русский', english: 'Russian' },
  { id: 'es', endonym: 'Español', english: 'Spanish' },
  { id: 'pt-BR', endonym: 'Português (Brasil)', english: 'Portuguese (Brazil)' },
  { id: 'tr', endonym: 'Türkçe', english: 'Turkish' },
  { id: 'vi', endonym: 'Tiếng Việt', english: 'Vietnamese' },
];

const CATALOGUES: Record<Exclude<LocaleId, 'system'>, Catalogue> = {
  en,
  'zh-CN': zhCN,
  ko,
  ru,
  es,
  'pt-BR': ptBR,
  tr,
  vi,
};

export function isLocaleId(v: unknown): v is LocaleId {
  return v === 'system' || LOCALES.some((l) => l.id === v);
}

/**
 * Turn whatever the OS reports into one of ours.
 *
 * `navigator.language` and Electron's `app.getLocale()` return things like
 * `pt-BR`, `zh-Hans-CN`, `es-419`. Exact match first, then the base language,
 * then English — a locale we do not carry is not an error, it is English.
 */
export function resolveSystemLocale(raw: string | null | undefined): Exclude<LocaleId, 'system'> {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 'en';
  const exact = LOCALES.find((l) => l.id.toLowerCase() === s.toLowerCase());
  if (exact) return exact.id;
  const base = s.split('-')[0].toLowerCase();
  // Chinese: any Simplified-ish tag lands on zh-CN. Traditional is NOT carried,
  // and sending a Traditional reader to Simplified is better than to English.
  if (base === 'zh') return 'zh-CN';
  if (base === 'pt') return 'pt-BR';
  const byBase = LOCALES.find((l) => l.id.split('-')[0].toLowerCase() === base);
  return byBase ? byBase.id : 'en';
}

/**
 * Look up a message.
 *
 * Falls back to English for any key a translation has not filled in, so a
 * half-finished locale is usable rather than broken. `{name}` placeholders are
 * replaced from `values`; a placeholder with no value is LEFT ALONE rather
 * than blanked, because an empty space where a number should be is the exact
 * failure this codebase spends its comments preventing.
 */
export function t(
  locale: Exclude<LocaleId, 'system'>,
  key: MessageKey,
  values?: Record<string, string | number>,
): string {
  const table = CATALOGUES[locale] ?? en;
  const raw = table[key] ?? en[key];
  if (!values) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = values[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/**
 * How much of a locale is actually translated, 0..1.
 *
 * Shown next to a language that is not finished, because someone choosing a
 * half-translated language should know that is what they are getting rather
 * than discovering it one English screen at a time.
 */
export function coverage(locale: Exclude<LocaleId, 'system'>): number {
  if (locale === 'en') return 1;
  const keys = Object.keys(en) as MessageKey[];
  const table = CATALOGUES[locale] ?? {};
  const done = keys.filter((k) => typeof table[k] === 'string' && table[k] !== '').length;
  return keys.length === 0 ? 1 : done / keys.length;
}
