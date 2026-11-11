import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';

import { createTasks } from '../lib/tasks.js';
import { createIngest } from '../lib/ingest.js';
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
// Edition URIs use the book collection; the outbox row uses `.edition`.
const PLC_PREFIX = `at://${PLC_PUBLISHER_DID}/community.lexicon.media.book/`;
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
  const state = { requests: [], applyWrites: [], applyWriteNext: undefined };

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
      return send(200, {
        accessJwt: 'refreshed-access-jwt',
        refreshJwt: 'test-refresh-jwt',
        did: PUBLISHER_DID
      });
    }
    if (request.method === 'POST' && request.url === '/xrpc/com.atproto.repo.applyWrites') {
      if (state.applyWriteNext) {
        const next = state.applyWriteNext;
        state.applyWriteNext = undefined;
        return send(next.status, next.body);
      }
      const write = body.writes[0];
      const uri = `at://${body.repo}/${write.collection}/${write.rkey}`;
      const result = write.$type.endsWith('#delete')
        ? { uri }
        : { uri, cid: `bafy-test-${state.applyWrites.length + 1}`, validationStatus: 'valid' };
      state.applyWrites.push({ body, result });
      return send(200, { results: [result], commit: { cid: 'bafy-commit', rev: 'test' } });
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
       uri, rkey, title, subtitle, language, published_date, format, pages,
       duration_seconds, chapters, series, book_edition, description, cover_url,
       created_at, indexed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,now())`,
    [
      uri,
      rkey,
      title,
      'A Subtitle',
      'en',
      '2020-01',
      'physical',
      320,
      3600,
      12,
      JSON.stringify({ name: 'Test Series', position: '1' }),
      'First',
      'A test description.',
      coverUrl,
      createdAt
    ]
  );

  for (const identifier of identifiers) {
    await pool.query(
      `INSERT INTO edition_identifiers (edition_uri, issuer, value) VALUES ($1,$2,$3)`,
      [uri, identifier.issuer, identifier.value]
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
    `INSERT INTO edition_publishers (edition_uri, publisher_id, position) VALUES ($1,$2,1)`,
    [uri, publisher.rows[0].id]
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
       FROM edition_publishers ep JOIN publishers p ON p.id = ep.publisher_id
      WHERE ep.edition_uri = $1 ORDER BY ep.position LIMIT 1`,
    [uri]
  );

  return {
    uri,
    rkey,
    createdAt,
    identifiers: storedIdentifiers.rows,
    contributors: storedContributors.rows.map((row) => ({
      name: row.name,
      role: row.role,
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
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`${PREFIX}%`]);
  await pool.query('DELETE FROM pds_cids WHERE uri LIKE $1', [`${PLC_PREFIX}%`]);
  await pool.query('DELETE FROM editions WHERE uri LIKE $1', [`${PLC_PREFIX}%`]);
  await pool.query('DELETE FROM pds_outbox WHERE uri LIKE $1', [`${PLC_PREFIX}%`]);
  await pool.query('DELETE FROM contributors WHERE name LIKE $1', [`${CONTRIBUTOR_PREFIX}%`]);
  await pool.query('DELETE FROM publishers WHERE name LIKE $1', ['PDS Test Publisher%']);
}

before(async () => {
  await pool.query('SELECT 1');
  await cleanup();
  await startStub();
});

after(async () => {
  await cleanup();
  await stub.close();
  await pool.end();
});

afterEach(async () => {
  await cleanup();
  stub.state.requests.length = 0;
  stub.state.applyWrites.length = 0;
  stub.state.applyWriteNext = undefined;
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
  assert.deepEqual(
    claimed.map((row) => row.uri),
    [ready.uri]
  );
  assert.match(claimed[0].claimed_at, /^\d{4}-\d{2}-\d{2}/);
  assert.equal(claimed[0].op, 'create');

  // A second claimer sees nothing while the lease is held.
  assert.deepEqual(
    await claimBatch(pool, { limit: DEFAULT_BATCH, publisherDid: PUBLISHER_DID }),
    []
  );

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
  assert.ok(session, 'createSession must be called');
  assert.deepEqual(session.body, { identifier: PUBLISHER_DID, password: 'test-password' });

  const [write] = applyWriteRequests();
  assert.ok(write, 'applyWrites must be called');
  assert.equal(write.method, 'POST');
  assert.equal(write.headers.authorization, 'Bearer test-access-jwt');
  assert.equal(write.body.repo, PUBLISHER_DID);
  assert.equal(write.body.validate, false);
  assert.deepEqual(write.body.writes, [
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
        durationSeconds: 3600,
        chapters: 12,
        series: { name: 'Test Series', position: '1' },
        bookEdition: 'First',
        description: 'A test description.',
        coverUrl: 'https://covers.example/test.jpg'
      }
    }
  ]);

  const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri]);
  assert.equal(outbox.rowCount, 0, 'successful publish deletes the outbox row');

  const cids = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [fixture.uri]);
  assert.equal(cids.rowCount, 1);
  assert.equal(cids.rows[0].cid, stub.state.applyWrites[0].result.cid);
});

