import { XRPCRouter, json, AuthRequiredError } from '@atcute/xrpc-server';
import { cors } from '@atcute/xrpc-server/middlewares/cors';
import {
  ComAtprotoIdentityResolveDid,
  ComAtprotoIdentityResolveHandle,
  ComAtprotoIdentityResolveIdentity,
  ComAtprotoLabelQueryLabels,
  ComAtprotoRepoDescribeRepo,
  ComAtprotoRepoGetRecord,
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
  NetOlamaelcuLivtetBiblioGetReviewsByBook,
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
import { invalidContributorResponsesTotal } from './metrics';
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
import { OpenLibraryEnricher } from './search/open-library-enricher';
import { GoogleBooksSource } from './search/google-books-source';
import { IsbndbSource } from './search/isbndb-source';
import { IsbndbEnricher, IsbndbWorkEnricher } from './search/isbndb-enricher';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './search/wikipedia-enricher';
import * as openLibraryApi from './api/open-library';
import { SearchService } from './search/service';
import { eq, inArray, and, gt, sql } from 'drizzle-orm';
import { db } from './db';
import { editions, works, contributors, publishers, records, follows, webSessions } from './db/schema';
import * as v from '@atcute/lexicons/validations';
import { allowRequest } from './rate-limit';
import { fetchEditionForUri } from './shelving/edition-fetch';
import { ingestEditionBatch } from './jobs/handlers';
import type { EditionItem } from './search/types';
import { getBacklinks } from './constellation/client';
import {
  hydrateShelvesByUri,
  hydrateBooksByUri,
  fetchBookShelvingRecord,
  fetchBookhiveBookRecord,
  resolveBookShelf,
  catalogEditionUriFromRkey,
  bookUriForRow,
  shelfUriForRow,
} from './shelving/hydrate';
import { olidFromEditionRkey } from './ol/keys';
import { isGbRkey } from './gb/keys';
import {
  BOOKHIVE_BOOK_COLLECTION,
  bhEditionUri,
  bookhiveCatalogUri,
  hiveIdFromBhRkey,
  hiveIdFromCatalogUri,
  isBhRkey,
} from './bookhive/keys';
import { BOOKHIVE_BACKLINK_SOURCE, normalizeBookhiveBook } from './bookhive/records';
import { enqueueCoverBackfill, enqueueDescriptionBackfill } from './jobs/enqueue';
import { buildBookContributorViews } from './book-contributor-view';
import { registerBookQueries } from '../../routes/xrpc/book-queries';
import { queryLabels, labelToJson } from './labeler/labels';
import { verifyFeedAuth, requireFeedAuth } from './auth/feed-auth';

export const log = createLogger('web');
log.info({ nodeEnv: process.env.NODE_ENV }, 'web process started');

const postgresSource = new PostgresSource(log);
const openLibrarySource = new OpenLibrarySource(log);
const googleBooksSource = new GoogleBooksSource(log);
const isbndbSource = new IsbndbSource(log);
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
    isbndbSource,
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


// ─── Viewer identity from the storefront session cookie ───────────────────
// XRPC routes are same-origin with the SPA, so the browser sends `bib_session`.
// The cookie holds an opaque id; the DID lives in `web_sessions`.

async function viewerDidFromRequest(request: Request): Promise<string | null> {
	// First-party services (livtet-service) present the viewer explicitly.
	// Follow records are public ATProto data, so naming a viewer here exposes
	// nothing a repo sync would not; the storefront cookie stays the fallback
	// for same-origin browser calls.
	const viewerHeader = request.headers.get('x-viewer-did');
	if (viewerHeader?.startsWith('did:')) return viewerHeader;

	const cookieHeader = request.headers.get('cookie');
	if (!cookieHeader) return null;
	let sessionId: string | null = null;
	for (const part of cookieHeader.split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name === 'bib_session') {
			sessionId = decodeURIComponent(rest.join('='));
			break;
		}
	}
	if (!sessionId) return null;
	const [row] = await db
		.select({ did: webSessions.did })
		.from(webSessions)
		.where(and(eq(webSessions.id, sessionId), gt(webSessions.expiresAt, new Date())));
	return row?.did ?? null;
}

export const router = new XRPCRouter({
  middlewares: [accessLog(log), cors(), rateLimitMiddleware(log)],
  handleHealthCheck: async () => json({ status: 'ok' }),
});

