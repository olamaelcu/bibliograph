import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

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
import { getLabelEvents, getActiveLabels } from './labeler.js';
import { logger } from './logger.js';

function getSqlite() {
  return (_d.$sqlite) as InstanceType<typeof import('better-sqlite3')>;
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

  describe('event log', () => {
    it('appends a neg=0 event on publishLabel', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');

      const events = getLabelEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        src: 'did:web:localhost',
        uri: 'at://did:plc:test/community.lexicon.book.book/test001',
        val: LABEL_AUTHOR,
        neg: false,
      });
    });

    it('appends a neg=1 event on negateLabel', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      negateLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');

      const events = getLabelEvents();
      expect(events).toHaveLength(2);
      expect(events[1].neg).toBe(true);
    });

    it('assigns monotonically increasing ids as seq', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      publishLabel('did:web:localhost', LABEL_LIBRARIAN, 'at://did:plc:test/community.lexicon.book.book/test001');

      const events = getLabelEvents();
      expect(events[0].id).toBeLessThan(events[1].id);
    });

    it('returns events after a cursor', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      publishLabel('did:web:localhost', LABEL_LIBRARIAN, 'at://did:plc:test/community.lexicon.book.book/test001');

      const all = getLabelEvents();
      const events = getLabelEvents(all[0].id);
      expect(events).toHaveLength(1);
      expect(events[0].val).toBe(LABEL_LIBRARIAN);
    });
  });

  describe('getActiveLabels', () => {
    it('returns all non-negated labels across URIs', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      publishLabel('did:web:localhost', LABEL_LIBRARIAN, 'did:web:librarian');
      publishLabel('did:web:localhost', LABEL_LIBRARIAN, 'did:web:other');
      negateLabel('did:web:localhost', LABEL_LIBRARIAN, 'did:web:other');

      const labels = getActiveLabels();
      expect(labels).toHaveLength(2);
      expect(labels.some((l) => l.val === LABEL_AUTHOR)).toBe(true);
      expect(labels.some((l) => l.uri === 'did:web:librarian')).toBe(true);
    });
  });

  describe('logging', () => {
    beforeEach(() => {
      vi.mocked(logger.debug).mockClear();
      vi.mocked(logger.info).mockClear();
    });

    it('logs at info when a label is published', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      expect(logger.info).toHaveBeenCalledWith(
        { src: 'did:web:localhost', val: LABEL_AUTHOR, uri: 'at://did:plc:test/community.lexicon.book.book/test001' },
        'label published',
      );
    });

    it('logs at info when a label is negated', () => {
      publishLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      vi.mocked(logger.info).mockClear();
      negateLabel('did:web:localhost', LABEL_AUTHOR, 'at://did:plc:test/community.lexicon.book.book/test001');
      expect(logger.info).toHaveBeenCalledWith(
        { src: 'did:web:localhost', val: LABEL_AUTHOR, uri: 'at://did:plc:test/community.lexicon.book.book/test001' },
        'label negated',
      );
    });

    it('logs at debug when checking for a label', () => {
      hasLabel('at://did:plc:test/community.lexicon.book.book/test001', LABEL_AUTHOR);
      expect(logger.debug).toHaveBeenCalledWith(
        { uri: 'at://did:plc:test/community.lexicon.book.book/test001', val: LABEL_AUTHOR, exists: false },
        'label checked',
      );
    });

    it('logs at debug when fetching labels for a URI', () => {
      getLabels('at://did:plc:test/community.lexicon.book.book/test001');
      expect(logger.debug).toHaveBeenCalledWith(
        { uri: 'at://did:plc:test/community.lexicon.book.book/test001', count: 0 },
        'labels fetched',
      );
    });

    it('logs at debug when fetching label events', () => {
      getLabelEvents();
      expect(logger.debug).toHaveBeenCalledWith(
        { afterId: undefined, count: 0 },
        'label events fetched',
      );
    });

    it('logs at debug when fetching active labels', () => {
      getActiveLabels();
      expect(logger.debug).toHaveBeenCalledWith({ count: 0 }, 'active labels fetched');
    });
  });
});
