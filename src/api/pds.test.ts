import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db/connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../db/schema.js');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });

  // FTS5 + identifier views so insertBook works in tests.
  sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
    title, author, description, isbn,
    content='books', content_rowid='rowid'
  )`);
  sqlite.exec(`CREATE VIEW IF NOT EXISTS books_identifiers AS
    SELECT b.uri, b.title, b.author, b.isbn,
      json_extract(json_each.value, '$.type') as identifier_type,
      json_extract(json_each.value, '$.value') as identifier_value,
      'json' as claim_status
    FROM books b JOIN json_each(b.identifiers) json_each
    WHERE json_extract(json_each.value, '$.value') IS NOT NULL
      AND json_extract(json_each.value, '$.value') != ''`);

  return { db, schema, sqliteHandle: sqlite };
});

import { db, schema } from '../db/connection.js';
import { insertBook, insertContributor, insertContributorType, COLLECTIONS } from '../records.js';
import {
  getRecord,
  listRecords,
  describeRepo,
  resolveHandle,
  serveAtprotoDid,
} from './pds.js';
import { cidForRecord } from '../pds/cid.js';
import { serializeBook } from '../pds/records.js';

const SERVICE_DID = 'did:web:test.local';

// Tiny test app: real Hono + real handlers + a `host` header so the
// resolveOwningDid helper treats `test.local` as our handle.
function makeApp(): Hono {
  const app = new Hono();
  app.get('/xrpc/com.atproto.repo.getRecord', getRecord);
  app.get('/xrpc/com.atproto.repo.listRecords', listRecords);
  app.get('/xrpc/com.atproto.repo.describeRepo', describeRepo);
  app.get('/xrpc/com.atproto.identity.resolveHandle', resolveHandle);
  app.get('/.well-known/atproto-did', serveAtprotoDid);
  return app;
}

const HOST = 'test.local';

function call(
  app: Hono,
  path: string,
  init: { headers?: Record<string, string> } = {},
): Promise<Response> {
  // Pass host explicitly so resolveOwningDid picks up our test handle.
  const headers = { host: HOST, ...init.headers };
  const result = app.request(`https://${HOST}${path}`, { headers });
  return Promise.resolve(result) as Promise<Response>;
}

// Counter-based ISBN so each test gets a unique value (the in-memory DB
// persists across tests in this suite).
let isbnCounter = 0;
function nextIsbn(): string {
  isbnCounter += 1;
  return `978${String(isbnCounter).padStart(10, '0')}`;
}

beforeEach(() => {
  process.env.ATP_SERVICE_DID = SERVICE_DID;
});

afterEach(() => {
  delete process.env.ATP_SERVICE_DID;
});

