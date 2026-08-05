import { describe, it, expect } from 'vitest';
import { toBookData, type DumpEditionRecord } from './edition-mapper.js';

const baseRecord = (): DumpEditionRecord => ({
  key: '/books/OL1M',
  type: '/type/edition',
  title: 'Dune',
  authors: [{ key: '/authors/OL1A', name: 'Frank Herbert' }],
  isbn_13: ['9780441172719'],
  isbn_10: ['0441172717'],
  publish_date: 'August 1, 1965',
  number_of_pages: 412,
  publishers: ['Chilton Books'],
  subjects: ['Science Fiction', 'Epic'],
  covers: [12345],
});

describe('editionMapper.toBookData', () => {
  it('maps a fully populated record', () => {
    const data = toBookData(baseRecord())!;
    expect(data.title).toBe('Dune');
    expect(data.author).toBe('Frank Herbert');
    expect(data.isbn13).toBe('9780441172719');
    expect(data.isbn10).toBe('0441172717');
    expect(data.publishedDate).toBe('August 1, 1965');
    expect(data.pageCount).toBe(412);
    expect(data.categories).toEqual(['Science Fiction', 'Epic']);
    expect(data.coverUrl).toBe('https://covers.openlibrary.org/b/id/12345-M.jpg');
    expect(data.identifiers['openlibrary']).toBe('/books/OL1M');
    expect(data.sourceProvider).toBe('openlibrary');
  });

  it('returns null when no ISBN-13 and no ISBN-10', () => {
    const r = baseRecord();
    delete r.isbn_13;
    delete r.isbn_10;
    expect(toBookData(r)).toBeNull();
  });

  it('accepts ISBN-10 only', () => {
    const r = baseRecord();
    delete r.isbn_13;
    const data = toBookData(r)!;
    expect(data.isbn13).toBeUndefined();
    expect(data.isbn10).toBe('0441172717');
  });

  it('defaults author to "Unknown" when authors is missing', () => {
    const r = baseRecord();
    delete r.authors;
    expect(toBookData(r)!.author).toBe('Unknown');
  });

  it('defaults title to "Unknown Title" when title is missing', () => {
    const r = baseRecord();
    delete r.title;
    expect(toBookData(r)!.title).toBe('Unknown Title');
  });

  it('returns coverUrl undefined when no covers', () => {
    const r = baseRecord();
    delete r.covers;
    expect(toBookData(r)!.coverUrl).toBeUndefined();
  });

  it('limits categories to 5 entries', () => {
    const r = baseRecord();
    r.subjects = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(toBookData(r)!.categories).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('omits categories when neither subjects nor subject_places is present', () => {
    const r = baseRecord();
    delete r.subjects;
    expect(toBookData(r)!.categories).toBeUndefined();
  });

  it('falls back to subject_places when subjects is absent', () => {
    const r = baseRecord();
    delete r.subjects;
    r.subject_places = ['Arrakis'];
    expect(toBookData(r)!.categories).toEqual(['Arrakis']);
  });

  it('returns null when the record is not an object', () => {
    expect(toBookData(null as any)).toBeNull();
    expect(toBookData(undefined as any)).toBeNull();
    expect(toBookData(123 as any)).toBeNull();
    expect(toBookData('string' as any)).toBeNull();
  });

  it('returns null when type or key is missing or wrong-typed', () => {
    expect(toBookData({} as any)).toBeNull();
    expect(toBookData({ key: 1, type: '/type/edition' } as any)).toBeNull();
    expect(toBookData({ key: '/books/OL1M', type: 999 } as any)).toBeNull();
  });
});
