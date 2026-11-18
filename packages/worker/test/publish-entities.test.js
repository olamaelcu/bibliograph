import { expect, test } from 'vitest';

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

  expect(rows).toEqual([]);
  expect(calls[0].sql).toMatch(/collection = ANY\(\$1::text\[\]\)/);
  expect(calls[0].params[0]).toEqual([...OUTBOX_COLLECTIONS]);
  expect(calls[0].params[0].includes(EDITION_COLLECTION)).toBeTruthy();
  expect(calls[0].params[0].includes('net.olamaelcu.livtet.biblio.contributor')).toBeTruthy();
  expect(calls[0].params[0].includes('net.olamaelcu.livtet.biblio.publisher')).toBeTruthy();
  expect(calls[0].params[1]).toBe(10);
  expect(calls[0].params[2]).toBe(300);
  expect(calls[0].params[3]).toBe(7);
  expect(calls[0].params[4]).toBe(AUTHORITY);
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
  expect(calls[0].params[0]).toEqual([EDITION_COLLECTION]);
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

  expect(result.value).toEqual({
    displayName: 'Ursula K. Le Guin',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    born: '1929-10-21',
    createdAt: '2026-11-12T10:20:30.000Z'
  });
  expect(pds.writes[0]).toEqual({
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

  expect(result.operation).toBe('update');
  expect(result.value).toEqual({
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
  expect(result.operation).toBe('delete');
  expect(pds.writes[0]).toEqual({
    operation: 'delete',
    collection: 'net.olamaelcu.livtet.biblio.contributor',
    rkey: '3abc'
  });
});

test('refuses a row from an unpublished collection', async () => {
  await expect(publishEntry({
      pds: recordingPds(),
      publisherDid: AUTHORITY,
      pool: entityPool(),
      entry: entry({ collection: 'com.example.unknown' }),
      logger: QUIET
    })).rejects.toThrow(/unpublished collection/);
});

test('refuses a row minted under another authority', async () => {
  await expect(publishEntry({
      pds: recordingPds(),
      publisherDid: AUTHORITY,
      pool: entityPool(),
      entry: entry({ uri: 'at://did:plc:other/net.olamaelcu.livtet.biblio.contributor/3abc' }),
      logger: QUIET
    })).rejects.toSatisfy((error) => error instanceof PublisherConfigError);
});

test('fails loudly when the catalog row vanished but the row is not a delete', async () => {
  await expect(publishEntry({
      pds: recordingPds(),
      publisherDid: AUTHORITY,
      pool: entityPool({}),
      entry: entry(),
      logger: QUIET
    })).rejects.toThrow(/gone from the catalog/);
});