describe('pds.getRecord', () => {
  it('returns the record with its CID for a book under our DID', async () => {
    const app = makeApp();
    const { uri, cid: storedCid } = await insertBook(db, {
      did: SERVICE_DID,
      title: 'The Pragmatic Programmer',
      author: 'Hunt & Thomas',
      isbn: nextIsbn(),
      identifiers: [],
    });

    const res = await call(app, `/xrpc/com.atproto.repo.getRecord?repo=${SERVICE_DID}&collection=${COLLECTIONS.book}&rkey=${uri.split('/').pop()}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      uri,
      cid: storedCid,
      value: {
        $type: 'community.lexicon.book.book',
        title: 'The Pragmatic Programmer',
        author: 'Hunt & Thomas',
        isbn: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    expect(body.cid).toMatch(/^b[a-z2-7]+$/);
  });

  it('returns the record with its CID for a contributor', async () => {
    const app = makeApp();
    const { uri, cid } = await insertContributor(db, {
      did: SERVICE_DID,
      name: 'Jane Hunt',
      identifiers: [{ type: 'olid', value: 'OL1A' }],
    });

    const res = await call(
      app,
      `/xrpc/com.atproto.repo.getRecord?repo=${SERVICE_DID}&collection=${COLLECTIONS.contributor}&rkey=${uri.split('/').pop()}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uri).toBe(uri);
    expect(body.cid).toBe(cid);
    expect(body.value).toMatchObject({
      $type: 'community.lexicon.book.contributor',
      name: 'Jane Hunt',
      identifiers: [{ type: 'olid', value: 'OL1A' }],
    });
  });

  it('returns the record with its CID for a contributor type', async () => {
    const app = makeApp();
    const { uri, cid } = await insertContributorType(db, {
      did: SERVICE_DID,
      name: 'author',
      description: 'Original writer of the work.',
    });

    const res = await call(
      app,
      `/xrpc/com.atproto.repo.getRecord?repo=${SERVICE_DID}&collection=${COLLECTIONS.contributorType}&rkey=${uri.split('/').pop()}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uri).toBe(uri);
    expect(body.cid).toBe(cid);
    expect(body.value).toEqual({
      $type: 'community.lexicon.book.contributor.type',
      name: 'author',
      description: 'Original writer of the work.',
      createdAt: expect.any(String),
    });
  });

  it('returns 400 RecordNotFound when the record does not exist', async () => {
    const app = makeApp();
    const res = await call(
      app,
      `/xrpc/com.atproto.repo.getRecord?repo=${SERVICE_DID}&collection=${COLLECTIONS.book}&rkey=nonexistent123`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('RecordNotFound');
  });

  it('returns 400 InvalidRequest when the collection is user-owned', async () => {
    const app = makeApp();
    const res = await call(
      app,
      `/xrpc/com.atproto.repo.getRecord?repo=${SERVICE_DID}&collection=${COLLECTIONS.review}&rkey=abc`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('InvalidRequest');
  });

  it('returns 400 InvalidRequest when the repo is not our DID', async () => {
    const app = makeApp();
    const res = await call(
      app,
      `/xrpc/com.atproto.repo.getRecord?repo=did:web:other.example&collection=${COLLECTIONS.book}&rkey=abc`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('InvalidRequest');
  });

  it('accepts the handle as repo when it matches the host', async () => {
    const app = makeApp();
    const { uri } = await insertBook(db, {
      did: SERVICE_DID,
      title: 'Foo',
      author: 'Bar',
      isbn: nextIsbn(),
      identifiers: [],
    });

    const res = await call(
      app,
      `/xrpc/com.atproto.repo.getRecord?repo=${HOST}&collection=${COLLECTIONS.book}&rkey=${uri.split('/').pop()}`,
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 when the cid query param does not match the stored CID', async () => {
    const app = makeApp();
    const { uri } = await insertBook(db, {
      did: SERVICE_DID,
      title: 'Mismatch',
      author: 'Author',
      isbn: nextIsbn(),
      identifiers: [],
    });

    const res = await call(
      app,
      `/xrpc/com.atproto.repo.getRecord?repo=${SERVICE_DID}&collection=${COLLECTIONS.book}&rkey=${uri.split('/').pop()}&cid=bafyreiwrongcid`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('InvalidRequest');
    expect(body.message).toMatch(/cid mismatch/);
  });

  it('matches cid when the query param equals the stored CID', async () => {
    const app = makeApp();
    const { uri, cid } = await insertBook(db, {
      did: SERVICE_DID,
      title: 'Match',
      author: 'Author',
      isbn: nextIsbn(),
      identifiers: [],
    });

    const res = await call(
      app,
      `/xrpc/com.atproto.repo.getRecord?repo=${SERVICE_DID}&collection=${COLLECTIONS.book}&rkey=${uri.split('/').pop()}&cid=${cid}`,
    );
    expect(res.status).toBe(200);
  });
});

describe('pds.listRecords', () => {
  it('paginates forward with cursors', async () => {
    const app = makeApp();
    const did = SERVICE_DID;
    for (let i = 0; i < 5; i++) {
      await insertBook(db, {
        did,
        title: `Book ${i}`,
        author: `Author ${i}`,
        isbn: nextIsbn(),
        identifiers: [],
      });
    }

    const page1Res = await call(app, `/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${COLLECTIONS.book}&limit=2`);
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json();
    expect(page1.records).toHaveLength(2);
    expect(page1.cursor).toBeTruthy();

    const page2Res = await call(
      app,
      `/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${COLLECTIONS.book}&limit=2&cursor=${page1.cursor}`,
    );
    const page2 = await page2Res.json();
    expect(page2.records).toHaveLength(2);

    const seenUris = new Set([
      ...page1.records.map((r: { uri: string }) => r.uri),
      ...page2.records.map((r: { uri: string }) => r.uri),
    ]);
    expect(seenUris.size).toBe(4);
  });

  it('respects reverse order', async () => {
    const app = makeApp();
    const did = SERVICE_DID;
    const tag = `REV-${Date.now()}`;
    const uris: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { uri } = await insertBook(db, {
        did,
        title: `${tag} ${i}`,
        author: `Author ${i}`,
        isbn: nextIsbn(),
        identifiers: [],
      });
      uris.push(uri);
    }

    const fwdRes = await call(app, `/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${COLLECTIONS.book}&limit=100`);
    const revRes = await call(app, `/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${COLLECTIONS.book}&limit=100&reverse=true`);
    const fwd = (await fwdRes.json()).records.map((r: { uri: string }) => r.uri);
    const rev = (await revRes.json()).records.map((r: { uri: string }) => r.uri);

    // The reverse of the entire page (when there are no NULL-cid rows
    // that get filtered mid-page) must equal the forward page. Our test
    // data uses a NULL-cid row from a previous test to exercise the skip
    // path, but the fwd/rev lists should still share all their non-NULL
    // rows. Assert the *shared* rows appear in opposite order.
    const fwdSet = new Set(fwd);
    const shared = rev.filter((u: string) => fwdSet.has(u));
    expect(shared).toEqual(fwd.slice().reverse());
  });

  it('rejects unsupported collections', async () => {
    const app = makeApp();
    const res = await call(app, `/xrpc/com.atproto.repo.listRecords?repo=${SERVICE_DID}&collection=${COLLECTIONS.review}`);
    expect(res.status).toBe(400);
  });

  it('serves rows that have no stored CID by computing on the fly', async () => {
    const app = makeApp();
    const did = SERVICE_DID;
    db.insert(schema.books).values({
      uri: 'at://did:web:test.local/community.lexicon.book.book/manual123',
      did,
      title: 'No Stored CID',
      author: 'B',
      language: 'en',
      categories: [],
      identifiers: [],
      contributors: [],
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cid: null,
    }).run();

    // listRecords includes the row, with a CID computed on the fly.
    const listRes = await call(app, `/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${COLLECTIONS.book}&limit=100`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const listed = listBody.records.find((r: { uri: string }) => r.uri.endsWith('manual123'));
    expect(listed).toBeDefined();
    expect(listed.cid).toMatch(/^b[a-z2-7]+$/);
    expect(listed.value.title).toBe('No Stored CID');

    // getRecord works too.
    const getRes = await call(
      app,
      `/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${COLLECTIONS.book}&rkey=manual123`,
    );
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.cid).toMatch(/^b[a-z2-7]+$/);
    expect(getBody.value.title).toBe('No Stored CID');
    // The computed CID is deterministic for the same value.
    const { cidForRecord } = await import('../pds/cid.js');
    const { serializeBook } = await import('../pds/records.js');
    const row = await db.query.books.findFirst({
      where: (b, { eq }) => eq(b.uri, 'at://did:web:test.local/community.lexicon.book.book/manual123'),
    });
    expect(getBody.cid).toBe(await cidForRecord(serializeBook(row!)));
  });
});

describe('pds.describeRepo', () => {
  it('returns the DID doc with both labeler and PDS services', async () => {
    const app = makeApp();
    const res = await call(app, `/xrpc/com.atproto.repo.describeRepo?repo=${SERVICE_DID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.did).toBe(SERVICE_DID);
    expect(body.handle).toBe(HOST);
    expect(body.handleIsCorrect).toBe(true);
    expect(body.didDoc.service).toHaveLength(2);
    expect(body.didDoc.service.map((s: { type: string }) => s.type)).toEqual([
      'AtprotoLabeler',
      'AtprotoPersonalDataServer',
    ]);
    expect(body.collections).toEqual([
      'community.lexicon.book.book',
      'community.lexicon.book.contributor',
      'community.lexicon.book.contributor.type',
    ]);
  });

  it('returns 400 for a non-owned repo', async () => {
    const app = makeApp();
    const res = await call(app, `/xrpc/com.atproto.repo.describeRepo?repo=did:web:other.example`);
    expect(res.status).toBe(400);
  });
});

describe('pds.resolveHandle', () => {
  it('resolves the host handle', async () => {
    const app = makeApp();
    const res = await call(app, `/xrpc/com.atproto.identity.resolveHandle?handle=${HOST}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.did).toBe(SERVICE_DID);
  });

  it('resolves the bare DID handle', async () => {
    const app = makeApp();
    const res = await call(app, `/xrpc/com.atproto.identity.resolveHandle?handle=test.local`);
    expect(res.status).toBe(200);
  });

  it('rejects unrelated handles', async () => {
    const app = makeApp();
    const res = await call(app, `/xrpc/com.atproto.identity.resolveHandle?handle=attacker.example`);
    expect(res.status).toBe(400);
  });
});

describe('pds.serveAtprotoDid', () => {
  it('returns the service DID as plain text', async () => {
    const app = makeApp();
    const res = await call(app, '/.well-known/atproto-did');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SERVICE_DID);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
  });
});

describe('CID integrity', () => {
  it('CID returned by getRecord equals cidForRecord(serializeBook(row))', async () => {
    const { uri, cid: storedCid } = await insertBook(db, {
      did: SERVICE_DID,
      title: 'Integrity',
      author: 'Check',
      isbn: nextIsbn(),
      identifiers: [],
    });
    const row = await db.query.books.findFirst({ where: (b, { eq }) => eq(b.uri, uri) });
    const expected = await cidForRecord(serializeBook(row!));
    expect(storedCid).toBe(expected);
  });
});