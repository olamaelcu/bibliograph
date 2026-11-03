import type { Logger } from 'pino';
import type { Task, TaskList } from 'graphile-worker';
import { eq, inArray, sql } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { editions, works, contributors, records, ingestDeadLetter, tapDeadLetter, publishers } from '../db/schema';
import type { EditionItem, WorkItem, ContributorItem, PublisherItem, Identifier } from '../search/types';
import { PUBLISHER_DID } from '../did';
import { parseEditionKey, parseWorkKey, parseAuthorKey, parsePublisherKey, editionRkey, workRkey, contributorRkey, publisherRkey } from '../ol/keys';
import { gbEditionRkey, gbWorkRkey, gbPublisherRkey, gbIdentifierFromUri } from '../gb/keys';
import { datacenterCoverUrl } from '../gb/cover-url';
import { bhEditionRkey, hiveIdFromCatalogUri, isHiveId } from '../bookhive/keys';
import { isbndbEditionRkey, isbndbWorkRkey, isbndbPublisherRkey, isbndbIdentifierFromUri } from '../isbndb/keys';
import { backfillCoverForEdition } from './cover-backfill';
import { backfillDescriptionForEdition } from './description-backfill';
import { backfillContributorImageForUri } from './contributor-image-backfill';
import { backfillIsbnForEdition } from './isbn-backfill';
import { fetchEditionForUri } from '../shelving/edition-fetch';
import { catalogUriForMirroredRecord } from '../shelving/pending-editions';
import { enqueueShelvingEditionBackfill } from './enqueue';
import { pdsClient } from '../pds/resolve';
import {
  dedupeByUri,
  parseRecordUri,
  uniqueUris,
  type MirrorRowInput,
  type RecordUriParts,
} from './tap-batch';
import {
  EDITION_WORK_LINK_COLLECTION,
  applyConsensus,
  consensusThreshold,
  forgetVoteByRecordUri,
  ingestVoteRecord,
} from '../edition-work-votes';

const db: typeof defaultDb = defaultDb;

type SourceKind = 'ol' | 'gb' | 'isbndb' | 'bh';

function olKeyFromIdentifiers(idents: Identifier[]): string | undefined {
  const i = idents.find((i) => i.resource === 'openlibrary');
  if (!i) return undefined;
  try {
    return new URL(i.uri).pathname;
  } catch {
    return undefined;
  }
}

function gbKeyFromIdentifiers(idents: Identifier[]): string | undefined {
  const i = idents.find((x) => x.resource === 'googlebooks');
  if (!i) return undefined;
  return gbIdentifierFromUri(i.uri) ?? undefined;
}

function isbndbKeyFromIdentifiers(idents: Identifier[]): string | undefined {
  const i = idents.find((x) => x.resource === 'isbndb');
  if (i) {
    const isbn = isbndbIdentifierFromUri(i.uri);
    if (isbn) return isbn;
  }
  for (const id of idents) {
    if (id.resource === 'isbn13' || id.resource === 'isbn10' || id.resource === 'isbn') {
      const clean = id.uri.replace(/^isbn:/, '').replace(/-/g, '');
      if (/^\d{10}(\d{3})?$/.test(clean)) return clean;
    }
  }
  return undefined;
}

/**
 * Hive id carried by a `bookhive` identifier — the catalog record's at-uri
 * (`at://…/buzz.bookhive.catalogBook/{hiveId}`), or the bare hive id.
 */
function bhHiveIdFromIdentifiers(idents: Identifier[]): string | undefined {
  const bookhive = idents.find((x) => x.resource === 'bookhive');
  if (!bookhive) return undefined;
  const hiveId = hiveIdFromCatalogUri(bookhive.uri);
  if (hiveId) return hiveId;
  return isHiveId(bookhive.uri) ? bookhive.uri : undefined;
}

/** Determine which synthesis path applies for an item, returning OL key, GB volume id, ISBNDb isbn, or nothing. */
function identifySource(
  idents: Identifier[],
): { kind: SourceKind; olKey: string; gbId: string; isbndbIsbn: string; hiveId: string } | null {
  const olKey = olKeyFromIdentifiers(idents);
  if (olKey) return { kind: 'ol', olKey, gbId: '', isbndbIsbn: '', hiveId: '' };
  const gbId = gbKeyFromIdentifiers(idents);
  if (gbId) return { kind: 'gb', olKey: '', gbId, isbndbIsbn: '', hiveId: '' };
  const isbndbIsbn = isbndbKeyFromIdentifiers(idents);
  if (isbndbIsbn) return { kind: 'isbndb', olKey: '', gbId: '', isbndbIsbn, hiveId: '' };
  const hiveId = bhHiveIdFromIdentifiers(idents);
  if (hiveId) return { kind: 'bh', olKey: '', gbId: '', isbndbIsbn: '', hiveId };
  return null;
}