// Wrapping registration: every addQuery call below bumps the counter AND
// writes the schema into a registry keyed by NSID, so the /queries and
// /query/[nsid] routes can render schema docs without a filesystem scan.
// Adding a new endpoint is the single source-of-truth edit.
export const endpointCounts = { queries: 0 };
export const queryRegistry = new Map<string, unknown>();

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

registerBookQueries(router, log, searchService);

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

// com.atproto.server.describeServer is deliberately NOT implemented.
//
// There is no account surface here: every write path (createAccount,
// createSession, createRecord, uploadBlob) is absent, so answering
// describeServer would advertise registration that cannot succeed. Returning
// "not found" is the honest signal; the DID's #atproto_pds entry exists for
// lexicon resolution, not for account operations.

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

// ─── Labeler ────────────────────────────────────────────────────────────────
// Labels are issued by this appview (see labeler/labels.ts); the matching
// com.atproto.label.subscribeLabels WebSocket lives on the Node entrypoint
// (server.ts), because adapter-node does not expose HTTP upgrades to routes.

router.addQuery(ComAtprotoLabelQueryLabels.mainSchema, {
  async handler({ params }) {
    const result = await queryLabels({
      uriPatterns: params.uriPatterns,
      sources: params.sources,
      cursor: params.cursor ? Number(params.cursor) : undefined,
      limit: params.limit,
    });
    return json({
      labels: result.labels.map(labelToJson),
      cursor: result.cursor !== undefined ? String(result.cursor) : undefined,
    } as unknown as ComAtprotoLabelQueryLabels.$output);
  },
});

