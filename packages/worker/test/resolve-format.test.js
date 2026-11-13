import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAdminHandler } from '../lib/admin.js';
import {
  FormatResolveError,
  normalizeFormatIsbns,
  resolveFormat
} from '../lib/resolve-format.js';

const ISBN10 = '0306406152';
const ISBN13 = '9780306406157';
const OTHER = '9780441013593';

function fakeProviders(byIdentifier) {
  const calls = [];
  return {
    calls,
    providers: {
      goodreads: {
        async byIdentifier(isbn) {
          calls.push(isbn);
          return byIdentifier(isbn);
        }
      }
    }
  };
}

test('normalises and dedupes ISBN-10 and ISBN-13 values', () => {
  assert.deepEqual(
    normalizeFormatIsbns([ISBN10, ISBN13, '0-306-40615-2', OTHER]),
    [ISBN13, OTHER]
  );
});

test('rejects missing, oversized, non-string and bad-checksum ISBN lists', () => {
  for (const value of [undefined, null, '9780306406157', [], Array(11).fill(ISBN13)]) {
    assert.throws(
      () => normalizeFormatIsbns(value),
      (error) => error instanceof FormatResolveError && error.status === 400,
      JSON.stringify(value)
    );
  }
  assert.throws(
    () => normalizeFormatIsbns([9780306406157]),
    (error) => error instanceof FormatResolveError && error.status === 400
  );
  assert.throws(
    () => normalizeFormatIsbns(['9780306406158']),
    (error) => error instanceof FormatResolveError && error.status === 400
  );
});

test('tries each ISBN in order and returns the first non-empty format', async () => {
  const fake = fakeProviders((isbn) =>
    isbn === ISBN13 ? [{ title: 'No format' }, { format: '   ' }] : [{ format: ' Paperback ' }]
  );
  const result = await resolveFormat(fake, [ISBN13, OTHER]);
  assert.deepEqual(result, { isbn: OTHER, format: 'Paperback', source: 'goodreads' });
  assert.deepEqual(fake.calls, [ISBN13, OTHER]);
});

test('uses the second candidate when the first has no format', async () => {
  const fake = fakeProviders(() => [{ title: 'No format' }, { format: 'Hardcover' }]);
  const result = await resolveFormat(fake, [ISBN13]);
  assert.deepEqual(result, { isbn: ISBN13, format: 'Hardcover', source: 'goodreads' });
});

test('returns null when Goodreads has no format for any ISBN', async () => {
  const fake = fakeProviders(() => [{ title: 'No format' }, {}]);
  assert.equal(await resolveFormat(fake, [ISBN13, OTHER]), null);
  assert.deepEqual(fake.calls, [ISBN13, OTHER]);
});

test('maps Goodreads failures to a 502 without touching other providers', async () => {
  const fake = fakeProviders(() => {
    throw new Error('upstream 503');
  });
  fake.providers.isbndb = {
    byIsbn() {
      assert.fail('the resolver must not call ISBNdb');
    }
  };
  await assert.rejects(
    resolveFormat(fake, [ISBN13]),
    (error) =>
      error instanceof FormatResolveError &&
      error.status === 502 &&
      error.code === 'ProviderUnavailable'
  );
  assert.deepEqual(fake.calls, [ISBN13]);
});

test('maps an exhausted anti-bot challenge to a clear 502 provider error', async () => {
  const fake = fakeProviders(() => {
    const error = new Error('goodreads answered an anti-bot challenge');
    error.code = 'GOODREADS_CHALLENGE';
    throw error;
  });

  await assert.rejects(
    resolveFormat(fake, [ISBN13]),
    (error) =>
      error instanceof FormatResolveError &&
      error.status === 502 &&
      error.code === 'ProviderUnavailable' &&
      /blocked the request/.test(error.message)
  );
  // A genuine "no format" answer stays a 404 upstream; only a block is 502.
  assert.deepEqual(fake.calls, [ISBN13]);
});

async function withAdminApi(providers, run) {
  const handler = createAdminHandler({
    providers,
    ingest: async () => undefined,
    token: 'test-token',
    logger: { error() {}, log() {} }
  });
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postFormat(base, body, token = 'test-token') {
  return fetch(`${base}/resolve-format`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

test('the admin endpoint preserves auth and maps format outcomes', async () => {
  const fake = fakeProviders((isbn) =>
    isbn === ISBN13 ? [{ format: 'Paperback' }] : []
  );
  await withAdminApi(fake, async (base) => {
    const ok = await postFormat(base, { isbns: [ISBN10] });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      isbn: ISBN13,
      format: 'Paperback',
      source: 'goodreads'
    });

    const unauthorized = await postFormat(base, { isbns: [ISBN10] }, '');
    assert.equal(unauthorized.status, 401);

    const invalid = await postFormat(base, { isbns: [] });
    assert.equal(invalid.status, 400);

    const missing = await postFormat(base, { isbns: [OTHER] });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'FormatNotFound');
  });

  const failing = fakeProviders(() => {
    throw new Error('upstream down');
  });
  await withAdminApi(failing, async (base) => {
    const response = await postFormat(base, { isbns: [ISBN13] });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'ProviderUnavailable');
  });
});
