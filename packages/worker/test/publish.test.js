import { expect, test, afterAll, afterEach, beforeAll } from 'vitest';

import http from 'node:http';
import pg from 'pg';

import { createTasks } from '../lib/tasks.js';
import { createIngest } from '../lib/ingest.js';
import { normalizeContributorRole } from '../lib/contributor-roles.js';
import {
  DEFAULT_BATCH,
  claimBatch,
  completeEntry,
  createOutboxPublisher,
  publishEntry
} from '../lib/publish.js';
import {
  PublisherConfigError,
  createPdsPublisher,
  resolvePublisherConfig
} from '../lib/pds.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://bibliograph:bibliograph@localhost:5432/bibliograph';
const PUBLISHER_DID = 'did:web:pds-test.example';
const HOST = 'pds-test.example';
const COLLECTION = 'community.lexicon.media.book.edition';
const PREFIX = `at://${PUBLISHER_DID}/${COLLECTION}/`;
const PLC_PUBLISHER_DID = 'did:plc:testpublisherauthority';
// Edition URIs and the outbox row both use the `.edition` collection.
const PLC_PREFIX = `at://${PLC_PUBLISHER_DID}/${COLLECTION}/`;
const CONTRIBUTOR_PREFIX = 'PDS Test Contributor';

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const silent = { info() {}, warn() {}, error() {}, debug() {} };

let stub;

function validConfig(pdsUrl) {
  return {
    pdsUrl,
    publisherDid: PUBLISHER_DID,
    accountDid: PUBLISHER_DID,
    password: 'test-password',
    accessToken: undefined,
    refreshToken: undefined,
    problems: [],
    configured: true
  };
}

function startStub() {
  const state = {
    requests: [],
    applyWrites: [],
    rejected: [],
    poisonRkey: undefined,
    applyWriteNext: undefined,
    refreshNext: undefined,
    refreshJwt: 'test-refresh-jwt'
  };

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text === '' ? undefined : JSON.parse(text);
    state.requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body
    });

    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (request.method === 'POST' && request.url === '/xrpc/com.atproto.server.createSession') {
      return send(200, {
        accessJwt: 'test-access-jwt',
        refreshJwt: 'test-refresh-jwt',
        did: body.identifier,
        handle: HOST
      });
    }
    if (request.method === 'GET' && request.url === '/xrpc/com.atproto.server.getSession') {
      return send(200, { did: PUBLISHER_DID, handle: HOST });
    }
    if (request.method === 'POST' && request.url === '/xrpc/com.atproto.server.refreshSession') {
      if (state.refreshNext) {
        const next = state.refreshNext;
        state.refreshNext = undefined;
        return send(next.status, next.body);
      }
      return send(200, {
        accessJwt: 'refreshed-access-jwt',
        refreshJwt: state.refreshJwt,
        did: PUBLISHER_DID
      });
    }
    if (request.method === 'POST' && request.url === '/xrpc/com.atproto.repo.applyWrites') {
      if (state.applyWriteNext) {
        const next = state.applyWriteNext;
        state.applyWriteNext = undefined;
        return send(next.status, next.body);
      }
      // A poisoned rkey makes the whole call fail, as an atomic PDS call would.
      if (state.poisonRkey && body.writes.some((write) => write.rkey === state.poisonRkey)) {
        state.rejected.push({ body });
        return send(500, {
          error: 'InternalServerError',
          message: `the PDS refused the chunk containing ${state.poisonRkey}`
        });
      }
      const results = body.writes.map((write) => {
        const uri = `at://${body.repo}/${write.collection}/${write.rkey}`;
        return write.$type.endsWith('#delete')
          ? { uri }
          : {
              uri,
              cid: `bafy-test-${state.applyWrites.length + 1}-${write.rkey}`,
              validationStatus: 'valid'
            };
      });
      state.applyWrites.push({ body, results });
      return send(200, { results, commit: { cid: 'bafy-commit', rev: 'test' } });
    }
    send(404, { error: 'NotFound', message: `no stub route for ${request.method} ${request.url}` });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      stub = {
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((done) => server.close(done))
      };
      resolve(stub);
    });
  });
}

