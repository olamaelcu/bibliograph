import type { Logger } from 'pino';
import { eq, isNull, and } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { works } from '../db/schema';
import type { WorkRow } from '../db/schema';
import { googleBooksBreaker, isbndbBreaker } from '../api/breakers';
import { UPSTREAM_TIMEOUT_MS } from '../api/timeout';
import { isGbRkey, volumeIdFromGbRkey } from '../gb/keys';
import { isIsbndbRkey } from '../isbndb/keys';
import { getEditionByVolumeId } from '../api/google-books';
import { getBookByIsbn, isbndbDescription } from '../api/isbndb';
import { isbnFromIdentifiers } from '../isbn/lookup';
import { rowIdentifiers } from '../edition-record';
import { wireContributorsFor } from './wire-contributors';
import { workRecordValue } from '../book-records';

type Db = typeof defaultDb;

export async function resolveWorkDescription(
  row: WorkRow,
  log: Logger,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const s = signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  if (isGbRkey(row.rkey)) {
    try {
      const volId = volumeIdFromGbRkey(row.rkey);
      const item = await getEditionByVolumeId(volId, log, s);
      if (item?.description) return item.description;
    } catch {
      // fall through
    }
  }
  // ISBNdb via identifiers
  const isbn = isbnFromIdentifiers(rowIdentifiers(row.identifiers));
  if (isbn && isIsbndbRkey(row.rkey)) {
    try {
      const book = await getBookByIsbn(isbn, log, s);
      const desc = book ? isbndbDescription(book) : undefined;
      if (desc) return desc;
    } catch {
      // fall through
    }
  }
  // Fallback GB by ISBN for non-GB rkeys
  if (isbn && !isGbRkey(row.rkey)) {
    // Not directly supported for works via GB volume search; skip to keep scope bounded.
  }
  return undefined;
}

export async function backfillDescriptionForWork(
  uri: string,
  log: Logger,
  db: Db = defaultDb,
  signal: AbortSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
): Promise<{ updated: boolean; description?: string; reason: string }> {
  const rows = await db.select().from(works).where(eq(works.uri, uri)).limit(1);
  const row = rows[0];
  if (!row) return { updated: false, reason: 'not_found' };
  if (row.description) return { updated: false, reason: 'already_has_description' };
  // A negative result is only trustworthy when every upstream we would consult
  // was actually reachable; otherwise the row stays unchecked for a later run.
  const deferrable = () => [googleBooksBreaker, isbndbBreaker]
    .some((b) => !b.canCall());
  const wasDeferred = deferrable();
  const description = await resolveWorkDescription(row, log, signal);
  if (!description) {
    if (wasDeferred || deferrable()) {
      log.warn({ stage: 'work-description-backfill', uri }, 'an upstream breaker is open; leaving description unchecked');
      return { updated: false, reason: 'deferred' };
    }
    // Even when nothing found, mark as checked so scan is finite.
    await db.update(works).set({ descriptionCheckedAt: new Date() }).where(eq(works.uri, uri));
    return { updated: false, reason: 'no_description_found' };
  }
  const contributors = await wireContributorsFor(db, row.contributors);
  const value = workRecordValue(row, contributors, { description });
  const cid = (await cidForLex(value as unknown as LexMap)).toString();
  const updated = await db
    .update(works)
    .set({ description, cid, descriptionCheckedAt: new Date(), indexedAt: new Date() })
    .where(eq(works.uri, uri))
    .returning({ uri: works.uri });
  if (updated.length === 0) return { updated: false, reason: 'update_missed' };
  log.info({ stage: 'work-description-backfill', uri, length: description.length, cid }, 'work description backfilled');
  return { updated: true, description, reason: 'ok' };
}

export async function findWorksMissingDescription(
  db: Db = defaultDb,
  limit = 200,
): Promise<string[]> {
  const rows = await db
    .select({ uri: works.uri })
    .from(works)
    .where(and(isNull(works.description), isNull(works.descriptionCheckedAt)))
    .limit(limit);
  return rows.map((r) => r.uri);
}
