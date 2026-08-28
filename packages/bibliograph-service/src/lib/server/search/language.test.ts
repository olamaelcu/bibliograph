import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toOlLanguage,
  toGbLangRestrict,
  pgLanguageVariants,
  translateOlLanguages,
  languageOf,
} from './language';

test('toOlLanguage: ISO 639-1 → MARC21', () => {
  assert.equal(toOlLanguage('en'), 'eng');
  assert.equal(toOlLanguage('fr'), 'fre');
  assert.equal(toOlLanguage('de'), 'ger');
  assert.equal(toOlLanguage('zh'), 'chi');
  assert.equal(toOlLanguage('nl'), 'dut');
});

test('toOlLanguage: case insensitive + trimmed', () => {
  assert.equal(toOlLanguage('EN'), 'eng');
  assert.equal(toOlLanguage('  fr  '), 'fre');
});

test('toOlLanguage: BCP-47 region tag strips to base lang', () => {
  assert.equal(toOlLanguage('en-US'), 'eng');
  assert.equal(toOlLanguage('pt-BR'), 'por');
  assert.equal(toOlLanguage('zh-Hant'), 'chi');
});

test('toOlLanguage: MARC input passes through', () => {
  assert.equal(toOlLanguage('eng'), 'eng');
  assert.equal(toOlLanguage('fre'), 'fre');
});

test('toOlLanguage: unknown / invalid returns null (fail-closed)', () => {
  assert.equal(toOlLanguage(''), null);
  assert.equal(toOlLanguage('xx'), null);
  assert.equal(toOlLanguage('not-a-tag'), null);
  assert.equal(toOlLanguage('123'), null);
});

test('toGbLangRestrict: 2-letter ISO passes through', () => {
  assert.equal(toGbLangRestrict('en'), 'en');
  assert.equal(toGbLangRestrict('fr'), 'fr');
  assert.equal(toGbLangRestrict('EN'), 'en');
});

test('toGbLangRestrict: BCP-47 strips region', () => {
  assert.equal(toGbLangRestrict('en-US'), 'en');
  assert.equal(toGbLangRestrict('pt-BR'), 'pt');
});

test('toGbLangRestrict: MARC3 → ISO 639-1', () => {
  assert.equal(toGbLangRestrict('eng'), 'en');
  assert.equal(toGbLangRestrict('fre'), 'fr');
  assert.equal(toGbLangRestrict('chi'), 'zh');
});

test('toGbLangRestrict: invalid → null', () => {
  assert.equal(toGbLangRestrict(''), null);
  assert.equal(toGbLangRestrict('xx'), null);
  assert.equal(toGbLangRestrict('!!!'), null);
});

test('pgLanguageVariants: en expands to en/eng', () => {
  const v = pgLanguageVariants(['en']);
  assert.deepEqual(new Set(v), new Set(['en', 'eng']));
});

test('pgLanguageVariants: en-US expands to en, eng, en-us', () => {
  const v = pgLanguageVariants(['en-US']);
  assert.deepEqual(new Set(v), new Set(['en', 'eng', 'en-us']));
});

test('pgLanguageVariants: multiple tags union (no dups)', () => {
  const v = pgLanguageVariants(['en', 'fr']);
  assert.deepEqual(new Set(v), new Set(['en', 'eng', 'fr', 'fre']));
});

test('pgLanguageVariants: MARC3 input also emits ISO 639-1 base', () => {
  const v = pgLanguageVariants(['eng']);
  assert.deepEqual(new Set(v), new Set(['eng', 'en']));
});

test('pgLanguageVariants: empty / all-invalid returns []', () => {
  assert.deepEqual(pgLanguageVariants([]), []);
  assert.deepEqual(pgLanguageVariants(['!!!', '']), []);
});

test('pgLanguageVariants: dedups', () => {
  const v = pgLanguageVariants(['en', 'eng', 'EN']);
  assert.deepEqual(new Set(v), new Set(['en', 'eng']));
});

test('translateOlLanguages: returns MARC list deduped', () => {
  assert.deepEqual(translateOlLanguages(['en', 'fr']), ['eng', 'fre']);
  assert.deepEqual(translateOlLanguages(['en-US', 'fr']), ['eng', 'fre']);
});

test('translateOlLanguages: drops unmapped tags (fail-closed)', () => {
  assert.deepEqual(translateOlLanguages(['xx']), []);
  assert.deepEqual(translateOlLanguages(['en', 'xx']), ['eng']);
});

test('languageOf: picks language OR originalLanguage, lowercased', () => {
  assert.equal(languageOf({ language: 'Eng' }), 'eng');
  assert.equal(languageOf({ originalLanguage: 'eng' }), 'eng');
  assert.equal(languageOf({}), undefined);
  assert.equal(languageOf({ language: null, originalLanguage: null }), undefined);
});

test('languageOf: prefers language over originalLanguage', () => {
  assert.equal(languageOf({ language: 'en', originalLanguage: 'eng' }), 'en');
});