/**
 * Edition uri an item with these identifiers is stored under, or undefined when
 * the identifiers carry no usable source key. Both the ingest loop and the DLQ
 * writer derive it from here so the two can never disagree about the key.
 */
export function editionUriFor(idents: Identifier[]): string | undefined {
  const source = identifySource(idents);
  if (!source) return undefined;
  const base = `at://${PUBLISHER_DID}/community.lexicon.book.edition/`;
  try {
    if (source.kind === 'ol') return `${base}${editionRkey(parseEditionKey(source.olKey))}`;
    if (source.kind === 'gb') return `${base}${gbEditionRkey(source.gbId)}`;
    if (source.kind === 'isbndb') return `${base}${isbndbEditionRkey(source.isbndbIsbn)}`;
    return `${base}${bhEditionRkey(source.hiveId)}`;
  } catch {
    return undefined;
  }
}

function publisherUriFor(item: PublisherItem): string | undefined {
  const olKey = olKeyFromIdentifiers(item.identifiers);
  if (olKey) {
    try {
      const olid = parsePublisherKey(olKey);
      const rkey = publisherRkey(olid);
      return `at://${PUBLISHER_DID}/community.lexicon.book.publisher/${rkey}`;
    } catch {
      return undefined;
    }
  }
  const gbId = gbKeyFromIdentifiers(item.identifiers);
  if (gbId) {
    try {
      const rkey = gbPublisherRkey(gbId);
      return `at://${PUBLISHER_DID}/community.lexicon.book.publisher/${rkey}`;
    } catch {
      return undefined;
    }
  }
  const isbndbIsbn = isbndbKeyFromIdentifiers(item.identifiers);
  if (isbndbIsbn) {
    try {
      const rkey = isbndbPublisherRkey(isbndbIsbn);
      return `at://${PUBLISHER_DID}/community.lexicon.book.publisher/${rkey}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function writeIngestDLQ(uri: string, payload: unknown, errorMessage: string, attempts: number): Promise<void> {
  await db.insert(ingestDeadLetter).values({
    uri,
    payload: payload as never,
    errorMessage,
    attempts,
  }).onConflictDoNothing();
}

async function writeTapDLQ(
  repoDid: string,
  collection: string,
  rkey: string,
  payload: unknown,
  errorMessage: string,
  attempts: number,
): Promise<void> {
  await db.insert(tapDeadLetter).values({
    repoDid,
    collection,
    rkey: rkey || 'unknown',
    payload: payload as never,
    errorMessage,
    attempts,
  });
}

// -- per-item tasks (kept for backward compat; new code prefers batch tasks) --

export const ingestEditionTask: Task = async (payload, helpers) => {
  await ingestEditionBatch([payload as EditionItem], helpers.logger as unknown as Logger, helpers.job.attempts);
};

export const ingestWorkTask: Task = async (payload, helpers) => {
  await ingestWorkBatch([payload as WorkItem], helpers.logger as unknown as Logger, helpers.job.attempts);
};

export const ingestContributorTask: Task = async (payload, helpers) => {
  await ingestContributorBatch([payload as ContributorItem], helpers.logger as unknown as Logger, helpers.job.attempts);
};

// -- batched handlers (single multi-row INSERT per call) --

export const ingestEditionBatchTask: Task = async (payload, helpers) => {
  const items = payload as EditionItem[];
  await ingestEditionBatch(items, helpers.logger as unknown as Logger, helpers.job.attempts);
};

export const ingestWorkBatchTask: Task = async (payload, helpers) => {
  const items = payload as WorkItem[];
  await ingestWorkBatch(items, helpers.logger as unknown as Logger, helpers.job.attempts);
};

export const ingestContributorBatchTask: Task = async (payload, helpers) => {
  const items = payload as ContributorItem[];
  await ingestContributorBatch(items, helpers.logger as unknown as Logger, helpers.job.attempts);
};

export async function ingestEditionBatch(items: EditionItem[], log: Logger, attempts: number): Promise<void> {
  try {
    const allRows: unknown[] = [];
    for (const item of items) {
      const uri = editionUriFor(item.identifiers);
      if (!uri) continue;
      const rkey = uri.slice(uri.lastIndexOf('/') + 1);
      const coverImageUrl = item.coverImageUrl ? datacenterCoverUrl(item.coverImageUrl) : undefined;
      const value = {
        $type: 'community.lexicon.book.edition' as const,
        title: item.title,
        subtitle: item.subtitle ?? undefined,
        place: item.place ?? undefined,
        publishedYear: item.publishedYear ?? undefined,
        language: item.language ?? undefined,
        coverImageUrl,
        contributors: item.contributors,
        identifiers: item.identifiers,
        description: item.description ?? undefined,
        createdAt: item.createdAt,
      };
      const cid = await cidForLex(value as unknown as LexMap);
      allRows.push({
        uri,
        cid: cid.toString(),
        did: PUBLISHER_DID,
        rkey,
        title: item.title,
        subtitle: item.subtitle ?? null,
        place: item.place ?? null,
        publishedYear: item.publishedYear ?? null,
        language: item.language ?? null,
        description: item.description ?? null,
        coverImageUrl: coverImageUrl ?? null,
        contributors: item.contributors,
        identifiers: item.identifiers,
        createdAt: new Date(item.createdAt),
      });
    }
    if (allRows.length === 0) return;
    await db.insert(editions).values(allRows as never).onConflictDoUpdate({
      target: editions.uri,
      set: {
        title: sql`excluded.title`,
        subtitle: sql`excluded.subtitle`,
        description: sql`excluded.description`,
        coverImageUrl: sql`excluded.cover_image_url`,
        identifiers: sql`excluded.identifiers`,
        contributors: sql`excluded.contributors`,
        indexedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'ingest-edition-batch', err, count: items.length }, 'batch ingest failed; writing to DLQ');
    for (const item of items) {
      const uri = editionUriFor(item.identifiers) ?? 'at://unknown/community.lexicon.book.edition/unknown';
      await writeIngestDLQ(uri, item, message, attempts);
    }
  }
}

async function ingestWorkBatch(items: WorkItem[], log: Logger, attempts: number): Promise<void> {
  try {
    const allRows: unknown[] = [];
    for (const item of items) {
      const source = identifySource(item.identifiers);
      let uri: string | undefined;
      let rkey: string | undefined;
      if (source?.kind === 'ol') {
        try {
          const olid = parseWorkKey(source.olKey);
          rkey = workRkey(olid);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.work/${rkey}`;
        } catch {
          continue;
        }
      } else if (source?.kind === 'gb') {
        try {
          rkey = gbWorkRkey(source.gbId);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.work/${rkey}`;
        } catch {
          continue;
        }
      } else if (source?.kind === 'isbndb') {
        try {
          rkey = isbndbWorkRkey(source.isbndbIsbn);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.work/${rkey}`;
        } catch {
          continue;
        }
      }
      if (!uri || !rkey) continue;
      const value = {
        $type: 'community.lexicon.book.work' as const,
        title: item.title,
        subtitle: item.subtitle ?? undefined,
        originalLanguage: item.originalLanguage ?? undefined,
        firstPublishedYear: item.firstPublishedYear ?? undefined,
        subjects: item.subjects,
        contributors: item.contributors,
        identifiers: item.identifiers,
        description: item.description ?? undefined,
        createdAt: item.createdAt,
      };
      const cid = await cidForLex(value as unknown as LexMap);
      allRows.push({
        uri,
        cid: cid.toString(),
        did: PUBLISHER_DID,
        rkey,
        title: item.title,
        subtitle: item.subtitle ?? null,
        originalLanguage: item.originalLanguage ?? null,
        firstPublishedYear: item.firstPublishedYear ?? null,
        subjects: item.subjects,
        contributors: item.contributors,
        identifiers: item.identifiers,
        description: item.description ?? null,
        createdAt: new Date(item.createdAt),
      });
    }
    if (allRows.length === 0) return;
    await db.insert(works).values(allRows as never).onConflictDoUpdate({
      target: works.uri,
      set: {
        title: sql`excluded.title`,
        subtitle: sql`excluded.subtitle`,
        description: sql`excluded.description`,
        identifiers: sql`excluded.identifiers`,
        contributors: sql`excluded.contributors`,
        indexedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'ingest-work-batch', err, count: items.length }, 'batch ingest failed; writing to DLQ');
    for (const item of items) {
      const olKey = olKeyFromIdentifiers(item.identifiers);
      let uri = 'at://unknown/community.lexicon.book.work/unknown';
      if (olKey) {
        try {
          const olid = parseWorkKey(olKey);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.work/${workRkey(olid)}`;
        } catch {
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.work/unknown`;
        }
      }
      await writeIngestDLQ(uri, item, message, attempts);
    }
  }
}

