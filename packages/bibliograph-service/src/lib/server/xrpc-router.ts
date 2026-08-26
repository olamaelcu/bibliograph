import { XRPCRouter, json } from '@atcute/xrpc-server';
import { cors } from '@atcute/xrpc-server/middlewares/cors';
import {
  ComAtprotoIdentityResolveDid,
  ComAtprotoIdentityResolveHandle,
  ComAtprotoIdentityResolveIdentity,
  ComAtprotoRepoDescribeRepo,
  ComAtprotoRepoGetRecord,
  ComAtprotoServerDescribeServer,
  ComAtprotoSyncGetBlocks,
  ComAtprotoSyncGetLatestCommit,
  ComAtprotoSyncGetRecord,
  ComAtprotoSyncGetRepo,
  ComAtprotoSyncGetRepoStatus,
} from '@atcute/atproto';
import {
  CommunityLexiconBookCompatibility,
  CommunityLexiconBookSearchContributors,
  CommunityLexiconBookSearchEditions,
  CommunityLexiconBookSearchPublishers,
  CommunityLexiconBookSearchWorks,
  NetOlamaelcuLivtetBiblioGetActorProfile,
  NetOlamaelcuLivtetBiblioGetReadingGoal,
  NetOlamaelcuLivtetBiblioGetShelf,
  NetOlamaelcuLivtetBiblioGetBookOnShelf,
  NetOlamaelcuLivtetBiblioListShelves,
  NetOlamaelcuLivtetBiblioListBooksOnShelf,
  NetOlamaelcuLivtetBiblioGetShelvingOfBook,
  NetOlamaelcuLivtetBiblioListShelvesWithBooks,
  NetOlamaelcuLivtetBiblioGetImageForBook,
  NetOlamaelcuLivtetBiblioGetImageForContributor,
  NetOlamaelcuLivtetBiblioGetEditionsByContributor,
  NetOlamaelcuLivtetBiblioShelf,
  NetOlamaelcuLivtetBiblioBookShelving,
  NetOlamaelcuLivtetBiblioDefs,
} from './lexicons/index.js';
import {
  fullRepoPath,
  LEX_COLLECTION,
  lexFilePath,
  readFullRepoCar,
  readPerRecordCar,
  resolveDid,
  resolveHandle,
} from './lex/publisher.js';
import { createLogger } from './logger';
import { accessLog } from './access-log';
import type { Logger } from 'pino';
import { pdsClient, resolvePds } from './pds/resolve.js';
import { readCar, MemoryBlockstore, MST, formatDataKey, parseObjByDef, def } from '@atproto/repo';
import { cidForLex, decode as cborDecode } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { getDidDocument, PUBLISHER_DID, PUBLISHER_HOSTNAME } from './did';
import { PostgresSource, findEditionUrisByContributor } from './search/postgres-source';
import { OpenLibrarySource } from './search/open-library-source';
import { GoogleBooksEnricher } from './search/google-books-enricher';
import { OpenLibraryEnricher } from './search/open-library-enricher';
import { GoogleBooksSource } from './search/google-books-source';
import { IsbndbEnricher, IsbndbWorkEnricher } from './search/isbndb-enricher';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './search/wikipedia-enricher';
import * as openLibraryApi from './api/open-library';
import { SearchService } from './search/service';
import { eq, inArray, and, sql } from 'drizzle-orm';
import { db } from './db';
import { editions, works, contributors, publishers, records } from './db/schema';
import * as v from 'valibot';
import { allowRequest } from './rate-limit';
import { getBacklinks } from './constellation/client';
import {
  hydrateShelvesByUri,
  hydrateBooksByUri,
  fetchBookShelvingRecord,
  resolveBookShelf,
  catalogEditionUriFromRkey,
} from './shelving/hydrate';
import { olidFromEditionRkey } from './ol/keys';
import { isGbRkey } from './gb/keys';
import { enqueueCoverBackfill } from './jobs/enqueue';
import { buildBookContributorViews } from './book-contributor-view';

export const log = createLogger('web');
log.info({ nodeEnv: process.env.NODE_ENV }, 'web process started');

const postgresSource = new PostgresSource(log);
const openLibrarySource = new OpenLibrarySource(log);
const googleBooksSource = new GoogleBooksSource(log);
const googleBooksEnricher = new GoogleBooksEnricher();
const openLibraryEnricher = new OpenLibraryEnricher();
const isbndbEnricher = new IsbndbEnricher();
const isbndbWorkEnricher = new IsbndbWorkEnricher();
const authorWikipediaEnricher = new AuthorWikipediaEnricher();
const contributorWikipediaEnricher = new ContributorWikipediaEnricher();
const searchService = new SearchService(
  {
    postgres: postgresSource,
    openLibrary: openLibrarySource,
    publisherSource: openLibraryApi,
    googleBooksSource,
    googleBooks: googleBooksEnricher,
    openLibraryEnricher,
    isbndbEnricher,
    isbndbWorkEnricher,
    authorWikipedia: authorWikipediaEnricher,
    contributorWikipedia: contributorWikipediaEnricher,
  },
  log,
);

/** Exported for SvelteKit load functions to call the same service the XRPC handlers use. */
export { searchService };