let sequence = 0;

async function makeEdition({
  title = 'A Test Edition',
  format = 'physical',
  identifiers = [
    { issuer: 'googlebooks', value: `gb-${sequence}` },
    { issuer: 'isbn13', value: `978000000${String(sequence).padStart(4, '0')}` }
  ],
  contributors = [{ name: `${CONTRIBUTOR_PREFIX} ${sequence}`, role: 'author' }],
  publisherName = `PDS Test Publisher ${sequence}`,
  coverUrl = 'https://covers.example/test.jpg'
} = {}) {
  sequence += 1;
  const rkey = `pds-test-${Date.now()}-${sequence}`;
  const uri = `${PREFIX}${rkey}`;
  const createdAt = new Date('2026-02-03T04:05:06.000Z');
  await pool.query(
    `INSERT INTO editions (
       uri, rkey, title, subtitle, chapters, series,
       book_edition, cover_url, created_at, indexed_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,now())`,
    [
      uri,
      rkey,
      title,
      'A Subtitle',
      12,
      JSON.stringify({ name: 'Test Series', position: '1' }),
      'First',
      coverUrl,
      createdAt
    ]
  );

  for (const identifier of identifiers) {
    await pool.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value) VALUES ($1,$2,$3)`,
      [uri, identifier.issuer, identifier.value]
    );
    // The published shape is the identifier union (0007), so the fixture's
    // claim has to live on the identifier.
    await pool.query(
      `INSERT INTO edition_identifier_info
         (edition_uri, issuer, value, language, published_date, description, extent)
       VALUES ($1,$2,$3,'en','2020-01','A test description.',
               jsonb_build_object('format', $4::text, 'pages', 320, 'durationSeconds', 3600))`,
      [uri, identifier.issuer, identifier.value, format]
    );
  }

  let position = 1;
  for (const contributor of contributors) {
    const inserted = await pool.query(
      `INSERT INTO contributors (name, identifiers) VALUES ($1, $2::jsonb)
       ON CONFLICT (lower(name), identifiers) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [contributor.name, JSON.stringify(contributor.identifiers ?? [])]
    );
    await pool.query(
      `INSERT INTO edition_contributors (edition_uri, contributor_id, position, role, ref)
       VALUES ($1,$2,$3,$4,$5)`,
      [uri, inserted.rows[0].id, position, contributor.role ?? 'author', contributor.ref ?? null]
    );
    position += 1;
  }

  const publisher = await pool.query(
    `INSERT INTO publishers (name, identifiers) VALUES ($1, $2::jsonb)
     ON CONFLICT (lower(name), identifiers) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [publisherName, JSON.stringify([{ issuer: 'wikidata', value: `Q${sequence}` }])]
  );
  await pool.query(
    `INSERT INTO edition_identifier_publishers
       (edition_uri, issuer, value, publisher_id, position)
     SELECT $1, t.issuer, t.value, $2, 1
       FROM unnest($3::text[], $4::text[]) AS t(issuer, value)`,
    [
      uri,
      publisher.rows[0].id,
      identifiers.map((identifier) => identifier.issuer),
      identifiers.map((identifier) => identifier.value)
    ]
  );

  const storedIdentifiers = await pool.query(
    `SELECT issuer, value FROM edition_identifiers
      WHERE edition_uri = $1 ORDER BY issuer, value`,
    [uri]
  );
  const storedContributors = await pool.query(
    `SELECT c.name, ec.role, c.identifiers, ec.ref
       FROM edition_contributors ec JOIN contributors c ON c.id = ec.contributor_id
      WHERE ec.edition_uri = $1 ORDER BY ec.position`,
    [uri]
  );
  const storedPublisher = await pool.query(
    `SELECT p.name, p.identifiers
       FROM edition_publishers_shape ps
       CROSS JOIN LATERAL unnest(ps.publisher_ids) WITH ORDINALITY AS ord(id, idx)
       JOIN publishers p ON p.id = ord.id
      WHERE ps.edition_uri = $1 ORDER BY ord.idx LIMIT 1`,
    [uri]
  );

  return {
    uri,
    rkey,
    createdAt,
    identifiers: storedIdentifiers.rows,
    contributors: storedContributors.rows.map((row) => ({
      displayName: row.name,
      role: normalizeContributorRole(row.role),
      ...(row.identifiers?.length ? { identifiers: row.identifiers } : {}),
      ...(row.ref ? { ref: row.ref } : {})
    })),
    publisher: {
      name: storedPublisher.rows[0].name,
      ...(storedPublisher.rows[0].identifiers?.length
        ? { identifiers: storedPublisher.rows[0].identifiers }
        : {})
    }
  };
}

async function cleanup() {
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [`${PLC_PREFIX}%`]);
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`${PLC_PREFIX}%`]);
  await pool.query('DELETE FROM contributors WHERE name LIKE $1', [`${CONTRIBUTOR_PREFIX}%`]);
  await pool.query('DELETE FROM publishers WHERE name LIKE $1', ['PDS Test Publisher%']);
  // Row deletes queue outbox rows (entity deletes included), so sweep last.
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`${PLC_PREFIX}%`]);
}

beforeAll(async () => {
  await pool.query('SELECT 1');
  await cleanup();
  await startStub();
});

afterAll(async () => {
  await cleanup();
  await stub.close();
  await pool.end();
});

afterEach(async () => {
  await cleanup();
  stub.state.requests.length = 0;
  stub.state.applyWrites.length = 0;
  stub.state.rejected.length = 0;
  stub.state.poisonRkey = undefined;
  stub.state.applyWriteNext = undefined;
  stub.state.refreshNext = undefined;
  stub.state.refreshJwt = 'test-refresh-jwt';
});

function helpers() {
  return { logger: silent };
}

function applyWriteRequests() {
  return stub.state.requests.filter(
    (request) => request.url === '/xrpc/com.atproto.repo.applyWrites'
  );
}

test('claims only ready, under-attempt rows with SKIP LOCKED semantics', async () => {
  const ready = await makeEdition();
  const later = await makeEdition();
  const parked = await makeEdition();

  await pool.query("UPDATE pds_outbox SET next_at = now() + interval '1 hour' WHERE uri = $1", [
    later.uri
  ]);
  await pool.query('UPDATE pds_outbox SET attempts = 10 WHERE uri = $1', [parked.uri]);

  const claimed = await claimBatch(pool, { limit: DEFAULT_BATCH, publisherDid: PUBLISHER_DID });
  expect(claimed.map((row) => row.uri)).toEqual([ready.uri]);
  expect(claimed[0].claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
  expect(claimed[0].op).toBe('create');

  // A second claimer sees nothing while the lease is held.
  expect(await claimBatch(pool, { limit: DEFAULT_BATCH, publisherDid: PUBLISHER_DID })).toEqual([]);

  await pool.query('UPDATE pds_outbox SET claimed_at = NULL WHERE uri = $1', [ready.uri]);
});

test('publishes a create, stores the returned CID and drains the outbox row', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const session = stub.state.requests.find(
    (request) => request.url === '/xrpc/com.atproto.server.createSession'
  );
  expect(session, 'createSession must be called').toBeTruthy();
  expect(session.body).toEqual({ identifier: PUBLISHER_DID, password: 'test-password' });

  const [write] = applyWriteRequests();
  expect(write, 'applyWrites must be called').toBeTruthy();
  expect(write.method).toBe('POST');
  expect(write.headers.authorization).toBe('Bearer test-access-jwt');
  expect(write.body.repo).toBe(PUBLISHER_DID);
  expect(write.body.validate).toBe(false);
  expect(write.body.writes).toEqual([
    {
      $type: 'com.atproto.repo.applyWrites#create',
      collection: COLLECTION,
      rkey: fixture.rkey,
      value: {
        title: 'A Test Edition',
        identifiers: fixture.identifiers,
        contributors: fixture.contributors,
        createdAt: '2026-02-03T04:05:06.000Z',
        subtitle: 'A Subtitle',
        language: 'en',
        publishedDate: '2020-01',
        publisher: fixture.publisher,
        format: 'physical',
        pages: 320,
        chapters: 12,
        series: { name: 'Test Series', position: '1' },
        bookEdition: 'First',
        description: 'A test description.',
        coverUrl: 'https://covers.example/test.jpg'
      }
    }
  ]);

  const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri]);
  expect(outbox.rowCount, 'successful publish deletes the outbox row').toBe(0);

  const cids = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [fixture.uri]);
  expect(cids.rowCount).toBe(1);
  expect(cids.rows[0].cid).toBe(stub.state.applyWrites[0].results[0].cid);
});

test('an audio edition publishes its duration instead of a page count', async () => {
  const fixture = await makeEdition({ title: 'An Audio Edition', format: 'Audiobook' });
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const [write] = applyWriteRequests();
  expect(write, 'applyWrites must be called').toBeTruthy();
  const [create] = write.body.writes;
  expect(create.rkey).toBe(fixture.rkey);
  expect(create.value.format).toBe('Audiobook');
  expect(create.value.durationSeconds).toBe(3600);
  expect('pages' in create.value, 'an audio edition publishes no page count').toBe(false);
});

test('a cached cover puts the edge URL in the published record', async () => {
  const fixture = await makeEdition({ title: 'A Cached Cover Edition' });
  const coverUrl = 'https://covers.example/test.jpg';
  await pool.query(
    `INSERT INTO edition_cover_files (edition_uri, source_url, content_type, byte_size)
     VALUES ($1, $2, 'image/jpeg', 74000)`,
    [fixture.uri, coverUrl]
  );
  const publisher = createOutboxPublisher({
    pool,
    config: validConfig(stub.url),
    coversBaseUrl: 'https://edge.test/'
  });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const write = applyWriteRequests()
    .flatMap((request) => request.body.writes)
    .find((entry) => entry.rkey === fixture.rkey);
  expect(write, 'the edition was published').toBeTruthy();
  expect(write.value.coverUrl).toBe(`https://edge.test/api/covers/${encodeURIComponent(fixture.uri)}`);
});

