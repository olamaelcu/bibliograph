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
import { isbndbEditionRkey, isbndbWorkRkey, isbndbPublisherRkey, isbndbIdentifierFromUri } from '../isbndb/keys';
import { backfillCoverForEdition } from './cover-backfill';
import { backfillDescriptionForEdition } from './description-backfill';
import { backfillContributorImageForUri } from './contributor-image-backfill';

const db: typeof defaultDb = defaultDb;

type SourceKind = 'ol' | 'gb' | 'isbndb';

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

/** Determine which synthesis path applies for an item, returning OL key, GB volume id, ISBNDb isbn, or nothing. */
function identifySource(
  idents: Identifier[],
): { kind: SourceKind; olKey: string; gbId: string; isbndbIsbn: string } | null {
  const olKey = olKeyFromIdentifiers(idents);
  if (olKey) return { kind: 'ol', olKey, gbId: '', isbndbIsbn: '' };
  const gbId = gbKeyFromIdentifiers(idents);
  if (gbId) return { kind: 'gb', olKey: '', gbId, isbndbIsbn: '' };
  const isbndbIsbn = isbndbKeyFromIdentifiers(idents);
  if (isbndbIsbn) return { kind: 'isbndb', olKey: '', gbId: '', isbndbIsbn };
  return null;
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

async function ingestEditionBatch(items: EditionItem[], log: Logger, attempts: number): Promise<void> {
  try {
    const allRows: unknown[] = [];
    for (const item of items) {
      const source = identifySource(item.identifiers);
      let uri: string | undefined;
      let rkey: string | undefined;
      if (source?.kind === 'ol') {
        try {
          const olid = parseEditionKey(source.olKey);
          rkey = editionRkey(olid);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.edition/${rkey}`;
        } catch {
          continue;
        }
      } else if (source?.kind === 'gb') {
        try {
          rkey = gbEditionRkey(source.gbId);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.edition/${rkey}`;
        } catch {
          continue;
        }
      } else if (source?.kind === 'isbndb') {
        try {
          rkey = isbndbEditionRkey(source.isbndbIsbn);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.edition/${rkey}`;
        } catch {
          continue;
        }
      }
      if (!uri || !rkey) continue;
      const value = {
        $type: 'community.lexicon.book.edition' as const,
        title: item.title,
        subtitle: item.subtitle ?? undefined,
        place: item.place ?? undefined,
        publishedYear: item.publishedYear ?? undefined,
        language: item.language ?? undefined,
        coverImageUrl: item.coverImageUrl ?? undefined,
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
        coverImageUrl: item.coverImageUrl ?? null,
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
      const olKey = olKeyFromIdentifiers(item.identifiers);
      let uri = 'at://unknown/community.lexicon.book.edition/unknown';
      if (olKey) {
        try {
          const olid = parseEditionKey(olKey);
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.edition/${editionRkey(olid)}`;
        } catch {
          uri = `at://${PUBLISHER_DID}/community.lexicon.book.edition/unknown`; // malformed
        }
      }
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

// -- TAP record handlers (unchanged) --

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
  }
};

export const tapRecordUpsertBatchTask: Task = async (payload, helpers) => {
  const items = payload as Array<{ uri: string; did: string; rkey: string; value: Record<string, unknown> }>;
  const log = helpers.logger as unknown as Logger;
  try {
    if (items.length === 0) return;
    const rows = items.map((it) => ({
      uri: it.uri,
      cid: 'bafyplaceholder',
      did: it.did,
      rkey: it.rkey,
      collection: it.uri.split('/').slice(-2, -1)[0] ?? '',
      value: it.value as never,
      createdAt: new Date(),
    }));
    await db.insert(records).values(rows as never).onConflictDoUpdate({
      target: records.uri,
      set: { value: records.value, indexedAt: new Date() },
    });
    log.info({ stage: 'tap-record-upsert-batch', count: items.length }, 'batch upsert ok');
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
  const uris = payload as string[];
  const log = helpers.logger as unknown as Logger;
  try {
    if (uris.length === 0) return;
    await db.delete(records).where(inArray(records.uri, uris));
    log.info({ stage: 'tap-record-delete-batch', count: uris.length }, 'batch delete ok');
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
};

export const tapTaskList: TaskList = {
  'tap-record-upsert': tapRecordUpsertTask,
  'tap-record-delete': tapRecordDeleteTask,
  'tap-record-upsert-batch': tapRecordUpsertBatchTask,
  'tap-record-delete-batch': tapRecordDeleteBatchTask,
};

export const allTaskList: TaskList = {
  ...searchTaskList,
  ...tapTaskList,
};