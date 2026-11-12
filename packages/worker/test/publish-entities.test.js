import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITION_COLLECTION,
  OUTBOX_COLLECTIONS,
  claimBatch,
  publishEntry
} from '../lib/publish.js';
import { PublisherConfigError } from '../lib/pds.js';

const AUTHORITY = 'did:plc:publishertest';
const QUIET = { info() {}, error() {} };

function entry(overrides = {}) {
  return {
    uri: `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/3abc`,
    collection: 'net.olamaelcu.livtet.biblio.contributor',
    rkey: '3abc',
    op: 'create',
    attempts: 0,
    claimed_at: '2026-11-12 10:00:00+00',
    updated_at: '2026-11-12 10:00:00+00',
    ...overrides
  };
}

/** A pool that answers the two entity-snapshot queries and the CID lookup. */
function entityPool({ row, cid } = {}) {
  return {
    query: async (sql) => {
      if (sql.includes('FROM contributors') || sql.includes('FROM publishers')) {
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes('FROM pds_cids')) {
        return { rowCount: cid ? 1 : 0, rows: cid ? [{ cid }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  };
}

function recordingPds() {
  const writes = [];
  return {
    writes,
    applyWrite: async (write) => {
      writes.push(write);
      return { uri: `at://${AUTHORITY}/${write.collection}/${write.rkey}`, cid: 'bafynew' };
    }
  };
}

test('claimBatch drains the contributor, publisher and edition collections', async () => {
  const calls = [];
  const rows = await claimBatch(
    {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [] };
      }
    },
    { publisherDid: AUTHORITY, limit: 7 }
  );

  assert.deepEqual(rows, []);
  assert.match(calls[0].sql, /collection = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(calls[0].params[0], [...OUTBOX_COLLECTIONS]);
  assert.ok(calls[0].params[0].includes(EDITION_COLLECTION));
  assert.ok(calls[0].params[0].includes('net.olamaelcu.livtet.biblio.contributor'));
  assert.ok(calls[0].params[0].includes('net.olamaelcu.livtet.biblio.publisher'));
  assert.equal(calls[0].params[1], 10);
  assert.equal(calls[0].params[2], 300);
  assert.equal(calls[0].params[3], 7);
  assert.equal(calls[0].params[4], AUTHORITY);
});

test('claimBatch accepts an explicit collection subset', async () => {
  const calls = [];
  await claimBatch(
    {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [] };
      }
    },
    { publisherDid: AUTHORITY, collections: [EDITION_COLLECTION] }
  );
  assert.deepEqual(calls[0].params[0], [EDITION_COLLECTION]);
});

test('publishes a contributor record built from its catalog row', async () => {
  const pds = recordingPds();
  const result = await publishEntry({
    pds,
    publisherDid: AUTHORITY,
    pool: entityPool({
      row: {
        at_uri: entry().uri,
        name: 'Ursula K. Le Guin',
        name_inverted: null,
        description: null,
        image_url: null,
        born: '1929-10-21',
        died: null,
        identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
        created_at: new Date('2026-11-12T10:20:30.000Z')
      }
    }),
    entry: entry(),
    logger: QUIET
  });

  assert.deepEqual(result.value, {
    displayName: 'Ursula K. Le Guin',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    born: '1929-10-21',
    createdAt: '2026-11-12T10:20:30.000Z'
  });
  assert.deepEqual(pds.writes[0], {
    operation: 'create',
    collection: 'net.olamaelcu.livtet.biblio.contributor',
    rkey: '3abc',
    value: result.value
  });
});

test('publishes a publisher record and switches to update when a CID exists', async () => {
  const pds = recordingPds();
  const result = await publishEntry({
    pds,
    publisherDid: AUTHORITY,
    pool: entityPool({
      row: {
        at_uri: entry().uri,
        name: 'Ace Books',
        description: null,
        image_url: null,
        started: '1952-01-01',
        ended: null,
        identifiers: [],
        created_at: new Date('2026-11-12T10:20:30.000Z')
      },
      cid: 'bafyprevious'
    }),
    entry: entry({
      uri: `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.publisher/3def`,
      collection: 'net.olamaelcu.livtet.biblio.publisher',
      rkey: '3def'
    }),
    logger: QUIET
  });

  assert.equal(result.operation, 'update');
  assert.deepEqual(result.value, {
    name: 'Ace Books',
    started: '1952-01-01',
    createdAt: '2026-11-12T10:20:30.000Z'
  });
});

test('deletes an entity row without reading the catalog', async () => {
  const pds = recordingPds();
  const result = await publishEntry({
    pds,
    publisherDid: AUTHORITY,
    pool: {
      query: async () => {
        throw new Error('a delete must not read the catalog');
      }
    },
    entry: entry({ op: 'delete' }),
    logger: QUIET
  });
  assert.equal(result.operation, 'delete');
  assert.deepEqual(pds.writes[0], {
    operation: 'delete',
    collection: 'net.olamaelcu.livtet.biblio.contributor',
    rkey: '3abc'
  });
});

test('refuses a row from an unpublished collection', async () => {
  await assert.rejects(
    publishEntry({
      pds: recordingPds(),
      publisherDid: AUTHORITY,
      pool: entityPool(),
      entry: entry({ collection: 'com.example.unknown' }),
      logger: QUIET
    }),
    /unpublished collection/
  );
});

test('refuses a row minted under another authority', async () => {
  await assert.rejects(
    publishEntry({
      pds: recordingPds(),
      publisherDid: AUTHORITY,
      pool: entityPool(),
      entry: entry({ uri: 'at://did:plc:other/net.olamaelcu.livtet.biblio.contributor/3abc' }),
      logger: QUIET
    }),
    (error) => error instanceof PublisherConfigError
  );
});

test('fails loudly when the catalog row vanished but the row is not a delete', async () => {
  await assert.rejects(
    publishEntry({
      pds: recordingPds(),
      publisherDid: AUTHORITY,
      pool: entityPool({}),
      entry: entry(),
      logger: QUIET
    }),
    /gone from the catalog/
  );
});
