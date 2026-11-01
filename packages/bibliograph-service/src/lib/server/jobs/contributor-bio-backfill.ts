import type { Logger } from 'pino';
import { eq, isNull, and } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db as defaultDb } from '../db/index';
import { contributors } from '../db/schema';
import type { ContributorRow } from '../db/schema';
import { UPSTREAM_TIMEOUT_MS } from '../api/timeout';
import { enrichContributorBios } from '../api/wikipedia';
import { getContributorBioByRkey, openLibraryDescription } from '../api/open-library';

type Db = typeof defaultDb;

function contributorValueForCid(row: ContributorRow, bio?: string): Record<string, unknown> {
  return {
    $type: 'community.lexicon.book.contributor' as const,
    name: row.name,
    aliases: row.aliases,
    bio: bio ?? undefined,
    bornYear: row.bornYear ?? undefined,
    diedYear: row.diedYear ?? undefined,
    linkedDid: row.linkedDid ?? undefined,
    identifiers: row.identifiers,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function resolveContributorBio(
  row: ContributorRow,
  log: Logger,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const s = signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  // Primary: Wikipedia by contributor name.
  const bio = await enrichContributorBios([{ name: row.name, bio: undefined, aliases: row.aliases, bornYear: row.bornYear, diedYear: row.diedYear, linkedDid: row.linkedDid, identifiers: row.identifiers, createdAt: row.createdAt.toISOString(), uri: row.uri }], log, s);
  const wikiBio = bio[0]?.bio;
  if (wikiBio) return wikiBio;

  // Fallback: OpenLibrary author doc bio for contributors derived from OL.
  if (row.identifiers.some((id) => id.resource === 'openlibrary' && id.uri.includes('/authors/'))) {
    try {
      const olBio = await getContributorBioByRkey(row.rkey, log, s);
      if (olBio) return openLibraryDescription(olBio) ?? olBio;
    } catch {
      // fall through
    }
  }
  return undefined;
}

export async function backfillBioForContributor(
  uri: string,
  log: Logger,
  db: Db = defaultDb,
  signal: AbortSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
  const value = contributorValueForCid(row, bio);
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
