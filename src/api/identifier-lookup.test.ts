import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, clearAllTables, seedBook, type TestDb } from '../test-utils/db.js';
import { parseIdentifierInput, resolveBooksByIdentifier } from './identifier-lookup.js';

describe('api/identifier-lookup', () => {
  describe('parseIdentifierInput', () => {
    describe('AT-URI', () => {
      it('returns at-uri kind for an at:// URI', () => {
        const result = parseIdentifierInput('at://did:plc:abc/community.lexicon.book.book/xyz');
        expect(result).toEqual({
          kind: 'at-uri',
          uri: 'at://did:plc:abc/community.lexicon.book.book/xyz',
        });
      });

      it('trims surrounding whitespace from at:// URI', () => {
        const result = parseIdentifierInput('  at://did:plc:abc/community.lexicon.book.book/xyz  ');
        expect(result?.kind).toBe('at-uri');
      });
    });

    describe('ISBN', () => {
      it('parses urn:isbn: form and normalizes digits', () => {
        const result = parseIdentifierInput('urn:isbn:978-0-441-17271-9');
        expect(result).toEqual({ kind: 'isbn', value: '9780441172719' });
      });

      it('parses bare ISBN-13', () => {
        const result = parseIdentifierInput('9780441172719');
        expect(result).toEqual({ kind: 'isbn', value: '9780441172719' });
      });

      it('parses dashed ISBN-13', () => {
        const result = parseIdentifierInput('978-0-441-17271-9');
        expect(result).toEqual({ kind: 'isbn', value: '9780441172719' });
      });

      it('parses bare ISBN-10', () => {
        const result = parseIdentifierInput('0441172717');
        expect(result).toEqual({ kind: 'isbn', value: '0441172717' });
      });

      it('parses ISBN-10 with X checksum', () => {
        const result = parseIdentifierInput('080442957X');
        expect(result).toEqual({ kind: 'isbn', value: '080442957X' });
      });

      it('parses dashed ISBN-10', () => {
        const result = parseIdentifierInput('0-441-17271-7');
        expect(result).toEqual({ kind: 'isbn', value: '0441172717' });
      });

      it('rejects too-short digit strings', () => {
        const result = parseIdentifierInput('12345');
        expect(result).toBeNull();
      });

      it('rejects too-long digit strings', () => {
        const result = parseIdentifierInput('12345678901234');
        expect(result).toBeNull();
      });
    });

    describe('OpenLibrary IDs', () => {
      it('parses bare OLID with M suffix as edition key', () => {
        const result = parseIdentifierInput('OL1234567M');
        expect(result).toEqual({
          kind: 'identifier',
          type: 'openlibrary',
          value: '/books/OL1234567M',
        });
      });

      it('parses bare OLID with W suffix as work key', () => {
        const result = parseIdentifierInput('OL1234567W');
        expect(result).toEqual({
          kind: 'identifier',
          type: 'openlibrary',
          value: '/works/OL1234567W',
        });
      });

      it('parses lowercase OLID (case-insensitive)', () => {
        const result = parseIdentifierInput('ol1234567w');
        expect(result).toEqual({ kind: 'identifier', type: 'openlibrary', value: '/works/OL1234567W' });
      });

      it('parses /works/OL..W path form', () => {
        const result = parseIdentifierInput('/works/OL1234567W');
        expect(result).toEqual({
          kind: 'identifier',
          type: 'openlibrary',
          value: '/works/OL1234567W',
        });
      });

      it('parses /books/OL..M path form', () => {
        const result = parseIdentifierInput('/books/OL1234567M');
        expect(result).toEqual({
          kind: 'identifier',
          type: 'openlibrary',
          value: '/books/OL1234567M',
        });
      });

      it('parses urn:olid:OL.. form', () => {
        const result = parseIdentifierInput('urn:olid:OL1234567W');
        expect(result).toEqual({ kind: 'identifier', type: 'openlibrary', value: '/works/OL1234567W' });
      });

      it('parses urn:openlibrary:OL.. form', () => {
        const result = parseIdentifierInput('urn:openlibrary:OL1234567M');
        expect(result).toEqual({ kind: 'identifier', type: 'openlibrary', value: '/books/OL1234567M' });
      });

      it('parses urn:openlibrary:/works/OL.. form (with internal path)', () => {
        const result = parseIdentifierInput('urn:openlibrary:/works/OL1234567W');
        expect(result).toEqual({ kind: 'identifier', type: 'openlibrary', value: '/works/OL1234567W' });
      });

      it('parses https://openlibrary.org/works/OL..W URL', () => {
        const result = parseIdentifierInput('https://openlibrary.org/works/OL1234567W');
        expect(result).toEqual({ kind: 'identifier', type: 'openlibrary', value: '/works/OL1234567W' });
      });

      it('parses http://openlibrary.org/books/OL..M URL', () => {
        const result = parseIdentifierInput('http://openlibrary.org/books/OL1234567M');
        expect(result).toEqual({ kind: 'identifier', type: 'openlibrary', value: '/books/OL1234567M' });
      });

      it('parses www.openlibrary.org URL', () => {
        const result = parseIdentifierInput('https://www.openlibrary.org/works/OL1234567W');
        expect(result).toEqual({ kind: 'identifier', type: 'openlibrary', value: '/works/OL1234567W' });
      });

      it('rejects OL.. key without W/M suffix', () => {
        const result = parseIdentifierInput('OL1234567');
        expect(result).toBeNull();
      });

      it('rejects OLID with no suffix letter', () => {
        const result = parseIdentifierInput('OL12345');
        expect(result).toBeNull();
      });
    });

    describe('Google Books', () => {
      it('parses https://books.google.com/books?id=... URL', () => {
        const result = parseIdentifierInput('https://books.google.com/books?id=abc123');
        expect(result).toEqual({
          kind: 'identifier',
          type: 'googleBooks',
          value: 'abc123',
        });
      });

      it('parses ?id= when id is later in the query', () => {
        const result = parseIdentifierInput('https://books.google.com/books?hl=en&id=abc123&printsec=frontcover');
        expect(result).toEqual({ kind: 'identifier', type: 'googleBooks', value: 'abc123' });
      });

      it('parses www.google.com/books/edition/... URL', () => {
        const result = parseIdentifierInput('https://www.google.com/books/edition/_/abc123');
        expect(result).toEqual({
          kind: 'identifier',
          type: 'googleBooks',
          value: 'abc123',
        });
      });
    });

    describe('Goodreads', () => {
      it('parses urn:goodreads:NN form', () => {
        const result = parseIdentifierInput('urn:goodreads:12345');
        expect(result).toEqual({
          kind: 'identifier',
          type: 'goodreads',
          value: '12345',
        });
      });
    });

    describe('DOI', () => {
      it('parses urn:doi:10.x/y form', () => {
        const result = parseIdentifierInput('urn:doi:10.1234/abc');
        expect(result).toEqual({
          kind: 'identifier',
          type: 'doi',
          value: '10.1234/abc',
        });
      });

      it('parses bare DOI 10.x/y form', () => {
        const result = parseIdentifierInput('10.1234/abc');
        expect(result).toEqual({
          kind: 'identifier',
          type: 'doi',
          value: '10.1234/abc',
        });
      });
    });

    describe('ASIN / EAN / ISSN / OCLC / LCCN', () => {
      it('parses urn:asin:B00XYZ123 form', () => {
        const result = parseIdentifierInput('urn:asin:B00XYZ123');
        expect(result).toEqual({ kind: 'identifier', type: 'asin', value: 'B00XYZ123' });
      });

      it('parses urn:ean: form', () => {
        const result = parseIdentifierInput('urn:ean:5901234123457');
        expect(result).toEqual({ kind: 'identifier', type: 'ean', value: '5901234123457' });
      });

      it('parses urn:issn: form', () => {
        const result = parseIdentifierInput('urn:issn:0317-8471');
        expect(result).toEqual({ kind: 'identifier', type: 'issn', value: '0317-8471' });
      });

      it('parses urn:oclc: form', () => {
        const result = parseIdentifierInput('urn:oclc:123456');
        expect(result).toEqual({ kind: 'identifier', type: 'oclc', value: '123456' });
      });

      it('parses urn:lccn: form', () => {
        const result = parseIdentifierInput('urn:lccn:2020123456');
        expect(result).toEqual({ kind: 'identifier', type: 'lccn', value: '2020123456' });
      });
    });

    describe('invalid input', () => {
      it('returns null for empty string', () => {
        expect(parseIdentifierInput('')).toBeNull();
      });

      it('returns null for whitespace only', () => {
        expect(parseIdentifierInput('   ')).toBeNull();
      });

      it('returns null for unparseable garbage', () => {
        expect(parseIdentifierInput('not-a-real-identifier')).toBeNull();
      });

      it('returns null for https URL not from a known provider', () => {
        expect(parseIdentifierInput('https://example.com/foo/bar')).toBeNull();
      });
    });
  });

  describe('resolveBooksByIdentifier', () => {
    let testDb: TestDb;

    beforeEach(() => {
      testDb = createTestDb();
      clearAllTables(testDb.db);
    });

    it('returns single book by AT-URI', async () => {
      const uri = seedBook(testDb.db, { uri: 'at://did:plc:a/community.lexicon.book.book/u1' });
      const rows = await resolveBooksByIdentifier(testDb.db, uri);
      expect(rows).toHaveLength(1);
      expect(rows[0].uri).toBe(uri);
    });

    it('returns single book by ISBN (urn form)', async () => {
      seedBook(testDb.db, { isbn: '9780441172719', identifiers: [] });
      const rows = await resolveBooksByIdentifier(testDb.db, 'urn:isbn:9780441172719');
      expect(rows).toHaveLength(1);
      expect(rows[0].isbn).toBe('9780441172719');
    });

    it('returns single book by ISBN (bare form)', async () => {
      seedBook(testDb.db, { isbn: '9780441172719', identifiers: [] });
      const rows = await resolveBooksByIdentifier(testDb.db, '9780441172719');
      expect(rows).toHaveLength(1);
    });

    it('returns single book by ISBN (dashed form)', async () => {
      seedBook(testDb.db, { isbn: '9780441172719', identifiers: [] });
      const rows = await resolveBooksByIdentifier(testDb.db, '978-0-441-17271-9');
      expect(rows).toHaveLength(1);
    });

    it('returns single book by OLID edition key', async () => {
      seedBook(testDb.db, {
        identifiers: [{ type: 'openlibrary', value: '/books/OL1234567M' }],
      });
      const rows = await resolveBooksByIdentifier(testDb.db, 'OL1234567M');
      expect(rows).toHaveLength(1);
    });

      it('returns multiple books for an OLID work key (every edition)', async () => {
      seedBook(testDb.db, {
        uri: 'at://did:plc:a/community.lexicon.book.book/ed1',
        isbn: '9780000000001',
        identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
        createdAt: '2024-01-01T00:00:00.000Z',
      });
      seedBook(testDb.db, {
        uri: 'at://did:plc:a/community.lexicon.book.book/ed2',
        isbn: '9780000000002',
        identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
        createdAt: '2024-02-01T00:00:00.000Z',
      });
      seedBook(testDb.db, {
        uri: 'at://did:plc:a/community.lexicon.book.book/ed3',
        isbn: '9780000000003',
        identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
        createdAt: '2024-03-01T00:00:00.000Z',
      });
      const rows = await resolveBooksByIdentifier(testDb.db, 'OL50W');
      expect(rows).toHaveLength(3);
    });

    it('returns empty array for unparseable input', async () => {
      seedBook(testDb.db);
      const rows = await resolveBooksByIdentifier(testDb.db, 'garbage');
      expect(rows).toEqual([]);
    });

    it('returns empty array for ISBN not in DB', async () => {
      seedBook(testDb.db, { isbn: '9780441172719' });
      const rows = await resolveBooksByIdentifier(testDb.db, '9780000000000');
      expect(rows).toEqual([]);
    });

    it('returns empty array for AT-URI not in DB', async () => {
      seedBook(testDb.db);
      const rows = await resolveBooksByIdentifier(
        testDb.db,
        'at://did:plc:nonexistent/community.lexicon.book.book/missing',
      );
      expect(rows).toEqual([]);
    });

    it('handles books with no identifiers column entry gracefully', async () => {
      seedBook(testDb.db, { identifiers: [] });
      const rows = await resolveBooksByIdentifier(testDb.db, 'OL1W');
      expect(rows).toEqual([]);
    });

    it('resolves via full openlibrary.org URL', async () => {
      seedBook(testDb.db, {
        identifiers: [{ type: 'openlibrary', value: '/works/OL50W' }],
      });
      const rows = await resolveBooksByIdentifier(
        testDb.db,
        'https://openlibrary.org/works/OL50W',
      );
      expect(rows).toHaveLength(1);
    });

    it('resolves via Google Books URL', async () => {
      seedBook(testDb.db, {
        identifiers: [{ type: 'googleBooks', value: 'abc123' }],
      });
      const rows = await resolveBooksByIdentifier(
        testDb.db,
        'https://books.google.com/books?id=abc123',
      );
      expect(rows).toHaveLength(1);
    });

    it('resolves via Goodreads urn', async () => {
      seedBook(testDb.db, {
        identifiers: [{ type: 'goodreads', value: '12345' }],
      });
      const rows = await resolveBooksByIdentifier(testDb.db, 'urn:goodreads:12345');
      expect(rows).toHaveLength(1);
    });

    it('resolves via DOI urn', async () => {
      seedBook(testDb.db, {
        identifiers: [{ type: 'doi', value: '10.1234/abc' }],
      });
      const rows = await resolveBooksByIdentifier(testDb.db, 'urn:doi:10.1234/abc');
      expect(rows).toHaveLength(1);
    });
  });
});
