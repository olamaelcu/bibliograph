import { XRPCRouter, json } from '@atcute/xrpc-server';
import { cors } from '@atcute/xrpc-server/middlewares/cors';
import { and, asc, desc, or, sql } from 'drizzle-orm';
import {
  CommunityLexiconBookCompatibility,
  CommunityLexiconBookSearchContributors,
  CommunityLexiconBookSearchEditions,
  CommunityLexiconBookSearchPublishers,
  CommunityLexiconBookSearchWorks,
} from './lexicons/index.js';
import { db } from './db';
import { editions } from './db/schema';
import { createLogger } from './logger';
import { accessLog } from './access-log';

const CURSOR_VERSION = 1;

function encodeCursor(indexedAt: Date, uri: string): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, t: indexedAt.toISOString(), u: uri }),
  ).toString('base64url');
}

function decodeCursor(cursor: string): { indexedAt: Date; uri: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (parsed.v !== CURSOR_VERSION) return null;
    return { indexedAt: new Date(parsed.t), uri: parsed.u };
  } catch {
    return null;
  }
}

async function approxRowCount(whereClause: ReturnType<typeof sql> | undefined): Promise<number> {
  if (!whereClause) {
    const result = await db.execute<{ estimate: number | string }>(
      sql`SELECT reltuples::int AS estimate FROM pg_class WHERE relname = 'editions'`,
    );
    return Number(result.rows[0]?.estimate ?? 0);
  }
  const result = await db.execute<Record<string, unknown>>(
    sql`EXPLAIN (FORMAT JSON) SELECT * FROM editions WHERE ${whereClause}`,
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const plan = row?.['QUERY PLAN'];
  if (Array.isArray(plan) && plan[0] && typeof plan[0] === 'object') {
    const inner = (plan[0] as { Plan?: { 'Plan Rows'?: number } }).Plan;
    if (inner && typeof inner['Plan Rows'] === 'number') return inner['Plan Rows'];
  }
  return 0;
}

export const log = createLogger('web');
log.info({ nodeEnv: process.env.NODE_ENV }, 'web process started');

export const router = new XRPCRouter({
  middlewares: [accessLog(log), cors()],
  handleHealthCheck: async () => json({ status: 'ok' }),
});

// Wrapped registrations: every addQuery / addProcedure call below bumps the
// counter so the landing page can show live endpoint counts. Adding a new
// endpoint is the single source-of-truth edit.
export const endpointCounts = { queries: 0, procedures: 0 };

const realAddQuery = router.addQuery.bind(router);
router.addQuery = ((schema: unknown, opts: unknown) => {
  const nsid = (schema as { nsid?: string })?.nsid;
  endpointCounts.queries++;
  return realAddQuery(schema as never, opts as never);
}) as typeof router.addQuery;

const realAddProcedure = router.addProcedure?.bind(router);
if (realAddProcedure) {
  router.addProcedure = ((schema: unknown, opts: unknown) => {
    endpointCounts.procedures++;
    return realAddProcedure(schema as never, opts as never);
  }) as typeof router.addProcedure;
}

router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, {
  async handler({ params }) {
    const limit = Math.min(params.limit ?? 20, 100);

    const conds: ReturnType<typeof sql>[] = [];
    if (params.q) {
      // search_vector is added via custom migration (drizzle-kit ignores functional indexes)
      conds.push(sql`${sql.raw('editions.search_vector')} @@ websearch_to_tsquery('english', ${params.q})`);
    }
    if (params.id) {
      for (const id of params.id) {
        conds.push(sql`${editions.identifiers} @> ${JSON.stringify([{ uri: id }])}::jsonb`);
      }
    }

    if (params.cursor) {
      const c = decodeCursor(params.cursor);
      if (c) {
        const cursorClause = or(
          sql`${editions.indexedAt} < ${c.indexedAt}`,
          and(sql`${editions.indexedAt} = ${c.indexedAt}`, sql`${editions.uri} > ${c.uri}`),
        );
        if (cursorClause) conds.push(cursorClause);
      }
    }

    const where = conds.length > 0 ? and(...conds) : undefined;

    const [rows, total] = await Promise.all([
      db
        .select()
        .from(editions)
        .where(where)
        .orderBy(desc(editions.indexedAt), asc(editions.uri))
        .limit(limit),
      approxRowCount(where),
    ]);

    const cursor =
      rows.length === limit
        ? encodeCursor(rows[rows.length - 1].indexedAt, rows[rows.length - 1].uri)
        : undefined;

    const items = rows.map((r) => ({
      $type: 'community.lexicon.book.edition' as const,
      title: r.title,
      subtitle: r.subtitle ?? undefined,
      publisher: r.publisherUri && r.publisherCid ? { uri: r.publisherUri, cid: r.publisherCid } : undefined,
      place: r.place ?? undefined,
      publishedYear: r.publishedYear ?? undefined,
      language: r.language ?? undefined,
      contributors: r.contributors,
      identifiers: r.identifiers,
      description: r.description ?? undefined,
      createdAt: r.createdAt.toISOString(),
    }));

    return json({ items, cursor, total } as never);
  },
});

router.addQuery(CommunityLexiconBookCompatibility.mainSchema, {
  async handler() {
    return json({
      queries: [
        { nsid: 'community.lexicon.book.searchEditions', type: 'query' },
        { nsid: 'community.lexicon.book.searchContributors', type: 'query' },
        { nsid: 'community.lexicon.book.searchPublishers', type: 'query' },
        { nsid: 'community.lexicon.book.searchWorks', type: 'query' },
      ],
    });
  },
});

const notImplemented = (nsid: string) =>
  new Response(
    JSON.stringify({ error: 'NotImplemented', message: `${nsid} is not implemented by this AppView` }),
    { status: 501, headers: { 'content-type': 'application/json' } },
  );

router.addQuery(CommunityLexiconBookSearchContributors.mainSchema, {
  async handler() {
    return notImplemented('community.lexicon.book.searchContributors');
  },
});
router.addQuery(CommunityLexiconBookSearchPublishers.mainSchema, {
  async handler() {
    return notImplemented('community.lexicon.book.searchPublishers');
  },
});
router.addQuery(CommunityLexiconBookSearchWorks.mainSchema, {
  async handler() {
    return notImplemented('community.lexicon.book.searchWorks');
  },
});
