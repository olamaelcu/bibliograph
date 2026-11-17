/**
 * Discovery harness — target 1: `packages/worker/lib/record-fields.js`.
 *
 * Properties are stated from the module's doc comments alone; no assertion
 * copies the production loop. Run: `node --test proptest/record-fields.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  clippedText,
  isoCalendarDate,
  canonicalIdentifiers,
  httpUrl
} from '../packages/worker/lib/record-fields.js';

const RUNS = 10_000;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const graphemes = (text) => Array.from(SEGMENTER.segment(text), (part) => part.segment);
const utf8 = (text) => Buffer.byteLength(text, 'utf8');

/** Text pieces that make grapheme, byte and trim boundaries disagree. */
const PIECES = [
  'a',
  'b',
  'Z',
  ' ',
  '  ',
  '\t',
  '\n',
  '\r\n',
  '\u00a0',
  'e\u0301',
  '\u0301',
  'é',
  'ß',
  '中',
  '👩‍👩‍👧‍👦',
  '👩👩👧👦',
  '🧑🏽‍🚀',
  '🇺🇳',
  '🐈‍⬛',
  '\u200b',
  '\u200d',
  '\u00ad',
  '\ud800',
  '\udc00'
];

const pieceText = fc.array(fc.constantFrom(...PIECES), { maxLength: 6 }).map((parts) => parts.join(''));
const binaryText = fc.string({ unit: 'binary', maxLength: 8 });
const anyText = fc.oneof({ arbitrary: pieceText, weight: 3 }, { arbitrary: binaryText, weight: 1 });

const maxGraphemesArb = fc.integer({ min: 0, max: 8 });
const maxBytesArb = fc.integer({ min: 0, max: 32 });

// ---------------------------------------------------------------------------
// clippedText
// ---------------------------------------------------------------------------

test('clippedText: grapheme and byte bounds, prefix, grapheme alignment, maximality', () => {
  fc.assert(
    fc.property(anyText, maxGraphemesArb, maxBytesArb, (value, maxGraphemes, maxBytes) => {
      const result = clippedText(value, { maxGraphemes, maxBytes });
      const trimmed = value.trim();
      const parts = graphemes(trimmed);

      if (result === undefined) {
        assert.ok(
          trimmed === '' || maxGraphemes < 1 || utf8(parts[0]) > maxBytes,
          `undefined for a value that had room: value=${JSON.stringify(value)} maxGraphemes=${maxGraphemes} maxBytes=${maxBytes}`
        );
        return;
      }

      assert.ok(typeof result === 'string' && result !== '');
      assert.ok(
        trimmed.startsWith(result),
        `result is not a prefix of the trimmed value: ${JSON.stringify(result)} vs ${JSON.stringify(trimmed)}`
      );
      assert.ok(
        utf8(result) <= maxBytes,
        `byte bound broken: ${utf8(result)} > ${maxBytes} for ${JSON.stringify(result)}`
      );
      const kept = graphemes(result);
      assert.ok(
        kept.length <= maxGraphemes,
        `grapheme bound broken: ${kept.length} > ${maxGraphemes} for ${JSON.stringify(result)}`
      );
      assert.strictEqual(
        parts.slice(0, kept.length).join(''),
        result,
        `result is not a whole-grapheme prefix of ${JSON.stringify(trimmed)}`
      );

      // Maximality, modulo the trailing-whitespace strip the clip applies to its
      // own prefix: the next non-whitespace grapheme cannot be added.
      let nextReal = kept.length;
      while (nextReal < parts.length && parts[nextReal].trim() === '') nextReal += 1;
      if (nextReal < parts.length) {
        const extended = parts.slice(0, nextReal + 1).join('');
        assert.ok(
          nextReal + 1 > maxGraphemes || utf8(extended) > maxBytes,
          `clip is not maximal: ${JSON.stringify(result)} could take ${JSON.stringify(parts[nextReal])} (maxGraphemes=${maxGraphemes} maxBytes=${maxBytes})`
        );
      }
    }),
    { numRuns: RUNS }
  );
});

// ---------------------------------------------------------------------------
// isoCalendarDate
// ---------------------------------------------------------------------------

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year, month) => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
};

/** Oracle: shape first, then the calendar, from a leap table — no `Date`. */
const expectedDate = (value) => {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return trimmed;
};

const INTERESTING_YEARS = [0, 1, 99, 100, 400, 1900, 1999, 2000, 2023, 2024, 2100, 2400, 9999];

