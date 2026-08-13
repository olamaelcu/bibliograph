import type { Context } from 'hono';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { COLLECTIONS, makeRecordUri } from '../records.js';
import {
  serializeBook,
  serializeContributor,
  serializeContributorType,
  type BookRecordValue,
  type ContributorRecordValue,
  type ContributorTypeRecordValue,
} from '../pds/records.js';
import { getServiceDid, buildDidDocument } from '../did.js';
import { logger } from '../logger.js';

/**
 * Minimal read-only PDS shim. The AppView's service DID
 * (`did:web:biblio.livtet.olamaelcu.net`) hosts records the AppView authors
 * itself: `community.lexicon.book.book`,
 * `community.lexicon.book.contributor`,
 * `community.lexicon.book.contributor.type`. User-authored records (reviews,
 * statuses, claims, shelves, shelfItems) are NOT exposed here — those
 * belong to the user's own PDS, which a resolver will find via that user's
 * DID document.
 *
 * Four endpoints, all unauthenticated per the AT Protocol spec:
 * - `com.atproto.repo.getRecord`
 * - `com.atproto.repo.listRecords`
 * - `com.atproto.repo.describeRepo`
 * - `com.atproto.identity.resolveHandle`
 *
 * Out of scope (would require a full PDS): `createRecord`, `putRecord`,
 * `deleteRecord`, `applyWrites`, `uploadBlob`, `getBlob`, `getRepo`
 * (CAR export), `subscribeRepos`, sessions, repo signing key.
 */

const { books, contributors, contributorTypes } = schema;

/** NSIDs this PDS actually serves — referenced by `describeRepo.collections`. */
const OWNED_COLLECTIONS = [
  COLLECTIONS.book,
  COLLECTIONS.contributor,
  COLLECTIONS.contributorType,
] as const;

type OwnedCollection = (typeof OWNED_COLLECTIONS)[number];

function isOwnedCollection(value: string): value is OwnedCollection {
  return (OWNED_COLLECTIONS as readonly string[]).includes(value);
}

function jsonError(c: Context, status: 400 | 500, error: string, message: string): Response {
  return c.json({ error, message }, { status });
}

function resolveOwningDid(c: Context, repoParam: string): string | null {
  // Accept either the bare DID or our handle. Anything else is a repo we
  // don't host — return null so the caller can produce a uniform
  // `InvalidRequest` (mirroring how real PDSes refuse non-owned repos).
  const ourDid = getServiceDid();
  if (repoParam === ourDid) return ourDid;

  const host = (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '')
    .toLowerCase()
    .split(':')[0];
  if (host && repoParam.toLowerCase() === host) return ourDid;

  return null;
}

function serviceEndpoint(c: Context): string {
  const proto = c.req.header('x-forwarded-proto') ?? (c.req.url.startsWith('https') ? 'https' : 'http');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? getServiceDid().replace(/^did:web:/, '');
  return `${proto}://${host}`;
}

type SerializedRecord =
  | BookRecordValue
  | ContributorRecordValue
  | ContributorTypeRecordValue;

interface GetRecordResponse {
  uri: string;
  cid: string;
  value: SerializedRecord;
}

// ─── getRecord ──────────────────────────────────────────────────────────────

export async function getRecord(c: Context): Promise<Response> {
  const log = c.get('log') as typeof logger | undefined;
  const repo = c.req.query('repo');
  const collection = c.req.query('collection');
  const rkey = c.req.query('rkey');
  const cidParam = c.req.query('cid');

  if (!repo || !collection || !rkey) {
    return jsonError(c, 400, 'InvalidRequest', 'repo, collection, and rkey are required');
  }

  if (!isOwnedCollection(collection)) {
    // We don't host this collection. Even if the repo is ours, return
    // InvalidRequest — clients should query the user's PDS for user-owned
    // collections.
    return jsonError(c, 400, 'InvalidRequest', `unsupported collection: ${collection}`);
  }

  const owningDid = resolveOwningDid(c, repo);
  if (!owningDid) {
    return jsonError(c, 400, 'InvalidRequest', `repo not hosted by this PDS: ${repo}`);
  }

  const uri = makeRecordUri(owningDid, collection, rkey);
  const storedCid: string | null = await loadStoredCid(collection, uri);

  if (storedCid === null) {
    log?.warn({ uri }, 'pds.getRecord: RecordNotFound');
    return jsonError(c, 400, 'RecordNotFound', `record not found: ${uri}`);
  }

  if (cidParam && cidParam !== storedCid) {
    return jsonError(
      c,
      400,
      'InvalidRequest',
      `cid mismatch: stored=${storedCid} requested=${cidParam}`,
    );
  }

  const value: SerializedRecord = await loadValue(collection, uri);
  const body: GetRecordResponse = { uri, cid: storedCid, value };
  return c.json(body);
}