test('a did:plc publisher authority mints and drains an edition', async () => {
  const ingest = createIngest({ pool, publisherDid: PLC_PUBLISHER_DID });
  const ingested = await ingest({
    title: 'A did:plc Edition',
    identifiers: [{ issuer: 'googlebooks', value: 'plc-publish-authority' }]
  });

  expect(ingested.created).toBe(true);
  expect(ingested.uri.startsWith(PLC_PREFIX), ingested.uri).toBeTruthy();

  const config = {
    ...validConfig(stub.url),
    publisherDid: PLC_PUBLISHER_DID,
    accountDid: PLC_PUBLISHER_DID
  };
  const publisher = createOutboxPublisher({ pool, config });
  const tasks = createTasks({
    pool,
    publisherDid: PLC_PUBLISHER_DID,
    publisherHost: HOST,
    publisher
  });

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const session = stub.state.requests.find(
    (request) => request.url === '/xrpc/com.atproto.server.createSession'
  );
  expect(session, 'createSession must be called for the did:plc account').toBeTruthy();
  expect(session.body).toEqual({
    identifier: PLC_PUBLISHER_DID,
    password: 'test-password'
  });

  const [write] = applyWriteRequests();
  expect(write, 'applyWrites must be called').toBeTruthy();
  expect(write.headers.authorization).toBe('Bearer test-access-jwt');
  expect(write.body.repo).toBe(PLC_PUBLISHER_DID);
  // New editions always mint a TID, never a provider-prefixed rkey.
  expect(write.body.writes[0].rkey).toMatch(/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);
  expect(write.body.writes[0].value.title).toBe('A did:plc Edition');

  const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri LIKE $1', [
    `${PLC_PREFIX}%`
  ]);
  expect(outbox.rowCount, 'the did:plc outbox row is drained').toBe(0);

  const cids = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [ingested.uri]);
  expect(cids.rowCount).toBe(1);
  expect(cids.rows[0].cid).toBe(stub.state.applyWrites[0].results[0].cid);
});

