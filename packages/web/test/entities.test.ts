import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EntityQueryError,
  EntityUriError,
  CONTRIBUTOR_COLLECTION,
  getContributor,
  getPublisher,
  listEditionsByContributor,
  parseEntityUri,
  resolveContributors,
  resolvePublishers,
  searchContributors,
  searchPublishers,
  type EntityQueryable
} from '../src/lib/server/catalog/entities.ts';
import {
  CatalogUnavailableError,
  catalogFailure
} from '../src/lib/server/catalog/errors.ts';
import {
  ENTITY_METHODS,
  ENTITY_PROCEDURES,
  ENTITY_QUERIES
} from '../src/lib/server/catalog/entity-methods.ts';
import { decodeOffsetCursor, encodeOffsetCursor, likePattern } from '../src/lib/server/catalog/sql.ts';

const AUTHORITY = 'did:plc:entitytest';
const CONTRIBUTOR_URI = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/3abc`;
const PUBLISHER_URI = `at://${AUTHORITY}/net.olamaelcu.livtet.biblio.publisher/3def`;
const CREATED = new Date('2026-11-12T10:20:30.000Z');

type QueryCall = { sql: string; values?: unknown[] };

/** A test double exposing only `query`, which is all the module uses. */
function fakePool(answer: (sql: string, values?: unknown[]) => unknown[]): {
  pool: EntityQueryable;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      const rows = answer(sql, values);
      return { rows, rowCount: rows.length };
    }
  } as unknown as EntityQueryable;
  return { pool, calls };
}

function contributorRow(overrides: Record<string, unknown> = {}) {
  return {
    uri: CONTRIBUTOR_URI,
    name: 'Ursula K. Le Guin',
    name_inverted: 'Le Guin, Ursula K.',
    description: 'An American author.',
    image_url: 'https://example.org/ursula.jpg',
    born: '1929-10-21',
    died: '2018-01-22',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    created_at: CREATED,
    cid: 'bafyrecord',
    ...overrides
  };
}

function publisherRow(overrides: Record<string, unknown> = {}) {
  return {
    uri: PUBLISHER_URI,
    name: 'Ace Books',
    description: null,
    image_url: null,
    started: '1952-01-01',
    ended: null,
    identifiers: [],
    created_at: CREATED,
    cid: null,
    ...overrides
  };
}

const EDITION_PREFIX = `at://${AUTHORITY}/community.lexicon.media.book.edition/`;

function editionRow(uri: string) {
  return {
    uri,
    title: 'A Test Edition',
    subtitle: null,
    language: null,
    published_date: null,
    format: null,
    pages: null,
    duration_seconds: null,
    chapters: null,
    series: null,
    book_edition: null,
    description: null,
    cover_url: null,
    created_at: CREATED
  };
}

test('parseEntityUri is scoped to one collection and rejects malformed URIs', () => {
  assert.deepEqual(parseEntityUri(CONTRIBUTOR_URI, 'net.olamaelcu.livtet.biblio.contributor'), {
    did: AUTHORITY,
    rkey: '3abc'
  });
  assert.equal(
    parseEntityUri(CONTRIBUTOR_URI, 'net.olamaelcu.livtet.biblio.publisher'),
    null
  );
  assert.equal(parseEntityUri('https://example.org/x', 'net.olamaelcu.livtet.biblio.contributor'), null);
  assert.equal(parseEntityUri('at://not-a-did/net.olamaelcu.livtet.biblio.contributor/3abc', 'net.olamaelcu.livtet.biblio.contributor'), null);
  assert.equal(parseEntityUri(`at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/.`, 'net.olamaelcu.livtet.biblio.contributor'), null);
});

