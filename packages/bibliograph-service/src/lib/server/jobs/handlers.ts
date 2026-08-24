import type { Logger } from 'pino';
import type { Task, TaskList } from 'graphile-worker';
import { eq } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { editions, works, contributors, records, ingestDeadLetter, tapDeadLetter } from '../db/schema';
import { PUBLISHER_DID } from '../did';
import type { EditionItem, WorkItem, ContributorItem, Identifier } from '../search/types';

type Db = typeof defaultDb;

const db: Db = defaultDb;

function rkeyForEdition(olKey: string): string {
  return `ol-edition-${olKey.replace(/^\/books\//, '')}`;
}
function rkeyForWork(olKey: string): string {
  return `ol-work-${olKey.replace(/^\/works\//, '')}`;
}
function rkeyForContributor(olKey: string): string {
  return `ol-author-${olKey.replace(/^\/authors\//, '')}`;
}

function olKeyFromIdentifiers(idents: Identifier[]): string | undefined {
  return idents.find((i) => i.resource === 'openlibrary')?.uri.replace(/^https:\/\/openlibrary\.org/, '');
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
      const olKey = olKeyFromIdentifiers(item.identifiers);
      if (!olKey) continue;
      const rkey = rkeyForEdition(olKey);
      const uri = `at://${PUBLISHER_DID}/community.lexicon.book.edition/${rkey}`;
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
        title: editions.title,
        subtitle: editions.subtitle,
        description: editions.description,
        coverImageUrl: editions.coverImageUrl,
        identifiers: editions.identifiers,
        contributors: editions.contributors,
        indexedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'ingest-edition-batch', err, count: items.length }, 'batch ingest failed; writing to DLQ');
    for (const item of items) {
      const olKey = olKeyFromIdentifiers(item.identifiers);
      const uri = olKey
        ? `at://${PUBLISHER_DID}/community.lexicon.book.edition/${rkeyForEdition(olKey)}`
        : 'at://unknown/community.lexicon.book.edition/unknown';
      await writeIngestDLQ(uri, item, message, attempts);
    }
  }
}

async function ingestWorkBatch(items: WorkItem[], log: Logger, attempts: number): Promise<void> {
  try {
    const allRows: unknown[] = [];
    for (const item of items) {
      const olKey = olKeyFromIdentifiers(item.identifiers);
      if (!olKey) continue;
      const rkey = rkeyForWork(olKey);
      const uri = `at://${PUBLISHER_DID}/community.lexicon.book.work/${rkey}`;
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
        title: works.title,
        subtitle: works.subtitle,
        description: works.description,
        identifiers: works.identifiers,
        contributors: works.contributors,
        indexedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'ingest-work-batch', err, count: items.length }, 'batch ingest failed; writing to DLQ');
    for (const item of items) {
      const olKey = olKeyFromIdentifiers(item.identifiers);
      const uri = olKey
        ? `at://${PUBLISHER_DID}/community.lexicon.book.work/${rkeyForWork(olKey)}`
        : 'at://unknown/community.lexicon.book.work/unknown';
      await writeIngestDLQ(uri, item, message, attempts);
    }
  }
}

async function ingestContributorBatch(items: ContributorItem[], log: Logger, attempts: number): Promise<void> {
  try {
    const allRows: unknown[] = [];
    for (const item of items) {
      const olKey = olKeyFromIdentifiers(item.identifiers);
      if (!olKey) continue;
      const rkey = rkeyForContributor(olKey);
      const uri = `at://${PUBLISHER_DID}/community.lexicon.book.contributor/${rkey}`;
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
        name: contributors.name,
        aliases: contributors.aliases,
        bio: contributors.bio,
        identifiers: contributors.identifiers,
        indexedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ stage: 'ingest-contributor-batch', err, count: items.length }, 'batch ingest failed; writing to DLQ');
    for (const item of items) {
      const olKey = olKeyFromIdentifiers(item.identifiers);
      const uri = olKey
        ? `at://${PUBLISHER_DID}/community.lexicon.book.contributor/${rkeyForContributor(olKey)}`
        : 'at://unknown/community.lexicon.book.contributor/unknown';
      await writeIngestDLQ(uri, item, message, attempts);
    }
  }
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

export const searchTaskList: TaskList = {
  'ingest-edition': ingestEditionTask,
  'ingest-work': ingestWorkTask,
  'ingest-contributor': ingestContributorTask,
  'ingest-edition-batch': ingestEditionBatchTask,
  'ingest-work-batch': ingestWorkBatchTask,
  'ingest-contributor-batch': ingestContributorBatchTask,
};

export const tapTaskList: TaskList = {
  'tap-record-upsert': tapRecordUpsertTask,
  'tap-record-delete': tapRecordDeleteTask,
};

export const allTaskList: TaskList = {
  ...searchTaskList,
  ...tapTaskList,
};