import type { Logger } from 'pino';
import { and, asc, desc, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db as defaultDb } from '../db/index';
import { editions, works, contributors, publishers } from '../db/schema';
import { PUBLISHER_DID } from '../did';
import { pgLanguageVariants } from './language';
import { identifierFromLegacy, identifierFromString, type LegacyIdentifier } from '../identifiers';
import type {
  SearchQuery,
  SearchResult,
  EditionItem,
  WorkItem,
  ContributorItem,
  PublisherItem,
  Identifier,
  ContributionEntry,
} from './types';

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CURSOR_VERSION = 2;

type PostgresCursor = { v: 1 | 2; src: 'postgres'; t: string; u: string };

// The lexicon caps `cursor` at 256 chars; a raw URI inside the payload used
// to push cursors over the limit for long collectors (hit in production
// 2026-11-11, client got 400 InvalidQuery from the `.cursor` field). Deflate
// shrinks the payload to ~150 bytes; legacy plain-text cursors still decode
// via the inflate failure fallback.
function encodeCursor(indexedAt: Date, uri: string): string {
  return deflateRawSync(Buffer.from(JSON.stringify({ v: CURSOR_VERSION, src: 'postgres', t: indexedAt.toISOString(), u: uri } satisfies PostgresCursor))).toString('base64url');
}

function decodeCursor(cursor: string): PostgresCursor | null {
  const raw = Buffer.from(cursor, 'base64url');
  let json: Buffer | undefined;
  try { json = inflateRawSync(raw); } catch { json = raw; }
  try {
    const parsed = JSON.parse(json.toString());
    if ((parsed.v !== 1 && parsed.v !== 2) || parsed.src !== 'postgres') return null;
    return parsed as PostgresCursor;
  } catch { return null; }
}

function contributionFromJson(c: { subject: { uri: string; cid: string }; role: string }): ContributionEntry {
  return { subject: c.subject, role: c.role };
}

/**
 * Stored identifiers are canonical after the migration; rows written before it
 * still hold `{ uri, resource }`, so the legacy shape is converted on read
 * rather than trusted.
 */
function identFromJson(i: Identifier | LegacyIdentifier): Identifier {
  if ('type' in i && 'value' in i) {
    return i.url === undefined ? { type: i.type, value: i.value } : { type: i.type, value: i.value, url: i.url };
  }
  return identifierFromLegacy(i);
}

/**
 * Stored edition row → `EditionItem`. Exported so the XRPC handlers that query
 * editions directly (exact-identifier resolution) map rows identically to the
 * Postgres search source.
 */
export function editionItemFromRow(r: Record<string, unknown>): EditionItem {
  return {
    uri: r.uri as string,
    title: r.title as string,
    subtitle: (r.subtitle as string | null) ?? undefined,
    publishedYear: (r.publishedYear as number | null) ?? undefined,
    place: (r.place as string | null) ?? undefined,
    language: (r.language as string | null) ?? undefined,
    description: (r.description as string | null) ?? undefined,
    coverImageUrl: (r.coverImageUrl as string | null) ?? undefined,
    format: ((r.format as string | null) ?? undefined)?.trim().toLowerCase() || undefined,
    pages: (r.pages as number | null) ?? undefined,
    identifiers: ((r.identifiers as Array<Identifier | LegacyIdentifier> | null) ?? []).map(identFromJson),
    contributors: ((r.contributors as Array<{ subject: { uri: string; cid: string }; role: string }> | null) ?? []).map(contributionFromJson),
    createdAt: (r.createdAt as Date).toISOString(),
  };
}

/** Columns runSearch reads off the table to compose WHERE/ORDER BY. */
interface SearchTable {
  identifiers: PgColumn;
  indexedAt: PgColumn;
  uri: PgColumn;
  /** Optional: language column for `lang` filtering. Editions + works only. */
  language?: PgColumn;
}

/** Minimal fields the cursor encoder reads off every row. */
interface CursorRow {
  indexedAt: Date;
  uri: string;
}

type DbExecutor = typeof defaultDb;
export type { DbExecutor };

/** Columns each mapper reads, so a page never fetches a TOASTed column it drops. */
type SelectProjection = Record<string, PgColumn | SQL | SQL.Aliased>;

const EDITION_COLUMNS: SelectProjection = {
  uri: editions.uri,
  title: editions.title,
  subtitle: editions.subtitle,
  publishedYear: editions.publishedYear,
  place: editions.place,
  language: editions.language,
  description: editions.description,
  coverImageUrl: editions.coverImageUrl,
  format: editions.format,
  pages: editions.pages,
  identifiers: editions.identifiers,
  contributors: editions.contributors,
  createdAt: editions.createdAt,
  indexedAt: editions.indexedAt,
};

