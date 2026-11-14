/**
 * Admin reporting queries.
 *
 * Every report is a fixed, read-only SELECT defined here. There is no
 * user-supplied SQL: report ids come from this registry and filter values are
 * bound parameters (the only interpolated fragment is an operator chosen from
 * a closed union, or a constant WHERE clause written below).
 *
 * Each report returns edition rows (or entity/identifier/outbox rows) plus a
 * stable order. `runReportFrom` appends LIMIT/OFFSET, runs the page query and
 * then the same SELECT wrapped in `count(*)`, so `total` is the full match
 * count. Rows are converted to JSON-safe values (Dates become ISO strings).
 *
 * No SvelteKit or environment imports: the route passes `catalogPool()` and
 * tests drive a scratch pool or a fake queryable.
 */

import type { Pool, PoolClient } from 'pg';
import type {
  ReportColumn,
  ReportParamSpec,
  ReportResponse,
  ReportRow,
  ReportSummary
} from '../../admin/types.ts';
import { likePattern } from '../catalog/sql.ts';

export type ReportQueryable = Pool | PoolClient;

export const REPORT_LIMIT_DEFAULT = 25;
export const REPORT_LIMIT_MAX = 100;
export const REPORT_OFFSET_MAX = 1_000_000_000;
/** Mirrors MAX_ATTEMPTS in the worker: at ten failures the row is parked. */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** A ready outbox row that has not been claimed for this long is overdue. */
export const OUTBOX_STALE_INTERVAL = '1 hour';

export class ReportQueryError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;

  constructor(status: number, message: string, code: string, field?: string) {
    super(message);
    this.name = 'ReportQueryError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

type AppliedParams = Record<string, string | number>;

type BuiltQuery = {
  text: string;
  values: Array<string | number | null>;
  /** The filters as applied, echoed to the caller. */
  applied: AppliedParams;
};

type ReportDefinition = {
  summary: ReportSummary;
  build: (raw: URLSearchParams) => BuiltQuery;
};

const AT_URI_COLUMN: ReportColumn = { key: 'uri', label: 'AT URI', format: 'at-uri' };
const RKEY_COLUMN: ReportColumn = { key: 'rkey', label: 'Rkey', format: 'text' };
const TITLE_COLUMN: ReportColumn = { key: 'title', label: 'Title', format: 'text' };
const INDEXED_COLUMN: ReportColumn = { key: 'indexed_at', label: 'Indexed', format: 'date' };

function editionColumns(...extra: ReportColumn[]): ReportColumn[] {
  return [AT_URI_COLUMN, RKEY_COLUMN, TITLE_COLUMN, ...extra];
}

/** Parameter keys other than limit/offset must be declared by the report. */
function assertOnly(raw: URLSearchParams, allowed: readonly string[]): void {
  for (const key of raw.keys()) {
    if (key === 'limit' || key === 'offset') continue;
    if (!allowed.includes(key)) {
      throw new ReportQueryError(
        400,
        `unsupported report parameter: ${key}`,
        'UnsupportedParameter',
        key
      );
    }
  }
}

function optionalText(raw: URLSearchParams, key: string, maxLength: number): string | undefined {
  const value = raw.get(key);
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > maxLength) {
    throw new ReportQueryError(
      400,
      `${key} must be at most ${maxLength} characters`,
      'InvalidParameter',
      key
    );
  }
  return trimmed;
}

function integerParam(
  raw: URLSearchParams,
  key: string,
  options: { min: number; max: number; defaultValue: number }
): number {
  const value = raw.get(key);
  if (value === null || value.trim() === '') return options.defaultValue;
  const text = value.trim();
  if (!/^-?[0-9]+$/.test(text)) {
    throw new ReportQueryError(400, `${key} must be an integer`, 'InvalidParameter', key);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new ReportQueryError(
      400,
      `${key} must be between ${options.min} and ${options.max}`,
      'InvalidParameter',
      key
    );
  }
  return parsed;
}

export type ReportPage = { limit: number; offset: number };

/** Shared pagination: limit 1–100 (default 25), offset up to 1e9 (default 0). */
export function parseReportPage(raw: URLSearchParams): ReportPage {
  return {
    limit: integerParam(raw, 'limit', {
      min: 1,
      max: REPORT_LIMIT_MAX,
      defaultValue: REPORT_LIMIT_DEFAULT
    }),
    offset: integerParam(raw, 'offset', {
      min: 0,
      max: REPORT_OFFSET_MAX,
      defaultValue: 0
    })
  };
}

