import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coverCacheDir,
  coverCacheKey,
  coverProxyUrl,
  getCachedCover,
  isAllowedCoverUrl,
} from './cover-cache';

const originalFetch = globalThis.fetch;
const originalDir = process.env.COVER_CACHE_DIR;
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bibliograph-cover-cache-'));
  process.env.COVER_CACHE_DIR = dir;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalDir === undefined) delete process.env.COVER_CACHE_DIR;
  else process.env.COVER_CACHE_DIR = originalDir;
  await rm(dir, { recursive: true, force: true });
});

const IMAGE = Buffer.from('jpeg-bytes');
const SOURCE = 'https://covers.openlibrary.org/b/id/42-L.jpg';

function imageResponse(): Response {
  return new Response(IMAGE, {
    headers: { 'content-type': 'image/jpeg' },
  });
}

test('allows the providers Bibliograph emits and rejects other hosts', () => {
  assert.equal(isAllowedCoverUrl(SOURCE), true);
  assert.equal(
    isAllowedCoverUrl(
      'https://books.google.com/books/publisher/content?id=abc123',
    ),
    true,
  );
  assert.equal(isAllowedCoverUrl('https://covers.isbndb.com/cover.jpg'), true);
  assert.equal(isAllowedCoverUrl('https://archive.org/download/cover.jpg'), true);
  assert.equal(
    isAllowedCoverUrl('https://ia800505.us.archive.org/view_archive.php'),
    true,
  );
  assert.equal(isAllowedCoverUrl('https://example.com/cover.jpg'), false);
  assert.equal(isAllowedCoverUrl('http://covers.openlibrary.org/b/id/1-L.jpg'), false);
});

test('builds an encoded proxy URL', () => {
  assert.equal(
    coverProxyUrl(SOURCE, 'https://biblio.test/'),
    'https://biblio.test/image/cover?url=https%3A%2F%2Fcovers.openlibrary.org%2Fb%2Fid%2F42-L.jpg',
  );
});

test('fetches once and serves the second request from disk', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return imageResponse();
  }) as typeof fetch;

  const first = await getCachedCover(SOURCE);
  assert.equal(first?.body.toString(), 'jpeg-bytes');
  assert.equal(first?.contentType, 'image/jpeg');

  const second = await getCachedCover(SOURCE);
  assert.equal(second?.body.toString(), 'jpeg-bytes');
  assert.equal(calls, 1, 'the second read must not call upstream');

  const files = await readdir(coverCacheDir());
  assert.ok(files.includes(`${coverCacheKey(SOURCE)}.bin`));
  assert.ok(files.includes(`${coverCacheKey(SOURCE)}.json`));
});

test('shares one upstream request between concurrent readers', async () => {
  let calls = 0;
  const gate = Promise.withResolvers<Response>();
  globalThis.fetch = (async () => {
    calls += 1;
    return gate.promise;
  }) as typeof fetch;

  const first = getCachedCover(SOURCE);
  const second = getCachedCover(SOURCE);
  gate.resolve(imageResponse());
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(a?.body.toString(), 'jpeg-bytes');
  assert.equal(b?.body.toString(), 'jpeg-bytes');
});

test('does not cache a non-image response', async () => {
  globalThis.fetch = (async () =>
    new Response('<html>not an image</html>', {
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;

  assert.equal(await getCachedCover(SOURCE), null);
  assert.deepEqual(await readdir(dir), []);
});

test('follows the Open Library archive redirect', async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    requested.push(url);
    if (requested.length === 1) {
      return new Response(null, {
        status: 302,
        headers: {
          location:
            'https://archive.org/download/l_covers_0014/0014328630-L.jpg',
        },
      });
    }
    return imageResponse();
  }) as typeof fetch;

  const cover = await getCachedCover(SOURCE);
  assert.equal(cover?.body.toString(), 'jpeg-bytes');
  assert.deepEqual(requested, [
    SOURCE,
    'https://archive.org/download/l_covers_0014/0014328630-L.jpg',
  ]);
});

test('does not follow a redirect to a non-cover host', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/cover.jpg' },
    });
  }) as typeof fetch;

  assert.equal(await getCachedCover(SOURCE), null);
  assert.equal(calls, 1, 'the disallowed hop must not be requested');
});

test('rejects a disallowed host without fetching it', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return imageResponse();
  }) as typeof fetch;

  assert.equal(await getCachedCover('https://example.com/cover.jpg'), null);
  assert.equal(calls, 0);
});