async function ingestContributorBatch(items: ContributorItem[], log: Logger, attempts: number): Promise<void> {
  try {
    const allRows: unknown[] = [];
    for (const item of items) {
      const olKey = olKeyFromIdentifiers(item.identifiers);
      let uri: string | undefined;
      let rkey: string | undefined;
      if (olKey) {
        try {
          const olid = parseAuthorKey(olKey);
          rkey = contributorRkey(olid);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.contributor/${rkey}`;
        } catch {
          continue;
        }
      }
      if (!uri || !rkey) continue;
      const value = {
        $type: 'community.lexicon.book.contributor' as const,
        name: item.name,
        aliases: item.aliases,
        bio: item.bio ?? undefined,
        bornYear: item.bornYear ?? undefined,
        diedYear: item.diedYear ?? undefined,
        linkedDid: item.linkedDid ?? undefined,
        identifiers: item.identifiers,
        createdAt: item.createdAt,
      };
      const cid = await cidForLex(value as unknown as LexMap);
      allRows.push({
        uri,
        cid: cid.toString(),
        did: PUBLISHER_DID,
        rkey,
        name: item.name,
        aliases: item.aliases,
        linkedDid: item.linkedDid ?? null,
        bio: item.bio ?? null,
        bornYear: item.bornYear ?? null,
        diedYear: item.diedYear ?? null,
        identifiers: item.identifiers,
        createdAt: new Date(item.createdAt),
      });
    }
    if (allRows.length === 0) return;
    await db.insert(contributors).values(allRows as never).onConflictDoUpdate({
      target: contributors.uri,
      set: {
        name: sql`excluded.name`,
        aliases: sql`excluded.aliases`,
        bio: sql`excluded.bio`,
        identifiers: sql`excluded.identifiers`,
        indexedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'ingest-contributor-batch', err, count: items.length }, 'batch ingest failed; writing to DLQ');
    for (const item of items) {
      const olKey = olKeyFromIdentifiers(item.identifiers);
      let uri = 'at://unknown/community.lexicon.book.contributor/unknown';
      if (olKey) {
        try {
          const olid = parseAuthorKey(olKey);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.contributor/${contributorRkey(olid)}`;
        } catch {
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.contributor/unknown`;
        }
      }
      await writeIngestDLQ(uri, item, message, attempts);
    }
  }
}

async function ingestPublisherBatch(items: PublisherItem[], log: Logger, attempts: number): Promise<void> {
  try {
    const allRows: unknown[] = [];
    for (const item of items) {
      const uri = publisherUriFor(item);
      const rkey = uri ? uri.split('/').pop() : undefined;
      if (!uri || !rkey) continue;
      const value = {
        $type: 'community.lexicon.book.publisher' as const,
        uri,
        name: item.name,
        imprintOf: item.imprintOf,
        foundingDate: item.foundingDate ?? undefined,
        closingDate: item.closingDate ?? undefined,
        identifiers: item.identifiers,
        createdAt: item.createdAt,
      };
      const cid = await cidForLex(value as unknown as LexMap);
      allRows.push({
        uri,
        cid: cid.toString(),
        did: PUBLISHER_DID,
        rkey,
        name: item.name,
        imprintOfUri: item.imprintOf?.uri ?? null,
        imprintOfCid: item.imprintOf?.cid ?? null,
        foundingDate: item.foundingDate ?? null,
        closingDate: item.closingDate ?? null,
        identifiers: item.identifiers,
        createdAt: new Date(item.createdAt),
      });
    }
    if (allRows.length === 0) return;
    await db.insert(publishers).values(allRows as never).onConflictDoUpdate({
      target: publishers.uri,
      set: {
        name: sql`excluded.name`,
        imprintOfUri: sql`excluded.imprint_of_uri`,
        imprintOfCid: sql`excluded.imprint_of_cid`,
        foundingDate: sql`excluded.founding_date`,
        closingDate: sql`excluded.closing_date`,
        identifiers: sql`excluded.identifiers`,
        indexedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'ingest-publisher-batch', err, count: items.length }, 'batch ingest failed; writing to DLQ');
    for (const item of items) {
      const uri = publisherUriFor(item) ?? `at://${PUBLISHER_DID}/community.lexicon.book.publisher/unknown`;
      await writeIngestDLQ(uri, item, message, attempts);
    }
  }
}

// -- Sync ingest helpers for direct-await caller paths (SearchService) --
// These mirror the batch handlers above but return synchronously so the caller
// can wait for getRecord to be resolvable before returning the search response.

export async function syncIngestEditions(items: EditionItem[], log: Logger): Promise<void> {
  await ingestEditionBatch(items, log, 1);
}

export async function syncIngestWorks(items: WorkItem[], log: Logger): Promise<void> {
  await ingestWorkBatch(items, log, 1);
}

export async function syncIngestContributors(items: ContributorItem[], log: Logger): Promise<void> {
  await ingestContributorBatch(items, log, 1);
}

export async function syncIngestPublishers(items: PublisherItem[], log: Logger): Promise<void> {
  await ingestPublisherBatch(items, log, 1);
}

// -- TAP record handlers --
// Mirroring a record comes first; anything derived from it (catalog fills,
// edition→work votes) runs after the write and never fails it.

/**
 * Fill one catalog edition that a shelf record points at.
 *
 * The ingest path enqueues this when a mirrored record names an edition the
 * `editions` table does not hold; the manual `backfill:shelving-editions` script
 * reaches the same rows, but only when someone runs it. The row is re-checked
 * here because a search ingest or an earlier job may have filled it first.
 *
 * A provider miss is a normal outcome, not a failure: `bh.*` editions have no
 * by-id provider, and an id can be genuinely absent upstream. Retrying would
 * only burn the attempt budget, so the job ends quietly and the next shelving
 * event for that edition asks again.
 */
export const backfillShelvingEditionTask: Task = async (payload, helpers) => {
  const { uri } = payload as { uri: string };
  const log = helpers.logger as unknown as Logger;
  const [existing] = await db.select({ uri: editions.uri }).from(editions).where(eq(editions.uri, uri)).limit(1);
  if (existing) return;

  const item = await fetchEditionForUri(uri, log, AbortSignal.timeout(15_000));
  if (!item) {
    log.info({ stage: 'backfill-shelving-edition', uri }, 'no provider record for edition; leaving catalog as is');
    return;
  }
  log.info({ stage: 'backfill-shelving-edition', uri }, 'filling catalog edition from its provider');
  await ingestEditionBatch([item], log, helpers.job.attempts);
};

/**
 * Enqueue a fill for every candidate the catalog is missing. Batched so a tap
 * page costs one existence query instead of one per event; failures are logged
 * and swallowed because mirroring the record matters more than filling behind it.
 */
async function enqueueMissingEditions(candidates: Set<string>, log: Logger): Promise<void> {
  if (candidates.size === 0) return;
  try {
    const uris = [...candidates];
    const known = new Set(
      (await db.select({ uri: editions.uri }).from(editions).where(inArray(editions.uri, uris))).map((row) => row.uri),
    );
    const missing = uris.filter((uri) => !known.has(uri));
    for (const uri of missing) await enqueueShelvingEditionBackfill(uri);
    if (missing.length > 0) {
      log.info({ stage: 'enqueue-missing-editions', missing: missing.length, seen: uris.length }, 'queued catalog fills');
    }
  } catch (err: unknown) {
    log.warn({ err, count: candidates.size }, 'enqueue-missing-editions failed; mirror left as is');
  }
}

export const tapRecordUpsertTask: Task = async (payload, helpers) => {
  const { uri, did, rkey, value } = payload as { uri: string; did: string; rkey: string; value: Record<string, unknown> };
  const collection = uri.split('/').slice(-2, -1)[0] ?? '';
  const log = helpers.logger as unknown as Logger;
  try {
    await db.insert(records).values({
      uri,
      cid: 'bafyplaceholder',
      did,
      rkey,
      collection,
      value: value as never,
      createdAt: new Date(),
    }).onConflictDoUpdate({
      target: records.uri,
      set: { value: value as never, indexedAt: new Date() },
    });

    // A shelf record for an edition the catalog has never ingested renders as
    // an empty shelf, so the fill has to start here rather than in a report.
    const candidate = catalogUriForMirroredRecord(collection, rkey, value);
    if (candidate) await enqueueMissingEditions(new Set([candidate]), log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'tap-record-upsert', err, uri }, 'tap upsert failed; writing to DLQ');
    await writeTapDLQ(did, collection, rkey, payload, message, helpers.job.attempts);
  }
};

export const tapRecordDeleteTask: Task = async (payload, helpers) => {
  const { uri } = payload as { uri: string };
  const collection = uri.split('/').slice(-2, -1)[0] ?? '';
  const did = uri.split('/').slice(-3, -2)[0] ?? '';
  const rkey = uri.split('/').pop() ?? '';
  const log = helpers.logger as unknown as Logger;
  try {
    await db.delete(records).where(eq(records.uri, uri));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'tap-record-delete', err, uri }, 'tap delete failed; writing to DLQ');
    await writeTapDLQ(did, collection, rkey, payload, message, helpers.job.attempts);
    return;
  }

  if (collection === EDITION_WORK_LINK_COLLECTION) {
    const editionUri = await forgetVoteByRecordUri(uri);
    if (editionUri) await applyConsensus(editionUri, consensusThreshold());
  }
};

