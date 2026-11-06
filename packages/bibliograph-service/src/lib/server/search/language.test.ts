import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toGbLangRestrict,
  pgLanguageVariants,
  languageOf,
} from './language';

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

test('languageOf: picks language OR originalLanguage, lowercased', () => {
  assert.equal(languageOf({ language: 'Eng' }), 'eng');
  assert.equal(languageOf({ originalLanguage: 'eng' }), 'eng');
  assert.equal(languageOf({}), undefined);
  assert.equal(languageOf({ language: null, originalLanguage: null }), undefined);
});

test('languageOf: prefers language over originalLanguage', () => {
  assert.equal(languageOf({ language: 'en', originalLanguage: 'eng' }), 'en');
});