// ─── com.atproto.repo.* handlers ───────────────────────────────
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
    if (!row.description) {
      void enqueueDescriptionBackfill(uri).catch((err) => {
        log.warn({ err, uri, stage: 'serveBookRecordFromDb.description.enqueue' }, 'description backfill enqueue failed');
      });
    }
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
  // A record's `value` is shaped by its own collection, and the callers only
  // pick the fields they need (shelf `name`, bookShelving `shelf`), so it is
  // carried through unvalidated. `v.record` is the lexicon-record builder — it
  // requires an object schema with a literal `$type` and threw a TypeError on
  // every `listRecords` page, which silently emptied both shelf scans.
  value: v.unknown(),
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
  if (result.ok) {
    const records: PdsListRecordsResponse['records'] = [];
    for (const record of result.value.records) {
      const value = record.value;
      records.push({
        uri: record.uri,
        cid: record.cid,
        // Non-object values can't carry a `name`/`shelf` field; keep the record
        // row rather than dropping it, so callers see the same shape either way.
        value: value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {},
      });
    }
    return { ok: true, data: { records, cursor: result.value.cursor } };
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

      // Bookhive users shelve a book by setting a status on their own book
      // record, so their shelving hangs off the catalog record's backlinks
      // rather than off a Bibliograph shelf.
      const bookhiveSubject = await bookhiveSubjectForEdition(bookUri);
      if (bookhiveSubject && merged.length < limit && !cursor) {
        const backlinks = await getBacklinks({
          subject: bookhiveSubject,
          source: BOOKHIVE_BACKLINK_SOURCE,
          limit,
        });
        const seen = new Set(merged.map((r) => r.uri));
        for (const ref of backlinks.records) {
          if (seen.has(ref.uri) || merged.length >= limit) continue;
          const row = await fetchBookhiveBookRecord(ref.uri, ref.did, AbortSignal.timeout(PDS_READ_TIMEOUT_MS));
          if (!row) continue;
          if (!normalizeBookhiveBook(row.value).shelf) continue;
          merged.push(row);
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

router.addQuery(NetOlamaelcuLivtetBiblioGetReviewsByBook.mainSchema, {
  async handler({ params }) {
    const bookUri = params.book as string;
    const limit = Math.min(params.limit ?? 25, 100);
    const cursor = params.cursor as string | undefined;
    const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    try {
      // Bookhive keeps the review on the user's book record and refs the catalog
      // record through `hiveBookUri`, so that at-uri — the edition's `bookhive`
      // identifier — is the extra matching term in the query below.
      const subject = await bookhiveSubjectForEdition(bookUri);
      const rows = await db
        .select()
        .from(records)
        .where(
          sql`(
            ${records.collection} IN ('net.olamaelcu.livtet.bookReview', 'net.olamaelcu.livtet.biblio.bookReview')
            AND (${records.value}->>'book' = ${bookUri} OR ${records.value}->'book'->>'uri' = ${bookUri} OR ${records.value}->'book'->>'ref' = ${bookUri})
          ) OR (
            ${records.collection} = ${BOOKHIVE_BOOK_COLLECTION}
            AND ${records.value}->>'hiveBookUri' = ${subject ?? ''}
            AND coalesce(${records.value}->>'review', '') <> ''
          )`,
        )
        .orderBy(sql`${records.indexedAt} DESC`, sql`${records.uri} DESC`)
        .limit(limit + 1)
        .offset(offset);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      let outCursor = hasMore ? String(offset + limit) : undefined;

      const reviews: BookReviewView[] = page.map((r) => r.collection === BOOKHIVE_BOOK_COLLECTION
        ? reviewViewFromBookhiveRow(r, bookUri)
        : reviewViewFromRow(r, bookUri));

      // Mirrored reviews are what TAP has seen; the network tier catches reviews
      // written since (or by repos no TAP instance follows) on the first page.
      if (subject && reviews.length < limit && offset === 0) {
        const known = new Set(reviews.map((r) => r.uri));
        const external = await collectBookhiveReviews({ subject, bookUri, limit: limit - reviews.length });
        for (const view of external.reviews) {
          if (known.has(view.uri) || reviews.length >= limit) continue;
          reviews.push(view);
        }
      }

      return json({
        reviews,
        cursor: outCursor,
      } as unknown as NetOlamaelcuLivtetBiblioGetReviewsByBook.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, bookUri }, "getReviewsByBook: failed");
      return Response.json({ error: "UpstreamUnavailable", message }, { status: 502 });
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

interface BookReviewView {
  uri: string;
  did: string;
  record: Record<string, unknown>;
}

/** jsonb columns arrive untyped; every reader here treats a non-object as empty. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Native `bookReview` row → lexicon `reviewView`, normalising the book ref. */
function reviewViewFromRow(row: typeof records.$inferSelect, bookUri: string): BookReviewView {
  const v = asRecord(row.value);
  // The record expects `book: at-uri`, but writers have stored a strongRef and
  // an expandedBook in the wild, so all three shapes are folded to the uri.
  let bookStr = bookUri;
  const rawBook = v.book;
  if (typeof rawBook === 'string') bookStr = rawBook;
  else if (rawBook && typeof rawBook === 'object') {
    const ref = asRecord(rawBook);
    if (typeof ref.uri === 'string') bookStr = ref.uri;
    else if (typeof ref.ref === 'string') bookStr = ref.ref;
  }
  const record: Record<string, unknown> = {
    $type: 'net.olamaelcu.livtet.biblio.bookReview',
    text: typeof v.text === 'string' ? v.text : '',
    book: bookStr,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
  };
  if (typeof v.shelf === 'string') record.shelf = v.shelf;
  else if (v.shelf && typeof v.shelf === 'object') {
    const shelf = asRecord(v.shelf);
    if (typeof shelf.uri === 'string') record.shelf = shelf.uri;
  }
  if (typeof v.rating === 'number') record.rating = v.rating;
  return { uri: row.uri, did: row.did, record };
}

/** `buzz.bookhive.book` row → the same `reviewView`, translated, not rewritten. */
function reviewViewFromBookhiveRow(row: typeof records.$inferSelect, bookUri: string): BookReviewView {
  const review = normalizeBookhiveBook(row.value).review;
  const record: Record<string, unknown> = {
    $type: 'net.olamaelcu.livtet.biblio.bookReview',
    text: review?.text ?? '',
    book: bookUri,
  };
  if (review?.createdAt) record.createdAt = review.createdAt;
  if (review?.rating !== undefined) record.rating = review.rating;
  return { uri: row.uri, did: row.did, record };
}

/**
 * Bookhive catalog record (at-uri) for a Bibliograph edition. `bh.` editions map
 * straight through the rkey; editions from any other source carry the at-uri as
 * a `bookhive` identifier, set when the catalog record was ingested.
 */
async function bookhiveSubjectForEdition(editionUri: string): Promise<string | null> {
  const rkey = editionUri.slice(editionUri.lastIndexOf('/') + 1);
  if (isBhRkey(rkey)) {
    try {
      return bookhiveCatalogUri(hiveIdFromBhRkey(rkey));
    } catch {
      return null;
    }
  }
  const [row] = await db
    .select({ identifiers: editions.identifiers })
    .from(editions)
    .where(eq(editions.uri, editionUri))
    .limit(1);
  for (const identifier of row?.identifiers ?? []) {
    if (identifier.resource !== 'bookhive') continue;
    if (hiveIdFromCatalogUri(identifier.uri)) return identifier.uri;
  }
  return null;
}

/**
 * Reviews written by Bookhive users for one catalog subject: Constellation tells
 * us who wrote them, each author's PDS supplies the record.
 */
async function collectBookhiveReviews(params: {
  subject: string;
  bookUri: string;
  limit: number;
}): Promise<{ reviews: BookReviewView[] }> {
  const backlinks = await getBacklinks({
    subject: params.subject,
    source: BOOKHIVE_BACKLINK_SOURCE,
    limit: params.limit,
  });
  const reviews: BookReviewView[] = [];
  for (const ref of backlinks.records) {
    if (reviews.length >= params.limit) break;
    const row = await fetchBookhiveBookRecord(ref.uri, ref.did, AbortSignal.timeout(PDS_READ_TIMEOUT_MS));
    if (!row) continue;
    if (!normalizeBookhiveBook(row.value).review) continue;
    reviews.push(reviewViewFromBookhiveRow(row, params.bookUri));
  }
  return { reviews };
}

// Lazy edition resolution. A shelving row whose edition is absent from the
// catalog used to be dropped outright, which left shelves looking empty even
// though the records were on the user's PDS. The row is now resolved from the
// provider that owns its rkey prefix, persisted through the normal ingest path,
// and re-hydrated for the same response.
//
// The pass is bounded on purpose: a page of 50 orphans must not fan out to 50
// provider calls, and a provider outage must not stretch a shelf page. Failures
// are remembered for a while so a page full of unresolvable rows does not retry
// them on every request.
const LAZY_EDITION_MAX = 6;
const LAZY_EDITION_BUDGET_MS = 2_500;
const LAZY_EDITION_MISS_TTL_MS = 10 * 60_000;
const lazyEditionMissUntil = new Map<string, number>();

/** URIs worth trying this request: deduped, not recently failed, and capped. */
function lazyEditionCandidates(uris: Array<string | null>): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (const uri of uris) {
    if (!uri || out.includes(uri)) continue;
    const until = lazyEditionMissUntil.get(uri);
    if (until !== undefined && until > now) continue;
    out.push(uri);
    if (out.length >= LAZY_EDITION_MAX) break;
  }
  return out;
}

/**
 * Fetch and persist the editions behind `uris`. Returns the URIs that are now
 * in the catalog; the caller re-selects them rather than trusting the provider
 * payload, so a row whose derived URI disagrees with the reference stays an
 * orphan instead of resolving to the wrong book.
 */
async function resolveMissingEditions(uris: Array<string | null>): Promise<string[]> {
  const candidates = lazyEditionCandidates(uris);
  if (candidates.length === 0) return [];
  const signal = AbortSignal.timeout(LAZY_EDITION_BUDGET_MS);
  const settled = await Promise.allSettled(
    candidates.map((uri) => fetchEditionForUri(uri, log, signal)),
  );
  const items: EditionItem[] = [];
  settled.forEach((result, i) => {
    const uri = candidates[i]!;
    const item = result.status === 'fulfilled' ? result.value : null;
    if (!item) {
      lazyEditionMissUntil.set(uri, Date.now() + LAZY_EDITION_MISS_TTL_MS);
      return;
    }
    items.push(item);
  });
  if (items.length === 0) return [];
  await ingestEditionBatch(items, log, 1).catch((err: unknown) => {
    log.warn({ stage: 'hydrateBookShelves.lazy-ingest', err }, 'persisting lazily fetched editions failed');
  });
  const stored = await hydrateBooksByUri(candidates);
  const resolved = [...stored.keys()];
  for (const uri of candidates) {
    if (!stored.has(uri)) lazyEditionMissUntil.set(uri, Date.now() + LAZY_EDITION_MISS_TTL_MS);
  }
  return resolved;
}

async function hydrateBookShelves(rows: Array<typeof records.$inferSelect>, bookUriHint?: string): Promise<NetOlamaelcuLivtetBiblioDefs.BookShelfView[]> {
  if (rows.length === 0) return [];
  const shelfUris = Array.from(new Set(rows.map((r) => shelfUriForRow(r)).filter((u): u is string => !!u)));
  const bookUris = Array.from(new Set([
    bookUriHint,
    ...rows.map((r) => bookUriForRow(r)).filter((u): u is string => !!u),
  ]));
  const [shelfMap, bookMap] = await Promise.all([hydrateShelvesByUri(shelfUris), hydrateBooksByUri(bookUris)]);

  const firstPass = rows.map((row) => ({ row, resolved: resolveBookShelf(row, bookMap, shelfMap) }));
  const missing = firstPass.filter((entry) => !entry.resolved.ok).map((entry) => bookUriForRow(entry.row));
  if (missing.length > 0) {
    const resolvedUris = await resolveMissingEditions(missing);
    if (resolvedUris.length > 0) {
      // Re-select instead of trusting the provider mapping: only rows the
      // catalog now actually holds can resolve.
      const refilled = await hydrateBooksByUri(resolvedUris);
      for (const [uri, view] of refilled) bookMap.set(uri, view);
    }
  }

  const out: NetOlamaelcuLivtetBiblioDefs.BookShelfView[] = [];
  for (const entry of firstPass) {
    const resolved = entry.resolved.ok
      ? entry.resolved
      : resolveBookShelf(entry.row, bookMap, shelfMap);
    if (!resolved.ok) {
      log.warn(
        {
          stage: 'hydrateBookShelves.orphan',
          uri: bookUriForRow(entry.row) ?? entry.row.uri,
          rkey: entry.row.rkey,
          did: entry.row.did,
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

// Collection sets used by the feed skeletons. Reviews are the primary feed
// content; shelving records are interleaved so followers see what people are
// reading (and on which shelf), not only what they finished and reviewed.
const FEED_REVIEW_COLLECTIONS = [
	'net.olamaelcu.livtet.bookReview',
	'net.olamaelcu.livtet.biblio.bookReview',
];
const SHELVING_COLLECTION = 'net.olamaelcu.livtet.biblio.bookShelving';
// Bookhive's per-user book records carry both a review and a reading status, so
// they read as either kind of activity depending on the record.
const FEED_COLLECTIONS = [...FEED_REVIEW_COLLECTIONS, SHELVING_COLLECTION, BOOKHIVE_BOOK_COLLECTION];

/**
 * Reason string for a shelving entry: `shelving:<shelf-rkey>|<book-uri>`.
 * Shelf rkey comes from the parent shelf AT-URI (`.../biblio.shelf/reading`),
 * falling back to `metadata.status` on older records.
 */
function shelvingReason(value: Record<string, unknown>, bookUri: string): string | undefined {
	let rkey: string | undefined;
	const shelf = value.shelf;
	if (typeof shelf === 'string') {
		const segments = shelf.split('?')[0]?.split('/').filter(Boolean) ?? [];
		const last = segments.at(-1);
		if (last && last !== 'shelf') rkey = last;
	}
	if (!rkey) {
		const metadata = value.metadata as Record<string, unknown> | undefined;
		if (metadata && typeof metadata.status === 'string') rkey = metadata.status;
	}
	return [rkey ? `shelving:${rkey}` : 'shelving', bookUri].filter(Boolean).join('|') || undefined;
}

/**
 * Reason string for a Bookhive entry: `bookhive:<shelf-rkey>|<edition-uri>`.
 * Bookhive has no shelf records, so the rkey names the status instead, and the
 * book is the `bh.` edition its catalog record maps to.
 */
function bookhiveReason(value: Record<string, unknown>): string | undefined {
	const normalized = normalizeBookhiveBook(value);
	const bookUri = normalized.editionUri ?? normalized.subjectUri;
	const rkey = normalized.shelf?.rkey;
	return [rkey ? `bookhive:${rkey}` : 'bookhive', bookUri].filter(Boolean).join('|') || undefined;
}

// ─── ATProto Feed Generator Endpoints ───────────────────────────────────────
// Interim inline schemas until @atcute/lexicons exports com.atproto.feed.* (PR 4817); migrate to imported schemas when available.
// exported by @atcute/atproto, so defined directly via valibot v.query.)

const describeFeedGeneratorSchema = /*#__PURE__*/ v.query('com.atproto.feed.describeFeedGenerator', {
  params: /*#__PURE__*/ v.object({
    feed: /*#__PURE__*/ v.optional(v.resourceUriString()),
  }),
  output: {
    type: 'lex',
    schema: /*#__PURE__*/ v.object({
      did: /*#__PURE__*/ v.didString(),
      feeds: /*#__PURE__*/ v.array(v.object({
        uri: /*#__PURE__*/ v.resourceUriString(),
        displayName: /*#__PURE__*/ v.string(),
        description: /*#__PURE__*/ v.optional(v.string()),
        requiresAuth: /*#__PURE__*/ v.optional(v.boolean()),
      })),
    }),
  },
});

const getFeedSkeletonSchema = /*#__PURE__*/ v.query('com.atproto.feed.getFeedSkeleton', {
  params: /*#__PURE__*/ v.object({
    feed: /*#__PURE__*/ v.resourceUriString(),
    cursor: /*#__PURE__*/ v.optional(v.string()),
    limit: /*#__PURE__*/ v.optional(v.constrain(v.integer(), [v.integerRange(1, 100)], 5)),
  }),
  output: {
    type: 'lex',
    schema: /*#__PURE__*/ v.object({
      feed: /*#__PURE__*/ v.array(v.object({
        post: /*#__PURE__*/ v.resourceUriString(),
        reason: /*#__PURE__*/ v.optional(v.string()),
      })),
      cursor: /*#__PURE__*/ v.optional(v.string()),
    }),
  },
});

router.addQuery(describeFeedGeneratorSchema, {
  async handler({ params }) {
    const feedUri = (params.feed as string | undefined) || `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed.generator/public`;
    return json({
      did: PUBLISHER_DID,
      feeds: [
        {
          uri: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed.generator/public`,
          displayName: 'Bibliograph Static Feed',
          description: 'Public static feed of book reviews (no authentication required)',
        },
        {
          uri: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed.generator/dynamic`,
          displayName: 'Bibliograph Dynamic Feed',
          description: 'Dynamic personalized feed requiring JWT authentication',
        },
        {
          uri: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed.generator/following`,
          displayName: 'Bibliograph Following Feed',
          description: 'Reviews and shelving by people you follow',
          requiresAuth: true,
        },
        {
          uri: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.feed.generator/extended`,
          displayName: 'Bibliograph Extended Network',
          description: 'Reviews and shelving by people followed by the people you follow (2 hops)',
          requiresAuth: true,
        },
      ],
    } as unknown as typeof describeFeedGeneratorSchema.output);
  },
});

router.addQuery(getFeedSkeletonSchema, {
  async handler(ctx) {
    const feedUri = ctx.params.feed as string;
    const cursor = ctx.params.cursor as string | undefined;
    const limit = Math.min((ctx.params.limit as number | undefined) ?? 5, 100);
    const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;

    // Parse the feed URI to determine the feed type.
    // Supported patterns:
    //   at://<did>/net.olamaelcu.livtet.biblio.feed.generator/public      (public)
    //   at://<did>/net.olamaelcu.livtet.biblio.feed.generator/dynamic     (requires auth)
    //   at://<did>/net.olamaelcu.livtet.biblio.feed.generator/edition/{rkey}
    const nsidMatch = feedUri.match(/^at:\/\/[^/]+\/(.+)$/);
    const nsid = nsidMatch ? nsidMatch[1] : '';
    const feedParts = nsid.split('/');
    const isGeneratorFeed = nsid.startsWith('net.olamaelcu.livtet.biblio.feed.generator');
    const feedType = isGeneratorFeed ? feedParts[1] : null;

    // ── Helper: build feed entries from DB rows ──────────────────────
    // `reason` carries what the client needs to render an entry without a
    // second fetch: the reviewed book URI for reviews, and
    // `shelving:<shelf-rkey>|<book-uri>` for shelving records (shelf rkey is
    // one of reading / read / to-read / dnf).
    function dbToFeed(rows: Array<typeof records.$inferSelect>): Array<{ post: string; reason?: string }> {
      return rows.map((r) => {
        const v = r.value as Record<string, unknown>;
        let bookStr = '';
        const rawBook = v.book;
        if (typeof rawBook === 'string') {
          bookStr = rawBook;
        } else if (rawBook && typeof rawBook === 'object') {
          const ro = rawBook as Record<string, unknown>;
          if (typeof ro.uri === 'string') bookStr = ro.uri;
          else if (typeof ro.ref === 'string') bookStr = ro.ref;
        }
        return {
          post: r.uri as string,
          reason: r.collection === SHELVING_COLLECTION
            ? shelvingReason(v, bookStr)
            : r.collection === BOOKHIVE_BOOK_COLLECTION
              ? bookhiveReason(v)
              : bookStr || undefined,
        };
      });
    }

    /**
     * Author DIDs whose activity feeds a social skeleton.
     *
     * - `following`: 1 hop — people the viewer follows.
     * - `extended`:  2 hops — people followed by the people the viewer follows,
     *   minus the viewer and minus anyone already followed (the point of the
     *   feed is discovery, so already-known authors are already in `/following`).
     *
     * Hop sizes are capped: a 2-hop expansion grows fast, and the skeleton only
     * needs a bounded candidate set per page.
     */
    async function feedAuthorDids(viewerDid: string, kind: string): Promise<string[]> {
      const MAX_HOP1 = 200;
      const MAX_HOP2 = 500;
      const hop1Rows = await db
        .select({ did: follows.followedDid })
        .from(follows)
        .where(eq(follows.followerDid, viewerDid))
        .limit(MAX_HOP1);
      const hop1 = [...new Set(hop1Rows.map((r) => r.did).filter(Boolean))];
      if (kind === 'following' || hop1.length === 0) return kind === 'following' ? hop1 : [];
      const hop2Rows = await db
        .select({ did: follows.followedDid })
        .from(follows)
        .where(inArray(follows.followerDid, hop1))
        .limit(MAX_HOP2);
      const exclude = new Set<string>([viewerDid, ...hop1]);
      return [...new Set(hop2Rows.map((r) => r.did).filter(Boolean))].filter((d) => !exclude.has(d));
    }

    function dbToFeedPaginated(offset: number, limit: number) {
      return { offset, limit };
    }

    // ── Helper: paginate DB records ───────────────────────────────────
    async function paginateFromDb(offsetNum: number, limitNum: number) {
      const rows = await db
        .select()
        .from(records)
        .where(inArray(records.collection, FEED_COLLECTIONS))
        .orderBy(sql`${records.indexedAt} DESC`, sql`${records.uri} DESC`)
        .limit(limitNum + 1)
        .offset(offsetNum);

      const hasMore = rows.length > limitNum;
      const page = hasMore ? rows.slice(0, limitNum) : rows;
      const outCursor = hasMore ? String(offsetNum + limitNum) : undefined;
      return { feed: dbToFeed(page), cursor: outCursor };
    }

    // ── Static / social feeds (public / following / extended) ───────────
    // at://<did>/net.olamaelcu.livtet.biblio.feed.generator/{public|following|extended}
    if (feedType === 'public' || feedType === 'static' || feedType === 'following' || feedType === 'extended') {
      const request = ctx.request;
      const viewerDid = await viewerDidFromRequest(request);
      let feed: Array<{ post: string; reason?: string }> = [];
      let outCursor: string | undefined;
      if (viewerDid && (feedType === 'following' || feedType === 'extended')) {
        const ids = await feedAuthorDids(viewerDid, feedType);
        if (ids.length > 0) {
          const reviewRows = await db.select().from(records).where(
            and(
              inArray(records.collection, FEED_COLLECTIONS),
              inArray(records.did, ids),
            )
          ).orderBy(sql`${records.indexedAt} DESC`, sql`${records.uri} DESC`).limit(limit + 1).offset(offset);
          const hasMore = reviewRows.length > limit;
          const page = hasMore ? reviewRows.slice(0, limit) : reviewRows;
          outCursor = hasMore ? String(offset + limit) : undefined;
          feed = dbToFeed(page);
        }
      }
      if (feed.length === 0) {
        const result = await paginateFromDb(offset, limit);
        feed = result.feed;
        outCursor = result.cursor;
      }
      return json({ feed, cursor: outCursor } as unknown as typeof getFeedSkeletonSchema.output);
    }

    // ── Dynamic feed (requires auth) ──────────────────────────────────
    // at://<did>/net.olamaelcu.livtet.biblio.feed.generator/dynamic
    if (feedType === 'dynamic') {
      const request = ctx.request;
      const userDid = await requireFeedAuth(request);

      // Personalize by querying reviews from authors the user follows.
      // Falls back to general feed if social graph is unavailable.
      let followingDids: string[] = [];
      try {
        const following = await getBacklinks({
          subject: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.social/following`,
          source: 'net.olamaelcu.livtet.biblio.social:follow',
          limit: 100,
          cursor,
        });
        followingDids = (following.records || [])
          .map((r) => (r as { value?: Record<string, unknown> }).value?.target?.did)
          .filter((d): d is string => !!d);
      } catch (err) {
        log.warn({ err, userDid }, 'feed: could not fetch following list for dynamic feed');
      }

      let feed: Array<{ post: string; reason?: string }> = [];
      let outCursor: string | undefined;

      if (followingDids.length > 0) {
        // Filter DB records to those authored by followed users
        const inClause = followingDids.map((d) => `'${d}'`).join(', ');
        const rows = await db
          .select()
          .from(records)
          .where(
            and(
              inArray(records.collection, FEED_COLLECTIONS),
              sql`${records.did} IN (${sql.raw(inClause)})`,
            ),
          )
          .orderBy(sql`${records.indexedAt} DESC`, sql`${records.uri} DESC`)
          .limit(limit + 1)
          .offset(offset);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        outCursor = hasMore ? String(offset + limit) : undefined;
        feed = dbToFeed(page);
      }

      // Fallback to general feed if no followed authors or no results
      if (feed.length === 0) {
        const result = await paginateFromDb(offset, limit);
        feed = result.feed;
        outCursor = result.cursor;
      }

      return json({ feed, cursor: outCursor } as unknown as typeof getFeedSkeletonSchema.output);
    }

    // ── Edition-specific feed (public) ────────────────────────────────
    // at://<did>/net.olamaelcu.livtet.biblio.feed.generator/edition/{rkey}
    if (feedType === 'edition') {
      const rkey = feedParts[2];
      if (!rkey) {
        throw new Error('Edition RKEY is missing from feed URI');
      }

      let feed: Array<{ post: string; reason?: string }> = [];
      let outCursor: string | undefined;

      try {
        const backlinks = await getBacklinks({
          subject: `at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.edition/${rkey}`,
          source: 'net.olamaelcu.livtet.bookReview:book',
          limit,
          cursor,
        });
        outCursor = backlinks.cursor;
        feed = backlinks.records.map((r) => ({
          post: r.uri,
          reason: 'Backlink from edition review',
        }));
      } catch (err) {
        log.warn({ err, feedUri }, 'feed: constellation merge failed for edition feed');
      }

      // Bookhive reviews of the same edition, resolved through the catalog record
      // the edition carries as its `bookhive` identifier.
      try {
        const subject = await bookhiveSubjectForEdition(`at://${PUBLISHER_DID}/net.olamaelcu.livtet.biblio.edition/${rkey}`);
        if (subject && feed.length < limit) {
          const bookhive = await getBacklinks({
            subject,
            source: BOOKHIVE_BACKLINK_SOURCE,
            limit: limit - feed.length,
          });
          const seen = new Set(feed.map((f) => f.post));
          for (const ref of bookhive.records) {
            if (seen.has(ref.uri) || feed.length >= limit) continue;
            feed.push({ post: ref.uri, reason: 'Bookhive review backlink' });
          }
        }
      } catch (err) {
        log.warn({ err, feedUri }, 'feed: bookhive merge failed for edition feed');
      }

      // Fallback to DB if constellation returns no results
      if (feed.length === 0) {
        const result = await paginateFromDb(offset, limit);
        feed = result.feed;
        outCursor = result.cursor;
      }

      return json({ feed, cursor: outCursor } as unknown as typeof getFeedSkeletonSchema.output);
    }

    // Unrecognized feed URI — return empty feed
    return json({ feed: [], cursor: undefined } as unknown as typeof getFeedSkeletonSchema.output);
  },
});

// ─── Social graph follow/unfollow (DB-authoritative) ─────────────────────
// Viewer DID comes from the JWT (requireFeedAuth, lxm com.atproto.feed.getFeedSkeleton).
const followUnfollowSchema = /*#__PURE__*/ v.query('net.olamaelcu.livtet.biblio.follow', {
  params: /*#__PURE__*/ v.object({
    followed: /*#__PURE__*/ v.didString(),
    action: /*#__PURE__*/ v.optional(v.literalEnum(['follow', 'unfollow']), 'follow'),
  }),
  output: {
    type: 'lex',
    schema: /*#__PURE__*/ v.object({ ok: /*#__PURE__*/ v.boolean() }),
  },
});

router.addQuery(followUnfollowSchema, {
  async handler({ params, request }) {
    const followed = params.followed as string;
    const action = (params.action as string | undefined) || 'follow';
    const viewerDid = await viewerDidFromRequest(request);
    if (!viewerDid) {
      throw new AuthRequiredError({
        status: 401,
        error: 'AuthenticationRequired',
        message: 'follow/unfollow requires a Bibliograph session cookie',
        wwwAuthenticate: { scheme: 'Bearer' },
      });
    }
    if (action === 'unfollow') {
      await db.delete(follows).where(
        and(eq(follows.followerDid, viewerDid), eq(follows.followedDid, followed)),
      );
    } else {
      await db.insert(follows).values({ followerDid: viewerDid, followedDid: followed }).onConflictDoNothing();
    }
    return json({ ok: true } as unknown as typeof followUnfollowSchema.output);
  },
});
