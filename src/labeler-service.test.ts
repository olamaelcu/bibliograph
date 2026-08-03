import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decode, decodeFirst } from '@atcute/cbor';

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
import { clearSqliteTables } from './test-utils/db.js';
const _s = schema;
const _d = db as any;

import { publishLabel, negateLabel, LABEL_AUTHOR, LABEL_LIBRARIAN } from './labeler.js';
import { createSubscribeLabelsHandler, encodeSubscriptionFrame, createSubscribeLabelsEvents } from './labeler-service.js';
import { logger } from './logger.js';

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
    clearSqliteTables(sqlite);
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

describe('encodeSubscriptionFrame', () => {
  it('encodes a labels message as a CBOR frame with op:1 header', () => {
    const message = {
      $type: 'com.atproto.label.subscribeLabels#labels' as const,
      seq: 3,
      labels: [{
        src: 'did:web:localhost',
        uri: URI,
        val: LABEL_AUTHOR,
        cts: '2026-01-01T00:00:00Z',
        neg: false,
      }],
    };

    const frame = encodeSubscriptionFrame(message as Parameters<typeof encodeSubscriptionFrame>[0]);

    const [header, rest] = decodeFirst(frame);
    expect(header).toEqual({ op: 1, t: '#labels' });
    const body = decode(rest);
    expect(body).toEqual({
      seq: 3,
      labels: [{ src: 'did:web:localhost', uri: URI, val: LABEL_AUTHOR, cts: '2026-01-01T00:00:00Z', neg: false }],
    });
  });

  it('encodes an info message with #info type and drops the $type field', () => {
    const message = { $type: 'com.atproto.label.subscribeLabels#info' as const, name: 'OutdatedCursor' };

    const frame = encodeSubscriptionFrame(message as Parameters<typeof encodeSubscriptionFrame>[0]);

    const [header, rest] = decodeFirst(frame);
    expect(header).toEqual({ op: 1, t: '#info' });
    expect(decode(rest)).toEqual({ name: 'OutdatedCursor' });
  });
});

describe('createSubscribeLabelsEvents', () => {
  it('streams encoded frames to a connected websocket', async () => {
    publishLabel('did:web:localhost', LABEL_AUTHOR, URI);

    const sent: Uint8Array[] = [];
    const fakeWs = {
      send: (data: Uint8Array) => { sent.push(data); },
      close: () => {},
    };
    const ctx = { params: {} };

    const events = createSubscribeLabelsEvents({ pollIntervalMs: 10 });
    const onOpen = events(ctx).onOpen!;
    onOpen(new Event('open'), fakeWs as never);

    await waitFor(() => sent.length > 0);

    const [header, rest] = decodeFirst(sent[0]);
    expect(header).toEqual({ op: 1, t: '#labels' });
    const body = decode(rest);
    expect(body.labels).toHaveLength(1);
    expect(body.labels[0].val).toBe(LABEL_AUTHOR);
  });

  it('logs when a websocket connects with a cursor', () => {
    const fakeWs = { send: () => {}, close: () => {} };
    const ctx = { params: { cursor: '42' } };

    const events = createSubscribeLabelsEvents({ pollIntervalMs: 10 });
    events(ctx).onOpen!(new Event('open'), fakeWs as never);

    expect(logger.info).toHaveBeenCalledWith({ cursor: 42 }, 'subscribeLabels client connected');
  });

  it('logs when a websocket disconnects', () => {
    const events = createSubscribeLabelsEvents({ pollIntervalMs: 10 });
    events({ params: {} }).onClose!(new CloseEvent('close') as never);

    expect(logger.info).toHaveBeenCalledWith({}, 'subscribeLabels client closed');
  });

  it('logs an error when a websocket errors', () => {
    const events = createSubscribeLabelsEvents({ pollIntervalMs: 10 });
    const evt = new ErrorEvent('error', { error: new Error('boom') });
    events({ params: {} }).onError!(evt as never);

    expect(logger.error).toHaveBeenCalledWith({ err: evt }, 'subscribeLabels client error');
  });
});

function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (fn()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 5);
  });
}
