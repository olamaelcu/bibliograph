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
import { PostgresSource } from './search/postgres-source';
import { OpenLibrarySource } from './search/open-library-source';
import { GoogleBooksEnricher } from './search/google-books-enricher';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './search/wikipedia-enricher';
import { LocalPostgresIngestor } from './search/local-postgres-ingestor';
import { SearchService } from './search/service';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { editions, works, contributors, publishers } from './db/schema';
import { allowRequest } from './rate-limit';

export const log = createLogger('web');
log.info({ nodeEnv: process.env.NODE_ENV }, 'web process started');

const postgresSource = new PostgresSource(log);
const openLibrarySource = new OpenLibrarySource(log);
const googleBooksEnricher = new GoogleBooksEnricher();
const authorWikipediaEnricher = new AuthorWikipediaEnricher();
const contributorWikipediaEnricher = new ContributorWikipediaEnricher();
const searchService = new SearchService(
  {
    postgres: postgresSource,
    openLibrary: openLibrarySource,
    googleBooks: googleBooksEnricher,
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
    const result = await searchService.searchContributors({
      q: params.q,
      id: params.id,
      limit: Math.min(params.limit ?? 20, 100),
      cursor: params.cursor,
    });
    const items = result.items.map((r) => ({
      $type: 'community.lexicon.book.contributor' as const,
      name: r.name,
      aliases: r.aliases,
      bio: r.bio,
      bornYear: r.bornYear,
      diedYear: r.diedYear,
      linkedDid: r.linkedDid,
      identifiers: r.identifiers,
      createdAt: r.createdAt,
    }));
    return json({ items, cursor: result.cursor, total: result.total } as unknown as CommunityLexiconBookSearchContributors.$output);
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
    const value = {
      $type: 'community.lexicon.book.edition',
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      place: row.place ?? undefined,
      publishedYear: row.publishedYear ?? undefined,
      language: row.language ?? undefined,
      coverImageUrl: row.coverImageUrl ?? undefined,
      contributors: row.contributors ?? [],
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
    const value = {
      $type: 'community.lexicon.book.work',
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      originalLanguage: row.originalLanguage ?? undefined,
      firstPublishedYear: row.firstPublishedYear ?? undefined,
      subjects: row.subjects ?? [],
      contributors: row.contributors ?? [],
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
  const v = value as Record<string, unknown>;
  return typeof v.uri === 'string' && typeof v.value === 'object' && v.value !== null;
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

// Remaining procedures (getActorStats, listShelvesForDid, listShelvingForDid,
// listReviewsForDid, getReview, getImageForActor) follow once Postgres cache
// tables + tap-consumer ingestion are wired.
