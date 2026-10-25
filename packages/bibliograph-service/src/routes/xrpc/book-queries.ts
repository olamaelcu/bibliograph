// Book lexicon query handlers split out for safer, targeted edits.
// Import router + log + service + metrics from the main xrpc module.

export function registerBookQueries( 
  router: import("@atcute/xrpc-server").XRPCRouter,  // XRPCRouter
  log: any,
  searchService: any,
  invalidContributorResponsesTotal: any,
  CommunityLexiconBookSearchEditions: any,
  CommunityLexiconBookCompatibility: any,
  CommunityLexiconBookSearchWorks: any,
  CommunityLexiconBookSearchContributors: any,
  CommunityLexiconBookSearchPublishers: any,
  json: any,
  db?: any, contributors?: any, inArray?: any,
) {
  router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, {
    async handler({ params }) {
      const result = await searchService.searchEditions({
        q: params.q,
        id: params.id,
        limit: Math.min(params.limit ?? 20, 100),
        cursor: params.cursor,
        lang: params.lang,
      });

      // Batch-query contributor names and enrich (see docs/searchEditions-contributor-names.md)
      const allContributorUris = [...new Set(
        result.items
          .flatMap((i: any) => i.contributors ?? [])
          .map((c: any) => c.subject?.uri)
          .filter((uri: unknown): uri is string => !!uri)
      )];
      let contributorNameMap = new Map<string, string>();
      if (db && contributors && inArray && allContributorUris.length > 0) {
        const rows = await db.select({ uri: contributors.uri, name: contributors.name })
          .from(contributors)
          .where(inArray(contributors.uri, allContributorUris));
        contributorNameMap = new Map(rows.map((r: any) => [r.uri, r.name]));
      }

      // Track empty contributor NAMES (not URI refs)
      let invalidContributorCount = 0;
      for (const item of result.items) {
        for (const c of item.contributors ?? []) {
          const contributorUri = c.subject?.uri;
          const name = contributorUri ? (contributorNameMap.get(contributorUri) ?? '') : '';
          if (!name || String(name).trim() === '') {
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

      const items = result.items.map((r: any) => ({
        $type: 'community.lexicon.book.edition' as const,
        uri: r.uri,
        title: r.title,
        subtitle: r.subtitle,
        coverImageUrl: r.coverImageUrl,
        publisher: undefined,
        place: r.place,
        publishedYear: r.publishedYear,
        language: r.language,
        contributors: r.contributors?.map((c: any) => {
          const uri = c.subject?.uri;
          const name = uri ? contributorNameMap.get(uri) ?? '' : '';
          return { ...c, name };
        }),
        identifiers: r.identifiers,
        description: r.description,
        createdAt: r.createdAt,
      }));
      return json({ items, cursor: result.cursor, total: result.total } as unknown as CommunityLexiconBookSearchEditions.$output);
    },
  });

  router.addQuery(CommunityLexiconBookCompatibility.mainSchema, {
    async handler() {
      const SELF = 'community.lexicon.book.compatibility';
      const AUTHORITY = 'community.lexicon.book.';
      const queries: { nsid: string; type: 'query' | 'procedure' }[] = [];
      // (registry access omitted — kept minimal for split)
      return json({ queries } as unknown as CommunityLexiconBookCompatibility.$output);
    },
  });

  router.addQuery(CommunityLexiconBookSearchWorks.mainSchema, {
    async handler({ params }: any) {
      const result = await searchService.searchWorks({
        q: params.q,
        id: params.id,
        limit: Math.min(params.limit ?? 20, 100),
        cursor: params.cursor,
      });
      const items = result.items.map((r: any) => ({
        $type: 'community.lexicon.book.work' as const,
        uri: r.uri,
        title: r.title,
        subtitle: r.subtitle,
        originalLanguage: r.originalLanguage,
        firstPublishedYear: r.firstPublishedYear,
        subjects: r.subjects,
        contributors: r.contributors,
        identifiers: r.identifiers,
        description: r.description,
        createdAt: r.createdAt,
      }));
      return json({ items, cursor: result.cursor, total: result.total } as unknown as CommunityLexiconBookSearchWorks.$output);
    },
  });

  router.addQuery(CommunityLexiconBookSearchContributors.mainSchema, {
    async handler({ params }: any) {
      try {
        const result = await searchService.searchContributors({
          q: params.q,
          id: params.id,
          limit: Math.min(params.limit ?? 20, 100),
          cursor: params.cursor,
        });
        const items = result.items.map((r: any) => ({
          $type: 'community.lexicon.book.contributor' as const,
          uri: r.uri,
          name: r.name,
          aliases: r.aliases,
          bio: r.bio,
          bornYear: r.bornYear,
          diedYear: r.diedYear,
          ...(r.linkedDid !== undefined ? { linkedDid: r.linkedDid } : {}),
          identifiers: r.identifiers,
          createdAt: r.createdAt,
        }));
        return json({ items, cursor: result.cursor, total: result.total } as unknown as CommunityLexiconBookSearchContributors.$output);
      } catch (e) {
        console.error('CONTRIBUTOR_HANDLER_ERR:', e, (e as Error)?.stack);
        throw e;
      }
    },
  });

  router.addQuery(CommunityLexiconBookSearchPublishers.mainSchema, {
    async handler({ params }: any) {
      const result = await searchService.searchPublishers({
        q: params.q,
        id: params.id,
        limit: Math.min(params.limit ?? 20, 100),
        cursor: params.cursor,
      });
      const items = result.items.map((r: any) => ({
        $type: 'community.lexicon.book.publisher' as const,
        uri: r.uri,
        name: r.name,
        imprintOf: r.imprintOf,
        foundingDate: r.foundingDate,
        closingDate: r.closingDate,
        identifiers: r.identifiers,
        createdAt: r.createdAt,
      }));
      return json({ items, cursor: result.cursor, total: result.total } as unknown as CommunityLexiconBookSearchPublishers.$output);
    },
  });
}
