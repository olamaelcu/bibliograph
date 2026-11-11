// Book lexicon query/procedure handlers split out for safer, targeted edits.
// External lexicon imports stay at the top of xrpc-router.ts (#320); the
// namespaces re-exported there are imported here for typing only.
import { type XRPCRouter, json } from '@atcute/xrpc-server';
import type { Logger } from 'pino';

import * as v from '@atcute/lexicons/validations';


import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import {
  CommunityLexiconBookCompatibility,
  CommunityLexiconBookResolveEditions,
  CommunityLexiconBookSearchContributors,
  CommunityLexiconBookSearchEditions,
  CommunityLexiconBookSearchPublishers,
  CommunityLexiconBookSearchWorks,
} from '../../lib/server/lexicons/index.js';
import { invalidContributorResponsesTotal } from '../../lib/server/metrics';
import { validContributorName } from '../../lib/server/search/contributor-name';
import { editionItemFromRow } from '../../lib/server/search/postgres-source';
import { db } from '../../lib/server/db';
import { editions, follows } from '../../lib/server/db/schema';
import { editionViewFromItem } from '../../lib/server/book-wire';
import { wireContributors } from '../../lib/server/book-wire';
import { isResourceUri, type ResourceUri } from '@atcute/lexicons';
import { contributorUrisFor, loadContributorRefs } from '../../lib/server/contributor-refs';
import {
  maybeEnqueueContributorBackfills,
  maybeEnqueueEditionBackfills,
} from '../../lib/server/jobs/on-read';
import type { SearchService } from '../../lib/server/search/service';
import type { Identifier } from '../../lib/server/identifiers';

/**
 * `identifiers` are `defs#identifier` pairs encoded as `<type>:<value>`: query
 * parameters carry primitives only, so the pair travels as one string. A hint
 * without both halves is dropped — it names nothing a row can match.
 */
function parseIdentifierHints(hints: readonly string[]): Identifier[] {
  const parsed: Identifier[] = [];
  for (const hint of hints) {
    const separator = hint.indexOf(':');
    if (separator <= 0 || separator === hint.length - 1) continue;
    parsed.push({
      type: hint.slice(0, separator),
      value: hint.slice(separator + 1),
    });
  }
  return parsed;
}

/** `InvalidQuery`: no nonblank q, title, author, or nonempty identifiers. */
function invalidQuery(message: string): Response {
  return Response.json({ error: 'InvalidQuery', message }, { status: 400 });
}

/**
 * The lexicons type `uri`/`ref` as `${string}:${string}` (any absolute URI).
 * Stored uris are validated AT-URIs, so the narrowing is safe here.
 */
function asUri(uri: string): `${string}:${string}` {
  return uri as `${string}:${string}`;
}

/** A `com.atproto.repo.strongRef` uri must be a canonical AT-URI. */
function asResourceUri(uri: string): ResourceUri | undefined {
  return isResourceUri(uri) ? uri : undefined;
}



// The follow graph is public ATProto data, so neither query needs a viewer
// token: `did` names whose edges to read. Both are keyset-paginated on the DID
// being listed — the indexed column for that direction — so a cursor is just
// the last DID returned.
const listFollowersSchema = /*#__PURE__*/ v.query(
  'net.olamaelcu.livtet.biblio.graph.listFollowers',
  {
    params: /*#__PURE__*/ v.object({
      did: /*#__PURE__*/ v.didString(),
      cursor: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
      limit: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(v.integer(), [v.integerRange(1, 1000)]),
        100,
      ),
    }),
    output: {
      type: 'lex',
      schema: /*#__PURE__*/ v.object({
        followers: /*#__PURE__*/ v.array(
          /*#__PURE__*/ v.object({
            did: /*#__PURE__*/ v.didString(),
            followedAt: /*#__PURE__*/ v.string(),
          }),
        ),
        // Exact count, independent of `limit` and `cursor`: it is what a
        // "Followers (n)" tab label needs, and it cannot be derived from a
        // page.
        total: /*#__PURE__*/ v.integer(),
        cursor: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
      }),
    },
  },
);

