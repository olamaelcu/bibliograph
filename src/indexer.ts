import { eq } from 'drizzle-orm';
import { db, schema } from './db/connection.js';
import { logger } from './logger.js';

const { books, reviews, readingStatuses, claims } = schema;

export interface TapRecordEvent {
  type: 'record';
  action: 'create' | 'update' | 'delete';
  did: string;
  rev: string;
  collection: string;
  rkey: string;
  record?: Record<string, unknown>;
  cid?: string;
  live: boolean;
}

export interface TapIdentityEvent {
  type: 'identity';
  did: string;
  handle: string;
  isActive: boolean;
  status: string;
}

export type TapEvent = TapRecordEvent | TapIdentityEvent;

export async function handleRecordEvent(evt: TapRecordEvent): Promise<void> {
  const uri = `at://${evt.did}/${evt.collection}/${evt.rkey}`;
  logger.info({ action: evt.action, collection: evt.collection, uri }, 'tap event');

  if (evt.action === 'delete') {
    await handleDelete(evt.collection, uri);
    return;
  }

  if (!evt.record) return;

  const record = evt.record as Record<string, unknown>;

  switch (evt.collection) {
    case 'community.lexicon.book.book':
      await indexBook(uri, evt.did, record, evt.action);
      break;
    case 'community.lexicon.book.review':
      await indexReview(uri, evt.did, record);
      break;
    case 'community.lexicon.book.status':
      await indexStatus(uri, evt.did, record);
      break;
    case 'community.lexicon.book.claim':
      await indexClaim(uri, evt.did, record);
      break;
  }
}

async function handleDelete(collection: string, uri: string): Promise<void> {
  switch (collection) {
    case 'community.lexicon.book.book':
      await db.delete(books).where(eq(books.uri, uri));
      break;
    case 'community.lexicon.book.review':
      await db.delete(reviews).where(eq(reviews.uri, uri));
      break;
    case 'community.lexicon.book.status':
      await db.delete(readingStatuses).where(eq(readingStatuses.uri, uri));
      break;
    case 'community.lexicon.book.claim':
      await db.delete(claims).where(eq(claims.uri, uri));
      break;
  }
}

async function indexBook(uri: string, did: string, record: Record<string, unknown>, action: string): Promise<void> {
  const cats = (Array.isArray(record.categories) ? record.categories : []) as string[];
  const idents = (Array.isArray(record.identifiers) ? record.identifiers : []) as Array<{ type: string; value: string }>;
  const now = new Date().toISOString();
  const data = {
    uri,
    did,
    title: record.title as string,
    author: record.author as string,
    isbn: record.isbn as string | undefined,
    publishedDate: record.publishedDate as string | undefined,
    description: record.description as string | undefined,
    pageCount: record.pageCount as number | undefined,
    language: record.language as string | undefined,
    categories: cats,
    identifiers: idents,
    coverUrl: record.coverUrl as string | undefined,
    deduplicationHash: record.deduplicationHash as string | undefined,
    status: (record.status as string) || 'pending',
    createdAt: (record.createdAt as string) || now,
    updatedAt: now,
  };

  if (action === 'create') {
    await db.insert(books).values(data).onConflictDoUpdate({
      target: books.uri,
      set: { ...data },
    });
  } else {
    await db.update(books)
      .set(data)
      .where(eq(books.uri, uri));
  }
}

async function indexReview(uri: string, did: string, record: Record<string, unknown>): Promise<void> {
  const bookRef = record.bookRef as Record<string, unknown> | undefined;
  const data = {
    uri,
    did,
    bookUri: record.bookUri as string,
    text: record.text as string,
    rating: record.rating as number | undefined,
    bookTitle: (bookRef?.title as string) || '',
    bookAuthor: (bookRef?.author as string) || '',
    createdAt: (record.createdAt as string) || new Date().toISOString(),
  };

  await db.insert(reviews).values(data).onConflictDoUpdate({
    target: reviews.uri,
    set: data,
  });
}

async function indexStatus(uri: string, did: string, record: Record<string, unknown>): Promise<void> {
  const bookRef = record.bookRef as Record<string, unknown> | undefined;
  const data = {
    uri,
    did,
    bookUri: record.bookUri as string,
    status: record.status as string,
    progress: record.progress as number | undefined,
    rating: record.rating as number | undefined,
    bookTitle: (bookRef?.title as string) || '',
    bookAuthor: (bookRef?.author as string) || '',
    startedAt: record.startedAt as string | undefined,
    finishedAt: record.finishedAt as string | undefined,
    createdAt: (record.createdAt as string) || new Date().toISOString(),
  };

  await db.insert(readingStatuses).values(data).onConflictDoUpdate({
    target: readingStatuses.uri,
    set: data,
  });
}

async function indexClaim(uri: string, did: string, record: Record<string, unknown>): Promise<void> {
  const data = {
    uri,
    did,
    bookUri: record.bookUri as string,
    identifier: record.identifier as string,
    identifierType: record.identifierType as string,
    claimedBy: record.claimedBy as string,
    status: (record.status as string) || 'pending',
    verifiedBy: record.verifiedBy as string | undefined,
    verifiedAt: record.verifiedAt as string | undefined,
    createdAt: (record.createdAt as string) || new Date().toISOString(),
  };

  await db.insert(claims).values(data).onConflictDoUpdate({
    target: claims.uri,
    set: data,
  });
}