const WORK_COLUMNS: SelectProjection = {
  uri: works.uri,
  title: works.title,
  subtitle: works.subtitle,
  originalLanguage: works.originalLanguage,
  firstPublishedYear: works.firstPublishedYear,
  subjects: works.subjects,
  description: works.description,
  identifiers: works.identifiers,
  contributors: works.contributors,
  createdAt: works.createdAt,
  indexedAt: works.indexedAt,
};

const CONTRIBUTOR_COLUMNS: SelectProjection = {
  uri: contributors.uri,
  name: contributors.name,
  aliases: contributors.aliases,
  bio: contributors.bio,
  bornYear: contributors.bornYear,
  diedYear: contributors.diedYear,
  linkedDid: contributors.linkedDid,
  imageUrl: contributors.imageUrl,
  identifiers: contributors.identifiers,
  createdAt: contributors.createdAt,
  indexedAt: contributors.indexedAt,
};

const PUBLISHER_COLUMNS: SelectProjection = {
  uri: publishers.uri,
  name: publishers.name,
  imprintOfUri: publishers.imprintOfUri,
  imprintOfCid: publishers.imprintOfCid,
  foundingDate: publishers.foundingDate,
  closingDate: publishers.closingDate,
  identifiers: publishers.identifiers,
  createdAt: publishers.createdAt,
  indexedAt: publishers.indexedAt,
};

export class PostgresSource {
  constructor(private readonly log: Logger, private readonly db: DbExecutor = defaultDb) { }

  searchEditions(query: SearchQuery): Promise<SearchResult<EditionItem>> {
    return this.runSearch<EditionItem>(editions as unknown as SearchTable, editions.title, this.mapEditionRow, query, 'edition', EDITION_COLUMNS);
  }

  searchWorks(query: SearchQuery): Promise<SearchResult<WorkItem>> {
    // The work/contributor/publisher result envelopes require a `total`, so they
    // keep paying for it on every page; the editions envelope does not.
    return this.runSearch<WorkItem>(works as unknown as SearchTable, works.title, this.mapWorkRow, query, 'work', WORK_COLUMNS, undefined, true);
  }

  searchContributors(query: SearchQuery): Promise<SearchResult<ContributorItem>> {
    // `name` is NOT NULL but may still be '' / whitespace, which the lexicon's
    // minLength: 1 rejects. Filter in SQL so `items` and `total` stay consistent
    // with each other instead of dropping rows after counting them.
    return this.runSearch<ContributorItem>(
      contributors as unknown as SearchTable,
      contributors.name,
      this.mapContributorRow,
      query,
      'contributor',
      CONTRIBUTOR_COLUMNS,
      sql`btrim(${contributors.name}) <> ''`,
      true,
    );
  }

  searchPublishers(query: SearchQuery): Promise<SearchResult<PublisherItem>> {
    return this.runSearch<PublisherItem>(publishers as unknown as SearchTable, publishers.name, this.mapPublisherRow, query, 'publisher', PUBLISHER_COLUMNS, undefined, true);
  }

