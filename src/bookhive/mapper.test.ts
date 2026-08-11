import { describe, it, expect } from 'vitest';
import { catalogBookToBookData, type BookhiveCatalogRecord } from './mapper.js';

const baseRecord = (): BookhiveCatalogRecord => ({
  $type: 'buzz.bookhive.catalogBook',
  id: 'M5fR8aBcDeFgHiJkLmNoP',
  title: 'Dune',
  authors: 'Frank Herbert',
  thumbnail: 'https://bookhive.buzz/covers/M5fR8-thumb.jpg',
  cover: 'https://bookhive.buzz/covers/M5fR8-full.jpg',
  description: 'A desert planet. A boy who would be prophet.',
  genres: ['Science Fiction', 'Epic'],
  identifiers: {
    isbn13: '9780441172719',
    isbn10: '0441172717',
    goodreadsId: '17347618',
  },
  source: 'goodreads',
  sourceId: '17347618',
  sourceUrl: 'https://www.goodreads.com/book/show/17347618',
  rating: 4500,
  ratingsCount: 10234,
  series: 'Dune Chronicles',
  createdAt: '2026-01-15T12:00:00.000Z',
  updatedAt: '2026-02-20T18:30:00.000Z',
});

describe('catalogBookToBookData', () => {
  it('maps a fully populated record', () => {
    const out = catalogBookToBookData(baseRecord());
    expect(out.title).toBe('Dune');
    expect(out.author).toBe('Frank Herbert');
    expect(out.description).toBe('A desert planet. A boy who would be prophet.');
    expect(out.coverUrl).toBe('https://bookhive.buzz/covers/M5fR8-thumb.jpg');
    expect(out.categories).toEqual(['Science Fiction', 'Epic']);
    expect(out.isbn).toBe('9780441172719');
    expect(out.hiveId).toBe('M5fR8aBcDeFgHiJkLmNoP');
    expect(out.contributors).toEqual([{ name: 'Frank Herbert', order: 0 }]);
    expect(out.identifiers).toEqual([
      { type: 'hiveId', value: 'M5fR8aBcDeFgHiJkLmNoP' },
      { type: 'isbn13', value: '9780441172719' },
      { type: 'isbn10', value: '0441172717' },
      { type: 'goodreadsId', value: '17347618' },
    ]);
  });

  it('drops BookHive-only fields (rating, source, series, etc.)', () => {
    const out = catalogBookToBookData(baseRecord());
    expect(out).not.toHaveProperty('rating');
    expect(out).not.toHaveProperty('ratingsCount');
    expect(out).not.toHaveProperty('source');
    expect(out).not.toHaveProperty('sourceId');
    expect(out).not.toHaveProperty('sourceUrl');
    expect(out).not.toHaveProperty('series');
  });

  it('falls back to isbn10 when isbn13 is absent', () => {
    const rec = baseRecord();
    rec.identifiers!.isbn13 = undefined;
    rec.identifiers!.isbn10 = '0441172717';
    const out = catalogBookToBookData(rec);
    expect(out.isbn).toBe('0441172717');
  });

  it('leaves isbn undefined when no identifiers are present', () => {
    const rec = baseRecord();
    rec.identifiers = {};
    expect(catalogBookToBookData(rec).isbn).toBeUndefined();
  });

  it('falls back from thumbnail to cover', () => {
    const rec = baseRecord();
    rec.thumbnail = undefined;
    expect(catalogBookToBookData(rec).coverUrl).toBe(
      'https://bookhive.buzz/covers/M5fR8-full.jpg',
    );
  });

  it('leaves coverUrl undefined when both thumbnail and cover are missing', () => {
    const rec = baseRecord();
    rec.thumbnail = undefined;
    rec.cover = undefined;
    expect(catalogBookToBookData(rec).coverUrl).toBeUndefined();
  });

  it('joins tab-separated authors with ", " in legacy author field', () => {
    const rec = baseRecord();
    rec.authors = 'Alice\tBob\tCarol';
    const out = catalogBookToBookData(rec);
    expect(out.author).toBe('Alice, Bob, Carol');
    expect(out.contributors).toEqual([
      { name: 'Alice', order: 0 },
      { name: 'Bob', order: 1 },
      { name: 'Carol', order: 2 },
    ]);
  });

  it('trims whitespace and skips empty author entries', () => {
    const rec = baseRecord();
    rec.authors = '  Alice  \t\t  Bob  \t  \tCarol\t';
    const out = catalogBookToBookData(rec);
    expect(out.author).toBe('Alice, Bob, Carol');
    expect(out.contributors).toEqual([
      { name: 'Alice', order: 0 },
      { name: 'Bob', order: 1 },
      { name: 'Carol', order: 2 },
    ]);
  });

  it('produces a deterministic URI for the same hiveId', () => {
    const a = catalogBookToBookData(baseRecord());
    const b = catalogBookToBookData(baseRecord());
    expect(a.uri).toBe(b.uri);
    expect(a.uri).toMatch(/^at:\/\/[^/]+\/community\.lexicon\.book\.book\/[a-z0-9]{13}$/);
  });

  it('returns empty contributors array when authors string is empty', () => {
    const rec = baseRecord();
    rec.authors = '';
    const out = catalogBookToBookData(rec);
    expect(out.contributors).toEqual([]);
    expect(out.author).toBe('');
  });

  it('records the sourceUri as a hiveBookUri identifier when provided', () => {
    const out = catalogBookToBookData(baseRecord(), {
      sourceUri: 'at://did:plc:enu2j5xjlqsjaylv3du4myh4/buzz.bookhive.catalogBook/3jabc',
    });
    const types = out.identifiers.map((i) => i.type);
    expect(types).toContain('hiveBookUri');
    expect(out.identifiers.find((i) => i.type === 'hiveBookUri')!.value).toBe(
      'at://did:plc:enu2j5xjlqsjaylv3du4myh4/buzz.bookhive.catalogBook/3jabc',
    );
  });
});
