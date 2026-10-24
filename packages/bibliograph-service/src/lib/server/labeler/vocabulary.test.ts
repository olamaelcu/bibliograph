import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMINISTRATOR_LABEL,
  CONTROVERSIAL_LABEL,
  KNOWN_LABELS,
  LABEL_DEFINITIONS,
  SENIOR_LIBRARIAN_LABEL,
  isKnownLabel,
  subjectMatches,
} from './vocabulary';
import { seniorityPolicy } from './seniority';

test('every declared label matches the protocol value charset', () => {
  for (const value of KNOWN_LABELS) {
    // Spec: lowercase a-z and dash only for custom values; `!` is reserved.
    assert.match(value, /^[a-z-]+$/, `${value} is not a valid label value`);
    assert.ok(Buffer.byteLength(value) <= 128);
    assert.equal(value.startsWith('!'), false, 'reserved prefix must not be used');
  }
});

test('definitions declare all behavior fields', () => {
  for (const [value, def] of Object.entries(LABEL_DEFINITIONS)) {
    assert.equal(def.identifier, value);
    assert.ok(['alert', 'inform', 'none'].includes(def.severity));
    assert.ok(['content', 'media', 'none'].includes(def.blurs));
    assert.ok(['hide', 'warn', 'ignore'].includes(def.defaultSetting));
    assert.equal(typeof def.adultOnly, 'boolean');
    assert.ok(def.subjects.length > 0);
    assert.ok(def.locales.length > 0);
    assert.ok(def.locales[0]!.name.length > 0);
    assert.ok(def.locales[0]!.description.length > 0);
  }
});

test('credential labels never blur content and stay informational', () => {
  // A badge that says nothing about the subject's content must not hide it.
  for (const label of [ADMINISTRATOR_LABEL, SENIOR_LIBRARIAN_LABEL]) {
    const def = LABEL_DEFINITIONS[label];
    assert.equal(def.blurs, 'none');
    assert.equal(def.severity, 'inform');
    assert.deepEqual([...def.subjects], ['account']);
  }
});

test('controversial is record-scoped and surfaced by default', () => {
  const def = LABEL_DEFINITIONS[CONTROVERSIAL_LABEL];
  assert.deepEqual([...def.subjects], ['record']);
  assert.equal(def.defaultSetting, 'warn');
  assert.equal(def.blurs, 'none', 'the book itself is not hidden');
});

test('subject kind is enforced', () => {
  assert.equal(subjectMatches(ADMINISTRATOR_LABEL, 'did:plc:abc'), true);
  assert.equal(subjectMatches(ADMINISTRATOR_LABEL, 'at://did:plc:abc/x/y'), false);
  assert.equal(subjectMatches(CONTROVERSIAL_LABEL, 'at://did:web:cat/community.lexicon.book.work/ol.W1'), true);
  assert.equal(subjectMatches(CONTROVERSIAL_LABEL, 'did:plc:abc'), false);
});

test('unknown values are rejected', () => {
  assert.equal(isKnownLabel('librarian'), true);
  assert.equal(isKnownLabel('senior-librarian'), true);
  assert.equal(isKnownLabel('librarien'), false);
  assert.equal(isKnownLabel('!hide'), false, 'global values are not ours to define');
});

test('seniority thresholds default and clamp', () => {
  assert.deepEqual(seniorityPolicy(undefined, undefined), { minDays: 365, minVotes: 10 });
  assert.deepEqual(seniorityPolicy('180', '3'), { minDays: 180, minVotes: 3 });
  assert.deepEqual(seniorityPolicy('nonsense', '-4'), { minDays: 365, minVotes: 10 });
  // Zero is a legitimate "everyone qualifies" setting, not a typo.
  assert.deepEqual(seniorityPolicy('0', '0'), { minDays: 0, minVotes: 0 });
});