// ── Edition reports ─────────────────────────────────────────────────────────

type EditionReportConfig = {
  id: string;
  title: string;
  description: string;
  /** Extra select-list entries appended after uri/rkey/title. Constants only. */
  select?: string;
  /** Constant JOIN clauses. */
  from?: string;
  /** Constant WHERE clause. No user input. */
  where: string;
  columns?: ReportColumn[];
  orderBy?: string;
};

function editionReport(config: EditionReportConfig): ReportDefinition {
  const select = config.select ? `, ${config.select}` : '';
  const from = config.from ? `\n       ${config.from}` : '';
  const orderBy = config.orderBy ?? 'e.indexed_at DESC, e.uri';
  const text = `SELECT e.uri, e.rkey, e.title, e.indexed_at${select}
       FROM editions e${from}
      WHERE ${config.where}
      ORDER BY ${orderBy}`;

  return {
    summary: {
      id: config.id,
      title: config.title,
      description: config.description,
      kind: 'editions',
      columns: editionColumns(...(config.columns ?? [INDEXED_COLUMN])),
      params: []
    },
    build(raw) {
      assertOnly(raw, []);
      return { text, values: [], applied: {} };
    }
  };
}

const COMPARISONS = ['eq', 'gte', 'lte'] as const;
export type IdentifierComparison = (typeof COMPARISONS)[number];

export type IdentifierCountFilters = {
  issuer: string | null;
  /** The trimmed, unescaped value filter as typed. */
  value: string | null;
  /** `%value%` with LIKE metacharacters escaped, ready for ILIKE. */
  pattern: string | null;
  comparison: IdentifierComparison;
  m: number;
};

export function parseIdentifierCountFilters(raw: URLSearchParams): IdentifierCountFilters {
  assertOnly(raw, ['issuer', 'value', 'comparison', 'm']);
  const issuer = optionalText(raw, 'issuer', 100) ?? null;
  const value = optionalText(raw, 'value', 200) ?? null;

  const comparisonText = (optionalText(raw, 'comparison', 8) ?? 'eq') as string;
  if (!COMPARISONS.includes(comparisonText as IdentifierComparison)) {
    throw new ReportQueryError(
      400,
      'comparison must be eq, gte or lte',
      'InvalidParameter',
      'comparison'
    );
  }
  const comparison = comparisonText as IdentifierComparison;

  return {
    issuer,
    value,
    pattern: value === null ? null : likePattern(value),
    comparison,
    m: integerParam(raw, 'm', { min: 0, max: 1_000_000, defaultValue: 0 })
  };
}

function comparisonOperator(comparison: IdentifierComparison): '=' | '>=' | '<=' {
  switch (comparison) {
    case 'eq':
      return '=';
    case 'gte':
      return '>=';
    case 'lte':
      return '<=';
  }
}

/**
 * Editions whose matching `edition_identifiers` row count satisfies
 * `count(i.*) <op> m`. The filters are applied inside the LEFT JOIN's ON
 * clause, so an edition with zero matching identifiers still yields a row with
 * `matching_identifiers = 0` (which is what `m=0` selects).
 */
export function identifierCountQuery(filters: IdentifierCountFilters): {
  text: string;
  values: Array<string | number | null>;
} {
  const text = `SELECT e.uri, e.rkey, e.title, e.indexed_at,
       count(i.*)::int AS matching_identifiers
       FROM editions e
       LEFT JOIN edition_identifiers i
         ON i.edition_uri = e.uri
        AND ($1::text IS NULL OR i.issuer = $1)
        AND ($2::text IS NULL OR i.value ILIKE $2 ESCAPE '\\')
      GROUP BY e.uri, e.rkey, e.title, e.indexed_at
     HAVING count(i.*) ${comparisonOperator(filters.comparison)} $3
      ORDER BY matching_identifiers DESC, e.indexed_at DESC, e.uri`;

  return { text, values: [filters.issuer, filters.pattern, filters.m] };
}