test('a did:plc publisher authority mints and drains an edition', async () => {
  const ingest = createIngest({ pool, publisherDid: PLC_PUBLISHER_DID });
  const ingested = await ingest({
    title: 'A did:plc Edition',
    identifiers: [{ issuer: 'googlebooks', value: 'plc-publish-authority' }]
  });

  assert.equal(ingested.created, true);
  assert.ok(ingested.uri.startsWith(PLC_PREFIX), ingested.uri);

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
  assert.ok(session, 'createSession must be called for the did:plc account');
  assert.deepEqual(session.body, {
    identifier: PLC_PUBLISHER_DID,
    password: 'test-password'
  });

  const [write] = applyWriteRequests();
  assert.ok(write, 'applyWrites must be called');
  assert.equal(write.headers.authorization, 'Bearer test-access-jwt');
  assert.equal(write.body.repo, PLC_PUBLISHER_DID);
  assert.equal(write.body.writes[0].rkey, 'gb.plc-publish-authority');
  assert.equal(write.body.writes[0].value.title, 'A did:plc Edition');

  const outbox = await pool.query('SELECT 1 FROM pds_outbox WHERE uri LIKE $1', [
    `${PLC_PREFIX}%`
  ]);
  assert.equal(outbox.rowCount, 0, 'the did:plc outbox row is drained');

  const cids = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [ingested.uri]);
  assert.equal(cids.rowCount, 1);
  assert.equal(cids.rows[0].cid, stub.state.applyWrites[0].result.cid);
});

test('an update uses the recorded CID and replaces it', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());
  assert.equal(stub.state.applyWrites.length, 1);

  await pool.query("UPDATE editions SET title = 'Renamed Edition' WHERE uri = $1", [fixture.uri]);
  const queued = await pool.query('SELECT op FROM pds_outbox WHERE uri = $1', [fixture.uri]);
  assert.equal(queued.rows[0].op, 'update');

  await tasks['pds-publish']({ limit: 10 }, helpers());

  const writes = applyWriteRequests();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].body.writes[0].$type, 'com.atproto.repo.applyWrites#update');
  assert.equal(writes[1].body.writes[0].value.title, 'Renamed Edition');

  const cids = await pool.query('SELECT cid FROM pds_cids WHERE uri = $1', [fixture.uri]);
  assert.equal(cids.rows[0].cid, stub.state.applyWrites[1].result.cid);
});