/** Timeout for the confirmation read a delete makes against the record's repo. */
const DELETE_CONFIRM_TIMEOUT_MS = 10_000;

/** The branded did type the atproto client accepts on `repo`. */
type Did = `did:${string}:${string}`;

/** How many delete confirmations to ask the repos for at once. */
const DELETE_CONFIRM_CONCURRENCY = 8;

/**
 * One `records` row per uri, written idempotently.
 *
 * Shared by the TAP upsert and the delete path that revives a record the repo
 * still has, so both go through the same dedupe and the same conflict clause.
 */
async function upsertMirrorRows(items: readonly MirrorRowInput[]): Promise<void> {
  const rows = dedupeByUri(items).map((it) => ({
    uri: it.uri,
    cid: 'bafyplaceholder',
    did: it.did,
    rkey: it.rkey,
    collection: it.uri.split('/').slice(-2, -1)[0] ?? '',
    value: it.value as never,
    createdAt: new Date(),
  }));
  if (rows.length === 0) return;
  await db.insert(records).values(rows as never).onConflictDoUpdate({
    target: records.uri,
    set: { value: sql`excluded.value`, indexedAt: new Date() },
  });
}

/** Whether an atcute client error is the repo saying "no such record". */
function isRecordNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; error?: string; description?: string; message?: string };
  const text = `${e.error ?? ''} ${e.description ?? e.message ?? ''}`;
  if (e.status !== undefined && e.status !== 400) return false;
  return /RecordNotFound|could not locate record|record not found/i.test(text);
}