async function loadStoredCid(
  collection: OwnedCollection,
  uri: string,
): Promise<string | null> {
  if (collection === COLLECTIONS.book) {
    const row = await db
      .select({ cid: books.cid })
      .from(books)
      .where(eq(books.uri, uri))
      .get();
    return row?.cid ?? null;
  }
  if (collection === COLLECTIONS.contributor) {
    const row = await db
      .select({ cid: contributors.cid })
      .from(contributors)
      .where(eq(contributors.uri, uri))
      .get();
    return row?.cid ?? null;
  }
  const row = await db
    .select({ cid: contributorTypes.cid })
    .from(contributorTypes)
    .where(eq(contributorTypes.uri, uri))
    .get();
  return row?.cid ?? null;
}

async function loadValue(
  collection: OwnedCollection,
  uri: string,
): Promise<SerializedRecord> {
  if (collection === COLLECTIONS.book) {
    const row = await db.query.books.findFirst({ where: eq(books.uri, uri) });
    if (!row) throw new Error(`book row vanished mid-request: ${uri}`);
    return serializeBook(row);
  }
  if (collection === COLLECTIONS.contributor) {
    const row = await db.query.contributors.findFirst({ where: eq(contributors.uri, uri) });
    if (!row) throw new Error(`contributor row vanished mid-request: ${uri}`);
    return serializeContributor(row);
  }
  const row = await db.query.contributorTypes.findFirst({ where: eq(contributorTypes.uri, uri) });
  if (!row) throw new Error(`contributorType row vanished mid-request: ${uri}`);
  return serializeContributorType(row);
}

// ─── listRecords ────────────────────────────────────────────────────────────

interface ListRecordsResponse {
  records: GetRecordResponse[];
  cursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function listRecords(c: Context): Promise<Response> {
  const repo = c.req.query('repo');
  const collection = c.req.query('collection');
  const limitParam = c.req.query('limit');
  const cursor = c.req.query('cursor');
  const reverseParam = c.req.query('reverse');

  if (!repo || !collection) {
    return jsonError(c, 400, 'InvalidRequest', 'repo and collection are required');
  }
  if (!isOwnedCollection(collection)) {
    return jsonError(c, 400, 'InvalidRequest', `unsupported collection: ${collection}`);
  }
  const owningDid = resolveOwningDid(c, repo);
  if (!owningDid) {
    return jsonError(c, 400, 'InvalidRequest', `repo not hosted by this PDS: ${repo}`);
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, limitParam ? Number(limitParam) || DEFAULT_LIMIT : DEFAULT_LIMIT),
  );
  const reverse = reverseParam === 'true';

  const cursorRkey = cursor ? decodeCursor(cursor) : null;

  const records = await fetchPage({
    collection,
    did: owningDid,
    limit,
    reverse,
    cursorRkey,
  });

  const hasMore = records.length > limit;
  const page = hasMore ? records.slice(0, limit) : records;

  const nextCursor =
    hasMore && page.length > 0 ? encodeCursor(extractRkey(page[page.length - 1].uri)) : undefined;

