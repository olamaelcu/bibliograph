import type { Logger } from 'pino';
import { eq, isNull, and } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { contributors } from '../db/schema';
import type { ContributorRow } from '../db/schema';
import { enrichContributorBios } from '../api/wikipedia';
import { rowIdentifiers } from '../edition-record';
import { contributorRecordValue } from '../book-records';

type Db = typeof defaultDb;

export async function resolveContributorBio(
  row: ContributorRow,
  log: Logger,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // Primary: Wikipedia by contributor name.
  // The column types are nullable; the enricher's inputs are optional. Absent and
  // null mean the same thing to it, so normalize rather than spread the null
  // through a type that has no room for it.
  const identifiers = rowIdentifiers(row.identifiers);
  const bio = await enrichContributorBios([{ name: row.name, bio: undefined, aliases: row.aliases, bornYear: row.bornYear ?? undefined, diedYear: row.diedYear ?? undefined, linkedDid: row.linkedDid ?? undefined, identifiers, createdAt: row.createdAt.toISOString(), uri: row.uri }], log, signal);
  const wikiBio = bio[0]?.bio;
  return wikiBio;
}

export async function backfillBioForContributor(
  uri: string,
  log: Logger,
  db: Db = defaultDb,
  signal?: AbortSignal,
): Promise<{ updated: boolean; bio?: string; reason: string }> {
  const rows = await db.select().from(contributors).where(eq(contributors.uri, uri)).limit(1);
  const row = rows[0];
  if (!row) return { updated: false, reason: 'not_found' };
  if (row.bio) return { updated: false, reason: 'already_has_bio' };

  const bio = await resolveContributorBio(row, log, signal);
  if (!bio) {
    await db.update(contributors).set({ bioCheckedAt: new Date() }).where(eq(contributors.uri, uri));
    return { updated: false, reason: 'no_bio_found' };
  }
  const value = contributorRecordValue({ ...row, bio });
  const cid = (await cidForLex(value as unknown as LexMap)).toString();
  const updated = await db
    .update(contributors)
    .set({ bio, cid, bioCheckedAt: new Date(), indexedAt: new Date() })
    .where(eq(contributors.uri, uri))
    .returning({ uri: contributors.uri });
  if (updated.length === 0) return { updated: false, reason: 'update_missed' };
  log.info({ stage: 'contributor-bio-backfill', uri, length: bio.length, cid }, 'contributor bio backfilled');
  return { updated: true, bio, reason: 'ok' };
}

export async function findContributorsMissingBio(
  db: Db = defaultDb,
  limit = 200,
): Promise<string[]> {
  const rows = await db
    .select({ uri: contributors.uri })
    .from(contributors)
    .where(and(isNull(contributors.bio), isNull(contributors.bioCheckedAt)))
    .limit(limit);
  return rows.map((r) => r.uri);
}
