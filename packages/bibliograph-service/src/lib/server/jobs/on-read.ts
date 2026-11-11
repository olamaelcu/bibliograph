import { inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db as defaultDb } from '../db/index';
import { contributors, editions } from '../db/schema';
import {
  enqueueContributorBioBackfill,
  enqueueContributorImageBackfill,
  enqueueCoverBackfill,
  enqueueDescriptionBackfill,
} from './enqueue';

type Db = typeof defaultDb;

/**
 * Fire-and-forget backfills for rows served on read paths (XRPC, hydration).
 * Every function here is internally fault-tolerant: a failed enqueue logs and
 * swallows, so a read never 502s because a backfill could not be queued.
 *
 * Gated on "never checked" in the database, not on the caller's view of the
 * row, so steady state costs one indexed ANY() query and zero enqueues; while
 * a job is pending the jobKey dedupes, and a miss is stamped, so the read path
 * converges to silence.
 */

/** Enqueue the missing-data backfills for these edition uris. */
export async function maybeEnqueueEditionBackfills(
  uris: Iterable<string>,
  log: Logger,
  db: Db = defaultDb,
): Promise<void> {
  try {
    const list = [...new Set(uris)].filter((uri) => uri.startsWith('at://'));
    if (list.length === 0) return;
    const rows = await db
      .select({
        uri: editions.uri,
        needDescription: sql<boolean>`${editions.description} is null and ${editions.descriptionCheckedAt} is null`,
        needCover: sql<boolean>`${editions.coverImageUrl} is null and ${editions.coverCheckedAt} is null`,
      })
      .from(editions)
      .where(inArray(editions.uri, list));
    for (const row of rows) {
      if (row.needDescription) {
        await enqueueDescriptionBackfill(row.uri).catch((err: unknown) =>
          log.warn({ err, uri: row.uri, stage: 'on-read-backfill' }, 'description backfill enqueue failed'),
        );
      }
      if (row.needCover) {
        // The cover job wants the rkey alongside the uri (legacy callers build
        // provider urls from it).
        const rkey = row.uri.split('/').pop() ?? '';
        await enqueueCoverBackfill(row.uri, rkey).catch((err: unknown) =>
          log.warn({ err, uri: row.uri, stage: 'on-read-backfill' }, 'cover backfill enqueue failed'),
        );
      }
    }
  } catch (err) {
    log.warn({ err, stage: 'on-read-backfill' }, 'book backfill enqueue failed');
  }
}

/** Enqueue the bio + portrait backfills for these contributor uris. */
export async function maybeEnqueueContributorBackfills(
  uris: Iterable<string>,
  log: Logger,
  db: Db = defaultDb,
): Promise<void> {
  try {
    const list = [...new Set(uris)].filter((uri) => uri.startsWith('at://'));
    if (list.length === 0) return;
    const rows = await db
      .select({
        uri: contributors.uri,
        needBio: sql<boolean>`${contributors.bio} is null and ${contributors.bioCheckedAt} is null`,
        needImage: sql<boolean>`${contributors.imageUrl} is null and ${contributors.imageCheckedAt} is null`,
      })
      .from(contributors)
      .where(inArray(contributors.uri, list));
    for (const row of rows) {
      if (row.needBio) {
        await enqueueContributorBioBackfill(row.uri).catch((err: unknown) =>
          log.warn({ err, uri: row.uri, stage: 'on-read-backfill' }, 'contributor bio backfill enqueue failed'),
        );
      }
      if (row.needImage) {
        await enqueueContributorImageBackfill(row.uri).catch((err: unknown) =>
          log.warn({ err, uri: row.uri, stage: 'on-read-backfill' }, 'contributor image backfill enqueue failed'),
        );
      }
    }
  } catch (err) {
    log.warn({ err, stage: 'on-read-backfill' }, 'contributor backfill enqueue failed');
  }
}
