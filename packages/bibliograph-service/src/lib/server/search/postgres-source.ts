import type { Logger } from 'pino';
import { and, asc, desc, or, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db as defaultDb } from '../db/index.ts';
import { editions, works, contributors } from '../db/schema.ts';
import { PUBLISHER_DID } from '../did.ts';
import type {
  SearchQuery,
  SearchResult,
  EditionItem,
  WorkItem,
  ContributorItem,
  Identifier,
  ContributionEntry,
} from './types.ts';

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

type DbExecutor = typeof defaultDb;

export class PostgresSource {
  constructor(private readonly log: Logger, private readonly db: DbExecutor = defaultDb) {}

  searchEditions(query: SearchQuery): Promise<SearchResult<EditionItem>> {
    return this.runSearch(editions, editions.title, this.mapEditionRow, query, 'edition');
  }

  searchWorks(query: SearchQuery): Promise<SearchResult<WorkItem>> {
    return this.runSearch(works, works.title, this.mapWorkRow, query, 'work');
  }

  searchContributors(query: SearchQuery): Promise<SearchResult<ContributorItem>> {
    return this.runSearch(contributors, contributors.name, this.mapContributorRow, query, 'contributor');
  }

  private async runSearch<TItem extends { identifiers?: Identifier[]; contributors?: ContributionEntry[] }>(
    table: PgTable,
    qColumn: PgColumn,
    mapRow: (row: any) => TItem,
    query: SearchQuery,
    kind: 'edition' | 'work' | 'contributor',
  ): Promise<SearchResult<TItem>> {
    const conds: ReturnType<typeof sql>[] = [];
    if (query.q) conds.push(sql`${qColumn} ILIKE ${'%' + query.q + '%'}`);
    if (query.id) {
      const identifiers = (table as any).identifiers as PgColumn;
      for (const id of query.id) conds.push(sql`${identifiers} @> ${JSON.stringify([{ uri: id }])}::jsonb`);
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        const indexedAt = (table as any).indexedAt as PgColumn;
        const uri = (table as any).uri as PgColumn;
        conds.push(or(sql`${indexedAt} < ${new Date(c.t)}`, and(sql`${indexedAt} = ${new Date(c.t)}`, sql`${uri} > ${c.u}`))!);
      }
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const indexedAt = (table as any).indexedAt as PgColumn;
    const uri = (table as any).uri as PgColumn;
    const base = this.db.select().from(table);
    const rows: any[] = await (where !== undefined ? base.where(where) : base).orderBy(desc(indexedAt), asc(uri)).limit(query.limit);
    const items = rows.map(mapRow);
    const cursor = rows.length === query.limit ? encodeCursor(rows[rows.length - 1]!.indexedAt, rows[rows.length - 1]!.uri) : undefined;
    this.log.info({ stage: 'postgres-source', kind, items: items.length, did: PUBLISHER_DID }, 'postgres ok');
    return { items, cursor };
  }

  private mapEditionRow(r: any): EditionItem {
    return {
      uri: r.uri,
      title: r.title,
      subtitle: r.subtitle ?? undefined,
      publishedYear: r.publishedYear ?? undefined,
      place: r.place ?? undefined,
      language: r.language ?? undefined,
      description: r.description ?? undefined,
      coverImageUrl: r.coverImageUrl ?? undefined,
      identifiers: (r.identifiers ?? []).map(identFromJson),
      contributors: (r.contributors ?? []).map(contributionFromJson),
      createdAt: r.createdAt.toISOString(),
    };
  }

  private mapWorkRow(r: any): WorkItem {
    return {
      uri: r.uri,
      title: r.title,
      subtitle: r.subtitle ?? undefined,
      originalLanguage: r.originalLanguage ?? undefined,
      firstPublishedYear: r.firstPublishedYear ?? undefined,
      subjects: r.subjects ?? [],
      description: r.description ?? undefined,
      identifiers: (r.identifiers ?? []).map(identFromJson),
      contributors: (r.contributors ?? []).map(contributionFromJson),
      createdAt: r.createdAt.toISOString(),
    };
  }

  private mapContributorRow(r: any): ContributorItem {
    return {
      uri: r.uri,
      name: r.name,
      aliases: r.aliases ?? [],
      bio: r.bio ?? undefined,
      bornYear: r.bornYear ?? undefined,
      diedYear: r.diedYear ?? undefined,
      linkedDid: r.linkedDid ?? undefined,
      identifiers: (r.identifiers ?? []).map(identFromJson),
      createdAt: r.createdAt.toISOString(),
    };
  }
}