test('an update uses the recorded CID and replaces it', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());
  expect(stub.state.applyWrites.length).toBe(1);

  await pool.query("UPDATE editions SET title = 'Renamed Edition' WHERE uri = $1", [fixture.uri]);
  const queued = await pool.query('SELECT op FROM pds_outbox WHERE uri = $1', [fixture.uri]);
  expect(queued.rows[0].op).toBe('update');

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const writes = applyWriteRequests();
  expect(writes.length).toBe(2);
  expect(writes[1].body.writes[0].$type).toBe('com.atproto.repo.applyWrites#update');
  expect(writes[1].body.writes[0].value.title).toBe('Renamed Edition');

  const cids = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [fixture.uri]);
  expect(cids.rows[0].cid).toBe(stub.state.applyWrites[1].results[0].cid);
});

test('a delete removes the CID and treats RecordNotFound as success', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());
  expect((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount).toBe(1);

  await pool.query(
    `INSERT INTO pds_outbox (uri, collection, rkey, op, value)
     VALUES ($1,$2,$3,'delete',NULL)`,
    [fixture.uri, COLLECTION, fixture.rkey]
  );
  stub.state.applyWriteNext = {
    status: 400,
    body: { error: 'RecordNotFound', message: 'Could not locate record' }
  };

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const write = applyWriteRequests().at(-1);
  expect(write.body.writes).toEqual([
    {
      $type: 'com.atproto.repo.applyWrites#delete',
      collection: COLLECTION,
      rkey: fixture.rkey
    }
  ]);

  expect((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount).toBe(0);
  expect((await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri])).rowCount).toBe(0);
});

