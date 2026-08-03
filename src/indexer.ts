import { eq, and } from 'drizzle-orm';
import { db, schema } from './db/connection.js';
import { logger } from './logger.js';

const { books, reviews, readingStatuses, claims, shelves, shelfItems } = schema;

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
      await indexReview(uri, evt.did, record, evt.cid);
      break;
    case 'community.lexicon.book.status':
      await indexStatus(uri, evt.did, record);
      break;
    case 'community.lexicon.book.claim':
      await indexClaim(uri, evt.did, record);
      break;
    case 'community.lexicon.book.shelf':
      await indexShelf(uri, evt.did, record);
      break;
    case 'community.lexicon.book.shelfItem':
      await indexShelfItem(uri, evt.did, record);
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
    case 'community.lexicon.book.shelf':
      await db.delete(shelves).where(eq(shelves.uri, uri));
      break;
    case 'community.lexicon.book.shelfItem':
      await db.delete(shelfItems).where(eq(shelfItems.uri, uri));
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

async function indexReview(uri: string, did: string, record: Record<string, unknown>, cid?: string): Promise<void> {
  const bookRef = record.bookRef as Record<string, unknown> | undefined;
  const data = {
    uri,
    did,
    bookUri: record.bookUri as string,
    text: record.text as string,
    rating: record.rating as number | undefined,
    cid,
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
  const idents = (Array.isArray(record.identifiers) ? record.identifiers : []) as Array<{ type: string; value: string }>;
  const data = {
    uri,
    did,
    bookUri: record.bookUri as string,
    status: record.status as string,
    progress: record.progress as number | undefined,
    rating: record.rating as number | undefined,
    bookTitle: (bookRef?.title as string) || '',
    bookAuthor: (bookRef?.author as string) || '',
    identifiers: idents,
    startedAt: record.startedAt as string | undefined,
    finishedAt: record.finishedAt as string | undefined,
    createdAt: (record.createdAt as string) || new Date().toISOString(),
  };

  const existing = await db.query.readingStatuses.findFirst({
    where: and(eq(readingStatuses.did, did), eq(readingStatuses.bookUri, data.bookUri)),
  });

  if (existing) {
    if (existing.uri === uri) {
      await db.update(readingStatuses).set(data).where(eq(readingStatuses.uri, uri));
    } else {
      logger.warn({ uri, existingUri: existing.uri, bookUri: data.bookUri, did }, 'status index: new record supersedes existing');
      await db.update(readingStatuses).set(data).where(eq(readingStatuses.uri, existing.uri));
    }
    return;
  }

  await db.insert(readingStatuses).values(data);
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

async function indexShelf(uri: string, did: string, record: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const data = {
    uri,
    did,
    name: record.name as string,
    description: record.description as string | undefined,
    metadata: record.metadata as Record<string, unknown> | undefined,
    coverUrl: record.coverUrl as string | undefined,
    createdAt: (record.createdAt as string) || now,
    updatedAt: now,
  };

  await db.insert(shelves).values(data).onConflictDoUpdate({
    target: shelves.uri,
    set: data,
  });
}

async function indexShelfItem(uri: string, did: string, record: Record<string, unknown>): Promise<void> {
  const bookRef = record.bookRef as Record<string, unknown> | undefined;
  const data = {
    uri,
    did,
    shelfUri: record.shelfUri as string,
    bookUri: record.bookUri as string,
    bookTitle: (bookRef?.title as string) || '',
    bookAuthor: (bookRef?.author as string) || '',
    note: record.note as string | undefined,
    createdAt: (record.createdAt as string) || new Date().toISOString(),
  };

  await db.insert(shelfItems).values(data).onConflictDoUpdate({
    target: shelfItems.uri,
    set: data,
  });
}