const listFolloweesSchema = /*#__PURE__*/ v.query(
  'net.olamaelcu.livtet.biblio.graph.listFollowees',
  {
    params: /*#__PURE__*/ v.object({
      did: /*#__PURE__*/ v.didString(),
      cursor: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
      limit: /*#__PURE__*/ v.optional(
        /*#__PURE__*/ v.constrain(v.integer(), [v.integerRange(1, 1000)]),
        100,
      ),
    }),
    output: {
      type: 'lex',
      schema: /*#__PURE__*/ v.object({
        followees: /*#__PURE__*/ v.array(
          /*#__PURE__*/ v.object({
            did: /*#__PURE__*/ v.didString(),
            followedAt: /*#__PURE__*/ v.string(),
          }),
        ),
        total: /*#__PURE__*/ v.integer(),
        cursor: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
      }),
    },
  },
);

/**
 * Whether `follower` follows `followed`. One primary-key probe: the index
 * answers it without scanning either side, which is what a "follows you" badge
 * needs on every profile view.
 */
const isFollowingSchema = /*#__PURE__*/ v.query(
  'net.olamaelcu.livtet.biblio.graph.isFollowing',
  {
    params: /*#__PURE__*/ v.object({
      follower: /*#__PURE__*/ v.didString(),
      followed: /*#__PURE__*/ v.didString(),
    }),
    output: {
      type: 'lex',
      schema: /*#__PURE__*/ v.object({
        following: /*#__PURE__*/ v.boolean(),
      }),
    },
  },
);

/**
 * How many edges one DID has on the given side. `count(*)` over an indexed
 * column is cheap, and the cast keeps drizzle from handing back the bigint as a
 * string, which would serialise as `"8"` instead of `8`.
 */
async function followCount(
  column: typeof follows.followerDid | typeof follows.followedDid,
  did: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(follows)
    .where(eq(column, did));
  return row?.total ?? 0;
}

