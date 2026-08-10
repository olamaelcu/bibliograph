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

vi.mock('../auth.js', async () => {
  return {
    requireAuth: vi.fn().mockResolvedValue('did:plc:test'),
    isLibrarian: vi.fn().mockReturnValue(false),
  };
});

import { db, schema } from '../db/connection.js';
import { clearSqliteTables } from '../test-utils/db.js';
const _d = db as any;
const _s = schema;

import { requireAuth, isLibrarian } from '../auth.js';
import {
  createContributor,
  updateContributor,
  createContributorType,
  serializeContributor,
  serializeContributorType,
} from './contributor.js';

function getSqlite() {
  return _d.$sqlite as InstanceType<typeof import('better-sqlite3')>;
}

function clearTables() {
  clearSqliteTables(getSqlite());
}

function mockContext(overrides: {
  jsonBody?: unknown;
} = {}) {
  const store = new Map<string, unknown>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  store.set('log', log);

  const headers = new Headers({ authorization: 'Bearer test-token' });

  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    req: {
      query: () => ({}),
      queries: () => undefined,
      json: () => Promise.resolve(overrides.jsonBody),
      raw: { headers },
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
  const uri = overrides.uri || 'at://did:plc:test/community.lexicon.book.contributor/test001';
  db.insert(_s.contributors).values({
    uri,
    did: overrides.did ?? 'did:plc:test',
    name: 'Existing Contributor',
    altNames: [],
    images: [],
    identifiers: [{ type: 'website', value: 'https://example.com' }],
    bio: null,
    createdAt: now,
    ...overrides,
  }).run();
  return uri;
}

function seedContributorType(overrides: Partial<typeof _s.contributorTypes.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const uri = overrides.uri || 'at://did:web:localhost/community.lexicon.book.contributorType/test001';
  db.insert(_s.contributorTypes).values({
    uri,
    did: overrides.did ?? 'did:web:localhost',
    name: overrides.name ?? 'author',
    description: overrides.description ?? null,
    createdAt: now,
  }).run();
  return uri;
}

describe('api/contributor', () => {
  beforeEach(() => {
    clearTables();
    vi.clearAllMocks();
    (requireAuth as any).mockResolvedValue('did:plc:test');
    (isLibrarian as any).mockReturnValue(false);
  });

  describe('createContributor', () => {
    it('returns 400 when name is missing', async () => {
      const c = mockContext({ jsonBody: { identifiers: [{ type: 'website', value: 'x' }] } });
      const res = await createContributor(c);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe('InvalidInput');
    });

    it('returns 400 when identifiers is missing', async () => {
      const c = mockContext({ jsonBody: { name: 'Alice' } });
      const res = await createContributor(c);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe('InvalidInput');
    });

    it('returns 400 when identifiers is empty', async () => {
      const c = mockContext({ jsonBody: { name: 'Alice', identifiers: [] } });
      const res = await createContributor(c);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe('InvalidInput');
    });

    it('returns 400 when an identifier value is empty', async () => {
      const c = mockContext({
        jsonBody: { name: 'Alice', identifiers: [{ type: 'website', value: '' }] },
      });
      const res = await createContributor(c);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe('InvalidInput');
    });

    it('returns 409 when an identifier already exists on another contributor', async () => {
      seedContributor({
        uri: 'at://did:plc:other/community.lexicon.book.contributor/existing',
        identifiers: [{ type: 'website', value: 'https://existing.com' }],
      });
      const c = mockContext({
        jsonBody: {
          name: 'Alice',
          identifiers: [{ type: 'website', value: 'https://existing.com' }],
        },
      });
      const res = await createContributor(c);
      expect(res.status).toBe(409);
      const body = await readJson(res);
      expect(body.error).toBe('DuplicateContributor');
      expect(body.existingUri).toBe('at://did:plc:other/community.lexicon.book.contributor/existing');
    });

    it('returns 200 and persists on happy path', async () => {
      const c = mockContext({
        jsonBody: {
          name: 'Alice Walker',
          altNames: ['A. Walker'],
          images: [{ url: 'https://example.com/alice.jpg', alt: 'Alice' }],
          identifiers: [{ type: 'website', value: 'https://alice.example' }],
          bio: 'American novelist',
        },
      });
      const res = await createContributor(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.uri).toMatch(/^at:\/\/did:plc:test\/community\.lexicon\.book\.contributor\//);
      expect(body.cid).toBeTruthy();

      const row = db.select().from(_s.contributors).all();
      expect(row).toHaveLength(1);
      expect(row[0].name).toBe('Alice Walker');
      expect(row[0].altNames).toEqual(['A. Walker']);
      expect(row[0].images).toEqual([{ url: 'https://example.com/alice.jpg', alt: 'Alice' }]);
      expect(row[0].identifiers).toEqual([{ type: 'website', value: 'https://alice.example' }]);
      expect(row[0].bio).toBe('American novelist');
    });

    it('accepts a 16384-char bio', async () => {
      const bio = 'a'.repeat(16384);
      const c = mockContext({
        jsonBody: {
          name: 'Alice',
          identifiers: [{ type: 'website', value: 'https://alice.example' }],
          bio,
        },
      });
      const res = await createContributor(c);
      expect(res.status).toBe(200);
    });

    it('rejects a 16385-char bio with 400', async () => {
      const bio = 'a'.repeat(16385);
      const c = mockContext({
        jsonBody: {
          name: 'Alice',
          identifiers: [{ type: 'website', value: 'https://alice.example' }],
          bio,
        },
      });
      const res = await createContributor(c);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe('InvalidInput');
    });

    it('rejects a name longer than 200 chars with 400', async () => {
      const c = mockContext({
        jsonBody: {
          name: 'a'.repeat(201),
          identifiers: [{ type: 'website', value: 'https://alice.example' }],
        },
      });
      const res = await createContributor(c);
      expect(res.status).toBe(400);
    });
  });

  describe('updateContributor', () => {
    it('returns 400 when uri is missing', async () => {
      const c = mockContext({ jsonBody: { patch: { name: 'New' } } });
      const res = await updateContributor(c);
      expect(res.status).toBe(400);
    });

    it('returns 404 when contributor does not exist', async () => {
      const c = mockContext({ jsonBody: { uri: 'at://nope/contributor/x' } });
      const res = await updateContributor(c);
      expect(res.status).toBe(404);
      const body = await readJson(res);
      expect(body.error).toBe('NotFound');
    });

    it('returns 403 when caller is neither creator nor librarian', async () => {
      const uri = seedContributor({ did: 'did:plc:other' });
      (requireAuth as any).mockResolvedValue('did:plc:stranger');
      (isLibrarian as any).mockReturnValue(false);

      const c = mockContext({ jsonBody: { uri, patch: { name: 'X' } } });
      const res = await updateContributor(c);
      expect(res.status).toBe(403);
    });

    it('returns 200 when caller is the creator', async () => {
      const uri = seedContributor();
      const c = mockContext({ jsonBody: { uri, patch: { name: 'New Name' } } });
      const res = await updateContributor(c);
      expect(res.status).toBe(200);

      const row = db.select().from(_s.contributors).all();
      const found = row.find((r: { uri: string }) => r.uri === uri)!;
      expect(found.name).toBe('New Name');
    });

    it('returns 200 when caller is a librarian (different DID)', async () => {
      const uri = seedContributor({ did: 'did:plc:other' });
      (requireAuth as any).mockResolvedValue('did:plc:librarian');
      (isLibrarian as any).mockReturnValue(true);

      const c = mockContext({ jsonBody: { uri, patch: { name: 'Edited by Lib' } } });
      const res = await updateContributor(c);
      expect(res.status).toBe(200);
    });

    it('replaces name via patch', async () => {
      const uri = seedContributor({ name: 'Old Name' });
      const c = mockContext({ jsonBody: { uri, patch: { name: 'New Name' } } });
      const res = await updateContributor(c);
      expect(res.status).toBe(200);
      const row = db.select().from(_s.contributors).all().find((r: { uri: string }) => r.uri === uri)!;
      expect(row.name).toBe('New Name');
    });

    it('replaces altNames entirely', async () => {
      const uri = seedContributor({ altNames: ['a', 'b'] });
      const c = mockContext({ jsonBody: { uri, patch: { altNames: ['c'] } } });
      const res = await updateContributor(c);
      expect(res.status).toBe(200);
      const row = db.select().from(_s.contributors).all().find((r: { uri: string }) => r.uri === uri)!;
      expect(row.altNames).toEqual(['c']);
    });

    it('appends addIdentifiers', async () => {
      const uri = seedContributor({
        identifiers: [{ type: 'website', value: 'https://a.com' }],
      });
      const c = mockContext({
        jsonBody: {
          uri,
          addIdentifiers: [{ type: 'mastodon', value: '@a@h.social' }],
        },
      });
      const res = await updateContributor(c);
      expect(res.status).toBe(200);
      const row = db.select().from(_s.contributors).all().find((r: { uri: string }) => r.uri === uri)!;
      expect(row.identifiers).toEqual([
        { type: 'website', value: 'https://a.com' },
        { type: 'mastodon', value: '@a@h.social' },
      ]);
    });

    it('removes identifiers by pair', async () => {
      const uri = seedContributor({
        identifiers: [
          { type: 'website', value: 'https://a.com' },
          { type: 'mastodon', value: '@a@h.social' },
        ],
      });
      const c = mockContext({
        jsonBody: {
          uri,
          removeIdentifiers: [{ type: 'mastodon', value: '@a@h.social' }],
        },
      });
      const res = await updateContributor(c);
      expect(res.status).toBe(200);
      const row = db.select().from(_s.contributors).all().find((r: { uri: string }) => r.uri === uri)!;
      expect(row.identifiers).toEqual([{ type: 'website', value: 'https://a.com' }]);
    });

    it('rejects removeIdentifiers for a pair that does not exist', async () => {
      const uri = seedContributor({
        identifiers: [{ type: 'website', value: 'https://a.com' }],
      });
      const c = mockContext({
        jsonBody: {
          uri,
          removeIdentifiers: [{ type: 'mastodon', value: '@missing@h.social' }],
        },
      });
      const res = await updateContributor(c);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe('InvalidInput');
    });

    it('rejects addIdentifiers when the pair already exists on this contributor', async () => {
      const uri = seedContributor({
        identifiers: [{ type: 'website', value: 'https://a.com' }],
      });
      const c = mockContext({
        jsonBody: {
          uri,
          addIdentifiers: [{ type: 'website', value: 'https://a.com' }],
        },
      });
      const res = await updateContributor(c);
      expect(res.status).toBe(400);
    });

    it('addImages dedupes by url', async () => {
      const uri = seedContributor({ images: [{ url: 'https://x.com/a.jpg' }] });
      const c = mockContext({
        jsonBody: {
          uri,
          addImages: [
            { url: 'https://x.com/b.jpg' },
            { url: 'https://x.com/a.jpg', alt: 'dup' },
          ],
        },
      });
      const res = await updateContributor(c);
      expect(res.status).toBe(400);
    });

    it('returns 400 when identifiers become empty after the patch', async () => {
      const uri = seedContributor({
        identifiers: [{ type: 'website', value: 'https://a.com' }],
      });
      const c = mockContext({
        jsonBody: {
          uri,
          removeIdentifiers: [{ type: 'website', value: 'https://a.com' }],
        },
      });
      const res = await updateContributor(c);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toBe('InvalidInput');
    });

    it('returns 400 when patch.name is empty', async () => {
      const uri = seedContributor();
      const c = mockContext({ jsonBody: { uri, patch: { name: '' } } });
      const res = await updateContributor(c);
      expect(res.status).toBe(400);
    });

    it('returns 409 when an added identifier collides with another contributor', async () => {
      const otherUri = seedContributor({
        uri: 'at://did:plc:other/contributor/other',
        identifiers: [{ type: 'website', value: 'https://taken.com' }],
      });
      const uri = seedContributor({
        uri: 'at://did:plc:test/contributor/mine',
        identifiers: [{ type: 'mastodon', value: '@a@h.social' }],
      });
      const c = mockContext({
        jsonBody: {
          uri,
          addIdentifiers: [{ type: 'website', value: 'https://taken.com' }],
        },
      });
      const res = await updateContributor(c);
      expect(res.status).toBe(409);
      const body = await readJson(res);
      expect(body.error).toBe('DuplicateContributor');
    });
  });

  describe('createContributorType', () => {
    it('returns 403 when caller is not a librarian', async () => {
      (isLibrarian as any).mockReturnValue(false);
      const c = mockContext({ jsonBody: { name: 'narrator' } });
      const res = await createContributorType(c);
      expect(res.status).toBe(403);
    });

    it('returns 200 and persists for a librarian', async () => {
      (isLibrarian as any).mockReturnValue(true);
      const c = mockContext({
        jsonBody: { name: 'narrator', description: 'Audiobook voice' },
      });
      const res = await createContributorType(c);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.uri).toMatch(/^at:\/\/did:plc:test\/community\.lexicon\.book\.contributorType\//);
    });

    it('returns 409 on duplicate name', async () => {
      seedContributorType({ name: 'author' });
      (isLibrarian as any).mockReturnValue(true);
      const c = mockContext({ jsonBody: { name: 'author' } });
      const res = await createContributorType(c);
      expect(res.status).toBe(409);
      const body = await readJson(res);
      expect(body.error).toBe('DuplicateContributorType');
    });

    it('returns 400 when name is missing', async () => {
      (isLibrarian as any).mockReturnValue(true);
      const c = mockContext({ jsonBody: {} });
      const res = await createContributorType(c);
      expect(res.status).toBe(400);
    });

    it('returns 400 when name exceeds 256 chars', async () => {
      (isLibrarian as any).mockReturnValue(true);
      const c = mockContext({ jsonBody: { name: 'a'.repeat(257) } });
      const res = await createContributorType(c);
      expect(res.status).toBe(400);
    });

    it('accepts a 256-char name', async () => {
      (isLibrarian as any).mockReturnValue(true);
      const c = mockContext({ jsonBody: { name: 'a'.repeat(256) } });
      const res = await createContributorType(c);
      expect(res.status).toBe(200);
    });

    it('rejects description longer than 16384 chars', async () => {
      (isLibrarian as any).mockReturnValue(true);
      const c = mockContext({ jsonBody: { name: 'foo', description: 'a'.repeat(16385) } });
      const res = await createContributorType(c);
      expect(res.status).toBe(400);
    });
  });

  describe('serializers', () => {
    it('serializeContributor omits empty optional fields', () => {
      const row = {
        uri: 'at://x',
        did: 'did:plc:test',
        name: 'Bob',
        altNames: [],
        images: [],
        identifiers: [],
        bio: null,
        createdAt: '2024-01-01T00:00:00Z',
      } as any;
      const rec = serializeContributor(row);
      expect(rec).toEqual({
        $type: 'community.lexicon.book.contributor',
        name: 'Bob',
        createdAt: '2024-01-01T00:00:00Z',
      });
    });

    it('serializeContributorType includes description when present', () => {
      const row = {
        uri: 'at://x',
        did: 'did:plc:test',
        name: 'editor',
        description: 'Edited the work',
        createdAt: '2024-01-01T00:00:00Z',
      } as any;
      const rec = serializeContributorType(row);
      expect(rec).toEqual({
        $type: 'community.lexicon.book.contributorType',
        name: 'editor',
        description: 'Edited the work',
        createdAt: '2024-01-01T00:00:00Z',
      });
    });
  });
});