  const body: ListRecordsResponse = {
    records: page,
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
  return c.json(body);
}

async function fetchPage(args: {
  collection: OwnedCollection;
  did: string;
  limit: number;
  reverse: boolean;
  cursorRkey: string | null;
}): Promise<GetRecordResponse[]> {
  const { collection, did, limit, reverse, cursorRkey } = args;
  const prefix = `at://${did}/${collection}/`;

  if (collection === COLLECTIONS.book) {
    return fetchPageFromTable({
      table: books,
      uriCol: books.uri,
      didCol: books.did,
      cidCol: books.cid,
      serialize: serializeBook,
      did,
      prefix,
      limit,
      reverse,
      cursorRkey,
    });
  }
  if (collection === COLLECTIONS.contributor) {
    return fetchPageFromTable({
      table: contributors,
      uriCol: contributors.uri,
      didCol: contributors.did,
      cidCol: contributors.cid,
      serialize: serializeContributor,
      did,
      prefix,
      limit,
      reverse,
      cursorRkey,
    });
  }
  return fetchPageFromTable({
    table: contributorTypes,
    uriCol: contributorTypes.uri,
    didCol: contributorTypes.did,
    cidCol: contributorTypes.cid,
    serialize: serializeContributorType,
    did,
    prefix,
    limit,
    reverse,
    cursorRkey,
  });
}

async function fetchPageFromTable<T extends { uri: string; cid: string | null; did: string }>(opts: {
  table: any;
  uriCol: any;
  didCol: any;
  cidCol: any;
  serialize: (row: T) => SerializedRecord;
  did: string;
  prefix: string;
  limit: number;
  reverse: boolean;
  cursorRkey: string | null;
}): Promise<GetRecordResponse[]> {
  const { uriCol, didCol, serialize, did, prefix, limit, reverse, cursorRkey } = opts;

  const conditions = [eq(didCol, did)];
  if (cursorRkey) {
    const cmp = reverse ? lt : gt;
    conditions.push(cmp(uriCol, `${prefix}${cursorRkey}`));
  }

  const rows = (await db
    .select()
    .from(opts.table)
    .where(and(...conditions))
    .orderBy(reverse ? sql`${uriCol} DESC` : sql`${uriCol} ASC`)
    .limit(limit + 1)) as T[];

  const out: GetRecordResponse[] = [];
  for (const row of rows) {
    if (!row.cid) continue;
    out.push({ uri: row.uri, cid: row.cid, value: serialize(row) });
  }
  return out;
}

function extractRkey(uri: string): string {
  const parts = uri.split('/');
  return parts[parts.length - 1];
}

function encodeCursor(rkey: string): string {
  return Buffer.from(rkey, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string | null {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// ─── describeRepo ───────────────────────────────────────────────────────────

export async function describeRepo(c: Context): Promise<Response> {
  const repo = c.req.query('repo');
  if (!repo) {
    return jsonError(c, 400, 'InvalidRequest', 'repo is required');
  }
  const owningDid = resolveOwningDid(c, repo);
  if (!owningDid) {
    return jsonError(c, 400, 'InvalidRequest', `repo not hosted by this PDS: ${repo}`);
  }

  const didDoc = buildDidDocument(owningDid, serviceEndpoint(c));
  const host = (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '')
    .toLowerCase()
    .split(':')[0];
  // handleIsCorrect: true means we know the handle resolves bidirectionally
  // to this DID. We host both the handle (via DNS) and the DID, so yes.
  const handle = host || owningDid.replace(/^did:web:/, '');

  return c.json({
    handle,
    did: owningDid,
    didDoc,
    collections: [...OWNED_COLLECTIONS],
    handleIsCorrect: true,
  });
}

// ─── resolveHandle ──────────────────────────────────────────────────────────

export async function resolveHandle(c: Context): Promise<Response> {
  const handle = c.req.query('handle');
  if (!handle) {
    return jsonError(c, 400, 'InvalidRequest', 'handle is required');
  }
  const ourDid = getServiceDid();
  const host = (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '')
    .toLowerCase()
    .split(':')[0];

  // Only resolve handles under our own domain. We're not a handle registry.
  if (handle.toLowerCase() !== host && handle.toLowerCase() !== ourDid.replace(/^did:web:/, '')) {
    return jsonError(c, 400, 'InvalidRequest', `handle not hosted by this PDS: ${handle}`);
  }

  return c.json({ did: ourDid });
}

// ─── /.well-known/atproto-did ──────────────────────────────────────────────

export async function serveAtprotoDid(_c: Context): Promise<Response> {
  return new Response(getServiceDid(), {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}