import type { Logger } from 'pino';
import { and, asc, desc, or, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db as defaultDb } from '../db/index';
import { editions, works, contributors, publishers } from '../db/schema';
import { PUBLISHER_DID } from '../did';
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

const CURSOR_VERSION = 2;

type PostgresCursor = { v: 1 | 2; src: 'postgres'; t: string; u: string };

function encodeCursor(indexedAt: Date, uri: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, src: 'postgres', t: indexedAt.toISOString(), u: uri } satisfies PostgresCursor)).toString('base64url');
}

function decodeCursor(cursor: string): PostgresCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if ((parsed.v !== 1 && parsed.v !== 2) || parsed.src !== 'postgres') return null;
    return parsed as PostgresCursor;
  } catch { return null; }
}

function contributionFromJson(c: { subject: { uri: string; cid: string }; role: string }): ContributionEntry {
  return { subject: c.subject, role: c.role };
}

function identFromJson(i: { uri: string; resource: string }): Identifier {
  return { uri: i.uri, resource: i.resource };
}

/** Columns runSearch reads off the table to compose WHERE/ORDER BY. */
interface SearchTable {
  identifiers: PgColumn;
  indexedAt: PgColumn;
  uri: PgColumn;
}

/** Minimal fields the cursor encoder reads off every row. */
interface CursorRow {
  indexedAt: Date;
  uri: string;
}

type DbExecutor = typeof defaultDb;
export type { DbExecutor };

export class PostgresSource {
  constructor(private readonly log: Logger, private readonly db: DbExecutor = defaultDb) {}

  searchEditions(query: SearchQuery): Promise<SearchResult<EditionItem>> {
    return this.runSearch<EditionItem>(editions as unknown as SearchTable, editions.title, this.mapEditionRow, query, 'edition');
  }

  searchWorks(query: SearchQuery): Promise<SearchResult<WorkItem>> {
    return this.runSearch<WorkItem>(works as unknown as SearchTable, works.title, this.mapWorkRow, query, 'work');
  }

  searchContributors(query: SearchQuery): Promise<SearchResult<ContributorItem>> {
    return this.runSearch<ContributorItem>(contributors as unknown as SearchTable, contributors.name, this.mapContributorRow, query, 'contributor');
  }

  searchPublishers(query: SearchQuery): Promise<SearchResult<PublisherItem>> {
    return this.runSearch<PublisherItem>(publishers as unknown as SearchTable, publishers.name, this.mapPublisherRow, query, 'publisher');
  }

  private async runSearch<TItem>(
    table: SearchTable,
    qColumn: PgColumn,
    mapRow: (row: Record<string, unknown>) => TItem,
    query: SearchQuery,
    kind: 'edition' | 'work' | 'contributor' | 'publisher',
  ): Promise<SearchResult<TItem>> {
    const indexedAt = table.indexedAt;
    const uri = table.uri;

    const filterConds: ReturnType<typeof sql>[] = [];
    if (query.q) filterConds.push(sql`${qColumn} ILIKE ${'%' + query.q + '%'}`);
    if (query.id) {
      const identifiers = table.identifiers;
      for (const id of query.id) filterConds.push(sql`${identifiers} @> ${JSON.stringify([{ uri: id }])}::jsonb`);
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

    let total = 0;
    if (filterConds.length > 0) {
      const countResult = await this.db.select({ count: sql<number>`count(*) as count` }).from(table as unknown as PgTable).where(and(...filterConds)).orderBy().limit(1);
      total = countResult[0]?.count ?? 0;
    }

    const base = this.db.select().from(table as unknown as PgTable);
    const rawRows = await (where !== undefined ? base.where(where) : base)
      .orderBy(desc(indexedAt), asc(uri))
      .limit(query.limit);
    const rows = rawRows as Array<Record<string, unknown>>;
    const items = rows.map(mapRow);
    const last = rows.length === query.limit ? rows[rows.length - 1] as unknown as CursorRow : null;
    const cursor = last ? encodeCursor(last.indexedAt, last.uri) : undefined;
    this.log.info({ stage: 'postgres-source', kind, items: items.length, total, did: PUBLISHER_DID }, 'postgres ok');
    return { items, cursor, total };
  }

  private mapEditionRow(r: Record<string, unknown>): EditionItem {
    return {
      uri: r.uri as string,
      title: r.title as string,
      subtitle: (r.subtitle as string | null) ?? undefined,
      publishedYear: (r.publishedYear as number | null) ?? undefined,
      place: (r.place as string | null) ?? undefined,
      language: (r.language as string | null) ?? undefined,
      description: (r.description as string | null) ?? undefined,
      coverImageUrl: (r.coverImageUrl as string | null) ?? undefined,
      identifiers: ((r.identifiers as Array<{ uri: string; resource: string }> | null) ?? []).map(identFromJson),
      contributors: ((r.contributors as Array<{ subject: { uri: string; cid: string }; role: string }> | null) ?? []).map(contributionFromJson),
      createdAt: (r.createdAt as Date).toISOString(),
    };
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