const identifierCountReport: ReportDefinition = {
  summary: {
    id: 'edition-identifier-count',
    title: 'Editions by identifier count',
    description:
      'Counts the edition_identifiers rows that match the optional issuer and value filters, ' +
      'then keeps editions whose count satisfies the comparison. With m=0 this lists editions ' +
      'that have no matching identifier at all. The value filter is a case-insensitive substring ' +
      'match with LIKE metacharacters escaped, never a regex or SQL expression.',
    kind: 'editions',
    columns: editionColumns({
      key: 'matching_identifiers',
      label: 'Matching identifiers',
      format: 'number'
    }, INDEXED_COLUMN),
    params: [
      {
        key: 'issuer',
        label: 'Issuer (exact)',
        kind: 'text',
        defaultValue: '',
        placeholder: 'isbn13'
      },
      {
        key: 'value',
        label: 'Value contains',
        kind: 'text',
        defaultValue: '',
        placeholder: '978'
      },
      {
        key: 'comparison',
        label: 'Comparison',
        kind: 'select',
        defaultValue: 'eq',
        options: [
          { value: 'eq', label: 'equals m' },
          { value: 'gte', label: 'at least m' },
          { value: 'lte', label: 'at most m' }
        ]
      },
      {
        key: 'm',
        label: 'Count m',
        kind: 'text',
        defaultValue: '0',
        placeholder: '0'
      }
    ]
  },
  build(raw) {
    const filters = parseIdentifierCountFilters(raw);
    const query = identifierCountQuery(filters);
    return {
      ...query,
      applied: {
        issuer: filters.issuer ?? '',
        value: filters.value ?? '',
        comparison: filters.comparison,
        m: filters.m
      }
    };
  }
};

// ── Contributor and publisher reports ───────────────────────────────────────

type EntityReportConfig = {
  id: string;
  title: string;
  description: string;
  table: 'contributors' | 'publishers';
  kind: 'contributors' | 'publishers';
};

function emptyIdentifiersReport(config: EntityReportConfig): ReportDefinition {
  const alias = config.table === 'contributors' ? 'c' : 'p';
  const text = `SELECT ${alias}.id::int AS id,
       ${alias}.name,
       ${alias}.at_uri,
       'none'::text AS identifier_status,
       CASE
         WHEN jsonb_typeof(${alias}.identifiers) = 'array'
           THEN jsonb_array_length(${alias}.identifiers)
         ELSE 0
       END::int AS identifier_count,
       ${alias}.created_at
       FROM ${config.table} ${alias}
      WHERE ${alias}.identifiers IS NULL
         OR jsonb_typeof(${alias}.identifiers) = 'null'
         OR (jsonb_typeof(${alias}.identifiers) = 'array'
             AND jsonb_array_length(${alias}.identifiers) = 0)
      ORDER BY ${alias}.created_at DESC, ${alias}.id`;

  return {
    summary: {
      id: config.id,
      title: config.title,
      description: config.description,
      kind: config.kind,
      columns: [
        { key: 'name', label: 'Name', format: 'text' },
        { key: 'at_uri', label: 'AT URI', format: 'at-uri' },
        { key: 'identifier_status', label: 'Identifier status', format: 'status' },
        { key: 'identifier_count', label: 'Identifiers', format: 'number' },
        { key: 'created_at', label: 'Created', format: 'date' }
      ],
      params: []
    },
    build(raw) {
      assertOnly(raw, []);
      return { text, values: [], applied: {} };
    }
  };
}

// ── Identifier pair report ──────────────────────────────────────────────────

const duplicateIdentifierReport: ReportDefinition = {
  summary: {
    id: 'duplicate-identifier-pairs',
    title: 'Duplicate identifier pairs',
    description:
      'Identifier (issuer, value) pairs attached to two or more editions. Each row lists every ' +
      'edition that carries the pair by canonical at-URI so the duplicates can be inspected or ' +
      'merged; the official identifier pair itself is not changed.',
    kind: 'identifier-pairs',
    columns: [
      { key: 'issuer', label: 'Issuer', format: 'text' },
      { key: 'value', label: 'Value', format: 'text' },
      { key: 'edition_count', label: 'Editions', format: 'number' },
      { key: 'editions', label: 'Editions (AT URIs)', format: 'edition-list' }
    ],
    params: []
  },
  build(raw) {
    assertOnly(raw, []);
    return {
      text: `SELECT i.issuer,
       i.value,
       count(DISTINCT i.edition_uri)::int AS edition_count,
       jsonb_agg(
         jsonb_build_object('uri', e.uri, 'rkey', e.rkey, 'title', e.title)
         ORDER BY e.uri
       ) AS editions
       FROM edition_identifiers i
       JOIN editions e ON e.uri = i.edition_uri
      GROUP BY i.issuer, i.value
     HAVING count(DISTINCT i.edition_uri) > 1
      ORDER BY edition_count DESC, i.issuer, i.value`,
      values: [],
      applied: {}
    };
  }
};

