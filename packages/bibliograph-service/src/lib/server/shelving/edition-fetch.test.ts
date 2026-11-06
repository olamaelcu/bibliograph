import test from 'node:test';
import assert from 'node:assert/strict';
import { pino } from 'pino';
import { catalogBookToEdition, parseCatalogBook } from '../bookhive/catalog';
import { BOOKHIVE_DID, bhEditionUri } from '../bookhive/keys';
import { fetchEditionForUri, providerForEditionUri, resolveBookhiveEdition } from './edition-fetch';
import { providerIdentifier } from '../identifiers';

const log = pino({ level: 'silent' });

const HIVE_ID = 'bk_zzpdK0fMgbLQYdzPhxwf';
const EDITION_URI = bhEditionUri(HIVE_ID);

// Shape observed on did:plc:enu2j5xjlqsjaylv3du4myh4 (Bookhive's PDS).
const RECORD = {
  $type: 'buzz.bookhive.catalogBook',
  id: HIVE_ID,
  title: 'Dune',
  authors: 'Brian Herbert, Kevin J. Anderson',
  cover: 'https://example.test/dune.jpg',
  rating: 3090,
  source: 'Goodreads',
  sourceId: '53780375',
  createdAt: '2024-06-01T00:00:00.000Z',
};

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => impl(String(url), init)) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function getRecordResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    uri: `at://${BOOKHIVE_DID}/buzz.bookhive.catalogBook/${HIVE_ID}`,
    cid: 'bafyreiexample',
    value,
  }), { headers: { 'content-type': 'application/json' } });
}

function recordNotFound(): Response {
  return new Response(JSON.stringify({ error: 'RecordNotFound', message: 'Could not locate record' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

test('catalogBookToEdition maps a catalog record onto its bh.{hiveId} edition', () => {
  const resolved = catalogBookToEdition(parseCatalogBook(RECORD)!)!;
  assert.equal(resolved.item.uri, EDITION_URI);
  assert.equal(resolved.item.title, 'Dune');
  assert.equal(resolved.item.coverImageUrl, RECORD.cover);
  assert.equal(resolved.item.createdAt, RECORD.createdAt);
  // No contributor records upstream, so no invented strongRefs.
  assert.deepEqual(resolved.item.contributors, []);
  assert.deepEqual(resolved.item.identifiers, [
    providerIdentifier('bookhive', `at://${BOOKHIVE_DID}/buzz.bookhive.catalogBook/${HIVE_ID}`),
    providerIdentifier('goodreads', 'https://www.goodreads.com/book/show/53780375'),
  ]);
  assert.deepEqual(resolved.authorNames, ['Brian Herbert', 'Kevin J. Anderson']);
});

test('catalogBookToEdition keeps a record that carries only an id and a title', () => {
  const bare = parseCatalogBook({ id: HIVE_ID, title: 'Untitled', createdAt: RECORD.createdAt })!;
  const resolved = catalogBookToEdition(bare)!;
  assert.equal(resolved.item.uri, EDITION_URI);
  assert.equal(resolved.item.coverImageUrl, undefined);
  assert.deepEqual(resolved.item.identifiers, [
    providerIdentifier('bookhive', `at://${BOOKHIVE_DID}/buzz.bookhive.catalogBook/${HIVE_ID}`),
  ]);
  assert.deepEqual(resolved.authorNames, []);
});

test('catalogBookToEdition returns null for a record with no usable timestamp', () => {
  assert.equal(catalogBookToEdition(parseCatalogBook({ id: HIVE_ID, title: 'Dune' })!), null);
  assert.equal(catalogBookToEdition(parseCatalogBook({ ...RECORD, createdAt: 'not-a-date' })!), null);
});

test('resolveBookhiveEdition reads the catalog record by hive id', async () => {
  const calls: string[] = [];
  const restore = stubFetch((url) => {
    calls.push(url);
    return Promise.resolve(getRecordResponse(RECORD));
  });
  try {
    const item = await resolveBookhiveEdition(`bh.${HIVE_ID}`);
    assert.equal(item?.uri, EDITION_URI);
    assert.equal(item?.title, 'Dune');
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!);
    assert.equal(url.pathname, '/xrpc/com.atproto.repo.getRecord');
    assert.equal(url.searchParams.get('repo'), BOOKHIVE_DID);
    assert.equal(url.searchParams.get('collection'), 'buzz.bookhive.catalogBook');
    assert.equal(url.searchParams.get('rkey'), HIVE_ID);
  } finally {
    restore();
  }
});

test('resolveBookhiveEdition returns null for a record the catalog does not hold', async () => {
  const restore = stubFetch(() => Promise.resolve(recordNotFound()));
  try {
    assert.equal(await resolveBookhiveEdition(`bh.${HIVE_ID}`), null);
  } finally {
    restore();
  }
});

test('resolveBookhiveEdition returns null for a record that cannot produce an edition', async () => {
  const restore = stubFetch(() => Promise.resolve(getRecordResponse({ id: HIVE_ID, title: 'Dune' })));
  try {
    assert.equal(await resolveBookhiveEdition(`bh.${HIVE_ID}`), null);
  } finally {
    restore();
  }
});

test('fetchEditionForUri resolves a bh. rkey through the Bookhive catalog', async () => {
  const restore = stubFetch(() => Promise.resolve(getRecordResponse(RECORD)));
  try {
    const item = await fetchEditionForUri(EDITION_URI, log);
    assert.equal(item?.uri, EDITION_URI);
    assert.equal(item?.title, 'Dune');
  } finally {
    restore();
  }
});

test('fetchEditionForUri falls back to null when the catalog fetch fails', async () => {
  const restore = stubFetch(() => Promise.reject(new DOMException('aborted', 'TimeoutError')));
  try {
    assert.equal(await fetchEditionForUri(EDITION_URI, log), null);
  } finally {
    restore();
  }
});

test('fetchEditionForUri does not ask the catalog for a malformed bh. rkey', async () => {
  let fetched = false;
  const restore = stubFetch(() => {
    fetched = true;
    return Promise.resolve(recordNotFound());
  });
  try {
    assert.equal(await fetchEditionForUri('at://did:web:x/community.lexicon.book.edition/bh.not-a-hive-id', log), null);
    assert.equal(fetched, false);
  } finally {
    restore();
  }
});

test('providerForEditionUri names the owning provider', () => {
  assert.equal(providerForEditionUri(EDITION_URI), 'bh');
  assert.equal(providerForEditionUri('at://did:web:x/community.lexicon.book.edition/ol.OL1W'), 'ol');
  assert.equal(providerForEditionUri('at://did:web:x/community.lexicon.book.edition/zz.1'), null);
});