/**
 * What the record's own repo says about a uri we were told was deleted.
 *
 * `null` means the repo confirmed it is gone; `undefined` means the repo could
 * not be asked (timeout, 5xx, unresolvable DID) and the caller must retry rather
 * than guess — a wrong guess either resurrects a row or drops a live one.
 */
async function readRepoRecord(
  parts: RecordUriParts,
): Promise<{ value: Record<string, unknown> } | null | undefined> {
  let client;
  try {
    ({ client } = await pdsClient(parts.did, {
      signal: AbortSignal.timeout(DELETE_CONFIRM_TIMEOUT_MS),
    }));
  } catch {
    // A repo that no longer resolves cannot be serving the record, so the mirror
    // row is stale. Retrying would dead-letter a delete that can never succeed.
    return null;
  }
  try {
    const raw = await client.get('com.atproto.repo.getRecord', {
      params: {
        repo: parts.did as Did,
        collection: parts.collection as `${string}.${string}.${string}`,
        rkey: parts.rkey,
      },
      signal: AbortSignal.timeout(DELETE_CONFIRM_TIMEOUT_MS),
    });
    // atcute returns the payload directly; tolerate a `{ ok, data }` wrapper the
    // same way the shelving hydration does.
    const wrapper = raw as {
      ok?: boolean;
      data?: { value?: Record<string, unknown> };
      value?: Record<string, unknown>;
    };
    const value = wrapper.ok === true && wrapper.data ? wrapper.data.value : wrapper.value;
    return value ? { value } : undefined;
  } catch (err) {
    return isRecordNotFound(err) ? null : undefined;
  }
}

