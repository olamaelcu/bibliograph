import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, seedBook, type TestDb } from '../test-utils/db.js';
import { BOOKS_MISSING_COVER_VARIANTS, SHELVES_MISSING_COVER_VARIANTS } from './views.js';

function makeRkey(): string {
  const chars = '234567abcdefghijklmnopqrstuvwxyz';
  let r = '';
  for (let i = 0; i < 13; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function seedShelf(env: TestDb, overrides: Record<string, unknown> = {}): string {
  const uri = `at://did:plc:test/community.lexicon.book.shelf/${makeRkey()}`;
  const now = new Date().toISOString();
  env.db.insert(env.schema.shelves).values({
    uri,
    did: 'did:plc:test',
    name: 'Test Shelf',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return uri;
}

describe('cover-variant views', () => {
  let env: TestDb;

  beforeEach(() => {
    env = createTestDb();
  });

  describe('books_missing_cover_variants', () => {
    it('includes books with cover.medium but missing variants', () => {
      const uri = seedBook(env.db, { cover: { medium: 'https://example.com/c.jpg' } });
      const rows = env.db.all(sql`SELECT uri FROM ${sql.raw(BOOKS_MISSING_COVER_VARIANTS)}`) as { uri: string }[];
      expect(rows.map((r) => r.uri)).toContain(uri);
    });

    it('excludes books with all 6 variants populated', () => {
      const uri = seedBook(env.db, {
        cover: {
          small: '/covers/book/x-S.jpg',
          medium: '/covers/book/x-M.jpg',
          large: '/covers/book/x-L.jpg',
          smallAvif: '/covers/book/x-S.avif',
          mediumAvif: '/covers/book/x-M.avif',
          largeAvif: '/covers/book/x-L.avif',
        },
      });
      const rows = env.db.all(sql`SELECT uri FROM ${sql.raw(BOOKS_MISSING_COVER_VARIANTS)}`) as { uri: string }[];
      expect(rows.map((r) => r.uri)).not.toContain(uri);
    });

    it('excludes books with NULL cover', () => {
      const uri = seedBook(env.db);
      const rows = env.db.all(sql`SELECT uri FROM ${sql.raw(BOOKS_MISSING_COVER_VARIANTS)}`) as { uri: string }[];
      expect(rows.map((r) => r.uri)).not.toContain(uri);
    });

    it('exposes the rkey extracted from the URI', () => {
      const uri = seedBook(env.db, { cover: { medium: 'https://example.com/c.jpg' } });
      const rows = env.db.all(sql`SELECT uri, rkey FROM ${sql.raw(BOOKS_MISSING_COVER_VARIANTS)}`) as { uri: string; rkey: string }[];
      const row = rows.find((r) => r.uri === uri);
      expect(row?.rkey).toBe(uri.slice(-13));
    });

    it('includes books missing only one AVIF variant', () => {
      const uri = seedBook(env.db, {
        cover: {
          small: '/a',
          medium: '/b',
          large: '/c',
          smallAvif: '/d',
          mediumAvif: '/e',
          // largeAvif missing
        },
      });
      const rows = env.db.all(sql`SELECT uri FROM ${sql.raw(BOOKS_MISSING_COVER_VARIANTS)}`) as { uri: string }[];
      expect(rows.map((r) => r.uri)).toContain(uri);
    });
  });

  describe('shelves_missing_cover_variants', () => {
    it('includes shelves with cover.medium but missing variants', () => {
      const uri = seedShelf(env, { cover: { medium: 'https://example.com/c.jpg' } });
      const rows = env.db.all(sql`SELECT uri FROM ${sql.raw(SHELVES_MISSING_COVER_VARIANTS)}`) as { uri: string }[];
      expect(rows.map((r) => r.uri)).toContain(uri);
    });

    it('excludes shelves with NULL cover', () => {
      const uri = seedShelf(env);
      const rows = env.db.all(sql`SELECT uri FROM ${sql.raw(SHELVES_MISSING_COVER_VARIANTS)}`) as { uri: string }[];
      expect(rows.map((r) => r.uri)).not.toContain(uri);
    });
  });
});
