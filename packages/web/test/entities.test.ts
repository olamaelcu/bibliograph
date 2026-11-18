import { expect, test } from 'vitest';

import {
  EntityQueryError,
  EntityUriError,
  CONTRIBUTOR_COLLECTION,
  getContributor,
  getPublisher,
  listBooksByContributor,
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
import { ENTITY_QUERIES } from '../src/lib/server/catalog/entity-methods.ts';
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
    shape_language: null,
    shape_published_date: null,
    shape_format: null,
    shape_pages: null,
    duration_seconds: null,
    chapters: null,
    series: null,
    book_edition: null,
    shape_description: null,
    cover_url: null,
    created_at: CREATED
  };
}

test('parseEntityUri is scoped to one collection and rejects malformed URIs', () => {
  expect(parseEntityUri(CONTRIBUTOR_URI, 'net.olamaelcu.livtet.biblio.contributor')).toEqual({
    did: AUTHORITY,
    rkey: '3abc'
  });
  expect(parseEntityUri(CONTRIBUTOR_URI, 'net.olamaelcu.livtet.biblio.publisher')).toBe(null);
  expect(parseEntityUri('https://example.org/x', 'net.olamaelcu.livtet.biblio.contributor')).toBe(null);
  expect(parseEntityUri('at://not-a-did/net.olamaelcu.livtet.biblio.contributor/3abc', 'net.olamaelcu.livtet.biblio.contributor')).toBe(null);
  expect(parseEntityUri(`at://${AUTHORITY}/net.olamaelcu.livtet.biblio.contributor/.`, 'net.olamaelcu.livtet.biblio.contributor')).toBe(null);
});