const dateCandidate = fc
  .tuple(
    fc.oneof(
      { arbitrary: fc.constantFrom(...INTERESTING_YEARS), weight: 2 },
      { arbitrary: fc.integer({ min: 0, max: 9999 }), weight: 1 }
    ),
    fc.integer({ min: 0, max: 13 }),
    fc.integer({ min: 0, max: 32 })
  )
  .map(
    ([year, month, day]) =>
      `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  );

const nearDate = fc.oneof(
  { arbitrary: dateCandidate, weight: 3 },
  {
    arbitrary: fc
      .tuple(dateCandidate, fc.constantFrom('', ' ', '\n', 'x', 'T00:00:00Z', '-01', '\u00a0'))
      .map(([candidate, suffix]) => `${candidate}${suffix}`),
    weight: 1
  },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 11 }), weight: 1 }
);

test('isoCalendarDate: exact YYYY-MM-DD and a real calendar day, per an independent leap table', () => {
  fc.assert(
    fc.property(nearDate, (value) => {
      assert.strictEqual(
        isoCalendarDate(value),
        expectedDate(value),
        `for ${JSON.stringify(value)}`
      );
    }),
    { numRuns: RUNS }
  );
});

test('isoCalendarDate: every century boundary and Feb 29 rule', () => {
  const cases = [
    '0000-02-29',
    '0100-02-29',
    '0190-02-29',
    '1900-02-29',
    '2000-02-29',
    '2023-02-29',
    '2024-02-29',
    '2100-02-29',
    '2400-02-29',
    '9999-12-31',
    '2023-04-31',
    '2023-13-01',
    '2023-00-10',
    '2023-01-00'
  ];
  for (const value of cases) {
    assert.strictEqual(isoCalendarDate(value), expectedDate(value), value);
  }
});

// ---------------------------------------------------------------------------
// canonicalIdentifiers
// ---------------------------------------------------------------------------

const NAME_PARTS = [
  'a',
  'A',
  'b',
  'ab',
  'a\u200bb',
  'e\u0301',
  'é',
  'reseau',
  'réseau',
  '中',
  '🇺🇳',
  '👩‍👩‍👧‍👦',
  '👩👩👧👦',
  'id',
  'ID',
  '0',
  '00',
  ' ',
  '',
  '  x  ',
  '\t'
];

const URLS = [undefined, undefined, '', ' ', '\t', 'https://example.org/x', 'http://a.example', 'not-a-url'];

const rawIdentifier = fc.record({
  issuer: fc.constantFrom(...NAME_PARTS),
  value: fc.constantFrom(...NAME_PARTS),
  url: fc.constantFrom(...URLS)
});

const rawEntry = fc.oneof(
  { arbitrary: rawIdentifier, weight: 4 },
  { arbitrary: fc.constantFrom(null, 7, 'junk', undefined), weight: 1 }
);

const rawEntries = fc.array(rawEntry, { maxLength: 6 });

/** Trim-or-drop, as the lexicon shape requires. Not the production helper. */
const normalize = (value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** The input as a set of entries: dedupe by key, first `url` wins. */
const asEntrySet = (input) => {
  const seen = new Map();
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object') continue;
    const issuer = normalize(entry.issuer);
    const value = normalize(entry.value);
    if (issuer === undefined || value === undefined) continue;
    const key = `${issuer}\u0000${value}`;
    if (seen.has(key)) continue;
    const url = normalize(entry.url) === undefined ? undefined : entry.url;
    seen.set(key, url === undefined ? { issuer, value } : { issuer, value, url });
  }
  return [...seen.values()];
};

const shuffledWith = fc.tuple(fc.array(fc.nat(), { maxLength: 8 }));

const shuffleBy = (items, keys) => {
  const keyed = items.map((item, index) => ({ item, key: keys[index] ?? index }));
  keyed.sort((left, right) => left.key - right.key);
  return keyed.map(({ item }) => item);
};

test('canonicalIdentifiers: set equality, first-url rule, unique keys, idempotence', () => {
  fc.assert(
    fc.property(rawEntries, (input) => {
      const expected = asEntrySet(input);
      const actual = canonicalIdentifiers(input);

      assert.equal(actual.length, expected.length, `for ${JSON.stringify(input)}`);

      const byKey = new Map(actual.map((entry) => [`${entry.issuer}\u0000${entry.value}`, entry]));
      assert.equal(byKey.size, actual.length, `duplicate key in ${JSON.stringify(actual)}`);

      for (const entry of expected) {
        const key = `${entry.issuer}\u0000${entry.value}`;
        const found = byKey.get(key);
        assert.ok(found !== undefined, `missing ${key} (input ${JSON.stringify(input)})`);
        assert.equal(
          found.url,
          entry.url,
          `first url not preserved for ${key} (input ${JSON.stringify(input)})`
        );
      }

      assert.deepStrictEqual(
        canonicalIdentifiers(actual),
        actual,
        `not idempotent for ${JSON.stringify(actual)}`
      );
    }),
    { numRuns: RUNS }
  );
});

test('canonicalIdentifiers: the same set always serializes the same way', () => {
  fc.assert(
    fc.property(rawEntries, shuffledWith, (input, keys) => {
      const entrySet = asEntrySet(input);
      const shuffled = shuffleBy(entrySet, keys);
      assert.deepStrictEqual(
        canonicalIdentifiers(shuffled),
        canonicalIdentifiers(entrySet),
        `input order changed the canonical array: ${JSON.stringify(entrySet)} vs ${JSON.stringify(shuffled)}`
      );
    }),
    { numRuns: RUNS }
  );
});

// ---------------------------------------------------------------------------
// httpUrl
// ---------------------------------------------------------------------------

const expectedUrl = (value) => {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined;
};

const urlCandidates = fc.oneof(
  { arbitrary: anyText, weight: 3 },
  {
    arbitrary: fc
      .tuple(
        fc.constantFrom('http://', 'https://', 'ftp://', 'HTTP://', 'mailto:', '', 'http:/', '//'),
        fc.constantFrom('example.org', 'a', '127.0.0.1:80', '[::1]', 'ex ample', 'é.example', ''),
        fc.constantFrom('', '/x', '?q=1', '#f', '\n', ' ')
      )
      .map(([scheme, host, tail]) => `${scheme}${host}${tail}`),
    weight: 2
  }
);

test('httpUrl: returns the trimmed input iff it parses with http:/https:', () => {
  fc.assert(
    fc.property(urlCandidates, (value) => {
      assert.strictEqual(httpUrl(value), expectedUrl(value), `for ${JSON.stringify(value)}`);
    }),
    { numRuns: RUNS }
  );
});