test('a delete removes the CID and treats RecordNotFound as success', async () => {
  const fixture = await makeEdition();
  const publisher = createOutboxPublisher({ pool, config: validConfig(stub.url) });
  const tasks = createTasks({ pool, publisherHost: HOST, publisher });

  await tasks['pds-publish']({ limit: 10 }, helpers());
  assert.equal((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount, 1);

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
  assert.deepEqual(write.body.writes, [
    {
      $type: 'com.atproto.repo.applyWrites#delete',
      collection: COLLECTION,
      rkey: fixture.rkey
    }
  ]);

  assert.equal((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri])).rowCount, 0);
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
  assert.equal(failed.rowCount, 1, 'outbox row survives a failure');
  assert.equal(failed.rows[0].attempts, 1);
  assert.equal(failed.rows[0].claimed_at, null);
  assert.match(failed.rows[0].last_error, /InternalServerError|pds unavailable/);
  assert.ok(failed.rows[0].next_at.getTime() > Date.now() + 60_000, 'backoff delays the retry');
  assert.equal((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount, 0);

  // The row is not claimable until next_at, then retries normally.
  assert.deepEqual(await claimBatch(pool, { publisherDid: PUBLISHER_DID }), []);
  await pool.query('UPDATE pds_outbox SET next_at = now() WHERE uri = $1', [fixture.uri]);
  await tasks['pds-publish']({ limit: 10 }, helpers());

  assert.equal((await pool.query('SELECT 1 FROM pds_outbox WHERE uri = $1', [fixture.uri])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount, 1);
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
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body.writes[0].$type, 'com.atproto.repo.applyWrites#create');
  assert.equal(writes[1].body.writes[0].$type, 'com.atproto.repo.applyWrites#update');
  assert.equal((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount, 1);
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
  assert.ok(refresh, 'refreshSession must be attempted');
  assert.equal(refresh.headers.authorization, 'Bearer test-refresh-jwt');

  const writes = applyWriteRequests();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].headers.authorization, 'Bearer refreshed-access-jwt');
  assert.equal((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount, 1);
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
  assert.equal(entry.uri, fixture.uri);
  const result = await publishEntry({
    pds: racing,
    publisherDid: PUBLISHER_DID,
    pool,
    entry,
    logger: silent
  });
  const completed = await completeEntry(pool, entry, result);
  assert.equal(completed, false, 'the newer outbox row must survive');

  const row = await pool.query(
    'SELECT op, claimed_at FROM pds_outbox WHERE uri = $1',
    [fixture.uri]
  );
  assert.equal(row.rowCount, 1);
  // The trigger preserves `create` for a row that has not been published under
  // our CID yet; the next run sees pds_cids and sends an update.
  assert.equal(row.rows[0].op, 'create');
  assert.equal(row.rows[0].claimed_at, null, 'our claim is released so the update runs promptly');
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
  assert.ok(session, 'getSession must verify the token');
  assert.equal(session.headers.authorization, 'Bearer provisioned-jwt');
  const write = applyWriteRequests()[0];
  assert.equal(write.headers.authorization, 'Bearer provisioned-jwt');
  assert.equal((await pool.query('SELECT 1 FROM pds_cids WHERE uri = $1', [fixture.uri])).rowCount, 1);
});

test('missing credentials fail before any network call', () => {
  const config = resolvePublisherConfig({ PDS_URL: 'http://127.0.0.1:1' });
  assert.equal(config.configured, false);
  assert.ok(config.problems.some((problem) => problem.includes('PDS_ACCOUNT_PASSWORD')));
  assert.throws(
    () => createPdsPublisher({ config }),
    (error) =>
      error instanceof PublisherConfigError &&
      /PDS_ACCOUNT_PASSWORD/.test(error.message) &&
      /not configured/.test(error.message)
  );

  assert.throws(
    () =>
      createPdsPublisher({
        config: {
          ...validConfig('http://127.0.0.1:1'),
          accountDid: 'did:web:someone-else.example'
        }
      }),
    /not the publisher DID/
  );
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
    await assert.rejects(
      tasks['pds-publish']({}, helpers()),
      (error) => error instanceof PublisherConfigError && /not configured/.test(error.message)
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
