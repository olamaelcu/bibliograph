import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db/connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('./db/schema.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  (db as any).$sqlite = sqlite;
  return { db, schema };
});

import { db, schema } from './db/connection.js';
import { clearSqliteTables } from './test-utils/db.js';
const _s = schema;
const _d = db as any;

import { handleRecordEvent } from './indexer.js';
import type { TapRecordEvent } from './indexer.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

function clearTables() {
  clearSqliteTables(getSqlite());
}

function makeEvent(
  overrides: Partial<TapRecordEvent> = {},
): TapRecordEvent {
  return {
    type: 'record',
    action: 'create',
    did: 'did:plc:test',
    rev: 'rev1',
    collection: 'community.lexicon.book.book',
    rkey: 'book001',
    record: {
      $type: 'community.lexicon.book.book',
      title: 'Test Book',
      author: 'Test Author',
      isbn: '9781234567890',
      status: 'active',
      createdAt: new Date().toISOString(),
    },
    cid: 'cid123',
    live: false,
    ...overrides,
  };
}

describe('indexer', () => {
  beforeEach(() => {
    clearTables();
  });

  describe('book indexing', () => {
    it('creates a book record on create event', async () => {
      await handleRecordEvent(makeEvent());

      const rows = db.select().from(_s.books).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].uri).toBe('at://did:plc:test/community.lexicon.book.book/book001');
      expect(rows[0].title).toBe('Test Book');
      expect(rows[0].status).toBe('active');
    });

    it('updates a book record on update event', async () => {
      await handleRecordEvent(makeEvent());

      await handleRecordEvent(makeEvent({
        action: 'update',
        record: {
          $type: 'community.lexicon.book.book',
          title: 'Updated Title',
          author: 'Updated Author',
          isbn: '9781234567890',
          status: 'active',
          createdAt: new Date().toISOString(),
        },
      }));

      const rows = db.select().from(_s.books).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Updated Title');
    });

    it('deletes a book record on delete event', async () => {
      await handleRecordEvent(makeEvent());

      await handleRecordEvent(makeEvent({
        action: 'delete',
        record: undefined,
      }));

      const rows = db.select().from(_s.books).all();
      expect(rows).toHaveLength(0);
    });

    it('defaults status to "pending" when not provided', async () => {
      await handleRecordEvent(makeEvent({
        record: {
          $type: 'community.lexicon.book.book',
          title: 'No Status Book',
          author: 'Author',
          createdAt: new Date().toISOString(),
        },
      }));

      const rows = db.select().from(_s.books).all();
      expect(rows[0].status).toBe('pending');
    });

    it('skips indexing when record is missing', async () => {
      await handleRecordEvent(makeEvent({ record: undefined }));

      const rows = db.select().from(_s.books).all();
      expect(rows).toHaveLength(0);
    });
  });

  describe('review indexing', () => {
    it('indexes a review', async () => {
      await handleRecordEvent(makeEvent());

      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:reviewer', rev: 'rev2',
        collection: 'community.lexicon.book.review', rkey: 'rev001',
        record: {
          $type: 'community.lexicon.book.review',
          bookUri: 'at://did:plc:test/community.lexicon.book.book/book001',
          text: 'Great book!',
          rating: 5,
          bookRef: { title: 'Test Book', author: 'Test Author' },
          createdAt: new Date().toISOString(),
        },
        live: false,
      });

      const rows = db.select().from(_s.reviews).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].text).toBe('Great book!');
      expect(rows[0].bookTitle).toBe('Test Book');
      expect(rows[0].bookAuthor).toBe('Test Author');
    });

    it('stores the event cid on a review', async () => {
      await handleRecordEvent(makeEvent());

      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:reviewer', rev: 'rev2',
        collection: 'community.lexicon.book.review', rkey: 'rev001',
        cid: 'bafyreicid123',
        record: {
          $type: 'community.lexicon.book.review',
          bookUri: 'at://did:plc:test/community.lexicon.book.book/book001',
          text: 'Great book!',
          rating: 5,
          bookRef: { title: 'Test Book', author: 'Test Author' },
          createdAt: new Date().toISOString(),
        },
        live: false,
      });

      const rows = db.select().from(_s.reviews).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].cid).toBe('bafyreicid123');
    });

    it('deletes a review', async () => {
      await handleRecordEvent(makeEvent());
      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:r', rev: 'r1',
        collection: 'community.lexicon.book.review', rkey: 'rev001',
        record: { $type: 'community.lexicon.book.review', bookUri: 'at://did:plc:test/community.lexicon.book.book/book001', text: 'Nice', bookRef: { title: 'T', author: 'A' }, createdAt: new Date().toISOString() },
        live: false,
      });

      await handleRecordEvent({
        type: 'record', action: 'delete', did: 'did:plc:r', rev: 'r2',
        collection: 'community.lexicon.book.review', rkey: 'rev001',
        record: undefined, live: false,
      });

      const rows = db.select().from(_s.reviews).all();
      expect(rows).toHaveLength(0);
    });
  });

  describe('status indexing', () => {
    it('indexes a reading status', async () => {
      await handleRecordEvent(makeEvent());

      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:reader', rev: 'r1',
        collection: 'community.lexicon.book.status', rkey: 'stat001',
        record: {
          $type: 'community.lexicon.book.status',
          bookUri: 'at://did:plc:test/community.lexicon.book.book/book001',
          status: 'reading',
          progress: 50,
          bookRef: { title: 'Test Book', author: 'Test Author' },
          createdAt: new Date().toISOString(),
        },
        live: false,
      });

      const rows = db.select().from(_s.readingStatuses).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('reading');
      expect(rows[0].progress).toBe(50);
    });

    it('deletes a reading status', async () => {
      await handleRecordEvent(makeEvent());
      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:reader', rev: 'r1',
        collection: 'community.lexicon.book.status', rkey: 'stat001',
        record: { $type: 'community.lexicon.book.status', bookUri: 'at://did:plc:test/community.lexicon.book.book/book001', status: 'to-read', bookRef: { title: 'T', author: 'A' }, createdAt: new Date().toISOString() },
        live: false,
      });

      await handleRecordEvent({
        type: 'record', action: 'delete', did: 'did:plc:reader', rev: 'r2',
        collection: 'community.lexicon.book.status', rkey: 'stat001',
        record: undefined, live: false,
      });

      const rows = db.select().from(_s.readingStatuses).all();
      expect(rows).toHaveLength(0);
    });

    it('replaces an existing status when a new record arrives for the same user and book', async () => {
      await handleRecordEvent(makeEvent());
      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:reader', rev: 'r1',
        collection: 'community.lexicon.book.status', rkey: 'stat001',
        record: { $type: 'community.lexicon.book.status', bookUri: 'at://did:plc:test/community.lexicon.book.book/book001', status: 'reading', progress: 50, bookRef: { title: 'T', author: 'A' }, createdAt: new Date().toISOString() },
        live: false,
      });

      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:reader', rev: 'r2',
        collection: 'community.lexicon.book.status', rkey: 'stat002',
        record: { $type: 'community.lexicon.book.status', bookUri: 'at://did:plc:test/community.lexicon.book.book/book001', status: 'read', bookRef: { title: 'T', author: 'A' }, createdAt: new Date().toISOString() },
        live: false,
      });

      const rows = db.select().from(_s.readingStatuses).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('read');
      expect(rows[0].uri).toBe('at://did:plc:reader/community.lexicon.book.status/stat002');
    });

    it('updates the row in place when the same record uri is re-indexed', async () => {
      await handleRecordEvent(makeEvent());
      const statusEvent = {
        type: 'record' as const, action: 'create' as const, did: 'did:plc:reader', rev: 'r1',
        collection: 'community.lexicon.book.status', rkey: 'stat001',
        record: { $type: 'community.lexicon.book.status', bookUri: 'at://did:plc:test/community.lexicon.book.book/book001', status: 'reading', progress: 20, bookRef: { title: 'T', author: 'A' }, createdAt: new Date().toISOString() },
        live: false,
      };

      await handleRecordEvent(statusEvent);
      await handleRecordEvent({
        ...statusEvent,
        action: 'update',
        record: { ...statusEvent.record, status: 'read', progress: 100 },
      });

      const rows = db.select().from(_s.readingStatuses).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('read');
      expect(rows[0].progress).toBe(100);
      expect(rows[0].uri).toBe('at://did:plc:reader/community.lexicon.book.status/stat001');
    });
  });

  describe('claim indexing', () => {
    it('indexes a claim', async () => {
      await handleRecordEvent(makeEvent());

      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:author', rev: 'r1',
        collection: 'community.lexicon.book.claim', rkey: 'clm001',
        record: {
          $type: 'community.lexicon.book.claim',
          bookUri: 'at://did:plc:test/community.lexicon.book.book/book001',
          identifier: '9781234567890',
          identifierType: 'isbn',
          claimedBy: 'did:plc:author',
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
        live: false,
      });

      const rows = db.select().from(_s.claims).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].identifierType).toBe('isbn');
      expect(rows[0].status).toBe('pending');
    });

    it('deletes a claim', async () => {
      await handleRecordEvent(makeEvent());
      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:a', rev: 'r1',
        collection: 'community.lexicon.book.claim', rkey: 'clm001',
        record: { $type: 'community.lexicon.book.claim', bookUri: 'at://did:plc:test/community.lexicon.book.book/book001', identifier: 'x', identifierType: 'isbn', claimedBy: 'did:plc:a', status: 'pending', createdAt: new Date().toISOString() },
        live: false,
      });

      await handleRecordEvent({
        type: 'record', action: 'delete', did: 'did:plc:a', rev: 'r2',
        collection: 'community.lexicon.book.claim', rkey: 'clm001',
        record: undefined, live: false,
      });

      const rows = db.select().from(_s.claims).all();
      expect(rows).toHaveLength(0);
    });
  });

  describe('shelf indexing', () => {
    it('indexes a shelf', async () => {
      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:user', rev: 'r1',
        collection: 'community.lexicon.book.shelf', rkey: 'shf001',
        record: {
          $type: 'community.lexicon.book.shelf',
          name: 'Sci-Fi Favorites',
          description: 'Top sci-fi picks',
          metadata: { theme: 'scifi' },
          coverUrl: 'https://example.com/cover.jpg',
          createdAt: new Date().toISOString(),
        },
        live: false,
      });

      const rows = db.select().from(_s.shelves).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Sci-Fi Favorites');
      expect(rows[0].description).toBe('Top sci-fi picks');
      expect(rows[0].metadata).toEqual({ theme: 'scifi' });
      expect(rows[0].coverUrl).toBe('https://example.com/cover.jpg');
    });

    it('updates a shelf on update event', async () => {
      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:user', rev: 'r1',
        collection: 'community.lexicon.book.shelf', rkey: 'shf001',
        record: { $type: 'community.lexicon.book.shelf', name: 'Old Name', createdAt: new Date().toISOString() },
        live: false,
      });

      await handleRecordEvent({
        type: 'record', action: 'update', did: 'did:plc:user', rev: 'r2',
        collection: 'community.lexicon.book.shelf', rkey: 'shf001',
        record: { $type: 'community.lexicon.book.shelf', name: 'New Name', createdAt: new Date().toISOString() },
        live: false,
      });

      const rows = db.select().from(_s.shelves).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('New Name');
    });

    it('deletes a shelf', async () => {
      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:user', rev: 'r1',
        collection: 'community.lexicon.book.shelf', rkey: 'shf001',
        record: { $type: 'community.lexicon.book.shelf', name: 'Temp', createdAt: new Date().toISOString() },
        live: false,
      });

      await handleRecordEvent({
        type: 'record', action: 'delete', did: 'did:plc:user', rev: 'r2',
        collection: 'community.lexicon.book.shelf', rkey: 'shf001',
        record: undefined, live: false,
      });

      const rows = db.select().from(_s.shelves).all();
      expect(rows).toHaveLength(0);
    });
  });

  describe('shelf item indexing', () => {
    async function seedShelf() {
      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:user', rev: 'rshelf',
        collection: 'community.lexicon.book.shelf', rkey: 'shf001',
        record: { $type: 'community.lexicon.book.shelf', name: 'Shelf', createdAt: new Date().toISOString() },
        live: false,
      });
    }

    it('indexes a shelf item', async () => {
      await seedShelf();
      await handleRecordEvent(makeEvent());

      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:user', rev: 'r1',
        collection: 'community.lexicon.book.shelfItem', rkey: 'sii001',
        record: {
          $type: 'community.lexicon.book.shelfItem',
          shelfUri: 'at://did:plc:user/community.lexicon.book.shelf/shf001',
          bookUri: 'at://did:plc:test/community.lexicon.book.book/book001',
          bookRef: { title: 'Test Book', author: 'Test Author' },
          note: 'favorite',
          createdAt: new Date().toISOString(),
        },
        live: false,
      });

      const rows = db.select().from(_s.shelfItems).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].bookTitle).toBe('Test Book');
      expect(rows[0].bookAuthor).toBe('Test Author');
      expect(rows[0].note).toBe('favorite');
    });

    it('deletes a shelf item', async () => {
      await seedShelf();
      await handleRecordEvent(makeEvent());
      await handleRecordEvent({
        type: 'record', action: 'create', did: 'did:plc:user', rev: 'r1',
        collection: 'community.lexicon.book.shelfItem', rkey: 'sii001',
        record: { $type: 'community.lexicon.book.shelfItem', shelfUri: 'at://did:plc:user/community.lexicon.book.shelf/shf001', bookUri: 'at://did:plc:test/community.lexicon.book.book/book001', bookRef: { title: 'T', author: 'A' }, createdAt: new Date().toISOString() },
        live: false,
      });

      await handleRecordEvent({
        type: 'record', action: 'delete', did: 'did:plc:user', rev: 'r2',
        collection: 'community.lexicon.book.shelfItem', rkey: 'sii001',
        record: undefined, live: false,
      });

      const rows = db.select().from(_s.shelfItems).all();
      expect(rows).toHaveLength(0);
    });
  });
});
