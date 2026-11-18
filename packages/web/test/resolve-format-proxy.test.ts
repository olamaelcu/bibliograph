import { expect, test } from 'vitest';

import { readFileSync } from 'node:fs';

import {
  FormatResolutionError,
  proxyFormatResolution
} from '../src/lib/server/admin/format-resolution.ts';
import type { Identifier } from '../src/lib/admin/types.ts';

const PERSISTED: Identifier[] = [
  { issuer: 'isbn13', value: '9780306406157' },
  { issuer: 'isbn10', value: '0306406152' },
  { issuer: 'oclc', value: '12345' }
];

function recorder(result: unknown = { status: 200, payload: { format: 'Paperback' } }) {
  const calls: Array<{ isbns: string[] }> = [];
  return {
    calls,
    postWorker: async (body: { isbns: string[] }) => {
      calls.push(body);
      return result as { status: number; payload: unknown };
    }
  };
}

test('uses form ISBNs, normalises/dedupes them, and never loads the persisted edition', async () => {
  const worker = recorder();
  let loaded = false;
  const result = await proxyFormatResolution({
    body: { isbns: ['0-306-40615-2', '9780306406157', 'not-an-isbn', 42] },
    loadIdentifiers: async () => {
      loaded = true;
      return PERSISTED;
    },
    postWorker: worker.postWorker
  });

  expect(loaded).toBe(false);
  expect(worker.calls).toEqual([{ isbns: ['9780306406157'] }]);
  expect(result).toEqual({ status: 200, payload: { format: 'Paperback' } });
});

test('omitting isbns loads only persisted ISBN identifiers', async () => {
  const worker = recorder();
  let loads = 0;
  await proxyFormatResolution({
    body: {},
    loadIdentifiers: async () => {
      loads += 1;
      return PERSISTED;
    },
    postWorker: worker.postWorker
  });

  expect(loads).toBe(1);
  expect(worker.calls).toEqual([{ isbns: ['9780306406157'] }]);
});

test('returns 400 when no valid ISBN is available from either source', async () => {
  await expect(proxyFormatResolution({
      body: { isbns: ['nope', '9780306406158'] },
      loadIdentifiers: async () => PERSISTED,
      postWorker: async () => ({ status: 200, payload: null })
    })).rejects.toSatisfy((error) =>
      error instanceof FormatResolutionError && error.status === 400 && error.code === 'NoIsbns');

  await expect(proxyFormatResolution({
      body: {},
      loadIdentifiers: async () => [{ issuer: 'oclc', value: '123' }],
      postWorker: async () => ({ status: 200, payload: null })
    })).rejects.toSatisfy((error) =>
      error instanceof FormatResolutionError && error.status === 400 && error.code === 'NoIsbns');
});

test('returns 400 for a non-array isbns value and 404 for a missing edition', async () => {
  await expect(proxyFormatResolution({
      body: { isbns: null },
      loadIdentifiers: async () => PERSISTED,
      postWorker: async () => ({ status: 200, payload: null })
    })).rejects.toSatisfy((error) =>
      error instanceof FormatResolutionError &&
      error.status === 400 &&
      error.code === 'InvalidIsbns');

  await expect(proxyFormatResolution({
      body: {},
      loadIdentifiers: async () => null,
      postWorker: async () => ({ status: 200, payload: null })
    })).rejects.toSatisfy((error) =>
      error instanceof FormatResolutionError && error.status === 404 && error.code === 'NotFound');
});

test('passes the worker status and payload through unchanged', async () => {
  const workerPayload = { error: 'FormatNotFound', message: 'no format' };
  const result = await proxyFormatResolution({
    body: { isbns: ['0306406152'] },
    loadIdentifiers: async () => PERSISTED,
    postWorker: async () => ({ status: 404, payload: workerPayload })
  });
  expect(result).toEqual({ status: 404, payload: workerPayload });
});

test('the resolve-format route requires admin and proxies the worker status', () => {
  const source = readFileSync(
    new URL(
      '../src/routes/admin/api/editions/[id]/resolve-format/+server.ts',
      import.meta.url
    ),
    'utf8'
  );
  expect(source).toMatch(/requireAdmin\(cookies\)/);
  expect(source).toMatch(/loadEditionForEdit\(catalogPool\(\), params\.id\)/);
  expect(source).toMatch(/workerAdminPost\('\/resolve-format', workerBody\)/);
  expect(source).toMatch(/status: result\.status/);
  expect(source).not.toMatch(/pds_outbox/);
});
