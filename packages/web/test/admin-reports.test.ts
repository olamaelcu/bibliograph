import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REPORT_LIMIT_DEFAULT,
  REPORTS,
  ReportQueryError,
  parseIdentifierCountFilters,
  parseReportPage,
  reportSummaries,
  runReportFrom,
  type ReportQueryable
} from '../src/lib/server/admin/reports.ts';

/**
 * Registry, validation and pagination without a database. The SQL itself is
 * exercised against a scratch schema in admin-reports-db.test.ts.
 */

type QueryCall = { sql: string; values?: unknown[] };

function fakeClient(pageRows: Array<Record<string, unknown>>, total: number): {
  client: ReportQueryable;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.trimStart().startsWith('SELECT count(*)')) {
        return { rows: [{ total }], rowCount: 1 };
      }
      return { rows: pageRows, rowCount: pageRows.length };
    }
  } as unknown as ReportQueryable;
  return { client, calls };
}

function errorFrom(run: () => unknown): ReportQueryError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ReportQueryError, `expected ReportQueryError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to throw');
}

test('registry exposes every curated report with unique ids', () => {
  const summaries = reportSummaries();
  assert.equal(summaries.length, REPORTS.length);
  assert.deepEqual(
    summaries.map((summary) => summary.id).sort(),
    [
      'contributors-missing-identifiers',
      'duplicate-identifier-pairs',
      'edition-identifier-count',
      'editions-missing-cover',
      'editions-missing-description',
      'editions-missing-language',
      'editions-missing-pages',
      'editions-missing-published-date',
      'editions-without-cid',
      'editions-without-contributors',
      'editions-without-publishers',
      'outbox-pending-editions',
      'outbox-stale-editions',
      'publishers-missing-identifiers'
    ]
  );
  assert.equal(new Set(summaries.map((summary) => summary.id)).size, summaries.length);
  for (const summary of summaries) {
    assert.ok(summary.title.length > 0, `${summary.id} needs a title`);
    assert.ok(summary.description.length > 0, `${summary.id} needs a description`);
    assert.ok(summary.columns.length > 0, `${summary.id} needs columns`);
    for (const column of summary.columns) {
      assert.ok(column.key.length > 0);
      assert.ok(column.label.length > 0);
    }
  }
});

test('edition reports expose the canonical AT URI, rkey and title columns', () => {
  for (const summary of reportSummaries().filter((report) => report.kind === 'editions')) {
    const keys = summary.columns.map((column) => column.key);
    assert.ok(keys.includes('uri'), `${summary.id} must carry uri`);
    assert.ok(keys.includes('rkey'), `${summary.id} must carry rkey`);
    assert.ok(keys.includes('title'), `${summary.id} must carry title`);
    assert.equal(summary.columns.find((column) => column.key === 'uri')?.format, 'at-uri');
  }
});

test('the identifier report declares issuer, value, comparison and m filters', () => {
  const summary = reportSummaries().find((report) => report.id === 'edition-identifier-count');
  assert.ok(summary);
  assert.deepEqual(
    summary.params.map((param) => param.key),
    ['issuer', 'value', 'comparison', 'm']
  );
  assert.deepEqual(
    summary.params.find((param) => param.key === 'comparison')?.options?.map((option) => option.value),
    ['eq', 'gte', 'lte']
  );
});

test('pagination defaults and bounds', () => {
  assert.deepEqual(parseReportPage(new URLSearchParams('')), {
    limit: REPORT_LIMIT_DEFAULT,
    offset: 0
  });
  assert.deepEqual(parseReportPage(new URLSearchParams('limit=100&offset=7')), {
    limit: 100,
    offset: 7
  });
  for (const query of ['limit=0', 'limit=101', 'limit=2.5', 'limit=abc']) {
    const error = errorFrom(() => parseReportPage(new URLSearchParams(query)));
    assert.equal(error.status, 400);
    assert.equal(error.code, 'InvalidParameter');
    assert.equal(error.field, 'limit');
  }
  for (const query of ['offset=-1', 'offset=1000000001', 'offset=1.5']) {
    const error = errorFrom(() => parseReportPage(new URLSearchParams(query)));
    assert.equal(error.status, 400);
    assert.equal(error.field, 'offset');
  }
});

test('unknown reports answer 404 and unsupported parameters answer 400', async () => {
  const { client } = fakeClient([], 0);
  await assert.rejects(
    () => runReportFrom(client, 'not-a-report', new URLSearchParams('')),
    (error: unknown) =>
      error instanceof ReportQueryError && error.status === 404 && error.code === 'UnknownReport'
  );

  const error = await runReportFrom(
    client,
    'editions-missing-cover',
    new URLSearchParams('foo=1')
  ).then(
    () => null,
    (caught: unknown) => caught
  );
  assert.ok(error instanceof ReportQueryError);
  assert.equal(error.status, 400);
  assert.equal(error.code, 'UnsupportedParameter');
  assert.equal(error.field, 'foo');

  await assert.rejects(
    () => runReportFrom(client, 'edition-identifier-count', new URLSearchParams('count=1')),
    (caught: unknown) =>
      caught instanceof ReportQueryError && caught.code === 'UnsupportedParameter'
  );
});

test('identifier filters validate the comparison and count', () => {
  assert.deepEqual(parseIdentifierCountFilters(new URLSearchParams('')), {
    issuer: null,
    value: null,
    pattern: null,
    comparison: 'eq',
    m: 0
  });

  const parsed = parseIdentifierCountFilters(
    new URLSearchParams('issuer=isbn13&value=978&comparison=gte&m=2')
  );
  assert.equal(parsed.issuer, 'isbn13');
  assert.equal(parsed.value, '978');
  assert.equal(parsed.pattern, '%978%');
  assert.equal(parsed.comparison, 'gte');
  assert.equal(parsed.m, 2);

  for (const query of ['comparison=gt', 'comparison=ne']) {
    const error = errorFrom(() => parseIdentifierCountFilters(new URLSearchParams(query)));
    assert.equal(error.status, 400);
    assert.equal(error.field, 'comparison');
  }
  for (const query of ['m=-1', 'm=1.5', 'm=abc', 'm=1000001']) {
    const error = errorFrom(() => parseIdentifierCountFilters(new URLSearchParams(query)));
    assert.equal(error.status, 400);
    assert.equal(error.field, 'm');
  }
  const longIssuer = errorFrom(() =>
    parseIdentifierCountFilters(new URLSearchParams(`issuer=${'x'.repeat(101)}`))
  );
  assert.equal(longIssuer.field, 'issuer');
  const longValue = errorFrom(() =>
    parseIdentifierCountFilters(new URLSearchParams(`value=${'x'.repeat(201)}`))
  );
  assert.equal(longValue.field, 'value');
});

test('identifier report binds parameters and interpolates only a closed operator', async () => {
  const { client, calls } = fakeClient([], 0);
  const result = await runReportFrom(
    client,
    'edition-identifier-count',
    new URLSearchParams('issuer=isbn13&value=978%25_&comparison=gte&m=2&limit=5&offset=10')
  );

  assert.equal(calls.length, 2);
  const page = calls[0];
  assert.ok(page);
  assert.match(page.sql, /HAVING count\(i\.\*\) >= \$3/);
  assert.match(page.sql, /LIMIT \$4 OFFSET \$5/);
  assert.deepEqual(page.values, ['isbn13', '%978\\%\\_%', 2, 5, 10]);

  const counted = calls[1];
  assert.ok(counted);
  assert.match(counted.sql, /^SELECT count\(\*\)::int AS total FROM \(/);
  assert.deepEqual(counted.values, ['isbn13', '%978\\%\\_%', 2]);
  assert.deepEqual(result.params, {
    issuer: 'isbn13',
    value: '978%_',
    comparison: 'gte',
    m: 2
  });
});

test('LIKE metacharacters in the value filter are escaped, never wildcards', () => {
  for (const raw of ['100%', 'a_b', 'back\\slash']) {
    const filters = parseIdentifierCountFilters(
      new URLSearchParams({ value: raw, comparison: 'eq', m: '1' })
    );
    assert.ok(filters.pattern);
    // Every metacharacter in the input is preceded by one escape backslash.
    const literal = filters.pattern.slice(1, -1);
    assert.equal(literal.replace(/\\([\\%_])/g, '$1'), raw);
  }
});

test('a report page is JSON-safe, echoes pagination and reports the full total', async () => {
  const indexed = new Date('2026-01-02T03:04:05.000Z');
  const { client, calls } = fakeClient(
    [
      {
        uri: 'at://did:plc:test/community.lexicon.media.book.edition/3abc',
        rkey: '3abc',
        title: 'Title',
        indexed_at: indexed
      }
    ],
    42
  );

  const result = await runReportFrom(
    client,
    'editions-missing-cover',
    new URLSearchParams('limit=2&offset=4')
  );

  assert.equal(result.total, 42);
  assert.equal(result.limit, 2);
  assert.equal(result.offset, 4);
  assert.equal(result.report.id, 'editions-missing-cover');
  assert.deepEqual(result.params, {});
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.indexed_at, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(calls[0]?.values, [2, 4]);
  assert.equal(calls[0]?.sql.endsWith('LIMIT $1 OFFSET $2'), true);
});

test('every report is a read-only SELECT with a stable order', async () => {
  const { client, calls } = fakeClient([], 0);
  for (const summary of reportSummaries()) {
    await runReportFrom(client, summary.id, new URLSearchParams('limit=1&offset=0'));
    const call = calls[calls.length - 2];
    assert.ok(call);
    assert.match(call.sql, /^\s*SELECT /, `${summary.id} must be a SELECT`);
    assert.match(call.sql, /\bORDER BY\b/, `${summary.id} must order its rows`);
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/i);
  }
});

// The routes cannot be imported in a plain node test because auth.ts reads
// SvelteKit's `$env`; assert the wiring statically instead.
test('report routes require the admin cookie and expose only GET', () => {
  const registry = readFileSync(
    new URL('../src/routes/admin/api/reports/+server.ts', import.meta.url),
    'utf8'
  );
  const results = readFileSync(
    new URL('../src/routes/admin/api/reports/[report]/+server.ts', import.meta.url),
    'utf8'
  );

  for (const source of [registry, results]) {
    assert.match(source, /requireAdmin\(cookies\)/);
    assert.match(source, /export const GET/);
    assert.doesNotMatch(source, /export const (POST|PUT|PATCH|DELETE)/);
  }
});
