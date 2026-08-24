import type { Logger } from 'pino';
import { and, asc, desc, or, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
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

type PostgresCursor = { v: 2; src: 'postgres'; t: string; u: string };

function encodeCursor(indexedAt: Date, uri: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, src: 'postgres', t: indexedAt.toISOString(), u: uri } satisfies PostgresCursor)).toString('base64url');
}

function decodeCursor(cursor: string): PostgresCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (parsed.v !== CURSOR_VERSION || parsed.src !== 'postgres') return null;
    return parsed as PostgresCursor;
  } catch { return null; }
}

function contributionFromJson(c: { subject: { uri: string; cid: string }; role: string }): ContributionEntry {
  return { subject: c.subject, role: c.role };
}

function identFromJson(i: { uri: string; resource: string }): Identifier {
  return { uri: i.uri, resource: i.resource };
}

export class PostgresSource {
  constructor(private readonly log: Logger) {}

  async searchEditions(query: SearchQuery): Promise<SearchResult<EditionItem>> {
    const conds: ReturnType<typeof sql>[] = [];
    if (query.q) conds.push(sql`${editions.title} ILIKE ${'%' + query.q + '%'}`);
    if (query.id) for (const id of query.id) conds.push(sql`${editions.identifiers} @> ${JSON.stringify([{ uri: id }])}::jsonb`);
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        conds.push(or(sql`${editions.indexedAt} < ${new Date(c.t)}`, and(sql`${editions.indexedAt} = ${new Date(c.t)}`, sql`${editions.uri} > ${c.u}`))!);
      }
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await db.select().from(editions).where(where).orderBy(desc(editions.indexedAt), asc(editions.uri)).limit(query.limit);
    const items: EditionItem[] = rows.map((r) => ({
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
    }));
    const cursor = rows.length === query.limit ? encodeCursor(rows[rows.length - 1]!.indexedAt, rows[rows.length - 1]!.uri) : undefined;
    this.log.info({ stage: 'postgres-source', kind: 'edition', items: items.length, did: PUBLISHER_DID }, 'postgres ok');
    return { items, cursor };
  }

  async searchWorks(query: SearchQuery): Promise<SearchResult<WorkItem>> {
    const conds: ReturnType<typeof sql>[] = [];
    if (query.q) conds.push(sql`${works.title} ILIKE ${'%' + query.q + '%'}`);
    if (query.id) for (const id of query.id) conds.push(sql`${works.identifiers} @> ${JSON.stringify([{ uri: id }])}::jsonb`);
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        conds.push(or(sql`${works.indexedAt} < ${new Date(c.t)}`, and(sql`${works.indexedAt} = ${new Date(c.t)}`, sql`${works.uri} > ${c.u}`))!);
      }
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await db.select().from(works).where(where).orderBy(desc(works.indexedAt), asc(works.uri)).limit(query.limit);
    const items: WorkItem[] = rows.map((r) => ({
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
    }));
    const cursor = rows.length === query.limit ? encodeCursor(rows[rows.length - 1]!.indexedAt, rows[rows.length - 1]!.uri) : undefined;
    this.log.info({ stage: 'postgres-source', kind: 'work', items: items.length }, 'postgres ok');
    return { items, cursor };
  }

  async searchContributors(query: SearchQuery): Promise<SearchResult<ContributorItem>> {
    const conds: ReturnType<typeof sql>[] = [];
    if (query.q) conds.push(sql`${contributors.name} ILIKE ${'%' + query.q + '%'}`);
    if (query.id) for (const id of query.id) conds.push(sql`${contributors.identifiers} @> ${JSON.stringify([{ uri: id }])}::jsonb`);
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        conds.push(or(sql`${contributors.indexedAt} < ${new Date(c.t)}`, and(sql`${contributors.indexedAt} = ${new Date(c.t)}`, sql`${contributors.uri} > ${c.u}`))!);
      }
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const rows = await db.select().from(contributors).where(where).orderBy(desc(contributors.indexedAt), asc(contributors.uri)).limit(query.limit);
    const items: ContributorItem[] = rows.map((r) => ({
      uri: r.uri,
      name: r.name,
      aliases: r.aliases ?? [],
      bio: r.bio ?? undefined,
      bornYear: r.bornYear ?? undefined,
      diedYear: r.diedYear ?? undefined,
      linkedDid: r.linkedDid ?? undefined,
      identifiers: (r.identifiers ?? []).map(identFromJson),
      createdAt: r.createdAt.toISOString(),
    }));
    const cursor = rows.length === query.limit ? encodeCursor(rows[rows.length - 1]!.indexedAt, rows[rows.length - 1]!.uri) : undefined;
    this.log.info({ stage: 'postgres-source', kind: 'contributor', items: items.length }, 'postgres ok');
    return { items, cursor };
  }
}