test('a failure records last_error and backoff, then a retry succeeds', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  stub.state.applyWriteNext = {
    status: 500,
    body: { error: 'InternalServerError', message: 'pds unavailable' }
  };

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const failed = await pool.query(
    `SELECT attempts, claimed_at, next_at, last_error FROM pds_outbox WHERE uri = $1`,
    [fixture.uri]
  );
  expect(failed.rowCount, 'outbox row survives a failure').toBe(1);
  expect(failed.rows[0].attempts).toBe(1);
  expect(failed.rows[0].claimed_at).toBe(null);
  expect(failed.rows[0].last_error).toMatch(/InternalServerError|pds unavailable/);
  expect(failed.rows[0].next_at.getTime() > Date.now() + 60_000, 'backoff delays the retry').toBeTruthy();
  expect((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount).toBe(0);

  // The row is not claimable until next_at, then retries normally.
  expect(await claimBatch(pool, { publisherDid: PUBLISHER_DID })).toEqual([]);
  await pool.query('UPDATE pds_outbox SET next_at = now() WHERE uri = $1', [fixture.uri]);
  await tasks['pds-publish']({ limit: 10 }, helpers());

  expect((await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri])).rowCount).toBe(0);
  expect((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount).toBe(1);
});

test('AlreadyExists is retried as an update', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  stub.state.applyWriteNext = {
    status: 400,
    body: { error: 'AlreadyExists', message: 'record already exists' }
  };

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const writes = applyWriteRequests();
  expect(writes.length).toBe(2);
  expect(writes[0].body.writes[0].$type).toBe('com.atproto.repo.applyWrites#create');
  expect(writes[1].body.writes[0].$type).toBe('com.atproto.repo.applyWrites#update');
  expect((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount).toBe(1);
});

test('an expired access token is refreshed once and the write retried', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  stub.state.applyWriteNext = {
    status: 401,
    body: { error: 'ExpiredToken', message: 'Token has expired' }
  };

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const refresh = stub.state.requests.find(
    (request) => request.url === '/xrpc/com.atproto.server.refreshSession'
  );
  expect(refresh, 'refreshSession must be attempted').toBeTruthy();
  expect(refresh.headers.authorization).toBe('Bearer test-refresh-jwt');

  const writes = applyWriteRequests();
  expect(writes.length).toBe(2);
  expect(writes[1].headers.authorization).toBe('Bearer refreshed-access-jwt');
  expect((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount).toBe(1);
});