test('getContributor maps the row, includes the published cid, and omits empty fields', async () => {
  const { pool, calls } = fakePool((sql) => (sql.includes('FROM contributors') ? [contributorRow()] : []));
  const view = await getContributor(pool, CONTRIBUTOR_URI);

  expect(view).toEqual({
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
  expect(calls.length).toBe(1);
  expect(calls[0].sql).toMatch(/LEFT JOIN pds_cids/);
  expect(calls[0].values).toEqual([CONTRIBUTOR_URI]);
});

test('getContributor returns null for a missing row and rejects another collection', async () => {
  const { pool } = fakePool(() => []);
  expect(await getContributor(pool, CONTRIBUTOR_URI)).toBe(null);
  await expect(getContributor(pool, PUBLISHER_URI)).rejects.toSatisfy((error) => error instanceof EntityUriError);
});

test('getPublisher maps a publisher row without inventing a cid', async () => {
  const { pool } = fakePool((sql) => (sql.includes('FROM publishers') ? [publisherRow()] : []));
  expect(await getPublisher(pool, PUBLISHER_URI)).toEqual({
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

  expect(result).toEqual({
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
  expect(calls[0].sql).toMatch(/identifiers @> ANY\(\$1::jsonb\[\]\)/);
  expect(calls[0].values?.[0]).toEqual([
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
  expect(result).toEqual({ items: [], hasMore: false });
  expect(calls.length).toBe(1);
  expect(calls[0].sql).toMatch(/FROM publishers c/);
});

test('searchContributors escapes LIKE metacharacters and ranks exact names first', async () => {
  const { pool, calls } = fakePool(() => []);
  await searchContributors(pool, { q: '100%_x', limit: 10 });

  const [call] = calls;
  expect(call.sql).toMatch(/c\.name ILIKE \$1/);
  expect(call.sql).toMatch(/jsonb_array_elements\(c\.identifiers\)/);
  expect(call.values?.[0]).toBe('%100\\%\\_x%');
  expect(call.values?.[1]).toBe('100%_x');
  expect(call.values?.[2]).toBe('100\\%\\_x%');
  expect(call.values?.[3]).toBe(11);
  expect(call.values?.[4]).toBe(0);
});

test('search pagination emits an offset cursor only when a probe row exists', async () => {
  const rows = [publisherRow(), publisherRow({ uri: `${PUBLISHER_URI}x` }), publisherRow()];
  let page = 0;
  const { pool, calls } = fakePool(() => (page++ === 0 ? rows : [publisherRow()]));
  const first = await searchPublishers(pool, { q: 'Ace', limit: 2 });
  expect(first.items.length).toBe(2);
  expect(first.cursor).toBeTruthy();
  expect(decodeOffsetCursor(first.cursor)).toBe(2);

  const second = await searchPublishers(pool, { q: 'Ace', limit: 2, cursor: first.cursor });
  expect(calls.at(-1)?.values?.[4]).toBe(2);
  expect(second.cursor).toBe(undefined);
});

test('a malformed cursor starts at the beginning and a blank q is InvalidQuery', async () => {
  expect(decodeOffsetCursor('not-base64-json')).toBe(0);
  expect(decodeOffsetCursor(encodeOffsetCursor(7))).toBe(7);

  const { pool } = fakePool(() => []);
  await expect(searchContributors(pool, { q: '   ', limit: 10 })).rejects.toSatisfy((error) => error instanceof EntityQueryError);
});

test('identifiers stored as JSON text are decoded', async () => {
  const { pool } = fakePool(() => [
    contributorRow({ identifiers: '[{"issuer":"viaf","value":"123","url":"https://viaf.example/123"}]' })
  ]);
  const view = await getContributor(pool, CONTRIBUTOR_URI);
  expect(view?.identifiers).toEqual([
    { issuer: 'viaf', value: '123', url: 'https://viaf.example/123' }
  ]);
});

test('all ten entity methods are GET queries, resolvers included', () => {
  expect(ENTITY_QUERIES.size).toBe(10);
  for (const method of [
    'net.olamaelcu.livtet.biblio.getIdentifiedFormats',
    'net.olamaelcu.livtet.biblio.getContributor',
    'net.olamaelcu.livtet.biblio.getGenresOfBook',
    'net.olamaelcu.livtet.biblio.searchPublishers',
    'net.olamaelcu.livtet.biblio.listEditions',
    'net.olamaelcu.livtet.biblio.listEditionsByContributor',
    'net.olamaelcu.livtet.biblio.resolveContributors',
    'net.olamaelcu.livtet.biblio.resolvePublishers'
  ]) {
    expect(ENTITY_QUERIES.has(method), `${method} is served as a query`).toBeTruthy();
  }
});

test('likePattern wraps and escapes in one place', () => {
  expect(likePattern('a_b%c')).toBe('%a\\_b\\%c%');
  expect(likePattern('plain')).toBe('%plain%');
});

test('listBooksByContributor returns bookViews for every credited edition', async () => {
  const rows = [editionRow(`${EDITION_PREFIX}1`), editionRow(`${EDITION_PREFIX}2`)];
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('WHERE at_uri = $1')) return [{ id: 42 }];
    if (sql.includes('count(*)::int AS n')) return [{ n: 2 }];
    if (sql.includes('FROM books e')) return rows;
    return [];
  });

  const page = await listBooksByContributor(pool, {
    contributor: CONTRIBUTOR_URI,
    offset: 0,
    limit: 1
  });

  expect(page).toBeTruthy();
  expect(page.items.length).toBe(1);
  expect(page.items[0]?.uri).toBe(`${EDITION_PREFIX}1`);
  expect(page.items[0]?.edition.title).toBe('A Test Edition');
  expect(page.items[0]?.edition.identifiers).toEqual([
    { issuer: 'atproto', value: `${EDITION_PREFIX}1` }
  ]);
  expect(page.total).toBe(2);
  expect(decodeOffsetCursor(page.cursor)).toBe(1);

  const pageCall = calls.find((call) => call.sql.includes('FROM books e'));
  expect(pageCall).toBeTruthy();
  expect(pageCall.sql).toMatch(/WHERE EXISTS/);
  // A contributor credited twice on one edition must not duplicate the row.
  expect(pageCall.sql).not.toMatch(/JOIN edition_contributors/);
  expect(pageCall.values).toEqual([42, 2, 0]);
});

test('listBooksByContributor uses the shared order and language clauses', async () => {
  const rows = [editionRow(`${EDITION_PREFIX}1`)];
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('WHERE at_uri = $1')) return [{ id: 42 }];
    if (sql.includes('count(*)::int AS n')) return [{ n: 1 }];
    if (sql.includes('FROM books e')) return rows;
    return [];
  });

  const page = await listBooksByContributor(pool, {
    contributor: CONTRIBUTOR_URI,
    language: 'EN-us',
    sort: 'publishedYear',
    order: 'desc',
    offset: 0,
    limit: 10
  });

  const pageCall = calls.find((call) => call.sql.includes('ORDER BY'));
  expect(pageCall).toBeTruthy();
  // The clauses `searchBooks` builds, from the shared helpers: the union
  // claim's primary subtag, and the year-then-date ordering with unknown last.
  expect(pageCall.sql).toMatch(/split_part\(lower\(s\.language\), '-', 1\) = split_part\(\$2, '-', 1\)/);
  expect(pageCall.sql).toMatch(/ORDER BY \(CASE WHEN s\.published_date/);
  expect(pageCall.sql).toMatch(/DESC NULLS LAST/);
  // contributor, language, limit + 1, offset; the count reuses the first two.
  expect(pageCall.values).toEqual([42, 'en-us', 11, 0]);
  // A short first page is the whole listing: its length is the total, and the
  // count (the same semi-join over the catalogue) is not run at all.
  expect(page?.total).toBe(1);
  expect(calls.some((call) => call.sql.includes('count(*)::int AS n')), 'a page shorter than the limit is its own total').toBe(false);
});

test('listBooksByContributor counts only a full first page', async () => {
  const rows = Array.from({ length: 11 }, (_, index) => editionRow(`${EDITION_PREFIX}${index}`));
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('WHERE at_uri = $1')) return [{ id: 42 }];
    if (sql.includes('count(*)::int AS n')) return [{ n: 27 }];
    if (sql.includes('FROM books e')) return rows;
    return [];
  });

  const page = await listBooksByContributor(pool, {
    contributor: CONTRIBUTOR_URI,
    offset: 0,
    limit: 10
  });

  expect(page?.items.length).toBe(10);
  expect(page?.total).toBe(27);
  expect(page?.cursor, 'a full page has more behind it').toBeTruthy();
  const countCall = calls.find((call) => call.sql.includes('count(*)::int AS n'));
  expect(countCall, 'a full first page is counted').toBeTruthy();
  expect(countCall.values).toEqual([42]);
});

