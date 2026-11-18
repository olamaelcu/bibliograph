import { expect, test } from 'vitest';

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
    expect(error instanceof ReportQueryError, `expected ReportQueryError, got ${String(error)}`).toBeTruthy();
    return error;
  }
  throw new Error('expected the call to throw');
}

test('registry exposes every curated report with unique ids', () => {
  const summaries = reportSummaries();
  expect(summaries.length).toBe(REPORTS.length);
  expect(summaries.map((summary) => summary.id).sort()).toEqual([
      'contributors-missing-identifiers',
      'duplicate-identifier-pairs',
      'edition-identifier-count',
      'edition-identifier-info',
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
    ]);
  expect(new Set(summaries.map((summary) => summary.id)).size).toBe(summaries.length);
  for (const summary of summaries) {
    expect(summary.title.length > 0, `${summary.id} needs a title`).toBeTruthy();
    expect(summary.description.length > 0, `${summary.id} needs a description`).toBeTruthy();
    expect(summary.columns.length > 0, `${summary.id} needs columns`).toBeTruthy();
    for (const column of summary.columns) {
      expect(column.key.length > 0).toBeTruthy();
      expect(column.label.length > 0).toBeTruthy();
    }
  }
});

test('edition reports expose the canonical AT URI, rkey and title columns', () => {
  for (const summary of reportSummaries().filter((report) => report.kind === 'editions')) {
    const keys = summary.columns.map((column) => column.key);
    expect(keys.includes('uri'), `${summary.id} must carry uri`).toBeTruthy();
    expect(keys.includes('rkey'), `${summary.id} must carry rkey`).toBeTruthy();
    expect(keys.includes('title'), `${summary.id} must carry title`).toBeTruthy();
    expect(summary.columns.find((column) => column.key === 'uri')?.format).toBe('at-uri');
  }
});

test('the identifier report declares issuer, value, comparison and m filters', () => {
  const summary = reportSummaries().find((report) => report.id === 'edition-identifier-count');
  expect(summary).toBeTruthy();
  expect(summary.params.map((param) => param.key)).toEqual(['issuer', 'value', 'comparison', 'm']);
  expect(summary.params.find((param) => param.key === 'comparison')?.options?.map((option) => option.value)).toEqual(['eq', 'gte', 'lte']);
});

test('pagination defaults and bounds', () => {
  expect(parseReportPage(new URLSearchParams(''))).toEqual({
    limit: REPORT_LIMIT_DEFAULT,
    offset: 0
  });
  expect(parseReportPage(new URLSearchParams('limit=100&offset=7'))).toEqual({
    limit: 100,
    offset: 7
  });
  for (const query of ['limit=0', 'limit=101', 'limit=2.5', 'limit=abc']) {
    const error = errorFrom(() => parseReportPage(new URLSearchParams(query)));
    expect(error.status).toBe(400);
    expect(error.code).toBe('InvalidParameter');
    expect(error.field).toBe('limit');
  }
  for (const query of ['offset=-1', 'offset=1000000001', 'offset=1.5']) {
    const error = errorFrom(() => parseReportPage(new URLSearchParams(query)));
    expect(error.status).toBe(400);
    expect(error.field).toBe('offset');
  }
});

test('unknown reports answer 404 and unsupported parameters answer 400', async () => {
  const { client } = fakeClient([], 0);
  await expect(() => runReportFrom(client, 'not-a-report', new URLSearchParams(''))).rejects.toSatisfy((error: unknown) =>
      error instanceof ReportQueryError && error.status === 404 && error.code === 'UnknownReport');

  const error = await runReportFrom(
    client,
    'editions-missing-cover',
    new URLSearchParams('foo=1')
  ).then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error instanceof ReportQueryError).toBeTruthy();
  expect(error.status).toBe(400);
  expect(error.code).toBe('UnsupportedParameter');
  expect(error.field).toBe('foo');

  await expect(() => runReportFrom(client, 'edition-identifier-count', new URLSearchParams('count=1'))).rejects.toSatisfy((caught: unknown) =>
      caught instanceof ReportQueryError && caught.code === 'UnsupportedParameter');
});

