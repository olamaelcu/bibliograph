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
const _s = schema;
const _d = db as any;

import { publishLabel, negateLabel, hasLabel, getLabels, LABEL_AUTHOR, LABEL_LIBRARIAN } from './labeler.js';

function getSqlite() {
  return (_d.$sqlite) as import('better-sqlite3').default;
}

describe('labeler', () => {
  beforeEach(() => {
    const sqlite = getSqlite();
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const t of tables) {
      if (t.name !== 'sqlite_sequence' && !t.name.startsWith('sqlite_')) {
        sqlite.prepare(`DELETE FROM "${t.name}"`).run();
      }
    }

    db.insert(_s.books).values({
      uri: 'at://did:plc:test/community.lexicon.book.book/test001',
      did: 'did:plc:test',
      title: 'Test Book',
      author: 'Test Author',
      isbn: '9781234567890',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  });

  afterEach(() => {
    // clean db state but keep connection
  });

  describe('publishLabel', () => {
    it('inserts a new label', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');

      const rows = db.select().from(_s.bookLabels).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].src).toBe('did:web:localhost');
      expect(rows[0].val).toBe(LABEL_AUTHOR);
      expect(rows[0].neg).toBe(0);
    });

    it('upserts on duplicate label', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');

      const rows = db.select().from(_s.bookLabels).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].neg).toBe(0);
    });

    it('allows different values on same URI', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      publishLabel('did:web:localhost', LABEL_LIBRARIAN, 'at://did:plc:test/community.lexicon.book.book/test001');

      const rows = db.select().from(_s.bookLabels).all();
      expect(rows).toHaveLength(2);
    });
  });

  describe('negateLabel', () => {
    it('negates a published label', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      negateLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');

      const rows = db.select().from(_s.bookLabels).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].neg).toBe(1);
    });
  });

  describe('hasLabel', () => {
    it('returns true for active label', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      expect(hasLabel('at://did:plc:test/community.lexicon.book.book/test001', LABEL_AUTHOR)).toBe(true);
    });

    it('returns false for negated label', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      negateLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      expect(hasLabel('at://did:plc:test/community.lexicon.book.book/test001', LABEL_AUTHOR)).toBe(false);
    });

    it('returns false for nonexistent label', () => {
      expect(hasLabel('at://did:plc:test/community.lexicon.book.book/test001', LABEL_AUTHOR)).toBe(false);
    });

    it('filters by DID when provided', () => {
      publishLabel('did:web:alice', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      expect(hasLabel('at://did:plc:test/community.lexicon.book.book/test001', LABEL_AUTHOR, 'did:web:alice')).toBe(true);
      expect(hasLabel('at://did:plc:test/community.lexicon.book.book/test001', LABEL_AUTHOR, 'did:web:bob')).toBe(false);
    });
  });

  describe('getLabels', () => {
    it('returns all active labels for a URI', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      publishLabel('did:web:other', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');

      const labels = getLabels('at://did:plc:test/community.lexicon.book.book/test001');
      expect(labels).toHaveLength(2);
    });

    it('filters by value when provided', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      publishLabel('did:web:localhost', LABEL_LIBRARIAN, 'at://did:plc:test/community.lexicon.book.book/test001');

      const labels = getLabels('at://did:plc:test/community.lexicon.book.book/test001', LABEL_AUTHOR);
      expect(labels).toHaveLength(1);
      expect(labels[0].val).toBe(LABEL_AUTHOR);
    });

    it('excludes negated labels', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      negateLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');

      const labels = getLabels('at://did:plc:test/community.lexicon.book.book/test001');
      expect(labels).toHaveLength(0);
    });

    it('returns empty array for unknown URI', () => {
      const labels = getLabels('at://did:plc:nonexistent/book/test999');
      expect(labels).toEqual([]);
    });

    it('maps neg field to boolean', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      const labels = getLabels('at://did:plc:test/community.lexicon.book.book/test001');
      expect(typeof labels[0].neg).toBe('boolean');
      expect(labels[0].neg).toBe(false);
    });
  });
});
