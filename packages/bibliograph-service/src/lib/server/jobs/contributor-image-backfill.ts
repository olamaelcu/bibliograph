import type { Logger } from 'pino';
import { eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/index';
import { contributors } from '../db/schema';
import { resolveContributorImage } from '../contributor-image/resolver';

/**
 * Look up and persist a contributor's image + license metadata.
 *
 * The image is NOT stored in the community record (`community.lexicon.book.contributor`)
 * because that lexicon has no image field — adding one would be a cross-
 * ecosystem schema change and would invalidate every contributor CID in
 * the network. Instead it lives as a derived column on the local cache,
 * served only via `getImageForContributor`.
 *
 * Idempotent: a contributor with `imageCheckedAt` already set is skipped
 * (the resolver was tried and produced nothing — retrying it on every
 * page render is wasted outbound traffic).
 *
 * Returns `updated: true` when a new image was found and persisted.
 */

type Db = typeof defaultDb;

export async function backfillContributorImageForUri(
  uri: string,
  log: Logger,
  db: Db = defaultDb,
): Promise<{ updated: boolean; reason: string }> {
  const rows = await db.select().from(contributors).where(eq(contributors.uri, uri)).limit(1);
  const row = rows[0];
  if (!row) return { updated: false, reason: 'not_found' };
  if (row.imageCheckedAt !== null) return { updated: false, reason: 'already_checked' };
  if (row.imageUrl) return { updated: false, reason: 'already_has_image' };

  const resolved = await resolveContributorImage({
    rkey: row.rkey,
    name: row.name,
    log,
  });

  if (!resolved) {
    await db
      .update(contributors)
      .set({ imageCheckedAt: new Date() })
      .where(eq(contributors.uri, uri));
    return { updated: false, reason: 'no_image_found' };
  }

  await db
    .update(contributors)
    .set({
      imageUrl: resolved.url,
      imageSource: resolved.source,
      imageArtist: resolved.artist ?? null,
      imageLicense: resolved.license ?? null,
      imageLicenseUrl: resolved.licenseUrl ?? null,
      imageAttributionRequired: resolved.attributionRequired,
      imageCheckedAt: new Date(),
    })
    .where(eq(contributors.uri, uri));

  log.info(
    { stage: 'contributor-image-backfill', uri, source: resolved.source },
    'contributor image backfilled',
  );
  return { updated: true, reason: 'ok' };
}

export async function findUncheckedContributorUris(
  db: Db = defaultDb,
  limit = 200,
): Promise<string[]> {
  const rows = await db
    .select({ uri: contributors.uri })
    .from(contributors)
    .where(isNull(contributors.imageCheckedAt))
    .limit(limit);
  return rows.map((r) => r.uri);
}