test('listBooksByContributor returns null for an unknown contributor', async () => {
  const { pool } = fakePool(() => []);
  expect(await listBooksByContributor(pool, {
      contributor: CONTRIBUTOR_URI,
      offset: 0,
      limit: 25
    })).toBe(null);
  expect(parseEntityUri(PUBLISHER_URI, CONTRIBUTOR_COLLECTION)).toBe(null);
});

test('listBooksByContributor pages by offset and omits the total after page one', async () => {
  const rows = [editionRow(`${EDITION_PREFIX}1`)];
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes('WHERE at_uri = $1')) return [{ id: 42 }];
    if (sql.includes('FROM books e')) return rows;
    return [];
  });

  const page = await listBooksByContributor(pool, {
    contributor: CONTRIBUTOR_URI,
    offset: 1,
    limit: 25
  });

  expect(page).toBeTruthy();
  expect(page.items.length).toBe(1);
  expect(page.cursor).toBe(undefined);
  expect(page.total).toBe(undefined);
  expect(calls.some((call) => call.sql.includes('count(*)::int AS n'))).toBe(false);
  const pageCall = calls.find((call) => call.sql.includes('FROM books e'));
  expect(pageCall).toBeTruthy();
  expect(pageCall.values).toEqual([42, 26, 1]);
});

test('catalog failures are 503 ServiceUnavailable', async () => {
  const unavailable = catalogFailure(new CatalogUnavailableError());
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({
    error: 'ServiceUnavailable',
    message: 'catalog database is not configured'
  });

  const original = console.error;
  console.error = () => {};
  try {
    const failed = catalogFailure(new Error('connection refused'));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: 'ServiceUnavailable',
      message: 'catalog unavailable'
    });
  } finally {
    console.error = original;
  }
});
