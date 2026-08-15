import { describe, expect, it } from 'vitest';
import { hasMinFields, splitTsv, tsvField } from './tsv.js';

describe('tsvField', () => {
  const line = '/type/author\t/authors/OL1A\t1\t2026-01-01T00:00:00Z\t{"name":"A"}';

  it('extracts the nth field', () => {
    expect(tsvField(line, 0)).toBe('/type/author');
    expect(tsvField(line, 1)).toBe('/authors/OL1A');
    expect(tsvField(line, 4)).toBe('{"name":"A"}');
  });

  it('returns null when the field does not exist', () => {
    expect(tsvField('a\tb', 2)).toBeNull();
    expect(tsvField('a', 1)).toBeNull();
  });

  it('returns an empty string for an existing empty field', () => {
    expect(tsvField('a\t\tc', 1)).toBe('');
  });
});

describe('splitTsv', () => {
  it('keeps the JSON payload intact for a well-formed OL line (5 fields)', () => {
    const line = '/type/author\t/authors/OL1A\t1\t2026-01-01T00:00:00Z\t{"name":"A","bio":"long"}';
    expect(splitTsv(line, 5)).toEqual([
      '/type/author',
      '/authors/OL1A',
      '1',
      '2026-01-01T00:00:00Z',
      '{"name":"A","bio":"long"}',
    ]);
  });

  it('stops scanning after the limit-th separator', () => {
    const line = 'a\tb\tc\td\te';
    expect(splitTsv(line, 5)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('hasMinFields', () => {
  it('is equivalent to split().length >= n, including empty/edge fields', () => {
    const cases = ['a\tb\tc\td\te', 'a\tb\tc\td', 'a\tb\tc\td\t', 'a\t\t\t\t', 'a', ''];
    for (const line of cases) {
      const split = line.split('\t').length >= 5;
      expect(hasMinFields(line, 5)).toBe(split);
    }
  });
});
