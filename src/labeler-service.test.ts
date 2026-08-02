import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { publishLabel, negateLabel, LABEL_AUTHOR, LABEL_LIBRARIAN } from './labeler.js';
import { createSubscribeLabelsHandler } from './labeler-service.js';

function getSqlite() {
  return (_d.$sqlite) as InstanceType<typeof import('better-sqlite3')>;
}

function connect(cursor?: number) {
  const controller = new AbortController();
  const handler = createSubscribeLabelsHandler({ pollIntervalMs: 10 });
  const params = cursor !== undefined ? { cursor } : {};
  const gen = handler({
    params,
    signal: controller.signal,
    request: new Request('http://localhost'),
  });
  const iter = gen[Symbol.asyncIterator]();
  return { controller, iter };
}

const URI = 'at://did:plc:test/community.lexicon.book.book/test001';

describe('labeler-service', () => {
  beforeEach(() => {
    const sqlite = getSqlite();
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const t of tables) {
      if (t.name !== 'sqlite_sequence' && !t.name.startsWith('sqlite_')) {
        sqlite.prepare(`DELETE FROM "${t.name}"`).run();
      }
    }
    sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'label_events'").run();
  });

  it('emits a snapshot of active labels when connecting without a cursor', async () => {
    publishLabel('did:web:localhost', LABEL_AUTHOR, URI);

    const { controller, iter } = connect();
    const first = await iter.next();
    controller.abort();

    const msg = first.value;
    expect(msg.$type).toBe('com.atproto.label.subscribeLabels#labels');
    expect(msg.labels).toHaveLength(1);
    expect(msg.labels[0].val).toBe(LABEL_AUTHOR);
    expect(msg.seq).toBe(1);
  });

  it('excludes negated labels from the snapshot', async () => {
    publishLabel('did:web:localhost', LABEL_AUTHOR, URI);
    publishLabel('did:web:localhost', LABEL_LIBRARIAN, 'did:web:librarian');
    negateLabel('did:web:localhost', LABEL_LIBRARIAN, 'did:web:librarian');

    const { controller, iter } = connect();
    const first = await iter.next();
    controller.abort();

    const msg = first.value;
    expect(msg.labels).toHaveLength(1);
    expect(msg.labels[0].val).toBe(LABEL_AUTHOR);
  });

  it('backfills events after a cursor', async () => {
    publishLabel('did:web:localhost', LABEL_AUTHOR, URI);
    publishLabel('did:web:localhost', LABEL_LIBRARIAN, 'did:web:librarian');

    const { controller, iter } = connect(1);
    const first = await iter.next();
    controller.abort();

    const msg = first.value;
    expect(msg.$type).toBe('com.atproto.label.subscribeLabels#labels');
    expect(msg.labels).toHaveLength(1);
    expect(msg.labels[0].val).toBe(LABEL_LIBRARIAN);
    expect(msg.seq).toBe(2);
  });

  it('streams newly published labels after connecting', async () => {
    const { controller, iter } = connect();
    await iter.next(); // snapshot (empty)

    publishLabel('did:web:localhost', LABEL_AUTHOR, URI);

    const frame = await iter.next();
    controller.abort();

    expect(frame.value.$type).toBe('com.atproto.label.subscribeLabels#labels');
    expect(frame.value.labels).toHaveLength(1);
    expect(frame.value.labels[0].val).toBe(LABEL_AUTHOR);
    expect(frame.value.seq).toBe(1);
  });

  it('streams negations as neg=true label events', async () => {
    publishLabel('did:web:localhost', LABEL_AUTHOR, URI);

    const { controller, iter } = connect();
    await iter.next(); // snapshot

    negateLabel('did:web:localhost', LABEL_AUTHOR, URI);

    const frame = await iter.next();
    controller.abort();

    expect(frame.value.labels).toHaveLength(1);
    expect(frame.value.labels[0].neg).toBe(true);
  });

  it('emits OutdatedCursor info for an out-of-range cursor', async () => {
    const { controller, iter } = connect(-1);
    const first = await iter.next();
    controller.abort();

    const msg = first.value;
    expect(msg.$type).toBe('com.atproto.label.subscribeLabels#info');
    expect(msg.name).toBe('OutdatedCursor');
  });

  it('stops when the connection is aborted', async () => {
    const { controller, iter } = connect();
    await iter.next(); // consume the initial snapshot
    controller.abort();

    const result = await iter.next();
    expect(result.done).toBe(true);
  });
});