export const tapRecordUpsertBatchTask: Task = async (payload, helpers) => {
  const items = payload as Array<{ uri: string; did: string; rkey: string; value: Record<string, unknown> }>;
  const log = helpers.logger as unknown as Logger;
  try {
    if (items.length === 0) return;
    // One row per uri: a batch that names the same uri twice fails the whole
    // statement (`ON CONFLICT DO UPDATE command cannot affect row a second
    // time`), which used to dead-letter every record in it.
    const unique = dedupeByUri(items);
    await upsertMirrorRows(unique);

    const candidates = new Set<string>();
    for (const it of unique) {
      const collection = it.uri.split('/').slice(-2, -1)[0] ?? '';
      const uri = catalogUriForMirroredRecord(collection, it.rkey, it.value);
      if (uri) candidates.add(uri);
    }
    await enqueueMissingEditions(candidates, log);

    // Edition→work votes are only useful in `edition_work_votes`, not in the
    // generic `records` mirror, so materialize them and let consensus decide
    // whether the catalog changes.
    const voteEditions = new Set<string>();
    for (const it of unique) {
      const collection = it.uri.split('/').slice(-2, -1)[0] ?? '';
      if (collection !== EDITION_WORK_LINK_COLLECTION) continue;
      const editionUri = await ingestVoteRecord(it.uri, it.did, it.value);
      if (editionUri) voteEditions.add(editionUri);
    }
    for (const editionUri of voteEditions) {
      await applyConsensus(editionUri, consensusThreshold());
    }

    log.info(
      {
        stage: 'tap-record-upsert-batch',
        count: unique.length,
        received: items.length,
        voteEditions: voteEditions.size,
      },
      'batch upsert ok',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'tap-record-upsert-batch', err, count: items.length }, 'batch upsert failed; writing to DLQ');
    for (const it of items) {
      const collection = it.uri.split('/').slice(-2, -1)[0] ?? '';
      const rkey = it.uri.split('/').pop() ?? '';
      await db.insert(tapDeadLetter).values({
        repoDid: it.did,
        collection,
        rkey: rkey || 'unknown',
        payload: it as never,
        errorMessage: message,
        attempts: helpers.job.attempts,
      });
    }
  }
};