// ── Identifier shape-claim report ───────────────────────────────────────────

const identifierInfoReport: ReportDefinition = {
  summary: {
    id: 'edition-identifier-info',
    title: 'Identifier claims and publishers',
    description:
      "One row per edition identifier: what that identifier's own record says about format, " +
      'language, publication date, pages and description, plus the publisher entities it is ' +
      'linked to, with the edition it is attached to. Issuer, format and language compare ' +
      'exactly (format and language case-insensitively); value and publisher are escaped ' +
      'case-insensitive substrings. An identifier without a claim row still appears.',
    kind: 'editions',
    columns: editionColumns(
      { key: 'issuer', label: 'Issuer', format: 'text' },
      { key: 'value', label: 'Value', format: 'text' },
      { key: 'format', label: 'Format', format: 'text' },
      { key: 'language', label: 'Language', format: 'text' },
      { key: 'published_date', label: 'Published', format: 'text' },
      { key: 'pages', label: 'Pages', format: 'number' },
      { key: 'publisher', label: 'Publishers', format: 'text' },
      { key: 'description', label: 'Description (first 160)', format: 'text' }
    ),
    params: [
      {
        key: 'issuer',
        label: 'Issuer (exact)',
        kind: 'text',
        defaultValue: '',
        placeholder: 'isbn13'
      },
      {
        key: 'value',
        label: 'Value contains',
        kind: 'text',
        defaultValue: '',
        placeholder: '978'
      },
      {
        key: 'format',
        label: 'Format (exact)',
        kind: 'text',
        defaultValue: '',
        placeholder: 'hardcover'
      },
      {
        key: 'language',
        label: 'Language (exact)',
        kind: 'text',
        defaultValue: '',
        placeholder: 'en'
      },
      {
        key: 'publisher',
        label: 'Publisher contains',
        kind: 'text',
        defaultValue: '',
        placeholder: 'Penguin'
      }
    ]
  },
  build(raw) {
    assertOnly(raw, ['issuer', 'value', 'format', 'language', 'publisher']);
    const issuer = optionalText(raw, 'issuer', 100) ?? null;
    const value = optionalText(raw, 'value', 200) ?? null;
    const format = optionalText(raw, 'format', 100) ?? null;
    const language = optionalText(raw, 'language', 35) ?? null;
    const publisher = optionalText(raw, 'publisher', 300) ?? null;
    return {
      text: `SELECT e.uri, e.rkey, e.title, i.issuer, i.value,
       c.format, c.language, c.published_date, c.pages,
       COALESCE((
         SELECT string_agg(p.name, ' · ' ORDER BY ip.position)
           FROM edition_identifier_publishers ip
           JOIN publishers p ON p.id = ip.publisher_id
          WHERE ip.edition_uri = i.edition_uri
            AND ip.issuer = i.issuer
            AND ip.value = i.value
       ), '') AS publisher,
       left(c.description, 160) AS description
       FROM edition_identifiers i
       JOIN editions e ON e.uri = i.edition_uri
       LEFT JOIN edition_identifier_info c
         ON c.edition_uri = i.edition_uri AND c.issuer = i.issuer AND c.value = i.value
      WHERE ($1::text IS NULL OR i.issuer = $1)
        AND ($2::text IS NULL OR i.value ILIKE $2 ESCAPE '\\')
        AND ($3::text IS NULL OR lower(c.format) = lower($3))
        AND ($4::text IS NULL OR lower(c.language) = lower($4))
        AND ($5::text IS NULL OR EXISTS (
              SELECT 1 FROM edition_identifier_publishers ip
                JOIN publishers p ON p.id = ip.publisher_id
               WHERE ip.edition_uri = i.edition_uri
                 AND ip.issuer = i.issuer
                 AND ip.value = i.value
                 AND p.name ILIKE $5 ESCAPE '\\'
            ))
      ORDER BY e.indexed_at DESC, e.uri, i.issuer, i.value`,
      values: [
        issuer,
        value === null ? null : likePattern(value),
        format,
        language,
        publisher === null ? null : likePattern(publisher)
      ],
      applied: {
        issuer: issuer ?? '',
        value: value ?? '',
        format: format ?? '',
        language: language ?? '',
        publisher: publisher ?? ''
      }
    };
  }
};

