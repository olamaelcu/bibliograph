import { XRPCRouter, json } from '@atcute/xrpc-server';
import { cors } from '@atcute/xrpc-server/middlewares/cors';
import {
  ComAtprotoIdentityResolveDid,
  ComAtprotoIdentityResolveHandle,
  ComAtprotoIdentityResolveIdentity,
  ComAtprotoLabelQueryLabels,
  ComAtprotoLexiconResolveLexicon,
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
  NetOlamaelcuLivtetBiblioListShelfItems,
  NetOlamaelcuLivtetBiblioGetShelvingOfBook,
  NetOlamaelcuLivtetBiblioGetShelversOfBook,
  NetOlamaelcuLivtetBiblioGetEditionsByContributor,
  NetOlamaelcuLivtetBiblioGetBooks,
  NetOlamaelcuLivtetBiblioListRecentShelving,
  NetOlamaelcuLivtetBiblioListReviewsByActor,
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
import { resolvePublishedLexicon } from './lex/resolve.js';
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
import { GoodreadsSource } from './search/goodreads-source';
import { IsbndbEnricher, IsbndbWorkEnricher } from './search/isbndb-enricher';
import { WikidataContributorEnricher, WikidataEditionEnricher } from './search/wikidata-enricher';
import { ContributorWikipediaEnricher, AuthorWikipediaEnricher } from './search/wikipedia-enricher';
import * as openLibraryApi from './api/open-library';
import { SearchService } from './search/service';
import { eq, inArray, and, gt, sql } from 'drizzle-orm';
import { db } from './db';
import { editions, works, contributors, publishers, records, webSessions } from './db/schema';
import * as v from '@atcute/lexicons/validations';
import type { Nsid } from '@atcute/lexicons';
import { allowRequest } from './rate-limit';
import { fetchEditionForUri } from './shelving/edition-fetch';
import { ingestEditionBatch } from './jobs/handlers';
import type { EditionItem } from './search/types';
import { getBacklinks, type BacklinkPage } from './constellation/client';
import {
  collectShelverDids,
  SHELVING_BACKLINK_SOURCE,
  SHELVING_COLLECTION,
  shelvingRkeyFor,
} from './shelving/shelvers';
import { newestRecordFirst, recordSortKeyOf } from './db/record-recency';
import { decodeRecentCursor, encodeRecentCursor } from './shelving/cursor';
import { compareShelfBooks } from './shelving/order';
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
import { resolveEditions } from './edition-lookup';
import { shelfEntryConditions, shelfRkeyForBookhiveStatus, shelfRkeyOf } from './shelving/shelf-rows';
import { shelfViewFromValue } from './shelving/shelf-view';
import {
  SHELF_ITEM_COLLECTION,
  bookUriForItemRow,
  buildShelfItemView,
  clampShelfItemLimit,
  isShelfItemOf,
  shelfItemConditions,
} from './shelving/shelf-items';
import { olidFromEditionRkey } from './ol/keys';
import { isGbRkey } from './gb/keys';
import { datacenterCoverUrl } from './gb/cover-url';
import { coverProxyUrl, isAllowedCoverUrl } from './cover-cache';
import {
  BOOKHIVE_BOOK_COLLECTION,
  bhEditionUri,
  bookhiveCatalogUri,
  hiveIdFromBhRkey,
  hiveIdFromCatalogUri,
  isBhRkey,
} from './bookhive/keys';
import { BOOKHIVE_BACKLINK_SOURCE, normalizeBookhiveBook, shelfForBookhiveStatus } from './bookhive/records';
import { enqueueCoverBackfill, enqueueDescriptionBackfill } from './jobs/enqueue';
import { buildBookContributorViews } from './book-contributor-view';
import { registerBookQueries } from '../../routes/xrpc/book-queries';
import { queryLabels, labelToJson } from './labeler/labels';
import { verifyFeedAuth, requireFeedAuth } from './auth/feed-auth';
import { publicOrigin } from './auth/oauth';

export const log = createLogger('web');
log.info({ nodeEnv: process.env.NODE_ENV }, 'web process started');

const postgresSource = new PostgresSource(log);
const openLibrarySource = new OpenLibrarySource(log);
const googleBooksSource = new GoogleBooksSource(log);
const isbndbSource = new IsbndbSource(log);
const goodreadsSource = new GoodreadsSource(log);
const googleBooksEnricher = new GoogleBooksEnricher();
const openLibraryEnricher = new OpenLibraryEnricher();
const isbndbEnricher = new IsbndbEnricher();
const isbndbWorkEnricher = new IsbndbWorkEnricher();
const authorWikipediaEnricher = new AuthorWikipediaEnricher();
const wikidataEditionEnricher = new WikidataEditionEnricher();
const wikidataContributorEnricher = new WikidataContributorEnricher();
const contributorWikipediaEnricher = new ContributorWikipediaEnricher();
const searchService = new SearchService(
  {
    postgres: postgresSource,
    openLibrary: openLibrarySource,
    publisherSource: openLibraryApi,
    googleBooksSource,
    isbndbSource,
    goodreadsSource,
    googleBooks: googleBooksEnricher,
    openLibraryEnricher,
    isbndbEnricher,
    isbndbWorkEnricher,
    authorWikipedia: authorWikipediaEnricher,
    contributorWikipedia: contributorWikipediaEnricher,
    wikidataEdition: wikidataEditionEnricher,
    wikidataContributor: wikidataContributorEnricher,
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


// ─── Viewer identity ──────────────────────────────────────────────────────
// Two ways to name a viewer, both proof rather than assertion:
//   * a service JWT in `Authorization: Bearer` (foreign callers such as
//     livtet-service mint one with `com.atproto.server.getServiceAuth`);
//   * the storefront's `bib_session` cookie, for same-origin browser calls.
// The cookie holds an opaque id; the DID lives in `web_sessions`.
//
// A bare `x-viewer-did` header used to be honoured here. It went away: nothing
// verified it, so any caller could read, follow and unfollow as any DID.

async function viewerDidFromRequest(
	request: Request,
	lxm: Nsid,
): Promise<string | null> {
	const verifiedDid = await verifyFeedAuth(request, lxm);
	if (verifiedDid) return verifiedDid;

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
  // `user-agent` is a forbidden header name for the browser's own fetch, but
  // the landing's XRPC client sets it explicitly, so the browser lists it in
  // `Access-Control-Request-Headers` and refuses the response when the
  // preflight does not echo it back. The library's default allowlist carries
  // only the atproto headers, hence the explicit addition here.
  middlewares: [
    accessLog(log),
    cors({ allowedHeaders: ['user-agent'] }),
    rateLimitMiddleware(log),
  ],
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

// Resolving an NSID is the read the slices above exist for: a client asks once
// and gets the schema document with the record's at-uri and CID, instead of
// resolving the DID, finding this service, and decoding a CAR by hand.
//
// Only NSIDs this host publishes resolve here. That is the whole point of the
// method for us — validating *our* lexicon calls — and it keeps the handler off
// the network: no DNS lookup, no third-party fetch, nothing to spoof.
router.addQuery(ComAtprotoLexiconResolveLexicon.mainSchema, {
  async handler({ params }) {
    const resolved = await resolvePublishedLexicon(params.nsid);
    if (!resolved) {
      return notFoundResponse(
        'LexiconNotFound',
        `this host publishes no lexicon under "${params.nsid}"; its own authority publishes ${PUBLISHER_DID}`,
      );
    }
    return json({
      uri: resolved.uri,
      cid: resolved.cid,
      schema: resolved.schema,
    } as unknown as ComAtprotoLexiconResolveLexicon.$output);
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

/**
 * The record itself, unwrapping the `@atcute/client` `{ok,data}` envelope.
 * `isRecordResponse` accepts both shapes, but only the data object has `value`;
 * reading `raw.value` on the envelope returns undefined and made every PDS
 * shelf read look like a record with no fields.
 */
function recordResponseOf(value: unknown): PdsRecordResponse | null {
  if (!isRecordResponse(value)) return null;
  const wrapper = value as { ok?: unknown; data?: unknown };
  if (wrapper.ok === true) {
    return isRecordResponse(wrapper.data)
      ? (wrapper.data as PdsRecordResponse)
      : null;
  }
  return value as PdsRecordResponse;
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

/**
 * One failure of `listRecords`, in the shape both producers below agree on:
 * valibot's own issues carry a `code` and a `path` but not a `message`, and a
 * value that is not an object carries a `message` but no code.
 */
interface ListRecordsIssue {
  code: string;
  message?: string;
  path?: unknown;
}

function safeParseListRecords(raw: unknown): { ok: true; data: PdsListRecordsResponse } | { ok: false; issues: ReadonlyArray<ListRecordsIssue> } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, issues: [{ code: 'invalid_type', message: 'raw is not an object' }] };
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
  return { ok: false, issues: result.issues.map((i) => ({ code: i.code, path: i.path })) };
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

    const record = recordResponseOf(raw);
    if (!record) {
      log.warn({ did: params.did, raw }, 'getReadingGoal: unexpected PDS response shape');
      return Response.json({ goal: null });
    }
    return json({ goal: record.value as NetOlamaelcuLivtetBiblioGetReadingGoal.$output['goal'] } as unknown as NetOlamaelcuLivtetBiblioGetReadingGoal.$output);
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

    const record = recordResponseOf(raw);
    if (!record) {
      log.warn({ did: params.did, raw }, 'getActorProfile: unexpected PDS response shape');
      return Response.json({ profile: null });
    }
    return json({ profile: record.value as NetOlamaelcuLivtetBiblioGetActorProfile.$output['profile'] } as unknown as NetOlamaelcuLivtetBiblioGetActorProfile.$output);
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
      const record = recordResponseOf(raw);
      if (!record) {
        return Response.json({ error: 'RecordNotResolved', message: 'PDS record missing' }, { status: 404 });
      }
      // The record value is the shelf; building the view here (instead of
      // passing the value through) is what publishes `description` and the
      // timestamps, and keeps fields the lexicon does not declare out of the
      // response.
      const shelf = shelfViewFromValue(uri, record.value);
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

/**
 * Cursor format shared by the paginated listings: `<tier>:<value>`.
 *
 * `listShelves` and `listBooksOnShelf` both answer from the local mirror and
 * from a fallback that pages differently (Constellation hands back an opaque
 * cursor, the PDS scan hands back a repo cursor), so a continuation has to say
 * which source it belongs to. Without that it fell back to the mirror query,
 * ignored the cursor it was handed and answered from the first slice — which is
 * why paging stopped after one page.
 *
 * Cursors issued before the tagging keep working: a bare number was a mirror
 * offset, anything else was an opaque Constellation cursor.
 */
function parseCursor(cursor: string | undefined): { tier: string; value: string } | undefined {
  if (!cursor) return undefined;
  const tagged = /^(tap|con|pds):/.exec(cursor);
  if (tagged) {
    const value = cursor.slice(tagged[0].length);
    return value ? { tier: tagged[1] ?? '', value } : undefined;
  }
  return { tier: /^\d+$/.test(cursor) ? 'tap' : 'con', value: cursor };
}

/**
 * A record read straight from a PDS, in the row shape the read paths share.
 * `recordCreatedAt` mirrors the generated column, so a row from this path can
 * still anchor a recency cursor.
 */
function pdsRecordRow(
  did: string,
  collection: string,
  record: { uri: string; value: unknown },
): typeof records.$inferSelect {
  return {
    uri: record.uri,
    cid: 'bafyplaceholder',
    did,
    rkey: record.uri.split('/').pop() ?? '',
    collection,
    value: record.value as never,
    createdAt: new Date(),
    indexedAt: new Date(),
    recordCreatedAt: recordSortKeyOf({ value: record.value }),
  };
}

const SHELF_COLLECTION = 'net.olamaelcu.livtet.biblio.shelf';

/**
 * Shelf containers for a reader whose books live in `buzz.bookhive.book`.
 *
 * Bookhive keeps the reading status inline on the reader's copy of each book, so
 * such a repo holds no `...biblio.shelf` records: every shelf listing answered
 * "no shelves" while the books sat on four shelves. The containers are derived
 * from the statuses the mirror holds, at the URIs a Livtet shelf record would
 * have, so `listBooksOnShelf` (which keys on the rkey alone) pages them
 * unchanged.
 */
async function bookhiveShelfContainers(did: string): Promise<NetOlamaelcuLivtetBiblioDefs.ShelfView[]> {
  const rows = await db
    .selectDistinct({ status: sql<string>`${records.value}->>'status'` })
    .from(records)
    .where(
      and(
        eq(records.did, did),
        eq(records.collection, BOOKHIVE_BOOK_COLLECTION),
        sql`${records.value}->>'status' IS NOT NULL`,
      ),
    );
  const shelves: NetOlamaelcuLivtetBiblioDefs.ShelfView[] = [];
  for (const { status } of rows) {
    const rkey = shelfRkeyForBookhiveStatus(status);
    const name = shelfForBookhiveStatus(status)?.name;
    if (!rkey || !name) continue;
    shelves.push({
      uri: `at://${did}/${SHELF_COLLECTION}/${rkey}` as NetOlamaelcuLivtetBiblioDefs.ShelfView['uri'],
      name,
      $type: 'net.olamaelcu.livtet.biblio.defs#shelfView',
    });
  }
  // Same order as the real shelf page (`uri` ascending), so a reader with both
  // kinds of record sees one stable list.
  return shelves.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
}

router.addQuery(NetOlamaelcuLivtetBiblioListShelves.mainSchema, {
  async handler({ params }) {
    const { did, limit = 50, cursor } = params;
    const repo = did as `did:${string}:${string}`;
    try {
      const resume = parseCursor(cursor);

      const scanPdsShelves = async (startCursor?: string) => {
        const { client } = await pdsClient(did);
        const raw = await client.get('com.atproto.repo.listRecords', {
          params: { repo, collection: 'net.olamaelcu.livtet.biblio.shelf', limit, cursor: startCursor },
          signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
        });
        const parsed = safeParseListRecords(raw);
        if (!parsed.ok) {
          log.warn({ stage: 'listShelves.parse', did, issues: parsed.issues }, 'listRecords response did not match schema');
          return { rows: [] as Array<typeof records.$inferSelect>, cursor: undefined };
        }
        const rows = parsed.data.records.map((r) =>
          pdsRecordRow(did as string, 'net.olamaelcu.livtet.biblio.shelf', r));
        return { rows, cursor: parsed.data.cursor };
      };

      // A continuation resumes the source that issued the cursor. Reading the
      // mirror again and ignoring the cursor is what pinned every page to the
      // first slice.
      if (resume?.tier === 'pds') {
        const { rows, cursor: next } = await scanPdsShelves(resume.value);
        return json({
          shelves: rows.map((row) => shelfViewFromValue(row.uri, row.value)),
          cursor: next ? `pds:${next}` : undefined,
        } as NetOlamaelcuLivtetBiblioListShelves.$output);
      }

      const offset = resume?.tier === 'tap' ? Number.parseInt(resume.value, 10) || 0 : 0;
      const cacheRows = await db
        .select()
        .from(records)
        .where(
          and(
            eq(records.did, did as string),
            eq(records.collection, 'net.olamaelcu.livtet.biblio.shelf'),
          ),
        )
        // Offset paging needs a total order to be stable across requests.
        .orderBy(newestRecordFirst())
        .limit(limit + 1)
        .offset(offset);
      const hasMore = cacheRows.length > limit;
      const merged = hasMore ? cacheRows.slice(0, limit) : cacheRows;
      let nextCursor: string | undefined = hasMore ? `tap:${offset + limit}` : undefined;

      if (!resume && merged.length < limit) {
        try {
          const { rows, cursor: next } = await scanPdsShelves();
          const seen = new Set(merged.map((r) => r.uri));
          // The whole PDS page is merged on purpose: breaking out early would
          // strand the rest of it, because the cursor only moves to the next
          // page. The mixed mirror-plus-PDS page can therefore carry up to twice
          // the requested limit, which paging clients handle as a full page.
          for (const row of rows) if (!seen.has(row.uri)) merged.push(row);
          if (next) nextCursor = `pds:${next}`;
        } catch (err: unknown) {
          log.warn({ err, did }, 'listShelves: PDS scan failed (cache-only result returned)');
        }
      }

      const shelves: NetOlamaelcuLivtetBiblioDefs.ShelfView[] = merged.map((row) =>
        shelfViewFromValue(row.uri, row.value));

      // The derived containers are constant, so they belong on the first page
      // only; paging continues on the real records. A real shelf record of the
      // same uri keeps its own name and wins over its derived twin.
      if (!resume) {
        try {
          const seen = new Set(shelves.map((shelf) => shelf.uri));
          for (const shelf of await bookhiveShelfContainers(did)) {
            if (seen.has(shelf.uri)) continue;
            seen.add(shelf.uri);
            shelves.push(shelf);
          }
        } catch (err: unknown) {
          log.warn({ err, did }, 'listShelves: bookhive shelf derivation failed');
        }
      }

      return json({ shelves, cursor: nextCursor } as NetOlamaelcuLivtetBiblioListShelves.$output);
    } catch (err: unknown) {
      log.warn({ err, did }, 'listShelves: failed');
      return json({ shelves: [], cursor: undefined } as NetOlamaelcuLivtetBiblioListShelves.$output);
    }
  },
});

/**
 * Cover URL for a `bh.` edition whose catalog record carries none.
 *
 * Bookhive's catalog record points at a cover as a URL, and a catalog entry can
 * have none while every reader who shelved the book uploaded one — the blob is
 * per reader, so the catalog cannot name it. Any writer whose copy points at
 * this hive id supplies the bytes; they are streamed back through the image
 * route rather than copied into the catalog, because the blob stays the
 * reader's record. `undefined` when no mirrored copy has one, which keeps the
 * answer a plain "no cover" instead of a URL that 404s.
 */
async function bookhiveCoverProxyUrl(editionRkey: string): Promise<string | undefined> {
  let hiveId: string;
  try {
    hiveId = hiveIdFromBhRkey(editionRkey);
  } catch {
    return undefined;
  }
  const withCover = and(
    eq(records.collection, BOOKHIVE_BOOK_COLLECTION),
    sql`jsonb_typeof(${records.value}->'cover') = 'object'`,
  );
  // Two reads, not one fold: `hiveBookUri` has an expression index (the current
  // write shape) while `hiveId` does not, and a `coalesce` across both matched
  // neither. This runs per cover tile, so the indexed form is tried first.
  const byUri = await db
    .select({ did: records.did, value: records.value })
    .from(records)
    .where(and(withCover, sql`${records.value}->>'hiveBookUri' = ${bookhiveCatalogUri(hiveId)}`))
    .orderBy(records.uri)
    // A few, not one: a copy whose blob ref cannot be read is not an answer
    // when another reader's copy carries a usable one.
    .limit(3);
  const indexed = coverUrlFrom(byUri);
  if (indexed) return indexed;
  const byId = await db
    .select({ did: records.did, value: records.value })
    .from(records)
    .where(and(withCover, sql`${records.value}->>'hiveId' = ${hiveId}`))
    .orderBy(records.uri)
    .limit(3);
  return coverUrlFrom(byId);
}

/** First candidate whose `cover` blob ref is readable, as a proxied URL. */
function coverUrlFrom(candidates: Array<{ did: string; value: unknown }>): string | undefined {
  for (const candidate of candidates) {
    const cover = normalizeBookhiveBook(candidate.value).cover;
    if (cover) return `${publicOrigin()}/image/bookhive/${candidate.did}/${cover.cid}`;
  }
  return undefined;
}

router.addQuery(NetOlamaelcuLivtetBiblioGetImageForBook.mainSchema, {
  async handler({ params }) {
    const uri = params.uri as string;
    if (!uri) {
      return Response.json({ error: 'InvalidRequest', message: 'uri is required' }, { status: 400 });
    }
    const rkey = uri.split('/').pop() ?? '';

    // The cover is the book's, not the uri's. Resolving first is what lets a uri
    // the catalog retired still answer — a legacy key (`gb-b9AOEAAAQBAJ`), an old
    // collection, a foreign DID or a merged-away edition has no valid provider
    // rkey of its own, and rejecting it before the lookup blanked the tile for a
    // book the catalog can serve perfectly well.
    const row = (await resolveEditions([uri])).get(uri);
    if (!row) {
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
      } else if (!isBhRkey(rkey)) {
        // `bh.` editions are Bookhive catalog mirrors. Their cover comes from the
        // catalog record at ingest, so the row is the whole answer: rejecting the
        // rkey sent every Bookhive cover down the caller's own record-read
        // fallback — one extra PDS read per tile — and the backfill below, which
        // only knows how to ask OpenLibrary and Google Books, can never serve
        // them.
        return Response.json({ error: 'InvalidRequest', message: `invalid edition rkey: ${rkey}` }, { status: 400 });
      }
      return Response.json({ error: 'RecordNotFound', message: `no edition at ${uri}` }, { status: 404 });
    }
    if (row.coverImageUrl) {
      const source = datacenterCoverUrl(row.coverImageUrl);
      const url = isAllowedCoverUrl(source)
        ? coverProxyUrl(source, publicOrigin())
        : source;
      return json({ url } as NetOlamaelcuLivtetBiblioGetImageForBook.$output);
    }
    if (isBhRkey(row.rkey)) {
      return json({ url: await bookhiveCoverProxyUrl(row.rkey) } as NetOlamaelcuLivtetBiblioGetImageForBook.$output);
    }
    // Backfill the book the uri resolves to: enqueueing the retired rkey would
    // re-ingest a row the merge deliberately removed.
    void enqueueCoverBackfill(row.uri, row.rkey).catch((err) => {
      log.warn({ err, uri: row.uri, rkey: row.rkey, stage: 'getImageForBook.enqueue' }, 'cover backfill enqueue failed');
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
          source: SHELVING_BACKLINK_SOURCE,
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
                fetched.push(pdsRecordRow(did as string, 'net.olamaelcu.livtet.biblio.bookShelving', r));
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

/**
 * `getShelversOfBook` answers "who put this book on a shelf" without reading a
 * single shelving record: the bookShelving rkey is derived from the book URI,
 * so the record URI alone names both the shelver (its authority) and the book
 * (its rkey).
 *
 * The tiers mirror `getShelvingOfBook` — local mirror first, Constellation once
 * it runs dry — but the mirror cannot be paged into on its own: it is legitimately
 * empty while Constellation holds every record. A short mirror page therefore
 * finishes from Constellation in the same response, and only the cursor of the
 * tier that is still holding records is returned.
 */
router.addQuery(NetOlamaelcuLivtetBiblioGetShelversOfBook.mainSchema, {
  async handler({ params }) {
    const bookUri = params.bookUri as string;
    const { limit = 50 } = params;
    const shelvingRkey = (params.shelvingRkey as string | undefined) ?? shelvingRkeyFor(bookUri);
    try {
      const resume = parseCursor(params.cursor);
      // Bookhive readers shelve by setting a status on their own copy of the
      // book, so their DIDs are rows in the mirror, not backlinks: there is no
      // shelf record to resolve. They ride along on every tier's answer, since
      // the shelving cursor cannot express them.
      const bookhiveSubject = await bookhiveSubjectForEdition(bookUri);
      const bookhiveDids = bookhiveSubject
        ? (
            await db
              .select({ did: records.did })
              .from(records)
              .where(
                shelfEntryConditions({
                  apps: ['bookhive'],
                  bookhiveSubject,
                }),
              )
              .orderBy(records.uri)
              .limit(limit)
          ).map((row) => row.did)
        : [];
      const withBookhive = (dids: string[]) => [...new Set([...dids, ...bookhiveDids])];

      if (resume?.tier === 'con') {
        const page = await getBacklinks({
          subject: bookUri,
          source: SHELVING_BACKLINK_SOURCE,
          limit,
          cursor: resume.value,
        });
        return json({
          bookUri,
          dids: withBookhive(collectShelverDids(shelvingRkey, page.records)),
          cursor: page.cursor ? `con:${page.cursor}` : undefined,
        } as NetOlamaelcuLivtetBiblioGetShelversOfBook.$output);
      }

      const offset = resume?.tier === 'tap' ? Number.parseInt(resume.value, 10) || 0 : 0;
      const mirror = await db
        .select({ uri: records.uri })
        .from(records)
        .where(
          and(
            eq(records.collection, SHELVING_COLLECTION),
            eq(records.rkey, shelvingRkey),
            sql`${records.value}->'book'->>'uri' = ${bookUri}`,
          ),
        )
        .orderBy(records.uri)
        .offset(offset)
        .limit(limit + 1);

      // One row past the limit means the mirror alone can fill this page; a
      // short page means it is exhausted and Constellation carries the rest.
      if (mirror.length > limit) {
        return json({
          bookUri,
          dids: withBookhive(collectShelverDids(shelvingRkey, mirror.slice(0, limit))),
          cursor: `tap:${offset + limit}`,
        } as NetOlamaelcuLivtetBiblioGetShelversOfBook.$output);
      }

      const remaining = limit - mirror.length;
      const page: BacklinkPage = remaining > 0
        ? await getBacklinks({ subject: bookUri, source: SHELVING_BACKLINK_SOURCE, limit: remaining })
        : { records: [] };
      return json({
        bookUri,
        dids: withBookhive(collectShelverDids(shelvingRkey, [...mirror, ...page.records])),
        cursor: page.cursor ? `con:${page.cursor}` : undefined,
      } as NetOlamaelcuLivtetBiblioGetShelversOfBook.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, bookUri, shelvingRkey }, 'getShelversOfBook: failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

/**
 * `listBooksOnShelf` answers from three tiers whose continuation state looks
 * nothing alike: the TAP mirror pages by row offset, Constellation hands back an
 * opaque cursor, and the PDS scan hands back a repo cursor. The cursor we return
 * therefore names its tier.
 *
 * Without that, a continuation page could not tell which tier to resume. It fell
 * back to the TAP query, ignored the cursor it was handed, and answered page two
 * from the rows of page one — so paging a shelf stopped after the first page.
 *
 * Cursors from before the tagging keep working: a bare number was a TAP offset,
 * anything else came from Constellation.
 */
type BooksOnShelfCursor =
  | { tier: 'tap'; offset: number }
  | { tier: 'constellation'; value: string }
  | { tier: 'pds'; value: string };

/**
 * Upper bound on how many PDS pages one request may walk while looking for the
 * records of a single shelf: the scan reads the whole bookShelving collection
 * and filters it, so a shelf holding a handful of a very large collection would
 * otherwise fan out without limit. Stopping early still returns the cursor, and
 * the next request resumes from it.
 */
const MAX_PDS_SCAN_PAGES = 40;

function parseBooksOnShelfCursor(cursor: string | undefined): BooksOnShelfCursor | undefined {
  const parsed = parseCursor(cursor);
  if (!parsed) return undefined;
  if (parsed.tier === 'tap') {
    const offset = Number.parseInt(parsed.value, 10);
    return Number.isFinite(offset) && offset > 0 ? { tier: 'tap', offset } : undefined;
  }
  if (parsed.tier === 'pds') return { tier: 'pds', value: parsed.value };
  return { tier: 'constellation', value: parsed.value };
}

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
      const resume = parseBooksOnShelfCursor(cursor);

      const pullBacklinks = async (atCursor?: string) => {
        const backlinks = await getBacklinks({
          subject: shelfUri,
          source: 'net.olamaelcu.livtet.biblio.bookShelving:shelf',
          did,
          limit,
          cursor: atCursor,
        });
        const rows: Array<typeof records.$inferSelect> = [];
        for (const bl of backlinks.records) {
          if (rows.length >= limit) break;
          const row = await fetchBookShelvingRecord(bl.uri, bl.did, AbortSignal.timeout(PDS_READ_TIMEOUT_MS));
          if (row) rows.push(row);
        }
        return { rows, cursor: backlinks.cursor };
      };

      const scanPds = async (startCursor?: string) => {
        const { client } = await pdsClient(did);
        let cur = startCursor;
        const fetched: Array<typeof records.$inferSelect> = [];
        let pages = 0;
        while (fetched.length < limit && pages < MAX_PDS_SCAN_PAGES) {
          pages += 1;
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
              fetched.push(pdsRecordRow(did, 'net.olamaelcu.livtet.biblio.bookShelving', r));
            }
          }
          if (!cur) break;
        }
        // Whole PDS pages are consumed on purpose. Stopping mid-page would drop
        // the matches after the cut: the cursor points at the next page, so
        // nothing would ever go back for them. A page never yields more than its
        // own size, and that size is this response's `limit`, so the accumulation
        // cannot overshoot the page it is meant to fill.
        return { rows: fetched, cursor: cur };
      };

      // A continuation belongs entirely to the tier that issued the cursor.
      // Merging tiers again would re-send what the first page already returned.
      if (resume?.tier === 'constellation') {
        const { rows, cursor: next } = await pullBacklinks(resume.value);
        return json({
          bookShelves: await hydrateBookShelves(rows),
          cursor: next ? `con:${next}` : undefined,
        } as NetOlamaelcuLivtetBiblioListBooksOnShelf.$output);
      }
      if (resume?.tier === 'pds') {
        const { rows, cursor: next } = await scanPds(resume.value);
        return json({
          bookShelves: await hydrateBookShelves(rows),
          cursor: next ? `pds:${next}` : undefined,
        } as NetOlamaelcuLivtetBiblioListBooksOnShelf.$output);
      }

      const offset = resume?.tier === 'tap' ? resume.offset : 0;
      const cacheRows = await db
        .select()
        .from(records)
        .where(
          shelfEntryConditions({ shelfUris: [shelfUri], did }),
        )
        // An offset page needs a total order, otherwise Postgres may answer the
        // same offset with a different slice and records repeat or vanish.
        .orderBy(newestRecordFirst())
        .limit(limit + 1)
        .offset(offset);
      const hasMore = cacheRows.length > limit;
      const merged = hasMore ? cacheRows.slice(0, limit) : cacheRows;
      let nextCursor: string | undefined = hasMore ? `tap:${offset + limit}` : undefined;

      if (!resume && merged.length < limit) {
        try {
          const seen = new Set(merged.map((r) => r.uri));
          const { rows, cursor: next } = await scanPds();
          for (const row of rows) {
            if (seen.has(row.uri)) continue;
            merged.push(row);
            seen.add(row.uri);
            if (merged.length >= limit) break;
          }
          if (next) nextCursor = `pds:${next}`;
        } catch (err: unknown) {
          log.warn({ err, did, shelfUri }, 'listBooksOnShelf: PDS scan failed (cache+constellation only)');
        }
      }

      // The PDS scan costs one request per hundred records; hydrating the same
      // records through Constellation backlinks costs one request each, which
      // trips the PDS rate limit on any shelf worth paginating. Scan first and
      // keep the backlink tier for repos the scan cannot serve at all.
      if (!resume && merged.length === 0) {
        try {
          const { rows, cursor: next } = await pullBacklinks();
          for (const row of rows) {
            merged.push(row);
            if (merged.length >= limit) break;
          }
          if (next && merged.length > 0) nextCursor = `con:${next}`;
        } catch (err: unknown) {
          log.warn({ err, did, shelfUri }, 'listBooksOnShelf: constellation scan failed (empty shelf returned)');
        }
      }

      const bookShelves = await hydrateBookShelves(merged);
      return json({ bookShelves, cursor: nextCursor } as NetOlamaelcuLivtetBiblioListBooksOnShelf.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, did, shelfUri }, 'listBooksOnShelf: failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

/**
 * The shelf record a custom shelf's items name, read once from its owner's PDS
 * when the mirror has not indexed it yet (a shelf created moments ago). Returns
 * null on any failure: the caller falls back to the name derived from the URI,
 * which is enough to render a status shelf and degrades gracefully for a custom
 * one.
 */
async function fetchShelfViewFromPds(
  uri: string,
  did: string,
): Promise<NetOlamaelcuLivtetBiblioDefs.ShelfView | null> {
  try {
    const { client } = await pdsClient(did);
    const raw = await client.get('com.atproto.repo.getRecord', {
      params: { repo: did as `did:${string}:${string}`, collection: SHELF_COLLECTION, rkey: shelfRkeyOf(uri) },
      signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
    });
    const record = recordResponseOf(raw);
    if (!record) return null;
    return shelfViewFromValue(uri, record.value);
  } catch (err: unknown) {
    log.warn({ err, did, uri }, 'listShelfItems: shelf record read failed; publishing the derived name');
    return null;
  }
}

/**
 * Hydrate shelfItem rows into views: the shelf once, the books in one batch.
 *
 * A book the catalog does not hold is looked up through the same lazy edition
 * path the shelving reads use, then dropped if it still does not resolve — an
 * item that lost its edition (a merge retired the URI, the provider dropped the
 * record) cannot be rendered, and publishing half an item is worse than
 * omitting it.
 */
async function hydrateShelfItems(
  rows: Array<typeof records.$inferSelect>,
  shelfUri: string,
  did: string,
): Promise<NetOlamaelcuLivtetBiblioDefs.ShelfItemView[]> {
  if (rows.length === 0) return [];
  const bookUris = Array.from(new Set(
    rows.map((row) => bookUriForItemRow(row)).filter((uri): uri is string => !!uri),
  ));
  const [shelfMap, bookMap] = await Promise.all([
    hydrateShelvesByUri([shelfUri]),
    hydrateBooksByUri(bookUris),
  ]);

  const missing = bookUris.filter((uri) => !bookMap.has(uri));
  if (missing.length > 0) {
    const resolved = await resolveMissingEditions(missing);
    if (resolved.length > 0) {
      const refilled = await hydrateBooksByUri(resolved);
      for (const [uri, view] of refilled) bookMap.set(uri, view);
    }
  }

  const shelfView = shelfMap.get(shelfUri)
    ?? await fetchShelfViewFromPds(shelfUri, did)
    ?? shelfViewFromValue(shelfUri, undefined);

  const items: NetOlamaelcuLivtetBiblioDefs.ShelfItemView[] = [];
  for (const row of rows) {
    const bookUri = bookUriForItemRow(row);
    const bookView = bookUri ? bookMap.get(bookUri) : undefined;
    if (!bookView) {
      log.warn(
        { stage: 'listShelfItems.orphan', uri: row.uri, did: row.did, bookUri },
        'dropping shelfItem row: book not in catalog',
      );
      continue;
    }
    items.push(buildShelfItemView(row, shelfView, bookView));
  }
  return items;
}

/**
 * The books on one shelf, as `shelfItem` records.
 *
 * Two tiers, for the same reason `listBooksOnShelf` has two: the mirror is what
 * TAP has seen, the PDS scan catches items written since it caught up (and repos
 * TAP does not follow). Both read the shelfItem collection; the mirror filters
 * on `value->>'shelf'` in SQL, the scan filters each record with
 * `isShelfItemOf`. Pages are ordered by record URI — a total, repeatable order
 * for offset paging — and a curated order is `metadata.position`, which the
 * client sorts on.
 */
router.addQuery(NetOlamaelcuLivtetBiblioListShelfItems.mainSchema, {
  async handler({ params }) {
    const shelfUri = params.shelf as string;
    const limit = clampShelfItemLimit(params.limit);
    let did: string;
    try {
      did = parseDidFromUri(shelfUri);
    } catch {
      return Response.json({ error: 'InvalidRequest', message: 'shelf must be an AT-URI' }, { status: 400 });
    }
    try {
      const resume = parseCursor(params.cursor);

      const scanPds = async (startCursor?: string) => {
        const { client } = await pdsClient(did);
        let cur = startCursor;
        const fetched: Array<typeof records.$inferSelect> = [];
        let pages = 0;
        while (fetched.length < limit && pages < MAX_PDS_SCAN_PAGES) {
          pages += 1;
          const page = await client.get('com.atproto.repo.listRecords', {
            params: { repo: did as `did:${string}:${string}`, collection: SHELF_ITEM_COLLECTION, limit, cursor: cur },
            signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
          });
          const parsed = safeParseListRecords(page);
          if (!parsed.ok) {
            log.warn({ stage: 'listShelfItems.parse', did, shelfUri, issues: parsed.issues }, 'listRecords response did not match schema');
            break;
          }
          cur = parsed.data.cursor;
          for (const record of parsed.data.records) {
            if (!isShelfItemOf(record.value, shelfUri)) continue;
            fetched.push(pdsRecordRow(did, SHELF_ITEM_COLLECTION, record));
          }
          if (!cur) break;
        }
        return { rows: fetched, cursor: cur };
      };

      // A continuation belongs entirely to the tier that issued the cursor;
      // merging tiers again would re-send what the first page already returned.
      if (resume?.tier === 'pds') {
        const { rows, cursor: next } = await scanPds(resume.value);
        return json({
          items: await hydrateShelfItems(rows, shelfUri, did),
          cursor: next ? `pds:${next}` : undefined,
        } as NetOlamaelcuLivtetBiblioListShelfItems.$output);
      }

      const offset = resume?.tier === 'tap' ? Number.parseInt(resume.value, 10) || 0 : 0;
      const mirrorRows = await db
        .select()
        .from(records)
        .where(shelfItemConditions({ shelfUri, did }))
        .orderBy(records.uri)
        .limit(limit + 1)
        .offset(offset);
      const hasMore = mirrorRows.length > limit;
      const merged = hasMore ? mirrorRows.slice(0, limit) : mirrorRows;
      let nextCursor: string | undefined = hasMore ? `tap:${offset + limit}` : undefined;

      if (!resume && merged.length < limit) {
        try {
          const seen = new Set(merged.map((row) => row.uri));
          const { rows, cursor: next } = await scanPds();
          // The whole scanned slice is merged on purpose, like `listShelves`:
          // the cursor points at the next PDS page, so dropping the tail of this
          // one would strand those items forever.
          for (const row of rows) {
            if (seen.has(row.uri)) continue;
            seen.add(row.uri);
            merged.push(row);
          }
          if (next) nextCursor = `pds:${next}`;
        } catch (err: unknown) {
          log.warn({ err, did, shelfUri }, 'listShelfItems: PDS scan failed (mirror-only result returned)');
        }
      }

      return json({
        items: await hydrateShelfItems(merged, shelfUri, did),
        cursor: nextCursor,
      } as NetOlamaelcuLivtetBiblioListShelfItems.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, did, shelfUri }, 'listShelfItems: failed');
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
            ${records.collection} = ${REVIEW_COLLECTION}
            AND (${records.value}->>'book' = ${bookUri} OR ${records.value}->'book'->>'uri' = ${bookUri} OR ${records.value}->'book'->>'ref' = ${bookUri})
          ) OR (
            ${records.collection} = ${BOOKHIVE_BOOK_COLLECTION}
            AND ${records.value}->>'hiveBookUri' = ${subject ?? ''}
            AND coalesce(${records.value}->>'review', '') <> ''
          )`,
        )
        .orderBy(newestRecordFirst())
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
        const known = new Set(reviews.map((review) => review.uri));
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
const CONTRIBUTOR_COLLECTION = 'community.lexicon.book.contributor';

/**
 * One review row → the lexicon's `reviewView`, whatever collection it came from.
 *
 * `null` when the record names no book: `reviewView.record` is declared as a
 * `bookReview`, whose `book` is a required at-uri, so a record that carries no
 * book ref (an empty value, or a legacy shape) cannot be rendered as a review.
 * `getReviewsByBook` never meets these — it selects rows by book — but an
 * author-keyed read sees whatever is in an actor's repo.
 */
function reviewViewOf(row: typeof records.$inferSelect): BookReviewView | null {
  const bookUri = bookUriForRow(row);
  if (!bookUri) return null;
  return row.collection === BOOKHIVE_BOOK_COLLECTION
    ? reviewViewFromBookhiveRow(row, bookUri)
    : reviewViewFromRow(row, bookUri);
}

/**
 * A `buzz.bookhive.book` value that says more than which shelf it is on: review
 * text, or a star rating.
 *
 * The same predicate is written as SQL in `listReviewsByActor`'s page query.
 * Two sources feed that listing (the mirror and the actor's PDS), and the two
 * forms must agree: a record one admits and the other refuses is a review that
 * appears or vanishes depending on whether TAP indexed it.
 */
function bookhiveRecordHasReview(value: unknown): boolean {
  const record = asRecord(value);
  return (typeof record.review === 'string' && record.review !== '') || 'stars' in record;
}

/**
 * Refill a mirror row TAP wrote without a body.
 *
 * A create/update event whose record failed to decode arrives with a cid and no
 * `record`, and the consumer stored `{}` for it. That row renders as nothing, so
 * every listing dropped the review — and because the author-keyed read treats a
 * uri it has already seen as data, the PDS fallback skipped it too. A guarded
 * UPDATE costs nothing when the row is fine and heals it for every read path.
 */
async function fillEmptyMirrorRow(row: typeof records.$inferSelect): Promise<void> {
  try {
    await db
      .update(records)
      .set({ value: row.value as never, indexedAt: new Date() })
      .where(and(eq(records.uri, row.uri), sql`${records.value} = '{}'::jsonb`));
  } catch (err: unknown) {
    log.warn({ err, uri: row.uri }, 'could not refill an empty mirror row');
  }
}

/**
 * `getEditionsByContributor` is the ID-based counterpart to contributor-name
 * search: it matches the `contributors` ref each edition already carries, so a
 * page can say "more by this author" without guessing at spellings.
 */
router.addQuery(NetOlamaelcuLivtetBiblioGetEditionsByContributor.mainSchema, {
  async handler({ params }) {
    const contributor = params.contributor as string;
    const limit = params.limit ?? 20;
    // The lexicon declares this error so a caller passing an author *name* by
    // mistake gets a clear answer instead of a silently empty list.
    if (!contributor.startsWith('at://') || !contributor.includes(`/${CONTRIBUTOR_COLLECTION}/`)) {
      return Response.json(
        { error: 'InvalidContributor', message: `not a ${CONTRIBUTOR_COLLECTION} at-uri: ${contributor}` },
        { status: 400 },
      );
    }
    try {
      const rows = await db
        .select({ uri: editions.uri })
        .from(editions)
        .where(
          sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements(${editions.contributors}) AS c
            WHERE c->'subject'->>'uri' = ${contributor}
          )`,
        )
        // `created_at` is the catalog record's own stamp (ingest writes
        // `item.createdAt` into it), so this is the same recency the feeds sort
        // by — not the batch-import time `indexed_at` holds.
        .orderBy(sql`${editions.createdAt} desc`, editions.uri)
        .limit(limit);
      return json({
        uris: rows.map((row) => row.uri),
      } as unknown as NetOlamaelcuLivtetBiblioGetEditionsByContributor.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, contributor }, 'getEditionsByContributor: failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

/**
 * Batch book hydration for a screenful of references. Unknown URIs are dropped
 * rather than reported: a caller maps the answer by `uri`, and one edition
 * missing from the catalog should not fail the other ninety-nine.
 */
router.addQuery(NetOlamaelcuLivtetBiblioGetBooks.mainSchema, {
  async handler({ params }) {
    const requested = params.uris as string[];
    const uris: string[] = [];
    const seen = new Set<string>();
    for (const uri of requested) {
      if (seen.has(uri)) continue;
      seen.add(uri);
      uris.push(uri);
    }
    try {
      const books = await hydrateBooksByUri(uris);
      return json({
        // One view per book: two requested uris that name the same book resolve
        // to the same row, and answering with it twice would be a duplicate row
        // in every client's list.
        books: [...new Map(
          uris
            .map((uri) => books.get(uri))
            .filter((view): view is NetOlamaelcuLivtetBiblioDefs.BookView => !!view)
            .map((view) => [view.uri, view] as const),
        ).values()],
      } as NetOlamaelcuLivtetBiblioGetBooks.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, count: uris.length }, 'getBooks: failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

/**
 * Shelves plus their books, one query instead of "list shelves, then N×
 * listBooksOnShelf". Paged by shelf URI: a shelf is a record with a stable uri,
 * so offset paging over that order is repeatable.
 */
/**
 * Budget for the book preview in `listShelvesWithBooks`.
 *
 * The query used to hydrate every book of every shelf it returned. One
 * production shelf holds 2,573 books, so a single call pinned the single core for
 * 682 s and every other XRPC call queued behind it (the cheap ones included).
 * The preview is capped per shelf by `booksPerShelf` (at most 100) and cut at this
 * deadline; the statement timeout sits just inside it so Postgres cancels a slow
 * query rather than leaving the JS side waiting on it.
 */
const LIST_SHELVES_BOOKS_DEADLINE_MS = 5_000;
const LIST_SHELVES_BOOKS_STATEMENT_TIMEOUT_MS = 4_000;

router.addQuery(NetOlamaelcuLivtetBiblioListShelvesWithBooks.mainSchema, {
  async handler({ params }) {
    const { limit = 50, did } = params;
    const resume = parseCursor(params.cursor);
    // `tap` carries the last shelf uri, not an offset: a shelf created while a
    // caller walks the pages shifts every offset after it, which repeats or
    // skips a shelf. The tier tag stays so a cursor from another read is
    // rejected here rather than silently restarting the page.
    if (resume && resume.tier !== 'tap') {
      return Response.json(
        { error: 'InvalidRequest', message: `unknown cursor tier: ${resume.tier}` },
        { status: 400 },
      );
    }
    if (resume && !resume.value.startsWith('at://')) {
      return Response.json(
        { error: 'InvalidRequest', message: 'cursor was not issued by this query' },
        { status: 400 },
      );
    }
    try {
      const shelfRows = await db
        .select()
        .from(records)
        .where(
          and(
            eq(records.collection, SHELF_COLLECTION),
            did ? eq(records.did, did) : undefined,
            resume ? gt(records.uri, resume.value) : undefined,
          ),
        )
        .orderBy(records.uri)
        .limit(limit + 1);
      const hasMore = shelfRows.length > limit;
      const page = hasMore ? shelfRows.slice(0, limit) : shelfRows;
      // A Bookhive-only reader has no shelf records at all — the status rides on
      // the copy of each book — so their containers are derived from those
      // statuses instead. Constant, hence first-page-only, like `listShelves`.
      const derived = did && !resume
        ? await bookhiveShelfContainers(did).catch((err: unknown) => {
            log.warn({ err, did }, 'listShelvesWithBooks: bookhive shelf derivation failed');
            return [] as NetOlamaelcuLivtetBiblioDefs.ShelfView[];
          })
        : [];
      if (page.length === 0 && derived.length === 0) {
        return json({ shelves: [], cursor: undefined } as unknown as NetOlamaelcuLivtetBiblioListShelvesWithBooks.$output);
      }

      const shelfUris = page.map((row) => row.uri);
      const shelfMap = await hydrateShelvesByUri(shelfUris);
      for (const shelf of derived) shelfMap.set(shelf.uri, shelf);

      // Real records first, in cursor order; a derived container only fills a
      // shelf the reader has no record for, so no uri appears twice.
      const containers: Array<{ uri: string; did: string; shelf: NetOlamaelcuLivtetBiblioDefs.ShelfView }> =
        page.map((row) => {
          return {
            uri: row.uri,
            did: row.did,
            // The row's own uri is what a shelf is addressed by, so the view is
            // built from it rather than re-derived.
            shelf: shelfMap.get(row.uri) ?? shelfViewFromValue(row.uri, row.value),
          };
        });
      if (did) {
        const realUris = new Set(containers.map((container) => container.uri));
        for (const shelf of derived) {
          if (realUris.has(shelf.uri)) continue;
          realUris.add(shelf.uri);
          containers.push({ uri: shelf.uri, did, shelf });
        }
      }

      // A shelf is unbounded in principle: one production shelf holds 2,573
      // books, and hydrating all of them per call pinned the single core for
      // 682 s while every other XRPC call queued behind it. This query is
      // therefore a *preview*: `booksPerShelf` books per shelf, fetched with one
      // indexed query per shelf so no shelf can crowd out the others, under a
      // hard deadline. `listBooksOnShelf` remains the complete listing.
      const booksPerShelf = Math.min(Math.max(params.booksPerShelf ?? 25, 1), 100);
      const deadline = Date.now() + LIST_SHELVES_BOOKS_DEADLINE_MS;
      const rowsByShelf = new Map<string, Array<typeof records.$inferSelect>>();
      try {
        await db.transaction(async (tx) => {
          // The deadline is enforced in Postgres too, so a query that is slow
          // for reasons the JS side cannot see is still cancelled rather than
          // holding the request open.
          // `SET` takes no bind parameters, so the value is inlined from a
          // module constant (a number, never caller input).
          await tx.execute(sql`set local statement_timeout = ${sql.raw(String(LIST_SHELVES_BOOKS_STATEMENT_TIMEOUT_MS))}`);
          for (const [index, container] of containers.entries()) {
            if (Date.now() >= deadline) {
              log.warn(
                { stage: 'listShelvesWithBooks.deadline', shelves: containers.length, hydrated: index },
                'deadline reached; returning the shelves with the books gathered so far',
              );
              break;
            }
            const rows = await tx
              .select()
              .from(records)
              .where(shelfEntryConditions({ shelfUris: [container.uri], did: container.did }))
              .orderBy(records.uri)
              .limit(booksPerShelf);
            rowsByShelf.set(container.uri, rows);
          }
        });
      } catch (err: unknown) {
        // A statement timeout or a dropped connection truncates the preview; the
        // shelves and the cursor are still the useful part of the answer.
        log.warn({ stage: 'listShelvesWithBooks.books', err }, 'book preview cut short');
      }

      const bookRows = [...rowsByShelf.values()].flat();
      const bookMap = await hydrateBooksByUri(
        Array.from(new Set(bookRows.map((row) => bookUriForRow(row)).filter((uri): uri is string => !!uri))),
      );

      // Each shelf was queried with its own predicate, so the grouping is the
      // map key rather than a second pass over mixed rows.
      const shelves = containers.map(({ uri, shelf }) => ({
        shelf,
        books: (rowsByShelf.get(uri) ?? [])
          .map((bookRow) => resolveBookShelf(bookRow, bookMap, shelfMap))
          .filter((resolved) => resolved.ok && resolved.view)
          .map((resolved) => resolved.view!)
          .sort(compareShelfBooks),
        $type: 'net.olamaelcu.livtet.biblio.defs#shelfWithBooksView' as const,
      }));

      return json({
        shelves,
        cursor: hasMore && page.length > 0 ? `tap:${page[page.length - 1]!.uri}` : undefined,
      } as unknown as NetOlamaelcuLivtetBiblioListShelvesWithBooks.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err }, 'listShelvesWithBooks: failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

/**
 * The author-keyed twin of `getReviewsByBook`. Reviews live in three
 * collections — our two review lexicons and Bookhive's book records, which carry
 * a review inline — so the mirror is filtered across all three, and the first
 * page falls back to the actor's own repo for anything TAP has not indexed yet.
 */
router.addQuery(NetOlamaelcuLivtetBiblioListReviewsByActor.mainSchema, {
  async handler({ params }) {
    const did = params.did as string;
    const { limit = 25 } = params;
    const resume = parseCursor(params.cursor);
    const sources = [...FEED_REVIEW_COLLECTIONS, BOOKHIVE_BOOK_COLLECTION];
    try {
      const offset = resume?.tier === 'tap' ? Number.parseInt(resume.value, 10) || 0 : 0;
      const rows = await db
        .select()
        .from(records)
        .where(
          and(
            eq(records.did, did),
            inArray(records.collection, sources),
            // A Bookhive copy record is shelving, not a review, unless it says
            // something about the book. Filtering that after the page window
            // let a run of newest status-only rows fill page 1 and hide every
            // older review; the predicate belongs in SQL so the window is a
            // window over reviews. Native review records need no check.
            sql`(${records.collection} <> ${BOOKHIVE_BOOK_COLLECTION}
              OR coalesce(${records.value}->>'review', '') <> ''
              OR ${records.value} ? 'stars')`,
          ),
        )
        .orderBy(newestRecordFirst())
        .limit(limit + 1)
        .offset(offset);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const reviews: BookReviewView[] = page
        .map(reviewViewOf)
        .filter((view): view is BookReviewView => !!view);
      const cursor = hasMore ? String(offset + limit) : undefined;

      if (!resume && reviews.length < limit) {
        // Seeded from what actually rendered, not from every row scanned. A row
        // TAP stored without a body (`{}`) renders nothing, and keying `seen`
        // on its uri let the fallback skip the live record the repo still
        // serves — the review stayed invisible even though this scan read it.
        const seen = new Set(reviews.map((view) => view.uri));
        try {
          const { client } = await pdsClient(did, { signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS) });
          for (const collection of sources) {
            if (reviews.length >= limit) break;
            const raw = await client.get('com.atproto.repo.listRecords', {
              params: {
                repo: did as `did:${string}:${string}`,
                collection: collection as `${string}.${string}.${string}`,
                limit: limit - reviews.length,
              },
              signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
            });
            const parsed = safeParseListRecords(raw);
            if (!parsed.ok) {
              log.warn({ stage: 'listReviewsByActor.parse', did, collection }, 'listRecords response did not match schema');
              continue;
            }
            for (const record of parsed.data.records) {
              if (seen.has(record.uri) || reviews.length >= limit) continue;
              // The same predicate as the page query: the fallback must not
              // reintroduce the blank cards the SQL window excluded.
              if (collection === BOOKHIVE_BOOK_COLLECTION && !bookhiveRecordHasReview(record.value)) continue;
              seen.add(record.uri);
              const row = pdsRecordRow(did, collection, record);
              const view = reviewViewOf(row);
              if (!view) continue;
              reviews.push(view);
              // The mirror copy of this uri has no body, or it would have
              // rendered above; write what the repo just gave us back.
              await fillEmptyMirrorRow(row);
            }
          }
        } catch (err: unknown) {
          log.warn({ err, did }, 'listReviewsByActor: PDS scan failed (mirror-only result returned)');
        }
      }

      return json({
        reviews,
        cursor,
      } as unknown as NetOlamaelcuLivtetBiblioListReviewsByActor.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, did }, 'listReviewsByActor: failed');
      return Response.json({ error: 'UpstreamUnavailable', message }, { status: 502 });
    }
  },
});

/**
 * Network-wide activity: the newest bookShelving records from every account.
 *
 * Recency is paged by key set (`createdAt`, `uri`) rather than by offset,
 * because rows keep arriving at the head of the order — an offset page two would
 * repeat whatever a new shelving pushed down. `createdAt` is the record's own
 * claim, not the mirror's indexing time, so a replay does not reshuffle the
 * feed. The cursor is taken from the last *scanned* row, not the last emitted
 * view: hydration drops rows whose book is missing from the catalog, and
 * anchoring on those would skip real shelving.
 */
router.addQuery(NetOlamaelcuLivtetBiblioListRecentShelving.mainSchema, {
  async handler({ params }) {
    const { limit = 50 } = params;
    const resume = decodeRecentCursor(params.cursor);
    try {
      const rows = await db
        .select()
        .from(records)
        .where(
          and(
            // Both apps' shelving, not just Livtet's: a Bookhive reader's shelf
            // lives on their own book record, and dropping it here is what made
            // the network's newest shelving depend on which app wrote it.
            shelfEntryConditions(),
            resume
              ? sql`(${records.recordCreatedAt}, ${records.uri}) < (${resume.sortKey}::text, ${resume.uri}::text)`
              : undefined,
          ),
        )
        .orderBy(newestRecordFirst())
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const bookShelves = await hydrateBookShelves(page);
      return json({
        bookShelves,
        cursor: hasMore && last ? encodeRecentCursor(recordSortKeyOf(last), last.uri) : undefined,
      } as NetOlamaelcuLivtetBiblioListRecentShelving.$output);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err }, 'listRecentShelving: failed');
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
      // A Bookhive record is the shelving row itself — same view, different
      // collection — so the read is chosen by what the uri names rather than
      // by assuming Livtet wrote it.
      const row = uri.includes(`/${BOOKHIVE_BOOK_COLLECTION}/`)
        ? await fetchBookhiveBookRecord(uri, did, AbortSignal.timeout(PDS_READ_TIMEOUT_MS))
        : await fetchBookShelvingRecord(uri, did, AbortSignal.timeout(PDS_READ_TIMEOUT_MS));
      if (!row) {
        return Response.json({ error: 'RecordNotFound', message: `no shelving record at ${uri}` }, { status: 404 });
      }
      // A Bookhive copy without a status is owned, not shelved: hydrating it
      // answers "no shelf", which is a different miss from a catalog gap.
      if (row.collection === BOOKHIVE_BOOK_COLLECTION && !normalizeBookhiveBook(row.value).shelf) {
        return Response.json(
          { error: 'RecordNotFound', message: `bookhive record carries no reading status: ${uri}` },
          { status: 404 },
        );
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
    // `createdAt` is required by the lexicon, and a client that parses the list
    // as one object loses every review over the single record that omits it.
    // Bookhive keeps the review as a plain string, so the book record's own
    // `createdAt` is the honest stand-in — never the mirror's index time.
    createdAt: review?.createdAt ?? (row.recordCreatedAt || row.createdAt.toISOString()),
  };
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
  // Resolved through the canonical book, so a caller that still names a uri the
  // catalog retired keeps seeing that book's Bookhive reviews and shelvers.
  const row = (await resolveEditions([editionUri])).get(editionUri);
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
    ...(bookUriHint ? [bookUriHint] : []),
    ...rows.map((r) => bookUriForRow(r)).filter((u): u is string => !!u),
  ]));
  const [shelfMap, bookMap] = await Promise.all([hydrateShelvesByUri(shelfUris), hydrateBooksByUri(bookUris)]);

  const firstPass = rows.map((row) => ({ row, resolved: resolveBookShelf(row, bookMap, shelfMap) }));
  // Only a book the catalog lacks is worth fetching. A row that resolved to no
  // shelf has nothing to hydrate, and asking a provider for its edition is a
  // guaranteed miss that also writes a negative-cache entry.
  const missing = firstPass
    .filter((entry) => !entry.resolved.ok && entry.resolved.reason === 'book-not-found')
    .map((entry) => bookUriForRow(entry.row));
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
        'dropping bookShelving row: shelf or book not resolvable',
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
// The one review collection. The pre-`biblio` namespace is not read here any
// more: Livtet's sign-in migration rewrites those records onto this collection
// and deletes the old copies, so a legacy row still in the mirror is a backlog
// item, not a second source of truth.
const REVIEW_COLLECTION = 'net.olamaelcu.livtet.biblio.bookReview';
const FEED_REVIEW_COLLECTIONS = [REVIEW_COLLECTION];
// Bookhive's per-user book records carry both a review and a reading status, so
// they read as either kind of activity depending on the record.
const FEED_COLLECTIONS = [...FEED_REVIEW_COLLECTIONS, SHELVING_COLLECTION, BOOKHIVE_BOOK_COLLECTION];

// Follow edges are written to each reader's own repo by livtet-service. TAP
// mirrors bookhive books only, so there is no local mirror of this collection:
// the feed reads it straight from the reader's PDS.
const FOLLOW_COLLECTION = 'net.olamaelcu.livtet.biblio.follow';
/** Pages of 100 records. A bound keeps a pathological repo cheap to scan. */
const FOLLOW_SCAN_PAGES = 20;
/** Hop caps for the social skeletons: a bounded candidate set per page. */
const MAX_FEED_HOP1 = 200;
const MAX_FEED_HOP2 = 500;
/** How many hop-1 repos `extended` reads at once. */
const HOP2_FANOUT = 8;
/** `extended` reads one follow set per hop-1 member, so they are memoised. */
const FOLLOW_SET_TTL_MS = 60_000;
const FOLLOW_SET_CACHE_MAX = 512;
const followSetCache = new Map<string, { dids: string[]; expiresAt: number }>();

/** Same contract as `listFollowRecords`: `subject` is the followed actor's at-uri. */
function didFromFollowSubject(subject: unknown): string | null {
  if (typeof subject !== 'string') return null;
  const rest = subject.startsWith('at://') ? subject.slice('at://'.length) : subject;
  const did = rest.split('/')[0] ?? '';
  return did.startsWith('did:') ? did : null;
}

function cachedFollowSet(did: string): string[] | null {
  const hit = followSetCache.get(did);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    followSetCache.delete(did);
    return null;
  }
  return hit.dids;
}

function rememberFollowSet(did: string, dids: string[]): void {
  // Insertion-ordered: drop the oldest entry at the cap, so a spike in distinct
  // viewers cannot grow the map without bound.
  if (followSetCache.size >= FOLLOW_SET_CACHE_MAX) {
    const oldest = followSetCache.keys().next();
    if (!oldest.done) followSetCache.delete(oldest.value);
  }
  followSetCache.set(did, { dids, expiresAt: Date.now() + FOLLOW_SET_TTL_MS });
}

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
    limit: /*#__PURE__*/ v.optional(v.constrain(v.integer(), [v.integerRange(1, 100)]), 5),
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
    } as unknown as v.InferXRPCBodyOutput<typeof describeFeedGeneratorSchema['output']>);
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
    const nsid = nsidMatch?.[1] ?? '';
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
      const hop1 = ((await followedDidsFromPds(viewerDid)) ?? []).slice(0, MAX_FEED_HOP1);
      if (kind === 'following' || hop1.length === 0) return kind === 'following' ? hop1 : [];
      // 2 hops, all of it read from the hop-1 members' own repos.
      const hop2 = await followSetsOf(hop1, MAX_FEED_HOP2);
      const exclude = new Set<string>([viewerDid, ...hop1]);
      const out = new Set<string>();
      for (const did of hop2) {
        if (!did || exclude.has(did) || out.size >= MAX_FEED_HOP2) continue;
        out.add(did);
      }
      return [...out];
    }

    /**
     * Every DID `did` follows, read from their PDS. `null` on any failure, so a
     * caller can tell an unreadable repo from one that follows nobody — and so a
     * failed read is never memoised as an empty follow set.
     *
     * This is the only source of the follow graph. TAP mirrors no
     * `…biblio.follow` records, and the local `follows` table is a best-effort
     * copy the platform's follow route writes *after* the repo record lands: it
     * can never hold a follow the repo lacks, and in production it was never
     * populated at all (see `drizzle/0021_follows.sql`). Reading it therefore
     * bought nothing and risked resurrecting an edge the reader had removed in
     * another client.
     */
    async function followedDidsFromPds(did: string): Promise<string[] | null> {
      const cached = cachedFollowSet(did);
      if (cached) return cached;
      try {
        const { client } = await pdsClient(did);
        const out = new Set<string>();
        let complete = true;
        let cursor: string | undefined;
        for (let page = 0; page < FOLLOW_SCAN_PAGES; page += 1) {
          const raw = await client.get('com.atproto.repo.listRecords', {
            params: {
              repo: did as `did:${string}:${string}`,
              collection: FOLLOW_COLLECTION,
              limit: 100,
              cursor,
            },
            signal: AbortSignal.timeout(PDS_READ_TIMEOUT_MS),
          });
          const parsed = safeParseListRecords(raw);
          if (!parsed.ok) {
            log.warn({ did, issues: parsed.issues }, 'feed: follow record page did not match schema');
            complete = false;
            break;
          }
          for (const record of parsed.data.records) {
            const followed = didFromFollowSubject(record.value.subject);
            if (followed) out.add(followed);
          }
          if (!parsed.data.cursor) break;
          cursor = parsed.data.cursor;
        }
        const dids = [...out];
        if (complete) rememberFollowSet(did, dids);
        return dids;
      } catch (err: unknown) {
        log.warn({ err, did }, 'feed: PDS follow read failed');
        return null;
      }
    }

    /**
     * Union of the follow sets of `dids`, gathered in bounded batches and cut
     * off at `wanted`. Unreachable repos are skipped: a 2-hop expansion is a
     * discovery heuristic, and one reader's broken PDS must not blank the feed.
     */
    async function followSetsOf(dids: string[], wanted: number): Promise<string[]> {
      const out = new Set<string>();
      for (let i = 0; i < dids.length && out.size < wanted; i += HOP2_FANOUT) {
        const sets = await Promise.all(
          dids.slice(i, i + HOP2_FANOUT).map((did) => followedDidsFromPds(did)),
        );
        for (const set of sets) {
          for (const did of set ?? []) {
            if (out.size >= wanted) break;
            out.add(did);
          }
        }
      }
      return [...out];
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
        .orderBy(newestRecordFirst())
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
      const viewerDid = await viewerDidFromRequest(request, 'com.atproto.feed.getFeedSkeleton');
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
          ).orderBy(newestRecordFirst()).limit(limit + 1).offset(offset);
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
      return json({ feed, cursor: outCursor } as unknown as v.InferXRPCBodyOutput<typeof getFeedSkeletonSchema['output']>);
    }

    // ── Dynamic feed (requires auth) ──────────────────────────────────
    // at://<did>/net.olamaelcu.livtet.biblio.feed.generator/dynamic
    if (feedType === 'dynamic') {
      const request = ctx.request;
      const userDid = await requireFeedAuth(request);

      // An authenticated request costs a DID resolution plus a DB query, so it
      // gets its own bucket: the anonymous limiter keys on client IP, and one
      // account must not be able to outrun it.
      if (!allowRequest(`did:${userDid}`, 'com.atproto.feed.getFeedSkeleton')) {
        log.warn({ userDid }, 'rate limited (authenticated feed)');
        return new Response(JSON.stringify({ error: 'RateLimited', message: 'Too many requests' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
        });
      }

      // Personalize by the *viewer's* follow graph — the same source the
      // `following`/`extended` feeds read. Falls back to the general feed when
      // the viewer follows nobody or has no reviews to show.
      let followingDids: string[] = [];
      try {
        followingDids = await feedAuthorDids(userDid, 'following');
      } catch (err) {
        log.warn({ err, userDid }, 'feed: could not read follow graph for dynamic feed');
      }

      let feed: Array<{ post: string; reason?: string }> = [];
      let outCursor: string | undefined;

      if (followingDids.length > 0) {
        // Filter DB records to those authored by followed users
        const rows = await db
          .select()
          .from(records)
          .where(
            and(
              inArray(records.collection, FEED_COLLECTIONS),
              inArray(records.did, followingDids),
            ),
          )
          .orderBy(newestRecordFirst())
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

      return json({ feed, cursor: outCursor } as unknown as v.InferXRPCBodyOutput<typeof getFeedSkeletonSchema['output']>);
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
          source: 'net.olamaelcu.livtet.biblio.bookReview:book.uri',
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

      return json({ feed, cursor: outCursor } as unknown as v.InferXRPCBodyOutput<typeof getFeedSkeletonSchema['output']>);
    }

    // Unrecognized feed URI — return empty feed
    return json({ feed: [], cursor: undefined } as unknown as v.InferXRPCBodyOutput<typeof getFeedSkeletonSchema['output']>);
  },
});

// No follow/unfollow procedure lives here. Follow edges are
// `net.olamaelcu.livtet.biblio.follow` records in the reader's own repo, written
// by livtet-service; the social feeds read them straight from there
// (`feedAuthorDids`), so a second, hand-maintained copy in this database had no
// readers to serve.