test('getContributor maps the row, includes the published cid, and omits empty fields', async () => {
  const { pool, calls } = fakePool((sql) => (sql.includes('FROM contributors') ? [contributorRow()] : []));
  const view = await getContributor(pool, CONTRIBUTOR_URI);

  assert.deepEqual(view, {
    uri: CONTRIBUTOR_URI,
    cid: 'bafyrecord',
    displayName: 'Ursula K. Le Guin',
    nameInverted: 'Le Guin, Ursula K.',
    description: 'An American author.',
    imageUrl: 'https://example.org/ursula.jpg',
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    born: '1929-10-21',
    died: '2018-01-22',
    createdAt: '2026-11-12T10:20:30.000Z'
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /LEFT JOIN pds_cids/);
  assert.deepEqual(calls[0].values, [CONTRIBUTOR_URI]);
});

test('getContributor returns null for a missing row and rejects another collection', async () => {
  const { pool } = fakePool(() => []);
  assert.equal(await getContributor(pool, CONTRIBUTOR_URI), null);
  await assert.rejects(getContributor(pool, PUBLISHER_URI), (error) => error instanceof EntityUriError);
});

test('getPublisher maps a publisher row without inventing a cid', async () => {
  const { pool } = fakePool((sql) => (sql.includes('FROM publishers') ? [publisherRow()] : []));
  assert.deepEqual(await getPublisher(pool, PUBLISHER_URI), {
    uri: PUBLISHER_URI,
    name: 'Ace Books',
    started: '1952-01-01',
    createdAt: '2026-11-12T10:20:30.000Z'
  });
});

test('resolveContributors matches identifier containment and pages with hasMore/total', async () => {
  const rows = [contributorRow({ cid: null }), contributorRow({ uri: `${CONTRIBUTOR_URI}x` })];
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('count(*)')) return [{ n: 2 }];
    return rows;
  });

  const result = await resolveContributors(pool, {
    identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
    offset: 0,
    limit: 1
  });

  assert.deepEqual(result, {
    items: [
      {
        uri: CONTRIBUTOR_URI,
        displayName: 'Ursula K. Le Guin',
        nameInverted: 'Le Guin, Ursula K.',
        description: 'An American author.',
        imageUrl: 'https://example.org/ursula.jpg',
        identifiers: [{ issuer: 'orcid', value: '0000-0002-1825-0097' }],
        born: '1929-10-21',
        died: '2018-01-22',
        createdAt: '2026-11-12T10:20:30.000Z'
      }
    ],
    hasMore: true,
    total: 2
  });
  assert.match(calls[0].sql, /identifiers @> ANY\(\$1::jsonb\[\]\)/);
  assert.deepEqual(calls[0].values?.[0], [
    JSON.stringify([{ issuer: 'orcid', value: '0000-0002-1825-0097' }])
  ]);
});

