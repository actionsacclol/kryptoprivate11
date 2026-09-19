// The active language, and `t()` bound to it.
//
// Reads the persisted setting and resolves 'system' against the browser's own
// locale — in Electron that is the OS's, which is the answer someone means
// when they have not chosen. Resolution happens HERE rather than being saved,
// so a user who moves their machine to another language follows it instead of
// being pinned to whatever it said the day they installed.
//
// There is no context and no provider: `t` is a pure function and the locale
// is one string, so a hook that reads the settings the app already holds is
// the whole thing.

import { useCallback, useMemo } from 'react';
import { resolveSystemLocale, t as translate, type LocaleId, type MessageKey } from '@shared/i18n';
import { useAppState } from './AppStateProvider';

export interface LocaleState {
  /** What is stored — may be 'system'. */
  setting: LocaleId;
  /** What is actually in use — never 'system'. */
  active: Exclude<LocaleId, 'system'>;
  /** Translate. Missing keys fall back to English, never to a blank. */
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  /** Persist a choice. 'system' means follow the OS from now on. */
  set: (next: LocaleId) => void;
}

export function useLocale(): LocaleState {
  const { settings, updateSettings } = useAppState();
  const setting: LocaleId = settings.locale ?? 'system';
  const active = useMemo(
    () =>
      setting === 'system'
        ? resolveSystemLocale(typeof navigator === 'undefined' ? null : navigator.language)
        : setting,
    [setting],
  );
  const t = useCallback(
    (key: MessageKey, values?: Record<string, string | number>) => translate(active, key, values),
    [active],
  );
  const set = useCallback(
    (next: LocaleId) => {
      void updateSettings({ locale: next });
    },
    [updateSettings],
  );
  return { setting, active, t, set };
}
