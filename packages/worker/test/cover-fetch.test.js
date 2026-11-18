/**
 * `catalog.covers`: which provider answers, what lands on disk, and what the
 * ledger records.
 *
 * The pool is scripted and the download is injected, so these tests assert the
 * behaviour itself: a cover URL is not evidence of a cover, a placeholder-sized
 * response is rejected for good, and an outage never writes a terminal outcome.
 */

import { expect, test } from 'vitest';

import { mkdtempSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTasks } from '../lib/tasks.js';
import { coverCachePath, writeCachedCover } from '../lib/cover-cache.js';
import { createCoverMetrics } from '../lib/cover-metrics.js';

const EDITION = 'at://did:plc:publisher/community.lexicon.media.book.edition/3abc';
const ISBN = '9780441478125';
const COVER = 'https://covers.openlibrary.org/b/id/12345-L.jpg';
const GOOGLE_COVER = 'https://books.google.test/cover.jpg';
const log = { info() {}, warn() {}, error() {} };

/** A JPEG-shaped buffer: the three-byte signature is all the sniff looks at. */
function jpegBytes(size = 74_000) {
  const bytes = Buffer.alloc(size, 0x20);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

/** The OpenLibrary "no cover" answer: a 43-byte 1×1 transparent GIF. */
function placeholderGif() {
  const bytes = Buffer.alloc(43, 0x00);
  bytes.write('GIF89a', 0, 'latin1');
  return bytes;
}

function cacheDirFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bibliograph-covers-'));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A scripted catalog.
 *
 * `cached` answers the single edition/ledger/cache join; `exists: false` is the
 * vanished-edition case. Every statement is recorded so a test can assert the
 * writes instead of a database.
 */
function coverPool({ coverUrl = null, cached = null, exists = true } = {}) {
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
      if (sql.includes('LEFT JOIN edition_cover_files')) {
        return exists
          ? {
              rows: [
                {
                  cover_url: coverUrl,
                  cached_source: cached?.sourceUrl ?? null,
                  content_type: cached?.contentType ?? null,
                  byte_size: cached?.byteSize ?? null
                }
              ],
              rowCount: 1
            }
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

/** A `fetch` stand-in: the value is a Buffer (200), an Error, or a status. */
function coverFetch(answer) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const result = typeof answer === 'function' ? answer(url) : answer;
    if (result instanceof Error) throw result;
    if (typeof result === 'number') {
      return new Response('nope', { status: result });
    }
    return new Response(result, {
      status: 200,
      headers: { 'content-length': String(result.length) }
    });
  };
  return { calls, impl };
}

function ledger(statements) {
  return statements
    .filter((statement) => statement.sql.includes('UPDATE edition_cover_fetches'))
    .at(-1);
}

function statementsLike(statements, fragment) {
  return statements.filter((statement) => statement.sql.includes(fragment));
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('a cached edition is never downloaded again', async (t) => {
  const cacheDir = cacheDirFor(t);
  const bytes = jpegBytes();
  await writeCachedCover(cacheDir, EDITION, bytes);
  const { pool, statements } = coverPool({
    coverUrl: COVER,
    cached: { sourceUrl: COVER, contentType: 'image/jpeg', byteSize: bytes.length }
  });
  const download = coverFetch(bytes);
  const tasks = createTasks({
    pool,
    providers: coverProviders(),
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverFetch: download.impl
  });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  expect(download.calls, 'the cached bytes are reused').toEqual([]);
  expect(ledger(statements)?.sql ?? '').toMatch(/outcome = 'found'/);
  expect(statementsLike(statements, 'UPDATE books'), 'no edition write').toEqual([]);
});

test('a downloaded cover is cached, recorded, and the record is republished', async (t) => {
  const cacheDir = cacheDirFor(t);
  const bytes = jpegBytes();
  const { pool, statements } = coverPool({ coverUrl: COVER });
  const download = coverFetch(bytes);
  const tasks = createTasks({
    pool,
    providers: coverProviders(),
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverFetch: download.impl
  });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  expect(await fileExists(coverCachePath(cacheDir, EDITION)), 'the bytes are on disk').toBe(true);
  const upsert = statementsLike(statements, 'INSERT INTO edition_cover_files');
  expect(upsert.length).toBe(1);
  expect(upsert[0].values).toEqual([EDITION, COVER, 'image/jpeg', bytes.length]);
  expect(ledger(statements)?.sql ?? '').toMatch(/outcome = 'found'/);
  expect(statementsLike(statements, 'INSERT INTO pds_outbox').length).toBe(1);
  expect(statementsLike(statements, 'UPDATE books'), 'an existing provider URL is left alone').toEqual([]);
});

test('a placeholder-sized image is rejected, and the URL is cleared', async (t) => {
  const cacheDir = cacheDirFor(t);
  const { pool, statements } = coverPool({ coverUrl: COVER });
  const download = coverFetch(placeholderGif());
  const tasks = createTasks({
    pool,
    providers: coverProviders(),
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverFetch: download.impl
  });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  const cleared = statementsLike(statements, 'UPDATE books SET cover_url = NULL');
  expect(cleared[0]?.values).toEqual([EDITION, COVER]);
  const rejected = ledger(statements);
  expect(rejected?.sql ?? '').toMatch(/outcome = 'rejected'/);
  expect(rejected?.sql ?? '').toMatch(/source_url = \$2/);
  expect(rejected?.values).toEqual([EDITION, COVER]);
  expect(await fileExists(coverCachePath(cacheDir, EDITION)), 'nothing was cached').toBe(false);
});

test('a transport failure rejects the job and writes no terminal outcome', async (t) => {
  const cacheDir = cacheDirFor(t);
  const { pool, statements } = coverPool({ coverUrl: COVER });
  const download = coverFetch(new Error('socket hang up'));
  const tasks = createTasks({
    pool,
    providers: coverProviders(),
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverFetch: download.impl
  });

  await expect(() => tasks['catalog.covers']({ editionUri: EDITION }, { logger: log })).rejects.toThrow(/socket hang up/);

  expect(ledger(statements), 'the claim is kept so the retry does not wait').toBe(undefined);
  expect(statementsLike(statements, 'UPDATE books')).toEqual([]);
});

test('a provider 5xx is retried rather than treated as a missing cover', async (t) => {
  const cacheDir = cacheDirFor(t);
  const { pool, statements } = coverPool({ coverUrl: COVER });
  const download = coverFetch(503);
  const coverMetrics = createCoverMetrics();
  const tasks = createTasks({
    pool,
    providers: coverProviders(),
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverMetrics,
    coverFetch: download.impl
  });

  await expect(() => tasks['catalog.covers']({ editionUri: EDITION }, { logger: log })).rejects.toThrow(/answered 503/);
  expect(ledger(statements)).toBe(undefined);
  // A 5xx is a provider problem: the retry is what the counter must show.
  expect(coverMetrics.snapshot()).toEqual([{ result: 'retry', status: '503', count: 1 }]);
});

test('a 403 is terminal for its URL, and the outcome is counted', async (t) => {
  const cacheDir = cacheDirFor(t);
  const { pool, statements } = coverPool({ coverUrl: GOOGLE_COVER });
  const download = coverFetch(403);
  const coverMetrics = createCoverMetrics();
  const tasks = createTasks({
    pool,
    providers: coverProviders(),
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverMetrics,
    coverFetch: download.impl
  });

  // No throw: retrying a URL the provider refuses only spends requests, so the
  // edition loses the dead URL and the ledger records it terminaally.
  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  expect(ledger(statements)?.sql ?? '').toMatch(/outcome = 'rejected'/);
  expect(statementsLike(statements, 'UPDATE books')[0]?.sql ?? '').toMatch(/cover_url = NULL/);
  expect(coverMetrics.snapshot()).toEqual([{ result: 'rejected', status: '403', count: 1 }]);
});

test('an edition without a cover URL discovers one, then caches it', async (t) => {
  const cacheDir = cacheDirFor(t);
  const bytes = jpegBytes();
  const { pool, statements } = coverPool();
  const providers = coverProviders({ openlibrary: COVER });
  const download = coverFetch(bytes);
  const coverMetrics = createCoverMetrics();
  const tasks = createTasks({
    pool,
    providers,
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverMetrics,
    coverFetch: download.impl
  });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  expect(download.calls, 'the discovered URL is what gets downloaded').toEqual([COVER]);
  expect(providers.calls.google, 'Google Books is only the fallback').toBe(0);
  // The guarded write is what keeps a concurrent curator edit winning.
  const discovered = statementsLike(statements, 'UPDATE books SET cover_url = $2');
  expect(discovered[0]?.values).toEqual([EDITION, COVER]);
  expect(discovered[0]?.sql ?? '').toMatch(/cover_url IS NULL OR btrim\(cover_url\) = ''/);
  expect(ledger(statements)?.sql ?? '').toMatch(/outcome = 'found'/);
  expect(await fileExists(coverCachePath(cacheDir, EDITION))).toBe(true);
  // One file on disk, and the byte total is its size — the metric an operator
  // reads to explain the cache directory's growth.
  expect(coverMetrics.counters()).toEqual({
    writes: 1,
    writeBytes: bytes.length,
    removals: 0
  });
});

test('Google Books answers when OpenLibrary has no cover', async (t) => {
  const cacheDir = cacheDirFor(t);
  const bytes = jpegBytes();
  const { pool, statements } = coverPool();
  const providers = coverProviders({
    openlibrary: undefined,
    google: [{ coverUrl: '' }, { coverUrl: GOOGLE_COVER }]
  });
  const tasks = createTasks({
    pool,
    providers,
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverFetch: coverFetch(bytes).impl
  });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  expect(providers.calls.isbn, 'the ISBN is what Google is asked for').toBe(ISBN);
  expect(statementsLike(statements, 'INSERT INTO edition_cover_files')[0]?.values.slice(0, 2)).toEqual([EDITION, GOOGLE_COVER]);
});

test('a "no cover" answer is recorded and no edition is touched', async (t) => {
  const cacheDir = cacheDirFor(t);
  const { pool, statements } = coverPool();
  const download = coverFetch(jpegBytes());
  const tasks = createTasks({
    pool,
    providers: coverProviders({ openlibrary: undefined, google: [] }),
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverFetch: download.impl
  });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  expect(download.calls, 'nothing to download').toEqual([]);
  expect(ledger(statements)?.sql ?? '').toMatch(/outcome = 'none'/);
  expect(statementsLike(statements, 'UPDATE books')).toEqual([]);
});

test('an outage during discovery fails the job instead of recording no cover', async (t) => {
  const cacheDir = cacheDirFor(t);
  const { pool, statements } = coverPool();
  const tasks = createTasks({
    pool,
    providers: coverProviders({
      openlibrary: new Error('openlibrary 503'),
      google: new Error('google 500')
    }),
    publisherHost: 'covers.example',
    coversCacheDir: cacheDir,
    coverFetch: coverFetch(jpegBytes()).impl
  });

  await expect(() => tasks['catalog.covers']({ editionUri: EDITION }, { logger: log })).rejects.toThrow(/openlibrary 503/);
  expect(ledger(statements)).toBe(undefined);
});

test('an unset COVERS_CACHE_DIR downloads nothing and records nothing', async () => {
  const { pool, statements } = coverPool({ coverUrl: COVER });
  const download = coverFetch(jpegBytes());
  const tasks = createTasks({
    pool,
    providers: coverProviders(),
    publisherHost: 'covers.example',
    coversCacheDir: '',
    coverFetch: download.impl
  });

  await tasks['catalog.covers']({ editionUri: EDITION }, { logger: log });

  expect(download.calls).toEqual([]);
  // No query at all: the guard runs before the edition lookup, so a disabled
  // cache cannot half-apply a ledger outcome to an edition it never examined.
  expect(statements).toEqual([]);
});
