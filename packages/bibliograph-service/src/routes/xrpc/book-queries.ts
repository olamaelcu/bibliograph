// Book lexicon query/procedure handlers split out for safer, targeted edits.
// External lexicon imports stay at the top of xrpc-router.ts (#320); the
// namespaces re-exported there are imported here for typing only.
import { type XRPCRouter, json } from '@atcute/xrpc-server';
import type { Logger } from 'pino';
import { inArray, or, sql } from 'drizzle-orm';
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
import { editions } from '../../lib/server/db/schema';
import { editionViewFromItem } from '../../lib/server/book-wire';
import { wireContributors } from '../../lib/server/book-wire';
import { isResourceUri, type ResourceUri } from '@atcute/lexicons';
import { contributorUrisFor, loadContributorRefs } from '../../lib/server/contributor-refs';
import type { SearchService } from '../../lib/server/search/service';
import type { Identifier } from '../../lib/server/identifiers';

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



export function registerBookQueries(
  router: XRPCRouter,
  log: Logger,
  searchService: SearchService,
) {
  router.addQuery(CommunityLexiconBookCompatibility.mainSchema, {
    async handler() {
      const queries: { nsid: string; type: 'query' | 'procedure' }[] = [
        { nsid: 'community.lexicon.book.compatibility', type: 'query' },
        { nsid: 'community.lexicon.book.searchEditions', type: 'procedure' },
        { nsid: 'community.lexicon.book.resolveEditions', type: 'procedure' },
        { nsid: 'community.lexicon.book.searchWorks', type: 'query' },
        { nsid: 'community.lexicon.book.searchContributors', type: 'query' },
        { nsid: 'community.lexicon.book.searchPublishers', type: 'query' },
      ];
      return json({ queries } as unknown as CommunityLexiconBookCompatibility.$output);
    },
  });

  router.addProcedure(CommunityLexiconBookSearchEditions.mainSchema, {
    async handler({ input }) {
      const q = input.q?.trim();
      const title = input.title?.trim();
      const author = input.author?.trim();
      const identifiers: Identifier[] = input.identifiers ?? [];
      if (!q && !title && !author && identifiers.length === 0) {
        return invalidQuery('one of q, title, author, or identifiers is required');
      }

      // The text sources index a single free-form field, so the structured
      // title/author hints are folded into it, most specific first.
      const text = q ?? ([title, author].filter(Boolean).join(' ') || undefined);
      const limit = Math.min(input.limit ?? 25, 100);
      const offset = Math.max(input.offset ?? 0, 0);

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

      // `limit` is the maximum per page, but the search service merges remote
      // sources on top of the local page, so the merged list can exceed it.
      const truncated = result.items.length > items.length;
      return json({
        items,
        hasMore: truncated || result.items.length >= limit,
        ...(result.total > 0 ? { total: result.total } : {}),
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
        .limit(limit);

      const items = rows.map((row) => editionItemFromRow(row as unknown as Record<string, unknown>));
      const contributorRefs = await loadContributorRefs(
        contributorUrisFor(items.flatMap((item) => item.contributors ?? [])),
      );

      const views = [];
      for (const item of items) {
        if (item.identifiers.length === 0) continue;
        views.push(editionViewFromItem(item, contributorRefs));
      }

      return json({
        items: views,
        hasMore: rows.length >= limit,
        total: rows.length,
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
      return json({ items, cursor: result.cursor, total: result.total });
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
        return json({ items, cursor: result.cursor, total: result.total });
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
      return json({ items, cursor: result.cursor, total: result.total });
    },
  });
}
