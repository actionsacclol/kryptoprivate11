// Translations — the rules that keep eight catalogues from drifting apart.
//
// None of this checks whether a translation is GOOD; nothing automated can,
// and pretending otherwise is how apps ship confident nonsense. It checks the
// things that are objectively checkable and that break silently: keys that do
// not exist, placeholders that were dropped or renamed in translation, and a
// locale list that claims a language it does not carry.
//
// The placeholder rule is the one that matters for money. `waiver.hold` is the
// only translated string with a number in it, and a catalogue that lost its
// `{amount}` would render "Hold  $KRYPTO to remove this fee" — a sentence
// about someone's money with the number silently missing.

import assert from 'node:assert';
import { en, LOCALES, coverage, isLocaleId, resolveSystemLocale, t } from './.i18n.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const KEYS = Object.keys(en);
const TRANSLATIONS = LOCALES.filter((l) => l.id !== 'en');

{
  assert.ok(KEYS.length > 50, `the English catalogue is populated (${KEYS.length} keys)`);
  for (const [k, v] of Object.entries(en)) {
    assert.ok(typeof v === 'string' && v.trim() !== '', `en.${k} is a non-empty string`);
  }
  ok(`English defines ${KEYS.length} keys, none of them blank`);
}

{
  // A key in a translation that English does not have is dead weight at best
  // and a typo at worst — it will never be looked up.
  for (const { id } of TRANSLATIONS) {
    for (const k of KEYS) {
      const v = t(id, k);
      assert.ok(typeof v === 'string' && v.trim() !== '', `${id}.${k} resolves to something`);
    }
  }
  ok('every key resolves in every locale — missing ones fall back to English');
}

{
  // The rule that protects the one number we translate.
  for (const { id } of [...TRANSLATIONS, { id: 'en' }]) {
    for (const k of KEYS) {
      const source = en[k];
      const translated = t(id, k);
      const want = [...source.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const got = [...translated.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(got, want, `${id}.${k}: placeholders must match English exactly (${want.join()} vs ${got.join()})`);
    }
  }
  ok('no translation drops, renames or invents a {placeholder}');
}

{
  // Interpolation itself, including the case that must NOT blank out.
  assert.equal(t('en', 'waiver.hold', { amount: '1,000,000' }), 'Hold 1,000,000 $KRYPTO to remove this fee');
  assert.ok(t('zh-CN', 'waiver.hold', { amount: '1,000,000' }).includes('1,000,000'), 'the amount survives translation');
  // A missing value leaves the placeholder visible rather than printing a gap
  // where a number belongs.
  assert.ok(t('en', 'waiver.hold', {}).includes('{amount}'), 'a value that was not supplied is visible, not blank');
  ok('interpolation fills what it is given and never silently blanks a number');
}

{
  assert.equal(resolveSystemLocale('pt-BR'), 'pt-BR');
  assert.equal(resolveSystemLocale('pt-PT'), 'pt-BR', 'European Portuguese lands on the one we carry');
  assert.equal(resolveSystemLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(resolveSystemLocale('zh-TW'), 'zh-CN', 'Traditional falls to Simplified, not to English');
  assert.equal(resolveSystemLocale('es-419'), 'es', 'Latin American Spanish matches on the base language');
  assert.equal(resolveSystemLocale('ko-KR'), 'ko');
  assert.equal(resolveSystemLocale('ja-JP'), 'en', 'a language we do not carry is English, not a crash');
  assert.equal(resolveSystemLocale(''), 'en');
  assert.equal(resolveSystemLocale(null), 'en');
  assert.equal(resolveSystemLocale(undefined), 'en');
  ok('the OS locale resolves to something we actually ship, always');
}

{
  assert.ok(isLocaleId('system'));
  assert.ok(isLocaleId('zh-CN'));
  assert.ok(!isLocaleId('zh'), 'a bare base tag is not a locale id we store');
  assert.ok(!isLocaleId('klingon'));
  assert.ok(!isLocaleId(''));
  assert.ok(!isLocaleId(null));
  assert.ok(!isLocaleId(42));
  ok('only a locale that ships can be stored in settings');
}

{
  assert.equal(coverage('en'), 1, 'English is complete by definition');
  for (const { id, endonym, english } of TRANSLATIONS) {
    const c = coverage(id);
    assert.ok(c > 0 && c <= 1, `${id} coverage is a fraction (${c})`);
    // The endonym is what someone scans for; an English-only row would be
    // invisible to the person it is for.
    assert.ok(endonym && endonym !== english, `${id} has a real endonym, not the English name`);
  }
  const complete = TRANSLATIONS.filter((l) => coverage(l.id) === 1).length;
  ok(`${complete}/${TRANSLATIONS.length} translations are complete, and coverage is honest about the rest`);
}

console.log(`\ni18n: ${passed}/${passed} passed`);