export const tapRecordDeleteBatchTask: Task = async (payload, helpers) => {
  const uris = uniqueUris(payload as string[]);
  const log = helpers.logger as unknown as Logger;
  try {
    if (uris.length === 0) return;

    // A delete and an earlier upsert for the same record are separate jobs on
    // separate workers, so acting on the event alone lets a late upsert
    // resurrect a deleted row. The repo is the authority: confirm each
    // deletion against the owner's PDS and mirror the record instead when it is
    // still there. The mirror drifted exactly this way (2845 shelving rows
    // against 2839 in the repo).
    const confirmed: string[] = [];
    const revived: MirrorRowInput[] = [];
    // Bounded concurrency: one PDS read per uri, eight in flight. Sequential
    // reads turned a 100-record batch into tens of seconds of job time, which
    // is exactly the backlog this has to drain.
    for (let start = 0; start < uris.length; start += DELETE_CONFIRM_CONCURRENCY) {
      const chunk = uris.slice(start, start + DELETE_CONFIRM_CONCURRENCY);
      const answers = await Promise.all(
        chunk.map(async (uri) => {
          const parts = parseRecordUri(uri);
          return { uri, parts, answer: parts ? await readRepoRecord(parts) : null };
        }),
      );
      for (const { uri, parts, answer } of answers) {
        if (!parts) {
          // Not addressable, so nothing better to do than drop the row.
          confirmed.push(uri);
          log.warn({ stage: 'tap-record-delete-batch', uri }, 'unparseable record uri; deleting the mirror row as-is');
          continue;
        }
        if (answer === null) {
          confirmed.push(uri);
          continue;
        }
        if (answer === undefined) {
          // The repo could not be asked. Retrying is the only safe answer: an
          // unconfirmed delete either resurrects a row or drops a live one.
          throw new Error(`could not confirm deletion of ${uri}`);
        }
        revived.push({ uri, did: parts.did, rkey: parts.rkey, value: answer.value });
      }
    }

    if (revived.length > 0) {
      await upsertMirrorRows(revived);
      log.warn(
        {
          stage: 'tap-record-delete-batch',
          count: revived.length,
          uris: revived.map((row) => row.uri),
        },
        'delete arrived for records the repo still has; mirrored them instead',
      );
    }

    if (confirmed.length > 0) {
      await db.delete(records).where(inArray(records.uri, confirmed));
    }

    const voteEditions = new Set<string>();
    for (const uri of confirmed) {
      if ((uri.split('/').slice(-2, -1)[0] ?? '') !== EDITION_WORK_LINK_COLLECTION) continue;
      const editionUri = await forgetVoteByRecordUri(uri);
      if (editionUri) voteEditions.add(editionUri);
    }
    for (const editionUri of voteEditions) {
      await applyConsensus(editionUri, consensusThreshold());
    }
    log.info(
      {
        stage: 'tap-record-delete-batch',
        count: confirmed.length,
        revived: revived.length,
        voteEditions: voteEditions.size,
      },
      'batch delete ok',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'tap-record-delete-batch', err, count: uris.length }, 'batch delete failed; writing to DLQ');
    for (const uri of uris) {
      const collection = uri.split('/').slice(-2, -1)[0] ?? '';
      const did = uri.split('/').slice(-3, -2)[0] ?? '';
      const rkey = uri.split('/').pop() ?? '';
      await db.insert(tapDeadLetter).values({
        repoDid: did,
        collection,
        rkey: rkey || 'unknown',
        payload: { uri } as never,
        errorMessage: message,
        attempts: helpers.job.attempts,
      });
    }
  }
};

