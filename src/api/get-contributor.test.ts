import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { db, schema } from '../db/connection.js';
import { clearSqliteTables } from '../test-utils/db.js';
const _d = db as any;
const _s = schema;

import { listContributors, searchContributors, listContributorTypes } from './get-contributor.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

function clearTables() {
  clearSqliteTables(getSqlite());
}

function mockContext(overrides: {
  query?: Record<string, string>;
} = {}) {
  const store = new Map<string, unknown>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  store.set('log', log);

  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    req: {
      query: () => (overrides.query || {}),
      queries: () => undefined,
    },
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as any;
}

async function readJson(res: Response) {
  return JSON.parse(await res.text());
}

function seedContributor(overrides: Partial<typeof _s.contributors.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const uri = overrides.uri || `at://did:plc:test/community.lexicon.book.contributor/${Math.random().toString(36).slice(2, 10)}`;
  db.insert(_s.contributors).values({
    uri,
    did: overrides.did ?? 'did:plc:test',
    name: overrides.name ?? 'Test Contributor',
    altNames: overrides.altNames ?? [],
    images: overrides.images ?? [],
    identifiers: overrides.identifiers ?? [],
    bio: overrides.bio ?? null,
    createdAt: overrides.createdAt ?? now,
  }).run();
  return uri;
}

function seedContributorType(overrides: Partial<typeof _s.contributorTypes.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const uri = overrides.uri || `at://did:web:localhost/community.lexicon.book.contributorType/${Math.random().toString(36).slice(2, 10)}`;
  db.insert(_s.contributorTypes).values({
    uri,
    did: overrides.did ?? 'did:web:localhost',
    name: overrides.name ?? 'author',
    description: overrides.description ?? null,
    createdAt: overrides.createdAt ?? now,
  }).run();
  return uri;
}

describe('api/get-contributor', () => {
  beforeEach(() => {
    clearTables();
    vi.clearAllMocks();
  });

  describe('listContributors', () => {
    it('returns all contributors sorted by createdAt desc', async () => {
      seedContributor({ name: 'Alice', createdAt: '2024-01-01T00:00:00.000Z' });
      seedContributor({ name: 'Bob',   createdAt: '2024-02-01T00:00:00.000Z' });
      const c = mockContext();
      const res = await listContributors(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.contributors.map((x: { record: { name: string } }) => x.record.name)).toEqual(['Bob', 'Alice']);
    });

    it('respects limit query param', async () => {
      seedContributor({ name: 'A' });
      seedContributor({ name: 'B' });
      seedContributor({ name: 'C' });
      const c = mockContext({ query: { limit: '2' } });
      const res = await listContributors(c);
      const body = await readJson(res);
      expect(body.contributors.length).toBe(2);
    });
  });

  describe('searchContributors', () => {
    it('returns 400 when q is missing', async () => {
      const c = mockContext();
      const res = await searchContributors(c);
      expect(res.status).toBe(400);
    });

    it('matches name substring (case-insensitive)', async () => {
      seedContributor({ name: 'Alice Walker' });
      seedContributor({ name: 'Bob Smith' });
      const c = mockContext({ query: { q: 'alice' } });
      const res = await searchContributors(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.contributors).toHaveLength(1);
      expect(body.contributors[0].record.name).toBe('Alice Walker');
    });

    it('matches altNames substring', async () => {
      seedContributor({ name: 'Alice Walker', altNames: ['A. W.'] });
      const c = mockContext({ query: { q: 'A. W.' } });
      const res = await searchContributors(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.contributors).toHaveLength(1);
    });
  });

  describe('listContributorTypes', () => {
    it('returns types scoped to SERVICE_DID', async () => {
      seedContributorType({ did: 'did:web:localhost', name: 'author' });
      seedContributorType({ did: 'did:web:localhost', name: 'illustrator' });
      seedContributorType({ did: 'did:plc:other', name: 'ghost' });
      const c = mockContext();
      const res = await listContributorTypes(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      const names = body.types.map((t: { record: { name: string } }) => t.record.name);
      expect(names).toContain('author');
      expect(names).toContain('illustrator');
      expect(names).not.toContain('ghost');
    });
  });
});