export function registerBookQueries(
  router: XRPCRouter,
  log: Logger,
  searchService: SearchService,
) {
  router.addQuery(isFollowingSchema, {
    async handler({ params }) {
      const [row] = await db
        .select({ follower: follows.followerDid })
        .from(follows)
        .where(
          and(
            eq(follows.followerDid, params.follower),
            eq(follows.followedDid, params.followed),
          ),
        )
        .limit(1);
      return json({
        following: Boolean(row),
      } as unknown as v.InferXRPCBodyOutput<typeof isFollowingSchema['output']>);
    },
  });

  router.addQuery(listFollowersSchema, {
    async handler({ params }) {
      // The total answers a tab label, so it is a first-page cost only, and it
      // runs beside the page instead of after it.
      const [rows, total] = await Promise.all([
        db
          .select({ did: follows.followerDid, followedAt: follows.createdAt })
          .from(follows)
          .where(
            and(
              eq(follows.followedDid, params.did),
              params.cursor ? gt(follows.followerDid, params.cursor) : undefined,
            ),
          )
          .orderBy(asc(follows.followerDid))
          .limit(params.limit),
        params.cursor ? undefined : followCount(follows.followedDid, params.did),
      ]);
      const last = rows.at(-1)?.did;
      return json({
        followers: rows.map((row) => ({ did: row.did, followedAt: row.followedAt.toISOString() })),
        ...(total !== undefined ? { total } : {}),
        ...(rows.length === params.limit && last ? { cursor: last } : {}),
      } as unknown as v.InferXRPCBodyOutput<typeof listFollowersSchema['output']>);
    },
  });

  router.addQuery(listFolloweesSchema, {
    async handler({ params }) {
      const [rows, total] = await Promise.all([
        db
          .select({ did: follows.followedDid, followedAt: follows.createdAt })
          .from(follows)
          .where(
            and(
              eq(follows.followerDid, params.did),
              params.cursor ? gt(follows.followedDid, params.cursor) : undefined,
            ),
          )
          .orderBy(asc(follows.followedDid))
          .limit(params.limit),
        params.cursor ? undefined : followCount(follows.followerDid, params.did),
      ]);
      const last = rows.at(-1)?.did;
      return json({
        followees: rows.map((row) => ({ did: row.did, followedAt: row.followedAt.toISOString() })),
        ...(total !== undefined ? { total } : {}),
        ...(rows.length === params.limit && last ? { cursor: last } : {}),
      } as unknown as v.InferXRPCBodyOutput<typeof listFolloweesSchema['output']>);
    },
  });

  router.addQuery(CommunityLexiconBookCompatibility.mainSchema, {
    async handler() {
      const queries: { nsid: string; type: 'query' | 'procedure' }[] = [
        { nsid: 'community.lexicon.book.compatibility', type: 'query' },
        { nsid: 'community.lexicon.book.searchEditions', type: 'query' },
        { nsid: 'community.lexicon.book.resolveEditions', type: 'procedure' },
        { nsid: 'community.lexicon.book.searchWorks', type: 'query' },
        { nsid: 'community.lexicon.book.searchContributors', type: 'query' },
        { nsid: 'community.lexicon.book.searchPublishers', type: 'query' },
      ];
      return json({ queries } as unknown as CommunityLexiconBookCompatibility.$output);
    },
  });

  router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, {
    async handler({ params }) {
      const q = params.q?.trim();
      const title = params.title?.trim();
      const author = params.author?.trim();
      const identifiers = parseIdentifierHints(params.identifiers ?? []);
      if (!q && !title && !author && identifiers.length === 0) {
        return invalidQuery('one of q, title, author, or identifiers is required');
      }

      // The text sources index a single free-form field, so the structured
      // title/author hints are folded into it, most specific first.
      const text = q ?? ([title, author].filter(Boolean).join(' ') || undefined);
      const limit = Math.min(params.limit ?? 25, 100);
      const offset = Math.max(params.offset ?? 0, 0);

      const result = await searchService.searchEditions({
        q: text,
        identifiers,
        limit,
        offset,
      });

      const contributorRefs = await loadContributorRefs(
        contributorUrisFor(result.items.flatMap((item) => item.contributors ?? [])),
      );

      // Track empty contributor NAMES (not URI refs)
      let invalidContributorCount = 0;
      for (const item of result.items) {
        for (const c of item.contributors ?? []) {
          const contributorUri = c.subject?.uri;
          const name = contributorUri ? (contributorRefs.get(contributorUri)?.name ?? '') : '';
          if (name.trim() === '') {
            invalidContributorCount++;
            log.warn(
              { contributorUri: contributorUri ?? 'unknown', endpoint: 'searchEditions', reason: 'empty_name' },
              'contributor with empty name in searchEditions response',
            );
          }
        }
      }
      if (invalidContributorCount > 0) {
        invalidContributorResponsesTotal.inc({ nsid: 'community.lexicon.book.searchEditions', reason: 'empty_name' });
      }

      // Books fetched over XRPC self-heal: enqueue missing-data backfills for
      // the local rows on this page. Steady state is one indexed query, no jobs.
      void maybeEnqueueEditionBackfills(result.items.map((item) => item.uri), log);
      void maybeEnqueueContributorBackfills(
        contributorUrisFor(result.items.flatMap((item) => item.contributors ?? [])),
        log,
      );

      const items = [];
      for (const item of result.items) {
        // `defs#editionView` requires at least one identifier; a row without one
        // cannot be represented without producing a lexicon-invalid body.
        if (item.identifiers.length === 0) {
          log.warn({ uri: item.uri, endpoint: 'searchEditions' }, 'skipped edition with no identifiers');
          continue;
        }
        if (items.length >= limit) break;
        items.push(editionViewFromItem(item, contributorRefs));
      }

      return json({
        items,
        // Page-fullness comes from the sources, not from a post-filter count:
        // `items` drops editions without identifiers, and the service already
        // caps the merged page at `limit`.
        hasMore: result.hasMore === true,
        ...(result.total !== undefined && result.total > 0 ? { total: result.total } : {}),
      });
    },
  });

  router.addProcedure(CommunityLexiconBookResolveEditions.mainSchema, {
    async handler({ input }) {
      const identifiers = input.identifiers ?? [];
      if (identifiers.length === 0) {
        return invalidQuery('at least one identifier is required');
      }
      const limit = Math.min(input.limit ?? 25, 100);
      const offset = Math.max(input.offset ?? 0, 0);

      // "An edition qualifies when at least one supplied type/value pair matches
      // exactly" — containment on the pair, ignoring `url` (display only).
      const matches = identifiers.map((identifier) =>
        sql`${editions.identifiers} @> ${JSON.stringify([{ type: identifier.type, value: identifier.value }])}::jsonb`,
      );
      const where = or(...matches);

      const rows = await db
        .select()
        .from(editions)
        .where(where)
        .orderBy(editions.indexedAt, editions.uri)
        .offset(offset)
        .limit(limit + 1);

      // One extra row answers `hasMore` without a second count query.
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = page.map((row) => editionItemFromRow(row as unknown as Record<string, unknown>));
      const contributorRefs = await loadContributorRefs(
        contributorUrisFor(items.flatMap((item) => item.contributors ?? [])),
      );

      const views = [];
      for (const item of items) {
        if (item.identifiers.length === 0) continue;
        views.push(editionViewFromItem(item, contributorRefs));
      }

      void maybeEnqueueEditionBackfills(items.map((item) => item.uri), log);
      void maybeEnqueueContributorBackfills(
        contributorUrisFor(items.flatMap((item) => item.contributors ?? [])),
        log,
      );

      return json({
        items: views,
        hasMore,
      });
    },
  });

  router.addQuery(CommunityLexiconBookSearchWorks.mainSchema, {
    async handler({ params }) {
      const result = await searchService.searchWorks({
        q: params.q,
        id: params.id,
        limit: Math.min(params.limit ?? 20, 100),
        cursor: params.cursor,
      });
      const contributorRefs = await loadContributorRefs(
        contributorUrisFor(result.items.flatMap((r) => r.contributors ?? [])),
      );
      void maybeEnqueueContributorBackfills(
        contributorUrisFor(result.items.flatMap((r) => r.contributors ?? [])),
        log,
      );
      const items = result.items.map((r) => ({
        $type: 'community.lexicon.book.work' as const,
        uri: asUri(r.uri),
        title: r.title,
        subtitle: r.subtitle,
        originalLanguage: r.originalLanguage,
        firstPublishedYear: r.firstPublishedYear,
        subjects: r.subjects,
        contributors: wireContributors(r.contributors, contributorRefs),
        identifiers: r.identifiers,
        description: r.description,
        createdAt: r.createdAt,
      }));
      return json({
        items,
        cursor: result.cursor,
        total: result.total ?? 0,
      });
    },
  });

  router.addQuery(CommunityLexiconBookSearchContributors.mainSchema, {
    async handler({ params }) {
      try {
        const result = await searchService.searchContributors({
          q: params.q,
          id: params.id,
          limit: Math.min(params.limit ?? 20, 100),
          cursor: params.cursor,
        });
        // Final contract enforcement: every emitted name must satisfy the
        // lexicon's minLength: 1, whatever the upstream sources handed back.
        const validContributors = result.items.filter((r) => validContributorName(r.name));
        const droppedCount = result.items.length - validContributors.length;
        if (droppedCount > 0) {
          log.warn(
            { endpoint: 'searchContributors', reason: 'empty_name', count: droppedCount },
            'dropped contributors with empty name from searchContributors response',
          );
          invalidContributorResponsesTotal.inc({ nsid: 'community.lexicon.book.searchContributors', reason: 'empty_name' }, droppedCount);
        }
        const items = validContributors.map((r) => ({
          $type: 'community.lexicon.book.contributor' as const,
          uri: asUri(r.uri),
          name: r.name,
          aliases: r.aliases,
          bio: r.bio,
          bornYear: r.bornYear,
          diedYear: r.diedYear,
          ...(r.linkedDid !== undefined ? { linkedDid: r.linkedDid as `did:${string}:${string}` } : {}),
          identifiers: r.identifiers,
          createdAt: r.createdAt,
        }));
        void maybeEnqueueContributorBackfills(validContributors.map((r) => r.uri), log);
        return json({
          items,
          cursor: result.cursor,
          total: result.total ?? 0,
        });
      } catch (e) {
        console.error('CONTRIBUTOR_HANDLER_ERR:', e, (e as Error)?.stack);
        throw e;
      }
    },
  });

  router.addQuery(CommunityLexiconBookSearchPublishers.mainSchema, {
    async handler({ params }) {
      const result = await searchService.searchPublishers({
        q: params.q,
        id: params.id,
        limit: Math.min(params.limit ?? 20, 100),
        cursor: params.cursor,
      });
      const items = result.items.map((r) => {
        const imprintUri = r.imprintOf ? asResourceUri(r.imprintOf.uri) : undefined;
        return {
          $type: 'community.lexicon.book.publisher' as const,
          uri: asUri(r.uri),
          name: r.name,
          imprintOf: imprintUri && r.imprintOf ? { uri: imprintUri, cid: r.imprintOf.cid } : undefined,
          foundingDate: r.foundingDate,
          closingDate: r.closingDate,
          identifiers: r.identifiers,
          createdAt: r.createdAt,
        };
      });
      return json({
        items,
        cursor: result.cursor,
        total: result.total ?? 0,
      });
    },
  });
}