export const backfillEditionCoverTask: Task = async (payload, helpers) => {
  const { uri, rkey } = payload as { uri: string; rkey: string };
  const log = helpers.logger as unknown as Logger;
  const res = await backfillCoverForEdition(uri, rkey, log);
  if (!res.updated) {
    log.info({ stage: 'backfill-edition-cover', uri, rkey, reason: res.reason }, 'cover backfill skipped');
  }
};

export const backfillEditionDescriptionTask: Task = async (payload, helpers) => {
  const { uri } = payload as { uri: string };
  const log = helpers.logger as unknown as Logger;
  const res = await backfillDescriptionForEdition(uri, log);
  if (!res.updated) {
    log.info({ stage: 'backfill-edition-description', uri, reason: res.reason }, 'description backfill skipped');
  }
};

export const backfillContributorImageTask: Task = async (payload, helpers) => {
  const { uri } = payload as { uri: string };
  const log = helpers.logger as unknown as Logger;
  await backfillContributorImageForUri(uri, log);
};

export const backfillEditionIsbnTask: Task = async (payload, helpers) => {
  const { uri, rkey } = payload as { uri: string; rkey: string };
  const log = helpers.logger as unknown as Logger;
  const res = await backfillIsbnForEdition(uri, rkey, log);
  if (!res.updated) {
    log.info({ stage: 'backfill-edition-isbn', uri, rkey, reason: res.reason }, 'isbn backfill skipped');
  }
};

export const searchTaskList: TaskList = {
  'ingest-edition': ingestEditionTask,
  'ingest-work': ingestWorkTask,
  'ingest-contributor': ingestContributorTask,
  'ingest-edition-batch': ingestEditionBatchTask,
  'ingest-work-batch': ingestWorkBatchTask,
  'ingest-contributor-batch': ingestContributorBatchTask,
  'backfill-edition-cover': backfillEditionCoverTask,
  'backfill-edition-description': backfillEditionDescriptionTask,
  'backfill-contributor-image': backfillContributorImageTask,
  'backfill-edition-isbn': backfillEditionIsbnTask,
};

export const tapTaskList: TaskList = {
  'tap-record-upsert': tapRecordUpsertTask,
  'tap-record-delete': tapRecordDeleteTask,
  'tap-record-upsert-batch': tapRecordUpsertBatchTask,
  'tap-record-delete-batch': tapRecordDeleteBatchTask,
  'backfill-shelving-edition': backfillShelvingEditionTask,
};

export const allTaskList: TaskList = {
  ...searchTaskList,
  ...tapTaskList,
};