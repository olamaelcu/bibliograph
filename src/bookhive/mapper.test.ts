import { describe, it, expect } from 'vitest';
import {
  catalogBookToBookData,
  bookhiveUserBookToReadingStatus,
  bookhiveUserBookToReview,
  type BookhiveCatalogRecord,
  type BookhiveUserBookRecord,
} from './mapper.js';

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

const baseUserBookRecord = (): BookhiveUserBookRecord => ({
  $type: 'buzz.bookhive.book',
  title: 'Dune',
  authors: 'Frank Herbert',
  hiveId: 'M5fR8aBcDeFgHiJkLmNoP',
  hiveBookUri: 'at://did:plc:enu2j5xjlqsjaylv3du4myh4/buzz.bookhive.catalogBook/bk_abc',
  status: 'buzz.bookhive.defs#finished',
  stars: 8,
  review: 'A masterpiece of worldbuilding.',
  bookProgress: {
    percent: 100,
    currentPage: 412,
    totalPages: 412,
    updatedAt: '2026-02-20T18:30:00.000Z',
  },
  startedAt: '2026-01-10T00:00:00.000Z',
  finishedAt: '2026-02-20T18:30:00.000Z',
  identifiers: {
    isbn13: '9780441172719',
    isbn10: '0441172717',
    goodreadsId: '17347618',
  },
  createdAt: '2026-01-10T00:00:00.000Z',
});

describe('bookhiveUserBookToReadingStatus', () => {
  it('maps a fully-populated record', () => {
    const out = bookhiveUserBookToReadingStatus(baseUserBookRecord(), {
      userDid: 'did:plc:user1',
    });
    expect(out.title).toBe('Dune');
    expect(out.author).toBe('Frank Herbert');
    expect(out.hiveId).toBe('M5fR8aBcDeFgHiJkLmNoP');
    expect(out.status).toBe('read');
    expect(out.rating).toBe(4);
    expect(out.progress).toBe(100);
    expect(out.startedAt).toBe('2026-01-10T00:00:00.000Z');
    expect(out.finishedAt).toBe('2026-02-20T18:30:00.000Z');
    expect(out.review).toBe('A masterpiece of worldbuilding.');
    expect(out.userDid).toBe('did:plc:user1');
    expect(out.bookProgress).toEqual({
      percent: 100,
      currentPage: 412,
      totalPages: 412,
      updatedAt: '2026-02-20T18:30:00.000Z',
    });
    expect(out.identifiers).toEqual([
      { type: 'hiveId', value: 'M5fR8aBcDeFgHiJkLmNoP' },
      { type: 'isbn13', value: '9780441172719' },
      { type: 'isbn10', value: '0441172717' },
      { type: 'goodreadsId', value: '17347618' },
    ]);
  });

  it('translates each BookHive status token to Bibliograph status', () => {
    const cases: Array<[string, string]> = [
      ['buzz.bookhive.defs#finished', 'read'],
      ['buzz.bookhive.defs#reading', 'reading'],
      ['buzz.bookhive.defs#wantToRead', 'to-read'],
      ['buzz.bookhive.defs#abandoned', 'abandoned'],
    ];
    for (const [bookhive, bibliograph] of cases) {
      const rec = baseUserBookRecord();
      rec.status = bookhive;
      const out = bookhiveUserBookToReadingStatus(rec, { userDid: 'did:plc:u' });
      expect(out.status).toBe(bibliograph);
    }
  });

  it('defaults to null status for unknown token', () => {
    const rec = baseUserBookRecord();
    rec.status = 'buzz.bookhive.defs#nonsense';
    const out = bookhiveUserBookToReadingStatus(rec, { userDid: 'did:plc:u' });
    expect(out.status).toBeNull();
  });

  it('scales 1-10 stars to 1-5 rating (rounds)', () => {
    for (const [stars, rating] of [
      [1, 1],
      [3, 2],
      [5, 3],
      [8, 4],
      [10, 5],
    ] as Array<[number, number]>) {
      const rec = baseUserBookRecord();
      rec.stars = stars;
      const out = bookhiveUserBookToReadingStatus(rec, { userDid: 'did:plc:u' });
      expect(out.rating).toBe(rating);
    }
  });

  it('leaves rating null when stars is absent', () => {
    const rec = baseUserBookRecord();
    rec.stars = undefined;
    const out = bookhiveUserBookToReadingStatus(rec, { userDid: 'did:plc:u' });
    expect(out.rating).toBeNull();
  });

  it('handles missing bookProgress', () => {
    const rec = baseUserBookRecord();
    rec.bookProgress = undefined;
    const out = bookhiveUserBookToReadingStatus(rec, { userDid: 'did:plc:u' });
    expect(out.progress).toBeNull();
    expect(out.bookProgress).toBeNull();
  });

  it('joins tab-separated authors for bookAuthor', () => {
    const rec = baseUserBookRecord();
    rec.authors = 'Alice	Bob';
    const out = bookhiveUserBookToReadingStatus(rec, { userDid: 'did:plc:u' });
    expect(out.author).toBe('Alice, Bob');
  });
});

describe('bookhiveUserBookToReview', () => {
  it('maps a record with review text and stars', () => {
    const out = bookhiveUserBookToReview(baseUserBookRecord(), {
      userDid: 'did:plc:user1',
    });
    expect(out).not.toBeNull();
    expect(out!.userDid).toBe('did:plc:user1');
    expect(out!.title).toBe('Dune');
    expect(out!.author).toBe('Frank Herbert');
    expect(out!.text).toBe('A masterpiece of worldbuilding.');
    expect(out!.rating).toBe(4);
  });

  it('returns null when there is no review text', () => {
    const rec = baseUserBookRecord();
    rec.review = undefined;
    const out = bookhiveUserBookToReview(rec, { userDid: 'did:plc:u' });
    expect(out).toBeNull();
  });
});
