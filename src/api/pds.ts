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
import { cidForRecord } from '../pds/cid.js';
import { getServiceDid, buildDidDocument } from '../did.js';
import { logger } from '../logger.js';

type BookRow = typeof schema.books.$inferSelect;
type ContributorRow = typeof schema.contributors.$inferSelect;
type ContributorTypeRow = typeof schema.contributorTypes.$inferSelect;
type RowShape = BookRow | ContributorRow | ContributorTypeRow;

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
  const row = await loadRow(collection, uri);

  if (!row) {
    log?.warn({ uri }, 'pds.getRecord: RecordNotFound');
    return jsonError(c, 400, 'RecordNotFound', `record not found: ${uri}`);
  }

  const value = serializeRow(collection, row);
  // The stored `cid` column is a cache. Rows written before the CID column
  // existed (or inserted through paths that don't set it) have `cid IS NULL`;
  // compute on the fly so every resolvable record still works.
  const cid = row.cid ?? (await cidForRecord(value));

  if (cidParam && cidParam !== cid) {
    return jsonError(
      c,
      400,
      'InvalidRequest',
      `cid mismatch: stored=${cid} requested=${cidParam}`,
    );
  }

  const body: GetRecordResponse = { uri, cid, value };
  return c.json(body);
}

async function loadRow(
  collection: OwnedCollection,
  uri: string,
): Promise<RowShape | null> {
  if (collection === COLLECTIONS.book) {
    return (await db.query.books.findFirst({ where: eq(books.uri, uri) })) ?? null;
  }
  if (collection === COLLECTIONS.contributor) {
    return (await db.query.contributors.findFirst({ where: eq(contributors.uri, uri) })) ?? null;
  }
  return (await db.query.contributorTypes.findFirst({ where: eq(contributorTypes.uri, uri) })) ?? null;
}

function serializeRow(collection: OwnedCollection, row: RowShape): SerializedRecord {
  if (collection === COLLECTIONS.book) return serializeBook(row as BookRow);
  if (collection === COLLECTIONS.contributor) return serializeContributor(row as ContributorRow);
  return serializeContributorType(row as ContributorTypeRow);
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
    const value = serialize(row);
    // Stored `cid` is a cache; compute on the fly for rows written before
    // the column existed.
    const cid = row.cid ?? (await cidForRecord(value));
    out.push({ uri: row.uri, cid, value });
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