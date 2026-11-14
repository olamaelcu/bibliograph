/**
 * `catalog.covers`: which provider answers, what the ledger records, and when an
 * outage is allowed to fail the job instead of being read as "no cover".
 *
 * The pool is scripted, so these tests assert the statements themselves:
 * OpenLibrary is asked first, Google Books only for an ISBN and only when
 * OpenLibrary had nothing, and a provider failure never writes "no cover".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTasks } from '../lib/tasks.js';

const EDITION = 'at://did:plc:publisher/community.lexicon.media.book.edition/3abc';
const ISBN = '9780441478125';
const COVER = 'https://covers.openlibrary.org/b/id/12345-L.jpg';
const GOOGLE_COVER = 'https://books.google.test/cover.jpg';
const log = { info() {}, warn() {}, error() {} };

function coverPool({ coverUrl = null, exists = true } = {}) {
  const statements = [];
  const record = (sql, values) => {
    statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
  };
  const client = {
    query: async (sql, values) => {
      record(sql, values);
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pool = {
    statements,
    connect: async () => client,
    query: async (sql, values) => {
      record(sql, values);
      if (sql.includes('SELECT cover_url FROM editions')) {
        return exists
          ? { rows: [{ cover_url: coverUrl }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM edition_identifiers')) {
        return { rows: [{ issuer: 'isbn13', value: ISBN }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  return { pool, statements };
}

/** `null` omits a provider entirely; a value, an array or an Error is its answer. */
function coverProviders({ openlibrary = undefined, google = undefined } = {}) {
  const calls = { openlibrary: 0, google: 0, isbn: null };
  const answer = (value) => {
    const resolved = typeof value === 'function' ? value() : value;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };
  const providers = {};
  if (openlibrary !== null) {
    providers.openlibrary = {
      coverForEdition: async () => {
        calls.openlibrary += 1;
        return answer(openlibrary);
      }
    };
  }
  if (google !== null) {
    providers.google = {
      byIsbn: async (isbn) => {
        calls.google += 1;
        calls.isbn = isbn;
        return answer(google);
      }
    };
  }
  return { calls, providers };
}

function ledger(statements) {
  return statements.find((statement) => statement.sql.includes('SET requested_at'));
}

function coverWrite(statements) {
  return statements.find((statement) => statement.sql.includes('UPDATE editions SET cover_url'));
}

test('an OpenLibrary cover is written and the ledger records it', async () => {
  const { pool, statements } = coverPool();
  const providers = coverProviders({ openlibrary: COVER });
  const tasks = createTasks({ pool, providers, publisherHost: 'covers.example' });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  assert.deepEqual(coverWrite(statements)?.values, [EDITION, COVER]);
  assert.equal(providers.calls.google, 0, 'Google Books is only the fallback');
  assert.match(ledger(statements)?.sql ?? '', /outcome = 'found'/);
});

test('Google Books answers when OpenLibrary has no cover', async () => {
  const { pool, statements } = coverPool();
  const providers = coverProviders({
    openlibrary: undefined,
    google: [{ coverUrl: '' }, { coverUrl: GOOGLE_COVER }]
  });
  const tasks = createTasks({ pool, providers, publisherHost: 'covers.example' });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  assert.equal(providers.calls.isbn, ISBN, 'the ISBN is what Google is asked for');
  assert.deepEqual(coverWrite(statements)?.values, [EDITION, GOOGLE_COVER]);
  assert.match(ledger(statements)?.sql ?? '', /outcome = 'found'/);
});

test('a "no cover" answer is recorded and no edition is touched', async () => {
  const { pool, statements } = coverPool();
  const providers = coverProviders({ openlibrary: undefined, google: [] });
  const tasks = createTasks({ pool, providers, publisherHost: 'covers.example' });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  assert.equal(coverWrite(statements), undefined, 'a missing cover writes no URL');
  assert.match(ledger(statements)?.sql ?? '', /outcome = 'none'/);
});

test('an outage fails the job instead of being recorded as no cover', async () => {
  const { pool, statements } = coverPool();
  const providers = coverProviders({
    openlibrary: new Error('openlibrary 503'),
    google: new Error('google 500')
  });
  const tasks = createTasks({ pool, providers, publisherHost: 'covers.example' });

  await assert.rejects(
    () => tasks['catalog.covers']({ editionUri: EDITION }, { logger: log }),
    /openlibrary 503/
  );

  assert.equal(ledger(statements), undefined, 'the claim is kept so the retry does not wait');
  assert.equal(coverWrite(statements), undefined);
});

test('Google Books still answers when only OpenLibrary failed', async () => {
  const { pool, statements } = coverPool();
  const providers = coverProviders({
    openlibrary: new Error('openlibrary 503'),
    google: [{ coverUrl: GOOGLE_COVER }]
  });
  const tasks = createTasks({ pool, providers, publisherHost: 'covers.example' });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  assert.deepEqual(coverWrite(statements)?.values, [EDITION, GOOGLE_COVER]);
});

test('an edition that already has a cover is never asked again', async () => {
  const { pool, statements } = coverPool({ coverUrl: COVER });
  const providers = coverProviders({ openlibrary: COVER, google: [] });
  const tasks = createTasks({ pool, providers, publisherHost: 'covers.example' });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  assert.deepEqual(providers.calls, { openlibrary: 0, google: 0, isbn: null });
  assert.match(ledger(statements)?.sql ?? '', /outcome = 'found'/);
});