test('a 400 ExpiredToken is refreshed once and the write retried', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  stub.state.applyWriteNext = {
    status: 400,
    body: { error: 'ExpiredToken', message: 'Token has expired' }
  };

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const refresh = stub.state.requests.find(
    (request) => request.url === '/xrpc/com.atproto.server.refreshSession'
  );
  expect(refresh, 'a 400 ExpiredToken must trigger refreshSession').toBeTruthy();
  expect(refresh.headers.authorization).toBe('Bearer test-refresh-jwt');

  const writes = applyWriteRequests();
  expect(writes.length, 'the write is retried exactly once').toBe(2);
  expect(writes[1].headers.authorization).toBe('Bearer refreshed-access-jwt');
  expect((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount).toBe(1);
  expect((await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri])).rowCount).toBe(0);
});

test('a rotated refresh token replaces the in-memory session token', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  stub.state.refreshJwt = 'rotated-refresh-jwt';
  stub.state.applyWriteNext = {
    status: 400,
    body: { error: 'ExpiredToken', message: 'Token has expired' }
  };
  await tasks['pds-publish']({ limit: 10 }, helpers());

  await pool.query("UPDATE editions SET title = 'Rotated Session Edition' WHERE uri = $1", [
    fixture.uri
  ]);
  stub.state.applyWriteNext = {
    status: 400,
    body: { error: 'ExpiredToken', message: 'Token has expired' }
  };
  await tasks['pds-publish']({ limit: 10 }, helpers());

  const refreshes = stub.state.requests.filter(
    (request) => request.url === '/xrpc/com.atproto.server.refreshSession'
  );
  expect(refreshes.length).toBe(2);
  expect(refreshes[1].headers.authorization).toBe('Bearer rotated-refresh-jwt');
  expect((await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri])).rowCount).toBe(0);
});

test('a rejected refresh falls back to an app-password createSession', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  stub.state.applyWriteNext = {
    status: 400,
    body: { error: 'ExpiredToken', message: 'Token has expired' }
  };
  stub.state.refreshNext = {
    status: 400,
    body: { error: 'ExpiredToken', message: 'Token has expired' }
  };

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const creates = stub.state.requests.filter(
    (request) => request.url === '/xrpc/com.atproto.server.createSession'
  );
  expect(creates.length, 'the initial sign-in plus the password fallback').toBe(2);
  expect(creates[1].body.password).toBe('test-password');

  const writes = applyWriteRequests();
  expect(writes.length).toBe(2);
  expect(writes[1].headers.authorization).toBe('Bearer test-access-jwt');
  expect((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount).toBe(1);
});

test('an unrelated 400 does not refresh the session', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  stub.state.applyWriteNext = {
    status: 400,
    body: { error: 'InvalidRequest', message: 'invalid write' }
  };

  await tasks['pds-publish']({ limit: 10 }, helpers());

  expect(stub.state.requests.some(
      (request) => request.url === '/xrpc/com.atproto.server.refreshSession'
    ), 'only an expired token may refresh').toBe(false);
  expect(applyWriteRequests().length).toBe(1);

  const failed = await pool.query(
    'SELECT attempts, last_error FROM pds_outbox WHERE uri = $1',
    [fixture.uri]
  );
  expect(failed.rowCount).toBe(1);
  expect(failed.rows[0].attempts).toBe(1);
  expect(failed.rows[0].last_error).toMatch(/InvalidRequest|invalid write/);
});