test('identifier filters validate the comparison and count', () => {
  expect(parseIdentifierCountFilters(new URLSearchParams(''))).toEqual({
    issuer: null,
    value: null,
    pattern: null,
    comparison: 'eq',
    m: 0
  });

  const parsed = parseIdentifierCountFilters(
    new URLSearchParams('issuer=isbn13&value=978&comparison=gte&m=2')
  );
  expect(parsed.issuer).toBe('isbn13');
  expect(parsed.value).toBe('978');
  expect(parsed.pattern).toBe('%978%');
  expect(parsed.comparison).toBe('gte');
  expect(parsed.m).toBe(2);

  for (const query of ['comparison=gt', 'comparison=ne']) {
    const error = errorFrom(() => parseIdentifierCountFilters(new URLSearchParams(query)));
    expect(error.status).toBe(400);
    expect(error.field).toBe('comparison');
  }
  for (const query of ['m=-1', 'm=1.5', 'm=abc', 'm=1000001']) {
    const error = errorFrom(() => parseIdentifierCountFilters(new URLSearchParams(query)));
    expect(error.status).toBe(400);
    expect(error.field).toBe('m');
  }
  const longIssuer = errorFrom(() =>
    parseIdentifierCountFilters(new URLSearchParams(`issuer=${'x'.repeat(101)}`))
  );
  expect(longIssuer.field).toBe('issuer');
  const longValue = errorFrom(() =>
    parseIdentifierCountFilters(new URLSearchParams(`value=${'x'.repeat(201)}`))
  );
  expect(longValue.field).toBe('value');
});

test('identifier report binds parameters and interpolates only a closed operator', async () => {
  const { client, calls } = fakeClient([], 0);
  const result = await runReportFrom(
    client,
    'edition-identifier-count',
    new URLSearchParams('issuer=isbn13&value=978%25_&comparison=gte&m=2&limit=5&offset=10')
  );

  expect(calls.length).toBe(2);
  const page = calls[0];
  expect(page).toBeTruthy();
  expect(page.sql).toMatch(/HAVING count\(i\.\*\) >= \$3/);
  expect(page.sql).toMatch(/LIMIT \$4 OFFSET \$5/);
  expect(page.values).toEqual(['isbn13', '%978\\%\\_%', 2, 5, 10]);

  const counted = calls[1];
  expect(counted).toBeTruthy();
  expect(counted.sql).toMatch(/^SELECT count\(\*\)::int AS total FROM \(/);
  expect(counted.values).toEqual(['isbn13', '%978\\%\\_%', 2]);
  expect(result.params).toEqual({
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
    expect(filters.pattern).toBeTruthy();
    // Every metacharacter in the input is preceded by one escape backslash.
    const literal = filters.pattern.slice(1, -1);
    expect(literal.replace(/\\([\\%_])/g, '$1')).toBe(raw);
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

  expect(result.total).toBe(42);
  expect(result.limit).toBe(2);
  expect(result.offset).toBe(4);
  expect(result.report.id).toBe('editions-missing-cover');
  expect(result.params).toEqual({});
  expect(result.rows.length).toBe(1);
  expect(result.rows[0]?.indexed_at).toBe('2026-01-02T03:04:05.000Z');
  expect(calls[0]?.values).toEqual([2, 4]);
  expect(calls[0]?.sql.endsWith('LIMIT $1 OFFSET $2')).toBe(true);
});

test('every report is a read-only SELECT with a stable order', async () => {
  const { client, calls } = fakeClient([], 0);
  for (const summary of reportSummaries()) {
    await runReportFrom(client, summary.id, new URLSearchParams('limit=1&offset=0'));
    const call = calls[calls.length - 2];
    expect(call).toBeTruthy();
    expect(call.sql, `${summary.id} must be a SELECT`).toMatch(/^\s*SELECT /);
    expect(call.sql, `${summary.id} must order its rows`).toMatch(/\bORDER BY\b/);
    expect(call.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/i);
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
    expect(source).toMatch(/requireAdmin\(cookies\)/);
    expect(source).toMatch(/export const GET/);
    expect(source).not.toMatch(/export const (POST|PUT|PATCH|DELETE)/);
  }
});