test('resolvePublishers skips the count on later pages', async () => {
  const { pool, calls } = fakePool(() => []);
  const result = await resolvePublishers(pool, {
    identifiers: [{ issuer: 'isni', value: '0000000121032683' }],
    offset: 25,
    limit: 25
  });
  assert.deepEqual(result, { items: [], hasMore: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM publishers c/);
});

test('searchContributors escapes LIKE metacharacters and ranks exact names first', async () => {
  const { pool, calls } = fakePool(() => []);
  await searchContributors(pool, { q: '100%_x', limit: 10 });

  const [call] = calls;
  assert.match(call.sql, /c\.name ILIKE \$1/);
  assert.match(call.sql, /jsonb_array_elements\(c\.identifiers\)/);
  assert.equal(call.values?.[0], '%100\\%\\_x%');
  assert.equal(call.values?.[1], '100%_x');
  assert.equal(call.values?.[2], '100\\%\\_x%');
  assert.equal(call.values?.[3], 11);
  assert.equal(call.values?.[4], 0);
});

test('search pagination emits an offset cursor only when a probe row exists', async () => {
  const rows = [publisherRow(), publisherRow({ uri: `${PUBLISHER_URI}x` }), publisherRow()];
  let page = 0;
  const { pool, calls } = fakePool(() => (page++ === 0 ? rows : [publisherRow()]));
  const first = await searchPublishers(pool, { q: 'Ace', limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.cursor);
  assert.equal(decodeOffsetCursor(first.cursor), 2);

  const second = await searchPublishers(pool, { q: 'Ace', limit: 2, cursor: first.cursor });
  assert.equal(calls.at(-1)?.values?.[4], 2);
  assert.equal(second.cursor, undefined);
});

test('a malformed cursor starts at the beginning and a blank q is InvalidQuery', async () => {
  assert.equal(decodeOffsetCursor('not-base64-json'), 0);
  assert.equal(decodeOffsetCursor(encodeOffsetCursor(7)), 7);

  const { pool } = fakePool(() => []);
  await assert.rejects(
    searchContributors(pool, { q: '   ', limit: 10 }),
    (error) => error instanceof EntityQueryError
  );
});

test('identifiers stored as JSON text are decoded', async () => {
  const { pool } = fakePool(() => [
    contributorRow({ identifiers: '[{"issuer":"viaf","value":"123","url":"https://viaf.example/123"}]' })
  ]);
  const view = await getContributor(pool, CONTRIBUTOR_URI);
  assert.deepEqual(view?.identifiers, [
    { issuer: 'viaf', value: '123', url: 'https://viaf.example/123' }
  ]);
});

test('the seven entity methods split into five GET queries and two POST procedures', () => {
  assert.equal(ENTITY_METHODS.size, 7);
  assert.equal(ENTITY_QUERIES.size, 5);
  assert.equal(ENTITY_PROCEDURES.size, 2);
  assert.ok(ENTITY_QUERIES.has('net.olamaelcu.livtet.biblio.getContributor'));
  assert.ok(ENTITY_QUERIES.has('net.olamaelcu.livtet.biblio.searchPublishers'));
  assert.ok(ENTITY_QUERIES.has('net.olamaelcu.livtet.biblio.listEditionsByContributor'));
  assert.ok(ENTITY_PROCEDURES.has('net.olamaelcu.livtet.biblio.resolveContributors'));
  assert.ok(ENTITY_PROCEDURES.has('net.olamaelcu.livtet.biblio.resolvePublishers'));
  assert.ok(!ENTITY_QUERIES.has('net.olamaelcu.livtet.biblio.resolvePublishers'));
});

test('likePattern wraps and escapes in one place', () => {
  assert.equal(likePattern('a_b%c'), '%a\\_b\\%c%');
  assert.equal(likePattern('plain'), '%plain%');
});

test('listEditionsByContributor returns bookViews for every credited edition', async () => {
  const rows = [editionRow(`${EDITION_PREFIX}1`), editionRow(`${EDITION_PREFIX}2`)];
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('WHERE at_uri = $1')) return [{ id: 42 }];
    if (sql.includes('count(DISTINCT')) return [{ n: 2 }];
    if (sql.includes('FROM editions e')) return rows;
    return [];
  });

  const page = await listEditionsByContributor(pool, {
    contributor: CONTRIBUTOR_URI,
    offset: 0,
    limit: 1
  });

  assert.ok(page);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.uri, `${EDITION_PREFIX}1`);
  assert.equal(page.items[0]?.edition.title, 'A Test Edition');
  assert.deepEqual(page.items[0]?.edition.identifiers, [
    { issuer: 'atproto', value: `${EDITION_PREFIX}1` }
  ]);
  assert.equal(page.total, 2);
  assert.equal(decodeOffsetCursor(page.cursor), 1);

  const pageCall = calls.find((call) => call.sql.includes('FROM editions e'));
  assert.ok(pageCall);
  assert.match(pageCall.sql, /WHERE EXISTS/);
  // A contributor credited twice on one edition must not duplicate the row.
  assert.doesNotMatch(pageCall.sql, /JOIN edition_contributors/);
  assert.deepEqual(pageCall.values, [42, 2, 0]);
});

test('listEditionsByContributor returns null for an unknown contributor', async () => {
  const { pool } = fakePool(() => []);
  assert.equal(
    await listEditionsByContributor(pool, {
      contributor: CONTRIBUTOR_URI,
      offset: 0,
      limit: 25
    }),
    null
  );
  assert.equal(parseEntityUri(PUBLISHER_URI, CONTRIBUTOR_COLLECTION), null);
});

test('listEditionsByContributor pages by offset and omits the total after page one', async () => {
  const rows = [editionRow(`${EDITION_PREFIX}1`)];
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('WHERE at_uri = $1')) return [{ id: 42 }];
    if (sql.includes('FROM editions e')) return rows;
    return [];
  });

  const page = await listEditionsByContributor(pool, {
    contributor: CONTRIBUTOR_URI,
    offset: 1,
    limit: 25
  });

  assert.ok(page);
  assert.equal(page.items.length, 1);
  assert.equal(page.cursor, undefined);
  assert.equal(page.total, undefined);
  assert.equal(calls.some((call) => call.sql.includes('count(DISTINCT')), false);
  const pageCall = calls.find((call) => call.sql.includes('FROM editions e'));
  assert.ok(pageCall);
  assert.deepEqual(pageCall.values, [42, 26, 1]);
});

test('catalog failures are 503 ServiceUnavailable', async () => {
  const unavailable = catalogFailure(new CatalogUnavailableError());
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: 'ServiceUnavailable',
    message: 'catalog database is not configured'
  });

  const original = console.error;
  console.error = () => {};
  try {
    const failed = catalogFailure(new Error('connection refused'));
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), {
      error: 'ServiceUnavailable',
      message: 'catalog unavailable'
    });
  } finally {
    console.error = original;
  }
});