  private async runSearch<TItem>(
    table: SearchTable,
    qColumn: PgColumn,
    mapRow: (row: Record<string, unknown>) => TItem,
    query: SearchQuery,
    kind: 'edition' | 'work' | 'contributor' | 'publisher',
    columns: SelectProjection,
    basePredicate?: SQL,
    alwaysCount = false,
  ): Promise<SearchResult<TItem>> {
    const indexedAt = table.indexedAt;
    const uri = table.uri;

    const filterConds: SQL[] = [];
    if (basePredicate) filterConds.push(basePredicate);
    if (query.q) filterConds.push(sql`${qColumn} ILIKE ${'%' + query.q + '%'}`);
    if (query.id) {
      const identifiers = table.identifiers;
      for (const id of query.id) {
        const parsed = identifierFromString(id);
        if (!parsed) {
          // An identifier that names no known namespace can never match; fail
          // closed instead of dropping the filter and returning everything.
          filterConds.push(sql`FALSE`);
          continue;
        }
        filterConds.push(sql`${identifiers} @> ${JSON.stringify([{ type: parsed.type, value: parsed.value }])}::jsonb`);
      }
    }
    if (query.identifiers?.length) {
      // `defs#identifier` comparison is exact `type`/`value` equality; the URL
      // is display-only, so it is excluded from the containment test.
      const identifiers = table.identifiers;
      for (const identifier of query.identifiers) {
        filterConds.push(
          sql`${identifiers} @> ${JSON.stringify([{ type: identifier.type, value: identifier.value }])}::jsonb`,
        );
      }
    }
    if (query.lang?.length && table.language) {
      const variants = pgLanguageVariants(query.lang);
      if (variants.length > 0) {
        filterConds.push(inArray(table.language, variants));
      } else {
        // Caller asked for a language we can't map to any Postgres-visible form.
        // Fail-closed: emit a predicate that's never true so we return zero rows
        // instead of silently dropping the filter and returning wrong-language hits.
        filterConds.push(sql`FALSE`);
      }
    }

    let cursorCond: ReturnType<typeof sql> | undefined;
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        cursorCond = or(
          sql`${indexedAt} < ${new Date(c.t)}`,
          and(sql`${indexedAt} = ${new Date(c.t)}`, sql`${uri} > ${c.u}`))!;
      }
    }

    const where = filterConds.length > 0
      ? (cursorCond ? and(...filterConds, cursorCond) : and(...filterConds)) : cursorCond;

    // A total is only produced on the first page: `count(*)` over an
    // `ILIKE '%q%'` set has to materialise every match (measured 459 ms for
    // `%the%` against a 1.8 ms page), and a continuation cannot change it. The
    // count and the page are independent, so they run together.
    const wantCount = alwaysCount || ((query.offset ?? 0) === 0 && !query.cursor);
    const countQuery = wantCount && filterConds.length > 0
      ? this.db
          .select({ count: sql<number>`count(*)` })
          .from(table as unknown as PgTable)
          .where(and(...filterConds))
      : undefined;

    const base = this.db.select(columns).from(table as unknown as PgTable);
    const [rawRows, countResult] = await Promise.all([
      (where !== undefined ? base.where(where) : base)
        .orderBy(desc(indexedAt), asc(uri))
        .offset(query.offset ?? 0)
        .limit(query.limit + 1),
      countQuery,
    ]);
    const hasMore = rawRows.length > query.limit;
    const rows = (hasMore ? rawRows.slice(0, query.limit) : rawRows) as unknown as Array<Record<string, unknown>>;
    const items = rows.map(mapRow);
    const last = hasMore ? rows[rows.length - 1] as unknown as CursorRow : null;
    const cursor = last ? encodeCursor(last.indexedAt, last.uri) : undefined;
    const total = countResult ? Number(countResult[0]?.count ?? 0) : undefined;
    this.log.info(
      { stage: 'postgres-source', kind, items: items.length, total: total ?? null, hasMore, did: PUBLISHER_DID },
      'postgres ok',
    );
    return { items, cursor, total, hasMore };
  }

  private mapEditionRow(r: Record<string, unknown>): EditionItem {
    return editionItemFromRow(r);
  }

  private mapWorkRow(r: Record<string, unknown>): WorkItem {
    return {
      uri: r.uri as string,
      title: r.title as string,
      subtitle: (r.subtitle as string | null) ?? undefined,
      originalLanguage: (r.originalLanguage as string | null) ?? undefined,
      firstPublishedYear: (r.firstPublishedYear as number | null) ?? undefined,
      subjects: (r.subjects as string[] | null) ?? [],
      description: (r.description as string | null) ?? undefined,
      identifiers: ((r.identifiers as Array<{ uri: string; resource: string }> | null) ?? []).map(identFromJson),
      contributors: ((r.contributors as Array<{ subject: { uri: string; cid: string }; role: string }> | null) ?? []).map(contributionFromJson),
      createdAt: (r.createdAt as Date).toISOString(),
    };
  }

  private mapContributorRow(r: Record<string, unknown>): ContributorItem {
    return {
      uri: r.uri as string,
      name: r.name as string,
      aliases: (r.aliases as string[] | null) ?? [],
      bio: (r.bio as string | null) ?? undefined,
      bornYear: (r.bornYear as number | null) ?? undefined,
      diedYear: (r.diedYear as number | null) ?? undefined,
      linkedDid: (r.linkedDid as string | null) ?? undefined,
      imageUrl: (r.imageUrl as string | null) ?? undefined,
      identifiers: ((r.identifiers as Array<{ uri: string; resource: string }> | null) ?? []).map(identFromJson),
      createdAt: (r.createdAt as Date).toISOString(),
    };
  }

  private mapPublisherRow(r: Record<string, unknown>): PublisherItem {
    const imprintOfUri = r.imprintOfUri as string | null;
    const imprintOfCid = r.imprintOfCid as string | null;
    return {
      uri: r.uri as string,
      name: r.name as string,
      imprintOf: imprintOfUri && imprintOfCid ? { uri: imprintOfUri, cid: imprintOfCid } : undefined,
      foundingDate: (r.foundingDate as number | null) ?? undefined,
      closingDate: (r.closingDate as number | null) ?? undefined,
      identifiers: ((r.identifiers as Array<{ uri: string; resource: string }> | null) ?? []).map(identFromJson),
      createdAt: (r.createdAt as Date).toISOString(),
    };
  }
}
