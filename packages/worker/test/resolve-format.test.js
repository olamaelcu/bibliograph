import { expect, test } from 'vitest';

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
  expect(normalizeFormatIsbns([ISBN10, ISBN13, '0-306-40615-2', OTHER])).toEqual([ISBN13, OTHER]);
});

test('rejects missing, oversized, non-string and bad-checksum ISBN lists', () => {
  for (const value of [undefined, null, '9780306406157', [], Array(11).fill(ISBN13)]) {
    expect(thrownBy(() => normalizeFormatIsbns(value)), JSON.stringify(value)).toSatisfy((error) => error instanceof FormatResolveError && error.status === 400);
  }
  expect(thrownBy(() => normalizeFormatIsbns([9780306406157]))).toSatisfy((error) => error instanceof FormatResolveError && error.status === 400);
  expect(thrownBy(() => normalizeFormatIsbns(['9780306406158']))).toSatisfy((error) => error instanceof FormatResolveError && error.status === 400);
});

test('tries each ISBN in order and returns the first non-empty format', async () => {
  const fake = fakeProviders((isbn) =>
    isbn === ISBN13 ? [{ title: 'No format' }, { format: '   ' }] : [{ format: ' Paperback ' }]
  );
  const result = await resolveFormat(fake, [ISBN13, OTHER]);
  expect(result).toEqual({ isbn: OTHER, format: 'Paperback', source: 'goodreads' });
  expect(fake.calls).toEqual([ISBN13, OTHER]);
});

test('uses the second candidate when the first has no format', async () => {
  const fake = fakeProviders(() => [{ title: 'No format' }, { format: 'Hardcover' }]);
  const result = await resolveFormat(fake, [ISBN13]);
  expect(result).toEqual({ isbn: ISBN13, format: 'Hardcover', source: 'goodreads' });
});

test('returns null when Goodreads has no format for any ISBN', async () => {
  const fake = fakeProviders(() => [{ title: 'No format' }, {}]);
  expect(await resolveFormat(fake, [ISBN13, OTHER])).toBe(null);
  expect(fake.calls).toEqual([ISBN13, OTHER]);
});

test('maps Goodreads failures to a 502 without touching other providers', async () => {
  const fake = fakeProviders(() => {
    throw new Error('upstream 503');
  });
  fake.providers.isbndb = {
    byIsbn() {
      throw new Error('the resolver must not call ISBNdb');
    }
  };
  await expect(resolveFormat(fake, [ISBN13])).rejects.toSatisfy((error) =>
      error instanceof FormatResolveError &&
      error.status === 502 &&
      error.code === 'ProviderUnavailable');
  expect(fake.calls).toEqual([ISBN13]);
});

test('maps an exhausted anti-bot challenge to a clear 502 provider error', async () => {
  const fake = fakeProviders(() => {
    const error = new Error('goodreads answered an anti-bot challenge');
    error.code = 'GOODREADS_CHALLENGE';
    throw error;
  });

  await expect(resolveFormat(fake, [ISBN13])).rejects.toSatisfy((error) =>
      error instanceof FormatResolveError &&
      error.status === 502 &&
      error.code === 'ProviderUnavailable' &&
      /blocked the request/.test(error.message));
  // A genuine "no format" answer stays a 404 upstream; only a block is 502.
  expect(fake.calls).toEqual([ISBN13]);
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
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      isbn: ISBN13,
      format: 'Paperback',
      source: 'goodreads'
    });

    const unauthorized = await postFormat(base, { isbns: [ISBN10] }, '');
    expect(unauthorized.status).toBe(401);

    const invalid = await postFormat(base, { isbns: [] });
    expect(invalid.status).toBe(400);

    const missing = await postFormat(base, { isbns: [OTHER] });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('FormatNotFound');
  });

  const failing = fakeProviders(() => {
    throw new Error('upstream down');
  });
  await withAdminApi(failing, async (base) => {
    const response = await postFormat(base, { isbns: [ISBN13] });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('ProviderUnavailable');
  });
});

/** vitest has no predicate form of toThrow: capture the throw and assert on it. */
function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