function rateLimitMiddleware(log: Logger) {
  return async (request: Request, next: (req: Request) => Promise<Response>): Promise<Response> => {
    const url = new URL(request.url);
    const m = /^\/xrpc\/([^/?]+)/.exec(url.pathname);
    const nsid = m?.[1] ?? null;
    if (!nsid) return next(request);
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      '0.0.0.0';
    if (!allowRequest(ip, nsid)) {
      log.warn({ ip, nsid }, 'rate limited');
      return new Response(JSON.stringify({ error: 'RateLimited', message: 'Too many requests' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      });
    }
    return next(request);
  };
}

export const router = new XRPCRouter({
  middlewares: [accessLog(log), cors(), rateLimitMiddleware(log)],
  handleHealthCheck: async () => json({ status: 'ok' }),
});

// Wrapped registrations: every addQuery / addProcedure call below bumps the
// counter AND writes the schema into a registry keyed by NSID, so the
// /queries and /query/[nsid] routes can render schema docs without a
// filesystem scan. Adding a new endpoint is the single source-of-truth edit.
export const endpointCounts = { queries: 0, procedures: 0 };
export const queryRegistry = new Map<string, unknown>();
export const procedureRegistry = new Map<string, unknown>();

type QuerySchema = Parameters<typeof router.addQuery>[0];
type QueryOpts = Parameters<typeof router.addQuery>[1];
const realAddQuery = router.addQuery.bind(router);
router.addQuery = ((schema: QuerySchema, opts: QueryOpts) => {
  const nsid = (schema as { nsid?: string }).nsid;
  // `com.atproto.*` is PDS infrastructure — keep the handler registered, but hide it
  // from the public /queries listing, the compatibility endpoint, and endpoint counts.
  if (nsid && !nsid.startsWith('com.atproto.')) {
    queryRegistry.set(nsid, schema);
    endpointCounts.queries++;
  }
  return realAddQuery(schema, opts);
}) as typeof router.addQuery;

const realAddProcedure = router.addProcedure?.bind(router);
if (realAddProcedure) {
  type ProcedureSchema = Parameters<NonNullable<typeof router.addProcedure>>[0];
  type ProcedureOpts = Parameters<NonNullable<typeof router.addProcedure>>[1];
  router.addProcedure = ((schema: ProcedureSchema, opts: ProcedureOpts) => {
    const nsid = (schema as { nsid?: string }).nsid;
    if (nsid && !nsid.startsWith('com.atproto.')) {
      procedureRegistry.set(nsid, schema);
      endpointCounts.procedures++;
    }
    return realAddProcedure(schema, opts);
  }) as typeof router.addProcedure;
}

router.addQuery(CommunityLexiconBookSearchEditions.mainSchema, {
  async handler({ params }) {
    const result = await searchService.searchEditions({
      q: params.q,
      id: params.id,
      limit: Math.min(params.limit ?? 20, 100),
      cursor: params.cursor,
    });
    const items = result.items.map((r) => ({
      $type: 'community.lexicon.book.edition' as const,
      uri: r.uri,
      title: r.title,
      subtitle: r.subtitle,
      coverImageUrl: r.coverImageUrl,
      publisher: undefined,
      place: r.place,
      publishedYear: r.publishedYear,
      language: r.language,
      contributors: r.contributors,
      identifiers: r.identifiers,
      description: r.description,
      createdAt: r.createdAt,
    }));
    return json({ items, cursor: result.cursor, total: result.total } as unknown as CommunityLexiconBookSearchEditions.$output);
  },
});

router.addQuery(CommunityLexiconBookCompatibility.mainSchema, {
  async handler() {
    // Derive from the registries populated by the wrappers above so the
    // list stays in sync with the public API. The introspection endpoint
    // itself is excluded — listing it would be self-referential.
    const SELF = 'community.lexicon.book.compatibility';
    const AUTHORITY = 'community.lexicon.book.';
    const queries: { nsid: string; type: 'query' | 'procedure' }[] = [];
    for (const nsid of queryRegistry.keys()) {
      if (nsid === SELF || !nsid.startsWith(AUTHORITY)) continue;
      queries.push({ nsid, type: 'query' });
    }
    for (const nsid of procedureRegistry.keys()) {
      if (!nsid.startsWith(AUTHORITY)) continue;
      queries.push({ nsid, type: 'procedure' });
    }
    return json({ queries } as unknown as CommunityLexiconBookCompatibility.$output);
  },
});

const notImplemented = (nsid: string) =>
  new Response(
    JSON.stringify({ error: 'NotImplemented', message: `${nsid} is not implemented by this AppView` }),
    { status: 501, headers: { 'content-type': 'application/json' } },
  );

router.addQuery(CommunityLexiconBookSearchWorks.mainSchema, {
  async handler({ params }) {
    const result = await searchService.searchWorks({
      q: params.q,
      id: params.id,
      limit: Math.min(params.limit ?? 20, 100),
      cursor: params.cursor,
    });
    const items = result.items.map((r) => ({
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
  async handler({ params }) {
    try {
      const result = await searchService.searchContributors({
        q: params.q,
        id: params.id,
        limit: Math.min(params.limit ?? 20, 100),
        cursor: params.cursor,
      });
      const items = result.items.map((r) => ({
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
      const j = json({ items, cursor: result.cursor, total: result.total } as unknown as CommunityLexiconBookSearchContributors.$output);
      return j;
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
    const items = result.items.map((r) => ({
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

// ─── Lex publisher endpoints ────────────────────────────────────────────────
// Serves com.atproto.sync.* and com.atproto.identity.* over prebuilt CAR files
// (see scripts/build-lex-repo.ts). The DID document at /.well-known/did.json
// advertises this host as the #atproto_pds for the publisher DID.

const carResponse = (body: Uint8Array): Response =>
  new Response(body as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.ipld.car',
      'cache-control': 'public, max-age=60, s-maxage=300',
    },
  });

const notFoundResponse = (error: string, message: string): Response =>
  new Response(JSON.stringify({ error, message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

const invalidContributorResponse = (contributor: string): Response =>
  new Response(
    JSON.stringify({ error: 'InvalidContributor', message: `not a contributor at-uri: ${contributor}` }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );

async function readLatestCommit(): Promise<{ cid: string; rev: string } | null> {
  const file = await readFullRepoCar();
  if (!file) return null;
  const parsed = await readCar(file.body);
  const commitCid = parsed.roots[0];
  if (!commitCid) return null;
  const commitBytes = parsed.blocks.get(commitCid);
  if (!commitBytes) return null;
  const { obj: commit } = parseObjByDef(commitBytes, commitCid, def.commit);
  return { cid: commitCid.toString(), rev: commit.rev };
}

router.addQuery(ComAtprotoIdentityResolveHandle.mainSchema, {
  async handler({ params }) {
    const id = resolveHandle(params.handle);
    if (!id) return notFoundResponse('HandleNotFound', `handle "${params.handle}" is not hosted by this PDS`);
    return json({ did: id.did } as unknown as ComAtprotoIdentityResolveHandle.$output);
  },
});

router.addQuery(ComAtprotoIdentityResolveDid.mainSchema, {
  async handler({ params }) {
    const id = resolveDid(params.did);
    if (!id) return notFoundResponse('DidNotFound', `DID "${params.did}" is not hosted by this PDS`);
    return json({ did: id.did } as unknown as ComAtprotoIdentityResolveDid.$output);
  },
});

router.addQuery(ComAtprotoIdentityResolveIdentity.mainSchema, {
  async handler({ params }) {
    const id = params.identifier.startsWith('did:')
      ? resolveDid(params.identifier)
      : resolveHandle(params.identifier);
    if (!id) {
      const errorKey = params.identifier.startsWith('did:') ? 'DidNotFound' : 'HandleNotFound';
      return notFoundResponse(errorKey, `${errorKey === 'DidNotFound' ? 'DID' : 'handle'} "${params.identifier}" is not hosted by this PDS`);
    }
    return json({
      did: id.did,
      handle: id.handle,
      didDoc: undefined,
    } as unknown as ComAtprotoIdentityResolveIdentity.$output);
  },
});

router.addQuery(ComAtprotoSyncGetRecord.mainSchema, {
  async handler({ params }) {
    if (params.collection !== LEX_COLLECTION) {
      return notFoundResponse('RecordNotFound', `collection "${params.collection}" not served`);
    }
    const file = await readPerRecordCar(params.rkey);
    if (!file) return notFoundResponse('RecordNotFound', `no CAR slice for rkey "${params.rkey}"`);
    return carResponse(file.body);
  },
});

router.addQuery(ComAtprotoSyncGetRepo.mainSchema, {
  async handler() {
    const file = await readFullRepoCar();
    if (!file) return notFoundResponse('RepoNotFound', 'no full.car published yet');
    return carResponse(file.body);
  },
});

router.addQuery(ComAtprotoSyncGetRepoStatus.mainSchema, {
  async handler() {
    const commit = await readLatestCommit();
    if (!commit) return notFoundResponse('RepoNotFound', 'no full.car published yet');
    return json({
      did: process.env.LEX_PUBLISHER_DID ?? PUBLISHER_DID,
      rev: commit.rev,
    } as unknown as ComAtprotoSyncGetRepoStatus.$output);
  },
});

router.addQuery(ComAtprotoServerDescribeServer.mainSchema, {
  async handler() {
    return json({
      availableUserDomains: [PUBLISHER_HOSTNAME],
      inviteCodeRequired: true,
      did: PUBLISHER_DID,
      links: {
        privacyPolicy: 'https://livtet.olamaelcu.net/privacy',
        termsOfService: 'https://livtet.olamaelcu.net/terms',
      },
    } as unknown as ComAtprotoServerDescribeServer.$output);
  },
});

router.addQuery(ComAtprotoSyncGetLatestCommit.mainSchema, {
  async handler({ params }) {
    if (!resolveDid(params.did)) {
      return notFoundResponse('RepoNotFound', `repo "${params.did}" is not hosted`);
    }
    const commit = await readLatestCommit();
    if (!commit) return notFoundResponse('RepoNotFound', 'no full.car published yet');
    return json(commit as unknown as ComAtprotoSyncGetLatestCommit.$output);
  },
});

router.addQuery(ComAtprotoSyncGetBlocks.mainSchema, {
  async handler() {
    // Static-file publisher: returns the full repo CAR; callers can CAR-trim
    // themselves. The canonical lexicon resolver does not call this endpoint
    // directly; it's here for protocol completeness.
    const file = await readFullRepoCar();
    if (!file) return notFoundResponse('RepoNotFound', 'no full.car published yet');
    return carResponse(file.body);
  },
});

// ─── com.atproto.repo.* handlers ─────────────────────────────────────────────
// JSON views of the records served by this PDS. pdsls.dev (and many legacy
// clients) call com.atproto.repo.getRecord with the same path as the sync
// equivalent; this serves the record value as JSON {uri, cid, value} instead
// of a CAR.

async function serveBookRecordFromDb(
  repo: string,
  collection: string,
  rkey: string,
): Promise<Response> {
  if (repo !== PUBLISHER_DID) {
    return notFoundResponse('RecordNotFound', `repo "${repo}" not hosted`);
  }
  const uri = `at://${repo}/${collection}/${rkey}`;
  if (collection === 'community.lexicon.book.edition') {
    const [row] = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
    if (!row) return notFoundResponse('RecordNotFound', `no row for ${uri}`);
    const bookContributors = await buildBookContributorViews(uri, row.contributors);
    const value = {
      $type: 'community.lexicon.book.edition',
      uri,
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      place: row.place ?? undefined,
      publishedYear: row.publishedYear ?? undefined,
      language: row.language ?? undefined,
      coverImageUrl: row.coverImageUrl ?? undefined,
      contributors: bookContributors,
      identifiers: row.identifiers ?? [],
      description: row.description ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
    const cid = await cidForLex(value as unknown as LexMap);
    return json({ uri, cid: cid.toString(), value } as unknown as ComAtprotoRepoGetRecord.$output);
  }
  if (collection === 'community.lexicon.book.work') {
    const [row] = await db.select().from(works).where(eq(works.uri, uri)).limit(1);
    if (!row) return notFoundResponse('RecordNotFound', `no row for ${uri}`);
    const bookContributors = await buildBookContributorViews(uri, row.contributors);
    const value = {
      $type: 'community.lexicon.book.work',
      uri,
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      originalLanguage: row.originalLanguage ?? undefined,
      firstPublishedYear: row.firstPublishedYear ?? undefined,
      subjects: row.subjects ?? [],
      contributors: bookContributors,
      identifiers: row.identifiers ?? [],
      description: row.description ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
    const cid = await cidForLex(value as unknown as LexMap);
    return json({ uri, cid: cid.toString(), value } as unknown as ComAtprotoRepoGetRecord.$output);
  }
  // community.lexicon.book.publisher
  if (collection === 'community.lexicon.book.publisher') {
    const [row] = await db.select().from(publishers).where(eq(publishers.uri, uri)).limit(1);
    if (!row) return notFoundResponse('RecordNotFound', `no row for ${uri}`);
    const value = {
      $type: 'community.lexicon.book.publisher',
      uri,
      name: row.name,
      imprintOf:
        row.imprintOfUri && row.imprintOfCid
          ? { uri: row.imprintOfUri, cid: row.imprintOfCid }
          : undefined,
      foundingDate: row.foundingDate ?? undefined,
      closingDate: row.closingDate ?? undefined,
      identifiers: row.identifiers ?? [],
      createdAt: row.createdAt.toISOString(),
    };
    const cid = await cidForLex(value as unknown as LexMap);
    return json({ uri, cid: cid.toString(), value } as unknown as ComAtprotoRepoGetRecord.$output);
  }
  // community.lexicon.book.contributor
  const [row] = await db.select().from(contributors).where(eq(contributors.uri, uri)).limit(1);
  if (!row) return notFoundResponse('RecordNotFound', `no row for ${uri}`);
  const value = {
    $type: 'community.lexicon.book.contributor',
    uri,
    name: row.name,
    aliases: row.aliases ?? [],
    bio: row.bio ?? undefined,
    bornYear: row.bornYear ?? undefined,
    diedYear: row.diedYear ?? undefined,
    linkedDid: row.linkedDid ?? undefined,
    identifiers: row.identifiers ?? [],
    createdAt: row.createdAt.toISOString(),
  };
  const cid = await cidForLex(value as unknown as LexMap);
  return json({ uri, cid: cid.toString(), value } as unknown as ComAtprotoRepoGetRecord.$output);
}


router.addQuery(ComAtprotoRepoGetRecord.mainSchema, {
  async handler({ params }) {
    if (!resolveDid(params.repo)) {
      return notFoundResponse('RepoNotFound', `repo "${params.repo}" is not hosted`);
    }
    const BOOK_COLLECTIONS = new Set([
      'community.lexicon.book.edition',
      'community.lexicon.book.work',
      'community.lexicon.book.contributor',
      'community.lexicon.book.publisher',
    ]);
    if (BOOK_COLLECTIONS.has(params.collection)) {
      return await serveBookRecordFromDb(params.repo, params.collection, params.rkey);
    }
    if (params.collection !== LEX_COLLECTION) {
      return notFoundResponse('RecordNotFound', `collection "${params.collection}" not served`);
    }
    const slice = await readPerRecordCar(params.rkey);
    if (!slice) {
      return notFoundResponse('RecordNotFound', `no CAR slice for rkey "${params.rkey}"`);
    }
    const parsed = await readCar(slice.body);
    const commitCid = parsed.roots[0];
    if (!commitCid) return notFoundResponse('RepoNotFound', 'CAR missing root');
    const commitBytes = parsed.blocks.get(commitCid);
    if (!commitBytes) return notFoundResponse('RepoNotFound', 'commit block missing');
    const { obj: commit } = parseObjByDef(commitBytes, commitCid, def.commit);
    const store = new MemoryBlockstore();
    store.blocks.addMap(parsed.blocks);
    const mst = MST.load(store, commit.data);
    const dataKey = formatDataKey(params.collection, params.rkey);
    const cids = await mst.cidsForPath(dataKey);
    // cidsForPath returns [mstRootCid, ..., recordCid] — the record CID is the last.
    if (cids.length < 2) {
      return notFoundResponse('RecordNotFound', `rkey "${params.rkey}" not in commit`);
    }
    const recordCid = cids[cids.length - 1]!;
    const recordBytes = parsed.blocks.get(recordCid);
    if (!recordBytes) return notFoundResponse('RepoNotFound', 'record block missing');
    return json({
      uri: `at://${params.repo}/${params.collection}/${params.rkey}`,
      cid: recordCid.toString(),
      value: cborDecode(recordBytes),
    } as unknown as ComAtprotoRepoGetRecord.$output);
  },
});

router.addQuery(ComAtprotoRepoDescribeRepo.mainSchema, {
  async handler({ params }) {
    const id = params.repo.startsWith('did:')
      ? resolveDid(params.repo)
      : resolveHandle(params.repo);
    if (!id) {
      return notFoundResponse('RepoNotFound', `repo "${params.repo}" is not hosted`);
    }
    const didDoc = getDidDocument();
    const handle = didDoc.alsoKnownAs[0]?.replace(/^at:\/\//, '') ?? '';
    return json({
      did: didDoc.id,
      didDoc: didDoc as unknown as Record<string, unknown>,
      handle,
      handleIsCorrect: true,
      collections: [LEX_COLLECTION],
    } as unknown as ComAtprotoRepoDescribeRepo.$output);
  },
});

// ─── User-owned record reads (Livtet AppView client refactor) ───────────────
// These procedures read records the user wrote to their OWN PDS. Bibliograph
// resolves the user's PDS via the DID document and reads anonymously. Caching
// (Postgres tables + tap-consumer ingestion) for the list/aggregate queries
// is a follow-up — these first two are simple on-read hydrations.

const PDS_READ_TIMEOUT_MS = 10_000;

interface PdsRecordResponse {
  uri: string;
  cid?: string;
  value: Record<string, unknown>;
}

function isRecordResponse(value: unknown): value is PdsRecordResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as { ok?: unknown; data?: unknown; uri?: unknown; value?: unknown };
  if (v.ok === true) {
    const d = v.data;
    if (!d || typeof d !== 'object') return false;
    const r = d as Record<string, unknown>;
    return typeof r.uri === 'string' && typeof r.value === 'object' && r.value !== null;
  }
  return typeof v.uri === 'string' && typeof v.value === 'object' && v.value !== null;
}

interface PdsListRecordsResponse {
  records: Array<{ uri: string; cid?: string; value: Record<string, unknown> }>;
  cursor?: string;
}

const PdsListRecordSchema = v.object({
  uri: v.string(),
  cid: v.optional(v.string()),
  value: v.record(v.string(), v.unknown()),
});
const PdsListRecordsSchema = v.object({
  records: v.array(PdsListRecordSchema),
  cursor: v.optional(v.string()),
});

function safeParseListRecords(raw: unknown): { ok: true; data: PdsListRecordsResponse } | { ok: false; issues: ReadonlyArray<{ message: string; path?: unknown }> } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, issues: [{ message: 'raw is not an object' }] };
  }
  const wrapper = raw as { ok?: unknown; data?: unknown };
  const inner = wrapper.ok === true && wrapper.data && typeof wrapper.data === 'object'
    ? wrapper.data
    : raw;
  const result = v.safeParse(PdsListRecordsSchema, inner);
  if (result.success) {
    return { ok: true, data: { records: result.output.records, cursor: result.output.cursor } };
  }
  return { ok: false, issues: result.issues.map((i) => ({ message: i.message, path: i.path })) };
}

router.addQuery(NetOlamaelcuLivtetBiblioGetReadingGoal.mainSchema, {
  async handler({ params }) {
    let raw: unknown;
    try {
      const { client } = await pdsClient(params.did);
      raw = await client.get('com.atproto.repo.getRecord', {
        params: {
          repo: params.did,
          collection: 'net.olamaelcu.livtet.biblio.readingGoal',
          rkey: 'current',
        },
        signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // RecordNotFound (HTTP 400 with the PDS-specific body) means the user
      // hasn't written a reading goal yet. That's not an error — return null.
      if (/RecordNotFound/i.test(message)) {
        return Response.json({ goal: null });
      }
      log.warn({ err, did: params.did }, 'getReadingGoal: PDS read failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }

    if (!isRecordResponse(raw)) {
      log.warn({ did: params.did, raw }, 'getReadingGoal: unexpected PDS response shape');
      return Response.json({ goal: null });
    }
    return json({ goal: raw.value as NetOlamaelcuLivtetBiblioGetReadingGoal.$output['goal'] } as unknown as NetOlamaelcuLivtetBiblioGetReadingGoal.$output);
  },
});

router.addQuery(NetOlamaelcuLivtetBiblioGetActorProfile.mainSchema, {
  async handler({ params }) {
    let raw: unknown;
    try {
      const { client } = await pdsClient(params.did);
      raw = await client.get('com.atproto.repo.getRecord', {
        params: {
          repo: params.did,
          collection: 'net.olamaelcu.livtet.biblio.actorProfile',
          rkey: 'self',
        },
        signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/RecordNotFound/i.test(message)) {
        return Response.json({ profile: null });
      }
      log.warn({ err, did: params.did }, 'getActorProfile: PDS read failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }

    if (!isRecordResponse(raw)) {
      log.warn({ did: params.did, raw }, 'getActorProfile: unexpected PDS response shape');
      return Response.json({ profile: null });
    }
    return json({ profile: raw.value as NetOlamaelcuLivtetBiblioGetActorProfile.$output['profile'] } as unknown as NetOlamaelcuLivtetBiblioGetActorProfile.$output);
  },
});
// Shelving and image queries
function parseDidFromUri(uri: string): string {
  const m = /^at:\/\/(did:[^/]+)/.exec(uri);
  if (!m) throw new Error(`Invalid AT-URI: ${uri}`);
  return m[1]!;
}

router.addQuery(NetOlamaelcuLivtetBiblioGetShelf.mainSchema, {
  async handler({ params }) {
    const uri = params.uri as string;
    const did = parseDidFromUri(uri);
    try {
      const { client } = await pdsClient(did);
      const raw = await client.get('com.atproto.repo.getRecord', {
        params: { repo: did as `did:${string}:${string}`, collection: 'net.olamaelcu.livtet.biblio.shelf', rkey: uri.split('/').pop()! },
        signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
      });
      if (!isRecordResponse(raw)) {
        return Response.json({ error: 'RecordNotResolved', message: 'PDS record missing' }, { status: 404 });
      }
      const shelf = raw.value as unknown as NetOlamaelcuLivtetBiblioDefs.ShelfView;
      return json({ shelf } as NetOlamaelcuLivtetBiblioGetShelf.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/RecordNotFound/i.test(message)) {
        return Response.json({ error: 'RecordNotFound', message }, { status: 404 });
      }
      log.warn({ err, did, uri }, 'getShelf: PDS read failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

router.addQuery(NetOlamaelcuLivtetBiblioListShelves.mainSchema, {
  async handler({ params }) {
    const { did, limit = 50, cursor } = params;
    try {
      const cacheRows = await db
        .select()
        .from(records)
        .where(
          and(
            eq(records.did, did as string),
            eq(records.collection, 'net.olamaelcu.livtet.biblio.shelf'),
          ),
        )
        .limit(limit + 1);
      const hasMore = cacheRows.length > limit;
      let merged = hasMore ? cacheRows.slice(0, limit) : cacheRows;
      let tier = 'tap' as 'tap' | 'pds';

      if (merged.length < limit && !cursor) {
        tier = 'pds';
        try {
          const { client } = await pdsClient(did);
          const raw = await client.get('com.atproto.repo.listRecords', {
            params: { repo: did as `did:${string}:${string}`, collection: 'net.olamaelcu.livtet.biblio.shelf', limit, cursor },
            signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
          });
          const parsed = safeParseListRecords(raw);
          if (!parsed.ok) {
            log.warn({ stage: 'listShelves.parse', did, issues: parsed.issues }, 'listRecords response did not match schema');
          }
          if (parsed.ok) {
            const { records: pdsRecords, cursor: pdsCursor } = parsed.data;
            const fetched = pdsRecords.map((r) => ({
              uri: r.uri,
              cid: 'bafyplaceholder',
              did: did as string,
              rkey: r.uri.split('/').pop() ?? '',
              collection: 'net.olamaelcu.livtet.biblio.shelf',
              value: r.value as never,
              createdAt: new Date(),
              indexedAt: new Date(),
            }));
            const seen = new Set(merged.map((r) => r.uri));
            for (const row of fetched) if (!seen.has(row.uri)) merged.push(row);
          }
        } catch (err: unknown) {
          log.warn({ err, did }, 'listShelves: PDS scan failed (cache-only result returned)');
        }
      }

      const shelves = merged.map((r) => ({
        uri: r.uri as `${string}:${string}`,
        name: ((r.value as { name?: string }).name) ?? '',
        $type: 'net.olamaelcu.livtet.biblio.defs#shelfView' as const,
      }));
      const outCursor = tier === 'tap' && hasMore ? String(merged.length) : undefined;
      return json({ shelves, cursor: outCursor } as NetOlamaelcuLivtetBiblioListShelves.$output);
    } catch (err: unknown) {
      log.warn({ err, did }, 'listShelves: failed');
      return json({ shelves: [], cursor: undefined } as NetOlamaelcuLivtetBiblioListShelves.$output);
    }
  },
});

router.addQuery(NetOlamaelcuLivtetBiblioGetImageForBook.mainSchema, {
  async handler({ params }) {
    const uri = params.uri as string;
    if (!uri) {
      return Response.json({ error: 'InvalidRequest', message: 'uri is required' }, { status: 400 });
    }
    const rkey = uri.split('/').pop() ?? '';
    const isOl = rkey.startsWith('ol.');
    const isGb = rkey.startsWith('gb.');
    if (isOl) {
      try { olidFromEditionRkey(rkey); } catch {
        return Response.json({ error: 'InvalidRequest', message: `invalid edition rkey: ${rkey}` }, { status: 400 });
      }
    } else if (isGb) {
      if (!isGbRkey(rkey)) {
        return Response.json({ error: 'InvalidRequest', message: `invalid edition rkey: ${rkey}` }, { status: 400 });
      }
    } else {
      return Response.json({ error: 'InvalidRequest', message: `invalid edition rkey: ${rkey}` }, { status: 400 });
    }

    const [row] = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
    if (!row) {
      return Response.json({ error: 'RecordNotFound', message: `no edition at ${uri}` }, { status: 404 });
    }
    if (row.coverImageUrl) {
      return json({ url: row.coverImageUrl } as NetOlamaelcuLivtetBiblioGetImageForBook.$output);
    }
    void enqueueCoverBackfill(uri, rkey).catch((err) => {
      log.warn({ err, uri, rkey, stage: 'getImageForBook.enqueue' }, 'cover backfill enqueue failed');
    });
    return json({ url: undefined } as NetOlamaelcuLivtetBiblioGetImageForBook.$output);
  },
});

router.addQuery(NetOlamaelcuLivtetBiblioGetImageForContributor.mainSchema, {
  async handler({ params }) {
    return json({ url: undefined } as NetOlamaelcuLivtetBiblioGetImageForContributor.$output);
  },
});

router.addQuery(NetOlamaelcuLivtetBiblioGetEditionsByContributor.mainSchema, {
  async handler({ params }) {
    const contributor = params.contributor;
    if (!/^at:\/\/[^/]+\/community\.lexicon\.book\.contributor\//.test(contributor)) {
      return invalidContributorResponse(contributor);
    }
    const limit = Math.min(params.limit ?? 20, 100);
    const uris = await findEditionUrisByContributor(contributor, limit);
    return json({ uris } as unknown as NetOlamaelcuLivtetBiblioGetEditionsByContributor.$output);
  },
});

router.addQuery(NetOlamaelcuLivtetBiblioGetShelvingOfBook.mainSchema, {
  async handler({ params }) {
    const bookUri = params.book as string;
    const { did, limit = 50, cursor } = params;
    try {
      const cacheRows = await db
        .select()
        .from(records)
        .where(
          and(
            eq(records.did, did as string),
            eq(records.collection, 'net.olamaelcu.livtet.biblio.bookShelving'),
            sql`${records.value}->'book'->>'uri' = ${bookUri}`,
          ),
        )
        .limit(limit + 1);
      const hasMore = cacheRows.length > limit;
      let merged = hasMore ? cacheRows.slice(0, limit) : cacheRows;
      let tier = 'tap' as 'tap' | 'constellation' | 'pds';

      if (merged.length < limit && !cursor) {
        const backlinks = await getBacklinks({
          subject: bookUri,
          source: 'net.olamaelcu.livtet.biblio.bookShelving:book.ref',
          did: did as string,
          limit,
        });
        if (backlinks.records.length > 0) {
          tier = 'constellation';
          const seen = new Set(merged.map((r) => r.uri));
          for (const bl of backlinks.records) {
            if (seen.has(bl.uri)) continue;
            const row = await fetchBookShelvingRecord(bl.uri, bl.did, AbortSignal.timeout(PDS_READ_TIMEOUT_MS));
            if (row) merged.push(row);
            if (merged.length >= limit) break;
          }
          if (backlinks.cursor && merged.length >= limit) {
            return json({
              bookShelves: await hydrateBookShelves(merged, bookUri),
              cursor: backlinks.cursor,
            } as NetOlamaelcuLivtetBiblioGetShelvingOfBook.$output);
          }
        }
      }

      if (merged.length < limit && !cursor) {
        tier = 'pds';
        try {
          const { client } = await pdsClient(did);
          let cur: string | undefined;
          const fetched: typeof merged = [];
          while (fetched.length < limit) {
            const page = await client.get('com.atproto.repo.listRecords', {
              params: { repo: did as `did:${string}:${string}`, collection: 'net.olamaelcu.livtet.biblio.bookShelving', limit, cursor: cur },
              signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
            });
            const parsed = safeParseListRecords(page);
            if (!parsed.ok) {
              log.warn({ stage: 'getShelvingOfBook.parse', did, bookUri, issues: parsed.issues }, 'listRecords response did not match schema');
              break;
            }
            const recs = parsed.data.records;
            cur = parsed.data.cursor;
            for (const r of recs) {
              const bookRef = (r.value.book as { uri?: string } | undefined)?.uri;
              if (bookRef === bookUri) {
                fetched.push({
                  uri: r.uri,
                  cid: 'bafyplaceholder',
                  did: did as string,
                  rkey: r.uri.split('/').pop() ?? '',
                  collection: 'net.olamaelcu.livtet.biblio.bookShelving',
                  value: r.value as never,
                  createdAt: new Date(),
                  indexedAt: new Date(),
                });
              }
              if (fetched.length >= limit) break;
            }
            if (!cur) break;
          }
          const seen = new Set(merged.map((r) => r.uri));
          for (const row of fetched) if (!seen.has(row.uri)) merged.push(row);
        } catch (err: unknown) {
          log.warn({ err, did, bookUri }, 'getShelvingOfBook: PDS scan failed (cache+constellation only)');
        }
      }

      const bookShelves = await hydrateBookShelves(merged, bookUri);
      const outCursor = tier === 'tap' && hasMore ? String(merged.length) : undefined;
      return json({ bookShelves, cursor: outCursor } as NetOlamaelcuLivtetBiblioGetShelvingOfBook.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, did, bookUri }, 'getShelvingOfBook: failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

router.addQuery(NetOlamaelcuLivtetBiblioListBooksOnShelf.mainSchema, {
  async handler({ params }) {
    const shelfUri = params.shelf as string;
    const { limit = 50, cursor } = params;
    let did: string;
    try {
      did = parseDidFromUri(shelfUri);
    } catch {
      return Response.json({ error: 'InvalidRequest', message: 'shelf must be an AT-URI' }, { status: 400 });
    }
    try {
      const cacheRows = await db
        .select()
        .from(records)
        .where(
          and(
            eq(records.did, did),
            eq(records.collection, 'net.olamaelcu.livtet.biblio.bookShelving'),
            sql`${records.value}->>'shelf' = ${shelfUri}`,
          ),
        )
        .limit(limit + 1);
      const hasMore = cacheRows.length > limit;
      let merged = hasMore ? cacheRows.slice(0, limit) : cacheRows;
      let tier = 'tap' as 'tap' | 'constellation' | 'pds';

      if (merged.length < limit && !cursor) {
        const backlinks = await getBacklinks({
          subject: shelfUri,
          source: 'net.olamaelcu.livtet.biblio.bookShelving:shelf',
          did,
          limit,
        });
        if (backlinks.records.length > 0) {
          tier = 'constellation';
          const seen = new Set(merged.map((r) => r.uri));
          for (const bl of backlinks.records) {
            if (seen.has(bl.uri)) continue;
            const row = await fetchBookShelvingRecord(bl.uri, bl.did, AbortSignal.timeout(PDS_READ_TIMEOUT_MS));
            if (row) merged.push(row);
            if (merged.length >= limit) break;
          }
          if (backlinks.cursor && merged.length >= limit) {
            return json({
              bookShelves: await hydrateBookShelves(merged),
              cursor: backlinks.cursor,
            } as NetOlamaelcuLivtetBiblioListBooksOnShelf.$output);
          }
        }
      }

      if (merged.length < limit && !cursor) {
        tier = 'pds';
        try {
          const { client } = await pdsClient(did);
          let cur: string | undefined;
          const fetched: typeof merged = [];
          while (fetched.length < limit) {
            const page = await client.get('com.atproto.repo.listRecords', {
              params: { repo: did as `did:${string}:${string}`, collection: 'net.olamaelcu.livtet.biblio.bookShelving', limit, cursor: cur },
              signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
            });
            const parsed = safeParseListRecords(page);
            if (!parsed.ok) {
              log.warn({ stage: 'listBooksOnShelf.parse', did, shelfUri, issues: parsed.issues }, 'listRecords response did not match schema');
              break;
            }
            const recs = parsed.data.records;
            cur = parsed.data.cursor;
            for (const r of recs) {
              const shelfRef = (r.value.shelf as string | undefined);
              if (shelfRef === shelfUri) {
                fetched.push({
                  uri: r.uri,
                  cid: 'bafyplaceholder',
                  did,
                  rkey: r.uri.split('/').pop() ?? '',
                  collection: 'net.olamaelcu.livtet.biblio.bookShelving',
                  value: r.value as never,
                  createdAt: new Date(),
                  indexedAt: new Date(),
                });
              }
              if (fetched.length >= limit) break;
            }
            if (!cur) break;
          }
          const seen = new Set(merged.map((r) => r.uri));
          for (const row of fetched) if (!seen.has(row.uri)) merged.push(row);
        } catch (err: unknown) {
          log.warn({ err, did, shelfUri }, 'listBooksOnShelf: PDS scan failed (cache+constellation only)');
        }
      }

      const bookShelves = await hydrateBookShelves(merged);
      const outCursor = tier === 'tap' && hasMore ? String(merged.length) : undefined;
      return json({ bookShelves, cursor: outCursor } as NetOlamaelcuLivtetBiblioListBooksOnShelf.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, did, shelfUri }, 'listBooksOnShelf: failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

router.addQuery(NetOlamaelcuLivtetBiblioGetBookOnShelf.mainSchema, {
  async handler({ params }) {
    const uri = params.uri as string;
    let did: string;
    try {
      did = parseDidFromUri(uri);
    } catch {
      return Response.json({ error: 'InvalidRequest', message: 'uri must be an AT-URI' }, { status: 400 });
    }
    try {
      let row = await fetchBookShelvingRecord(uri, did, AbortSignal.timeout(PDS_READ_TIMEOUT_MS));
      if (!row) {
        return Response.json({ error: 'RecordNotFound', message: `no bookShelving record at ${uri}` }, { status: 404 });
      }
      const [view] = await hydrateBookShelves([row]);
      if (!view) {
        const fallbackUri = catalogEditionUriFromRkey(row.rkey);
        return Response.json(
          { error: 'RecordNotFound', message: `bookShelving record's book not resolvable in catalog${fallbackUri ? ` (tried ${fallbackUri})` : ''}` },
          { status: 404 },
        );
      }
      return json({ bookShelf: view } as NetOlamaelcuLivtetBiblioGetBookOnShelf.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, did, uri }, 'getBookOnShelf: failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

async function hydrateBookShelves(rows: Array<typeof records.$inferSelect>, bookUriHint?: string): Promise<NetOlamaelcuLivtetBiblioDefs.BookShelfView[]> {
  if (rows.length === 0) return [];
  const shelfUris = Array.from(new Set(rows.map((r) => (r.value as { shelf?: string }).shelf).filter((u): u is string => !!u)));
  const bookUris = Array.from(new Set([
    bookUriHint,
    ...rows.flatMap((r) => {
      const explicit = (r.value as { book?: { uri?: string } }).book?.uri;
      if (explicit) return [explicit];
      return [catalogEditionUriFromRkey(r.rkey)].filter((u): u is string => !!u);
    }),
  ].filter((u): u is string => !!u)));
  const [shelfMap, bookMap] = await Promise.all([hydrateShelvesByUri(shelfUris), hydrateBooksByUri(bookUris)]);
  const out: NetOlamaelcuLivtetBiblioDefs.BookShelfView[] = [];
  for (const r of rows) {
    const resolved = resolveBookShelf(r, bookMap, shelfMap);
    if (!resolved.ok) {
      log.warn(
        {
          stage: 'hydrateBookShelves.orphan',
          uri: r.uri,
          rkey: r.rkey,
          did: r.did,
          reason: resolved.reason,
        },
        'dropping bookShelving row: book not resolvable in catalog',
      );
      continue;
    }
    out.push(resolved.view!);
  }
  return out;
}