test('a trigger update during publishing is not swallowed', async () => {
  const fixture = await makeEdition();
  const real = createPdsPublisher({ config: validConfig(stub.url) });
  const racing = {
    applyWrite: async (write) => {
      await pool.query("UPDATE editions SET title = 'Changed mid-publish' WHERE uri = $1", [
        fixture.uri
      ]);
      return real.applyWrite(write);
    }
  };

  const [entry] = await claimBatch(pool, { limit: 1, publisherDid: PUBLISHER_DID });
  expect(entry.uri).toBe(fixture.uri);
  const result = await publishEntry({
    pds: racing,
    publisherDid: PUBLISHER_DID,
    pool,
    entry,
    logger: silent
  });
  const completed = await completeEntry(pool, entry, result);
  expect(completed, 'the newer outbox row must survive').toBe(false);

  const row = await pool.query(
    'SELECT op, claimed_at FROM pds_outbox WHERE uri = $1',
    [fixture.uri]
  );
  expect(row.rowCount).toBe(1);
  // The trigger preserves `create` for a row that has not been published under
  // our CID yet; the next run sees pds_cids and sends an update.
  expect(row.rows[0].op).toBe('create');
  expect(row.rows[0].claimed_at, 'our claim is released so the update runs promptly').toBe(null);
});

test('a provisioned access token is verified with getSession', async () => {
  const fixture = await makeEdition();
  const config = {
    ...validConfig(stub.url),
    password: undefined,
    accessToken: 'provisioned-jwt'
  };
  const publisher = createOutboxPublisher({ pool, config });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const session = stub.state.requests.find(
    (request) => request.url === '/xrpc/com.atproto.server.getSession'
  );
  expect(session, 'getSession must verify the token').toBeTruthy();
  expect(session.headers.authorization).toBe('Bearer provisioned-jwt');
  const write = applyWriteRequests()[0];
  expect(write.headers.authorization).toBe('Bearer provisioned-jwt');
  expect((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount).toBe(1);
});

test('missing credentials fail before any network call', () => {
  const config = resolvePublisherConfig({ PDS_URL: 'http://127.0.0.1:1' });
  expect(config.configured).toBe(false);
  expect(config.problems.some((problem) => problem.includes('PDS_ACCOUNT_PASSWORD'))).toBeTruthy();
  expect(thrownBy(() => createPdsPublisher({ config }))).toSatisfy((error) =>
      error instanceof PublisherConfigError &&
      /PDS_ACCOUNT_PASSWORD/.test(error.message) &&
      /not configured/.test(error.message));

  expect(() =>
      createPdsPublisher({
        config: {
          ...validConfig('http://127.0.0.1:1'),
          accountDid: 'did:web:someone-else.example'
        }
      })).toThrow(/not the publisher DID/)
});

test('the task fails loudly when the publisher cannot be constructed', async () => {
  const saved = {
    PDS_URL: process.env.PDS_URL,
    PDS_ACCOUNT_PASSWORD: process.env.PDS_ACCOUNT_PASSWORD,
    PDS_ACCESS_TOKEN: process.env.PDS_ACCESS_TOKEN
  };
  delete process.env.PDS_URL;
  delete process.env.PDS_ACCOUNT_PASSWORD;
  delete process.env.PDS_ACCESS_TOKEN;
  const tasks = createTasks({ pool, publisherHost: HOST });
  try {
    await expect(tasks['pds-publish']({}, helpers())).rejects.toSatisfy((error) => error instanceof PublisherConfigError && /not configured/.test(error.message));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('one claim publishes in one applyWrites call carrying every write', async () => {
  // The PDS charges per call, not per write: three rows must not become three
  // requests.
  const fixtures = [await makeEdition(), await makeEdition(), await makeEdition()];
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  const results = [];
  await tasks['pds-publish'](
    { limit: 10 },
    { logger: { ...silent, info: (line) => results.push(line) } }
  );

  const writes = applyWriteRequests();
  expect(writes.length, 'the claim rides one call').toBe(1);
  // Each edition also queues its contributor and publisher, so the call is
  // wider than the three fixtures — which is the point.
  expect(writes[0].body.writes.length >= fixtures.length).toBeTruthy();
  expect(writes[0].body.writes.length <= DEFAULT_BATCH).toBeTruthy();

  for (const fixture of fixtures) {
    const rkey = fixture.uri.split('/').pop();
    const index = writes[0].body.writes.findIndex((write) => write.rkey === rkey);
    expect(index >= 0, `${rkey} is in the same call as its neighbours`).toBeTruthy();
    const cids = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [fixture.uri]);
    expect(cids.rowCount, 'each row keeps its own returned CID').toBe(1);
    expect(cids.rows[0].cid).toBe(stub.state.applyWrites[0].results[index].cid);
    const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri]);
    expect(outbox.rowCount).toBe(0);
  }
  expect(results.filter((line) => line.includes('pds-publish: create') && line.includes(`/${COLLECTION}/`))
      .length).toBe(fixtures.length);
});

test('a record the PDS rejects is isolated from the rest of its chunk', async () => {
  const good = await makeEdition();
  const poison = await makeEdition();
  const alsoGood = await makeEdition();
  stub.state.poisonRkey = poison.uri.split('/').pop();

  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());

  // The chunk failed, then each half was retried; only the poisoned row is left.
  expect(stub.state.rejected.length > 0, 'the PDS refused the chunk').toBeTruthy();
  for (const fixture of [good, alsoGood]) {
    const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri]);
    expect(outbox.rowCount, `${fixture.uri} published despite its neighbour`).toBe(0);
    const cids = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [fixture.uri]);
    expect(cids.rowCount).toBe(1);
  }

  const parked = await pool.query(
    'SELECT attempts, last_error FROM pds_outbox WHERE uri = $1',
    [poison.uri]
  );
  expect(parked.rowCount, 'the rejected row stays queued').toBe(1);
  expect(parked.rows[0].attempts, 'it consumed exactly one attempt').toBe(1);
  expect(parked.rows[0].last_error).toMatch(/InternalServerError|500/);
});

