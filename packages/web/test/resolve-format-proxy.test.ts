import test from 'node:test';
import assert from 'node:assert/strict';
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

  assert.equal(loaded, false);
  assert.deepEqual(worker.calls, [{ isbns: ['9780306406157'] }]);
  assert.deepEqual(result, { status: 200, payload: { format: 'Paperback' } });
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

  assert.equal(loads, 1);
  assert.deepEqual(worker.calls, [{ isbns: ['9780306406157'] }]);
});

test('returns 400 when no valid ISBN is available from either source', async () => {
  await assert.rejects(
    proxyFormatResolution({
      body: { isbns: ['nope', '9780306406158'] },
      loadIdentifiers: async () => PERSISTED,
      postWorker: async () => ({ status: 200, payload: null })
    }),
    (error) =>
      error instanceof FormatResolutionError && error.status === 400 && error.code === 'NoIsbns'
  );

  await assert.rejects(
    proxyFormatResolution({
      body: {},
      loadIdentifiers: async () => [{ issuer: 'oclc', value: '123' }],
      postWorker: async () => ({ status: 200, payload: null })
    }),
    (error) =>
      error instanceof FormatResolutionError && error.status === 400 && error.code === 'NoIsbns'
  );
});

test('returns 400 for a non-array isbns value and 404 for a missing edition', async () => {
  await assert.rejects(
    proxyFormatResolution({
      body: { isbns: null },
      loadIdentifiers: async () => PERSISTED,
      postWorker: async () => ({ status: 200, payload: null })
    }),
    (error) =>
      error instanceof FormatResolutionError &&
      error.status === 400 &&
      error.code === 'InvalidIsbns'
  );

  await assert.rejects(
    proxyFormatResolution({
      body: {},
      loadIdentifiers: async () => null,
      postWorker: async () => ({ status: 200, payload: null })
    }),
    (error) =>
      error instanceof FormatResolutionError && error.status === 404 && error.code === 'NotFound'
  );
});

test('passes the worker status and payload through unchanged', async () => {
  const workerPayload = { error: 'FormatNotFound', message: 'no format' };
  const result = await proxyFormatResolution({
    body: { isbns: ['0306406152'] },
    loadIdentifiers: async () => PERSISTED,
    postWorker: async () => ({ status: 404, payload: workerPayload })
  });
  assert.deepEqual(result, { status: 404, payload: workerPayload });
});

test('the resolve-format route requires admin and proxies the worker status', () => {
  const source = readFileSync(
    new URL(
      '../src/routes/admin/api/editions/[id]/resolve-format/+server.ts',
      import.meta.url
    ),
    'utf8'
  );
  assert.match(source, /requireAdmin\(cookies\)/);
  assert.match(source, /loadEditionForEdit\(catalogPool\(\), params\.id\)/);
  assert.match(source, /workerAdminPost\('\/resolve-format', workerBody\)/);
  assert.match(source, /status: result\.status/);
  assert.doesNotMatch(source, /pds_outbox/);
});
