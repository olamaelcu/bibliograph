import { and, eq, count, gt } from 'drizzle-orm';
import { db, schema } from './db/connection.js';
import { logger } from './logger.js';

const { bookLabels, labelEvents } = schema;

/**
 * Publish a label asserted by this service.
 * The `src` field is the service's own DID — this AppView is the label authority.
 * This is a reference implementation: label authority is self-contained.
 */
export function publishLabel(
  src: string,
  val: string,
  uri: string,
): void {
  const now = new Date().toISOString();
  db.insert(bookLabels)
    .values({ src, uri, val, cts: now, neg: 0 })
    .onConflictDoUpdate({
      target: [bookLabels.src, bookLabels.uri, bookLabels.val],
      set: { neg: 0, cts: now },
    })
    .run();
  db.insert(labelEvents).values({ src, uri, val, cts: now, neg: 0 }).run();
  logger.info({ src, val, uri }, 'label published');
}

/**
 * Negate a previously published label.
 */
export function negateLabel(
  src: string,
  val: string,
  uri: string,
): void {
  const now = new Date().toISOString();
  db.update(bookLabels)
    .set({ neg: 1, cts: now })
    .where(
      and(
        eq(bookLabels.src, src),
        eq(bookLabels.uri, uri),
        eq(bookLabels.val, val),
      ),
    )
    .run();
  db.insert(labelEvents).values({ src, uri, val, cts: now, neg: 1 }).run();
  logger.info({ src, val, uri }, 'label negated');
}

/**
 * Check whether an active label exists.
 * If `did` is provided, the label must match that DID as src.
 */
export function hasLabel(
  uri: string,
  val: string,
  did?: string,
): boolean {
  const conditions = [
    eq(bookLabels.uri, uri),
    eq(bookLabels.val, val),
    eq(bookLabels.neg, 0),
  ];
  if (did) conditions.push(eq(bookLabels.src, did));

  const rows = db
    .select({ n: count() })
    .from(bookLabels)
    .where(and(...conditions))
    .all();

  const n = rows[0]?.n ?? 0;
  return Number(n) > 0;
}

export interface LabelEntry {
  src: string;
  uri: string;
  val: string;
  cts: string;
  neg: boolean;
}

/**
 * Return all active labels for a given URI and optional value filter.
 */
export function getLabels(
  uri: string,
  val?: string,
): LabelEntry[] {
  const conditions = [eq(bookLabels.uri, uri), eq(bookLabels.neg, 0)];
  if (val) conditions.push(eq(bookLabels.val, val));

  const rows = db
    .select()
    .from(bookLabels)
    .where(and(...conditions))
    .all();

  return rows.map((r) => ({
    src: r.src,
    uri: r.uri,
    val: r.val,
    cts: r.cts,
    neg: r.neg === 1,
  }));
}

export const LABEL_AUTHOR = 'book:author' as const;
export const LABEL_LIBRARIAN = 'book:librarian' as const;

export interface LabelEventEntry {
  id: number;
  src: string;
  uri: string;
  val: string;
  cts: string;
  neg: boolean;
}

/**
 * Return label events with id greater than `afterId` (or all events when
 * omitted), ordered by id. `id` is the atproto subscription `seq`.
 */
export function getLabelEvents(afterId?: number): LabelEventEntry[] {
  const conditions = [];
  if (afterId !== undefined) conditions.push(gt(labelEvents.id, afterId));

  const rows = db
    .select()
    .from(labelEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(labelEvents.id)
    .all();

  return rows.map((r) => ({
    id: r.id,
    src: r.src,
    uri: r.uri,
    val: r.val,
    cts: r.cts,
    neg: r.neg === 1,
  }));
}

/**
 * Return all currently active (non-negated) labels across all URIs.
 * Used as the initial snapshot when a subscriber connects without a cursor.
 */
export function getActiveLabels(): LabelEntry[] {
  const rows = db
    .select()
    .from(bookLabels)
    .where(eq(bookLabels.neg, 0))
    .all();

  return rows.map((r) => ({
    src: r.src,
    uri: r.uri,
    val: r.val,
    cts: r.cts,
    neg: r.neg === 1,
  }));
}
