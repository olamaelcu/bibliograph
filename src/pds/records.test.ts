import { describe, it, expect } from 'vitest';
import { serializeBook, serializeContributor, serializeContributorType } from './records.js';
import type { books, contributors, contributorTypes } from '../db/schema.js';

const baseBook = {
  uri: 'at://did:web:b/x/community.lexicon.book.book/abc',
  did: 'did:web:b/x',
  title: 'Title',
  author: 'Author',
  isbn: null,
  publishedDate: null,
  description: null,
  pageCount: null,
  language: 'en',
  categories: [],
  identifiers: [],
  contributors: [],
  coverUrl: null,
  cover: null,
  deduplicationHash: null,
  status: 'pending',
  cid: null,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
} satisfies typeof books.$inferSelect;

const baseContributor = {
  uri: 'at://did:web:b/x/community.lexicon.book.contributor/abc',
  did: 'did:web:b/x',
  name: 'Name',
  altNames: [],
  images: [],
  identifiers: [{ type: 'olid', value: 'OL1A' }],
  bio: null,
  cid: null,
  createdAt: '2025-01-01T00:00:00Z',
} satisfies typeof contributors.$inferSelect;

const baseContributorType = {
  uri: 'at://did:web:b/x/community.lexicon.book.contributor.type/abc',
  did: 'did:web:b/x',
  name: 'author',
  description: null,
  cid: null,
  createdAt: '2025-01-01T00:00:00Z',
} satisfies typeof contributorTypes.$inferSelect;

describe('serializeBook', () => {
  it('emits the required lex fields', () => {
    const value = serializeBook(baseBook);
    expect(value).toEqual({
      $type: 'community.lexicon.book.book',
      title: 'Title',
      author: 'Author',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
  });

  it('omits null/undefined/empty optional fields', () => {
    const value = serializeBook({ ...baseBook, isbn: null, pageCount: null, categories: [] });
    expect('isbn' in value).toBe(false);
    expect('pageCount' in value).toBe(false);
    expect('categories' in value).toBe(false);
  });

  it('includes optional fields when present', () => {
    const value = serializeBook({
      ...baseBook,
      isbn: '9780000000001',
      pageCount: 200,
      categories: ['Fiction'],
      coverUrl: 'https://example/cover.jpg',
      description: 'A book',
      publishedDate: '2024-01-01',
    });
    expect(value).toMatchObject({
      isbn: '9780000000001',
      pageCount: 200,
      categories: ['Fiction'],
      coverUrl: 'https://example/cover.jpg',
      description: 'A book',
      publishedDate: '2024-01-01',
    });
  });

  it('drops the default English language to keep the lex output minimal', () => {
    const value = serializeBook({ ...baseBook, language: 'en' });
    expect('language' in value).toBe(false);
  });

  it('preserves non-English language', () => {
    const value = serializeBook({ ...baseBook, language: 'fr' });
    expect(value.language).toBe('fr');
  });

  it('does not leak AppView admin fields (status, deduplicationHash, cid)', () => {
    const value = serializeBook({ ...baseBook, status: 'verified', deduplicationHash: 'h', cid: 'cid' });
    expect('status' in value).toBe(false);
    expect('deduplicationHash' in value).toBe(false);
    expect('cid' in value).toBe(false);
  });

  it('passes through the contributors strongRef array verbatim', () => {
    const value = serializeBook({
      ...baseBook,
      contributors: [{ contributor: { uri: 'at://x', cid: 'b' }, role: { uri: 'at://y', cid: 'c' }, order: 0 }],
    });
    expect(value.contributors).toEqual([
      { contributor: { uri: 'at://x', cid: 'b' }, role: { uri: 'at://y', cid: 'c' }, order: 0 },
    ]);
  });
});

describe('serializeContributor', () => {
  it('emits required lex fields and identifiers', () => {
    const value = serializeContributor(baseContributor);
    expect(value).toEqual({
      $type: 'community.lexicon.book.contributor',
      name: 'Name',
      createdAt: '2025-01-01T00:00:00Z',
      identifiers: [{ type: 'olid', value: 'OL1A' }],
    });
  });

  it('omits empty optional arrays', () => {
    const value = serializeContributor({ ...baseContributor, altNames: [], images: [] });
    expect('altNames' in value).toBe(false);
    expect('images' in value).toBe(false);
  });

  it('does not leak AppView admin fields (cid, did)', () => {
    const value = serializeContributor({ ...baseContributor, cid: 'cid' });
    expect('cid' in value).toBe(false);
    expect('did' in value).toBe(false);
  });
});

describe('serializeContributorType', () => {
  it('emits required lex fields', () => {
    const value = serializeContributorType(baseContributorType);
    expect(value).toEqual({
      $type: 'community.lexicon.book.contributor.type',
      name: 'author',
      createdAt: '2025-01-01T00:00:00Z',
    });
  });

  it('includes description when present', () => {
    const value = serializeContributorType({ ...baseContributorType, description: 'Original writer' });
    expect(value.description).toBe('Original writer');
  });
});