// ── Outbox reports ──────────────────────────────────────────────────────────

const OUTBOX_COLUMNS: ReportColumn[] = [
  AT_URI_COLUMN,
  RKEY_COLUMN,
  TITLE_COLUMN,
  { key: 'collection', label: 'Collection', format: 'text' },
  { key: 'op', label: 'Op', format: 'status' },
  { key: 'attempts', label: 'Attempts', format: 'number' },
  { key: 'next_at', label: 'Next attempt', format: 'date' },
  { key: 'last_error', label: 'Last error', format: 'text' },
  { key: 'outbox_updated_at', label: 'Queued', format: 'date' }
];

type OutboxReportConfig = {
  id: string;
  title: string;
  description: string;
  where: string;
  orderBy: string;
  columns: ReportColumn[];
  /** Constant extra select-list entries, e.g. a computed stale reason. */
  select?: string;
};

function outboxReport(config: OutboxReportConfig): ReportDefinition {
  const extra = config.select ? `,
       ${config.select}` : '';
  const text = `SELECT e.uri, e.rkey, e.title, o.collection, o.op, o.attempts,
       o.next_at, o.claimed_at, o.last_error,
       o.updated_at AS outbox_updated_at${extra}
       FROM pds_outbox o
       JOIN editions e ON e.uri = o.uri
      WHERE ${config.where}
      ORDER BY ${config.orderBy}`;

  return {
    summary: {
      id: config.id,
      title: config.title,
      description: config.description,
      kind: 'outbox',
      columns: config.columns,
      params: []
    },
    build(raw) {
      assertOnly(raw, []);
      return { text, values: [], applied: {} };
    }
  };
}

// ── Registry ────────────────────────────────────────────────────────────────