test('deletes and creates share a call without losing their operations', async () => {
  const created = await makeEdition();
  const removed = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());
  // One row to update and one to delete, so the next claim is genuinely mixed.
  await pool.query("UPDATE editions SET title = 'Renamed While Deleting' WHERE uri = $1", [
    created.uri
  ]);
  await pool.query('DELETE FROM editions WHERE uri = $1', [removed.uri]);

  stub.state.applyWrites.length = 0;
  stub.state.requests.length = 0;
  await tasks['pds-publish']({ limit: 10 }, helpers());

  const writes = applyWriteRequests();
  expect(writes.length).toBe(1);
  // The operations are per write, not per call: an update and a delete ride
  // together and each keeps its own `$type`.
  const createdRkey = created.uri.split('/').pop();
  const updateWrite = writes[0].body.writes.find((write) => write.rkey === createdRkey);
  expect(updateWrite.$type).toBe('com.atproto.repo.applyWrites#update');
  expect(updateWrite.value.title).toBe('Renamed While Deleting');
  const removedRkey = removed.uri.split('/').pop();
  const deleteWrite = writes[0].body.writes.find((write) => write.rkey === removedRkey);
  expect(deleteWrite.$type).toBe('com.atproto.repo.applyWrites#delete');
  expect(deleteWrite.value, 'a delete carries no value').toBe(undefined);
  const cids = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [removed.uri]);
  expect(cids.rowCount, 'a delete drops the recorded CID').toBe(0);
});

test('an aborted shutdown stops the drain before the next claim', async () => {
  const fixtures = [await makeEdition(), await makeEdition()];
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const controller = new AbortController();
  controller.abort();

  const result = await publisher.drain({ limit: 10, signal: controller.signal, logger: silent });

  expect(result).toEqual({ published: 0, failed: 0, batches: 0, calls: 0 });
  expect(applyWriteRequests().length, 'no write is started after the abort').toBe(0);
  // The rows stay claimable: nothing was claimed, nothing was published twice.
  const rows = await pool.query('SELECT uri FROM pds_outbox WHERE uri = ANY($1::text[])', [
    fixtures.map((fixture) => fixture.uri)
  ]);
  expect(rows.rowCount).toBe(2);
});

/** vitest has no predicate form of toThrow: capture the throw and assert on it. */
function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
