import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../db/schema.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  (db as any).$sqlite = sqlite;
  return { db, schema };
});

vi.mock('../features.js', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../auth.js', () => ({
  optionalAuth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/follows.js', () => ({
  FollowsService: class {
    async getFollows(_did: string): Promise<string[]> {
      return [];
    }
  },
}));

import { db, schema } from '../db/connection.js';
import { clearSqliteTables } from '../test-utils/db.js';
const _s = schema;
const _d = db as any;

import { isFeatureEnabled } from '../features.js';
import { optionalAuth } from '../auth.js';
import { FollowsService } from '../services/follows.js';
import { getFeed } from './get-feed.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

function clearTables() {
  clearSqliteTables(getSqlite());
}

function mockContext(overrides: {
  query?: Record<string, string>;
  headers?: Record<string, string>;
} = {}) {
  const store = new Map<string, unknown>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  store.set('log', log);
  const headers = new Headers(overrides.headers);
  const req = new Request('http://localhost', { headers });

  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    req: {
      query: () => (overrides.query || {}),
      queries: () => undefined,
      raw: req,
    },
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    store,
  } as any;
}

async function readJson(res: Response) {
  return JSON.parse(await res.text());
}

function seedBook(overrides: Partial<typeof _s.books.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const uri = overrides.uri || `at://did:plc:author/book/${Math.random().toString(36).slice(2, 10)}`;
  db.insert(_s.books).values({
    uri,
    did: 'did:plc:author',
    title: 'Test Book',
    author: 'Test Author',
    isbn: `978${Math.random().toString(36).slice(2, 12)}`,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return uri;
}

function seedReview(overrides: Partial<typeof _s.reviews.$inferInsert> = {}) {
  const uri = overrides.uri || `at://did:plc:reader/review/${Math.random().toString(36).slice(2, 10)}`;
  const bookUri = overrides.bookUri || seedBook();
  db.insert(_s.reviews).values({
    uri,
    did: 'did:plc:reader',
    bookUri,
    text: 'good',
    bookTitle: 'Test Book',
    bookAuthor: 'Test Author',
    createdAt: new Date().toISOString(),
    ...overrides,
  }).run();
  return uri;
}

function seedStatus(overrides: Partial<typeof _s.readingStatuses.$inferInsert> = {}) {
  const uri = overrides.uri || `at://did:plc:reader/status/${Math.random().toString(36).slice(2, 10)}`;
  const bookUri = overrides.bookUri || seedBook();
  db.insert(_s.readingStatuses).values({
    uri,
    did: 'did:plc:reader',
    bookUri,
    status: 'reading',
    bookTitle: 'Test Book',
    bookAuthor: 'Test Author',
    createdAt: new Date().toISOString(),
    ...overrides,
  }).run();
  return uri;
}

describe('getFeed', () => {
  beforeEach(() => {
    clearTables();
    vi.clearAllMocks();
    (isFeatureEnabled as any).mockReturnValue(true);
    (optionalAuth as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 when the feedGenerator feature is disabled', async () => {
    (isFeatureEnabled as any).mockReturnValue(false);
    const c = mockContext();
    const res = await getFeed(c);
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error).toBe('InvalidRequest');
  });

  it('returns the public buckets for an unauthenticated request', async () => {
    seedBook({ createdAt: '2026-08-01T00:00:00.000Z' });
    seedReview({ createdAt: '2026-08-02T00:00:00.000Z' });
    seedStatus({ createdAt: '2026-08-03T00:00:00.000Z' });

    const c = mockContext();
    const res = await getFeed(c);
    expect(res.status).toBe(200);
    const body = await readJson(res);

    expect(body.recent).toBeDefined();
    expect(body.newestBooks).toBeDefined();
    expect(body.trending).toBeDefined();
    expect(body.trending.day).toBeDefined();
    expect(body.trending.week).toBeDefined();
    expect(body.trending.month).toBeDefined();
    expect(body.following).toBeUndefined();
    expect(body.crossUser).toBeUndefined();
  });

  it('merges reviews and statuses in recent ordered by createdAt desc', async () => {
    seedBook();
    seedReview({ createdAt: '2026-08-02T00:00:00.000Z' });
    seedStatus({ createdAt: '2026-08-03T00:00:00.000Z' });

    const c = mockContext();
    const body = await readJson(await getFeed(c));

    expect(body.recent).toHaveLength(2);
    expect(body.recent[0].type).toBe('status');
    expect(body.recent[0].createdAt).toBe('2026-08-03T00:00:00.000Z');
    expect(body.recent[1].type).toBe('review');
    expect(body.recent[0].book.title).toBe('Test Book');
  });

  it('paginates recent with a stable keyset cursor without skips or duplicates', async () => {
    seedBook();
    for (let i = 0; i < 5; i++) {
      seedStatus({ createdAt: `2026-08-0${i + 1}T00:00:00.000Z` });
    }

    const page1 = await readJson(await getFeed(mockContext({ query: { limit: '3' } })));
    expect(page1.recent).toHaveLength(3);
    expect(page1.cursor).toBeDefined();

    const page2 = await readJson(await getFeed(mockContext({ query: { limit: '3', cursor: page1.cursor } })));
    expect(page2.recent).toHaveLength(2);

    const uris1 = page1.recent.map((r: any) => r.uri);
    const uris2 = page2.recent.map((r: any) => r.uri);
    expect(new Set([...uris1, ...uris2]).size).toBe(5);
    expect(uris1.filter((u: string) => uris2.includes(u))).toHaveLength(0);
  });

  it('counts distinct DIDs for trending so one user counts once', async () => {
    seedBook({ uri: 'at://did:plc:author/book/trend', createdAt: '2026-01-01T00:00:00.000Z' });
    // same user, two events on the same book
    seedReview({ did: 'did:plc:reader', bookUri: 'at://did:plc:author/book/trend', createdAt: new Date(Date.now() - 60 * 1000).toISOString() });
    seedStatus({ did: 'did:plc:reader', bookUri: 'at://did:plc:author/book/trend', createdAt: new Date().toISOString() });
    // second user, one event
    seedReview({ did: 'did:plc:other', bookUri: 'at://did:plc:author/book/trend', createdAt: new Date(Date.now() - 120 * 1000).toISOString() });

    const body = await readJson(await getFeed(mockContext()));
    expect(body.trending.day).toHaveLength(1);
    expect(body.trending.day[0].uri).toBe('at://did:plc:author/book/trend');
    // other books have no trending activity
    expect(body.trending.month).toHaveLength(1);
  });

  it('excludes events outside the trending window', async () => {
    seedBook({ uri: 'at://did:plc:author/book/old', createdAt: '2026-01-01T00:00:00.000Z' });
    seedReview({
      bookUri: 'at://did:plc:author/book/old',
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const body = await readJson(await getFeed(mockContext()));
    // older than 30 days: not in any window
    expect(body.trending.day).toHaveLength(0);
    expect(body.trending.week).toHaveLength(0);
    expect(body.trending.month).toHaveLength(0);
  });

  it('includes an event exactly at the window cutoff', async () => {
    const NOW = Date.parse('2026-08-03T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    seedBook({ uri: 'at://did:plc:author/book/edge', createdAt: '2026-01-01T00:00:00.000Z' });
    // exactly 24h before NOW -> at the day cutoff (inclusive lower bound)
    seedReview({
      bookUri: 'at://did:plc:author/book/edge',
      createdAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
    });

    const body = await readJson(await getFeed(mockContext()));
    expect(body.trending.day).toHaveLength(1);

    vi.restoreAllMocks();
  });

  it('excludes rejected books from newestBooks', async () => {
    seedBook({ uri: 'at://did:plc:author/book/ok', status: 'active' });
    seedBook({ uri: 'at://did:plc:author/book/rejected', status: 'rejected' });

    const body = await readJson(await getFeed(mockContext()));
    const uris = body.newestBooks.map((b: any) => b.uri);
    expect(uris).toContain('at://did:plc:author/book/ok');
    expect(uris).not.toContain('at://did:plc:author/book/rejected');
  });

  it('adds following and crossUser for an authenticated viewer', async () => {
    (optionalAuth as any).mockResolvedValue('did:plc:viewer');
    const mockFollows = vi.fn().mockResolvedValue(['did:plc:followed']);
    (FollowsService.prototype.getFollows as any) = mockFollows;

    seedBook({ uri: 'at://did:plc:author/book/f1' });
    seedReview({ did: 'did:plc:followed', bookUri: 'at://did:plc:author/book/f1', createdAt: new Date().toISOString() });

    seedBook({ uri: 'at://did:plc:author/book/x1' });
    seedStatus({ did: 'did:plc:viewer', bookUri: 'at://did:plc:author/book/x1', createdAt: new Date().toISOString() });
    seedReview({ did: 'did:plc:other', bookUri: 'at://did:plc:author/book/x1', createdAt: new Date().toISOString() });

    const c = mockContext({ headers: { authorization: 'Bearer fake' } });
    const body = await readJson(await getFeed(c));

    expect(body.following).toHaveLength(1);
    expect(body.following[0].uri).toBe('at://did:plc:author/book/f1');
    expect(body.crossUser).toBeDefined();
    expect(body.crossUser.day.map((b: any) => b.uri)).toContain('at://did:plc:author/book/x1');
    expect(mockFollows).toHaveBeenCalledWith('did:plc:viewer');
  });

  it('sets degraded and empty following when the follows fetch fails', async () => {
    (optionalAuth as any).mockResolvedValue('did:plc:viewer');
    (FollowsService.prototype.getFollows as any) = vi.fn().mockRejectedValue(new Error('boom'));

    const body = await readJson(await getFeed(mockContext({ headers: { authorization: 'Bearer fake' } })));

    expect(body.degraded).toBe(true);
    expect(body.following).toEqual([]);
    expect(body.crossUser).toBeDefined();
  });

  it('returns 401 for a present-but-invalid token', async () => {
    (optionalAuth as any).mockRejectedValue(Object.assign(new Error('bad'), { status: 401, error: 'AuthenticationRequired' }));
    const c = mockContext({ headers: { authorization: 'Bearer invalid' } });
    await expect(getFeed(c)).rejects.toMatchObject({ status: 401 });
  });
});