export const REPORTS: readonly ReportDefinition[] = [
  editionReport({
    id: 'editions-missing-cover',
    title: 'Editions missing a cover',
    description: 'Editions whose cover_url is NULL, empty or whitespace only.',
    where: "e.cover_url IS NULL OR btrim(e.cover_url) = ''"
  }),
  identifierCountReport,
  emptyIdentifiersReport({
    id: 'contributors-missing-identifiers',
    title: 'Contributors with no identifiers',
    description:
      'Contributor rows whose identifiers JSONB is SQL NULL, JSON null or an empty array. Rows ' +
      'without an at_uri are included too, because an unminted contributor record still needs ' +
      'identifier data.',
    table: 'contributors',
    kind: 'contributors'
  }),
  emptyIdentifiersReport({
    id: 'publishers-missing-identifiers',
    title: 'Publishers with no identifiers',
    description:
      'Publisher rows whose identifiers JSONB is SQL NULL, JSON null or an empty array, ' +
      'including rows that have not been minted an at_uri yet.',
    table: 'publishers',
    kind: 'publishers'
  }),
  editionReport({
    id: 'editions-missing-description',
    title: 'Editions missing a description',
    description:
      'Editions where no identifier records a description: no edition_identifier_info row of ' +
      'the edition has a non-blank description.',
    where:
      'NOT EXISTS (SELECT 1 FROM edition_identifier_info i ' +
      'WHERE i.edition_uri = e.uri ' +
      "AND i.description IS NOT NULL AND btrim(i.description) <> '')"
  }),
  editionReport({
    id: 'editions-missing-language',
    title: 'Editions missing a language',
    description:
      'Editions where no identifier records a language: no edition_identifier_info row of the ' +
      'edition has a non-blank language.',
    where:
      'NOT EXISTS (SELECT 1 FROM edition_identifier_info i ' +
      'WHERE i.edition_uri = e.uri ' +
      "AND i.language IS NOT NULL AND btrim(i.language) <> '')"
  }),
  editionReport({
    id: 'editions-missing-pages',
    title: 'Editions missing a page count',
    description: 'Editions where no identifier records a page count.',
    where:
      'NOT EXISTS (SELECT 1 FROM edition_identifier_info i ' +
      'WHERE i.edition_uri = e.uri AND i.pages IS NOT NULL)'
  }),
  editionReport({
    id: 'editions-missing-published-date',
    title: 'Editions missing a published date',
    description:
      'Editions where no identifier records a publication date: no edition_identifier_info ' +
      'row of the edition has a non-blank published_date.',
    where:
      'NOT EXISTS (SELECT 1 FROM edition_identifier_info i ' +
      'WHERE i.edition_uri = e.uri ' +
      "AND i.published_date IS NOT NULL AND btrim(i.published_date) <> '')"
  }),
  editionReport({
    id: 'editions-without-contributors',
    title: 'Editions with no contributors',
    description: 'Editions that have no edition_contributors row.',
    where: 'NOT EXISTS (SELECT 1 FROM edition_contributors ec WHERE ec.edition_uri = e.uri)'
  }),
  editionReport({
    id: 'editions-without-publishers',
    title: 'Editions with no publishers',
    description: 'Editions where no identifier is linked to a publisher.',
    where:
      'NOT EXISTS (SELECT 1 FROM edition_identifier_publishers ip WHERE ip.edition_uri = e.uri)'
  }),
  editionReport({
    id: 'editions-without-cid',
    title: 'Editions with no published CID',
    description:
      'Editions that have no pds_cids row: their record has not been published to the PDS, or ' +
      'the publish state is unknown.',
    from: 'LEFT JOIN pds_cids p ON p.uri = e.uri',
    where: 'p.uri IS NULL'
  }),
  duplicateIdentifierReport,
  identifierInfoReport,
  outboxReport({
    id: 'outbox-pending-editions',
    title: 'Editions in the publish outbox',
    description:
      'Edition record rows currently queued in pds_outbox, with their operation, attempt count ' +
      'and next scheduled attempt. Entity records (contributors, publishers) are not included.',
    where: 'TRUE',
    orderBy: 'o.next_at ASC, o.uri',
    columns: OUTBOX_COLUMNS
  }),
  outboxReport({
    id: 'outbox-stale-editions',
    title: 'Editions with a stale outbox row',
    description:
      `Edition outbox rows that are parked after ${OUTBOX_MAX_ATTEMPTS} failed attempts, or ` +
      `whose next attempt is more than ${OUTBOX_STALE_INTERVAL} overdue.`,
    where: `o.attempts >= ${OUTBOX_MAX_ATTEMPTS} OR o.next_at < now() - interval '${OUTBOX_STALE_INTERVAL}'`,
    orderBy: 'o.attempts DESC, o.next_at ASC, o.uri',
    columns: [
      ...OUTBOX_COLUMNS,
      { key: 'stale_reason', label: 'Stale reason', format: 'status' }
    ],
    select: `CASE WHEN o.attempts >= ${OUTBOX_MAX_ATTEMPTS} THEN 'parked' ELSE 'overdue' END AS stale_reason`
  })
];

/** The registry as it is serialized to the browser. */
export function reportSummaries(): ReportSummary[] {
  return REPORTS.map((definition) => definition.summary);
}

export function reportById(id: string): ReportDefinition | undefined {
  return REPORTS.find((definition) => definition.summary.id === id);
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    const record: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) record[key] = jsonSafe(nested);
    return record;
  }
  return value;
}

/**
 * Run one registered report with validated filters and pagination.
 *
 * Throws `ReportQueryError` (404 unknown report, 400 invalid filter) before a
 * query is sent. Database failures propagate so the route can answer 503.
 */
export async function runReportFrom(
  client: ReportQueryable,
  id: string,
  raw: URLSearchParams
): Promise<ReportResponse> {
  const definition = reportById(id);
  if (!definition) {
    throw new ReportQueryError(404, `unknown report: ${id}`, 'UnknownReport');
  }

  const { limit, offset } = parseReportPage(raw);
  const built = definition.build(raw);
  const values = [...built.values, limit, offset];
  const limitIndex = values.length - 1;
  const offsetIndex = values.length;

  const page = await client.query<ReportRow>(
    `${built.text} LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    values
  );
  const counted = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM (${built.text}) report_rows`,
    built.values
  );

  return {
    report: definition.summary,
    params: built.applied,
    rows: page.rows.map((row) => jsonSafe(row) as ReportRow),
    total: counted.rows[0]?.total ?? 0,
    limit,
    offset
  };
}
