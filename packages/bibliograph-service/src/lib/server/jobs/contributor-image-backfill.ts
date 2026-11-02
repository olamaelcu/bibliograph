import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/index';
import { contributors } from '../db/schema';
import { UpstreamDeferred } from '../api/deferred';
import {
  resolveContributorImage,
  type ContributorImageResolver,
  type ResolvedContributorImage,
} from '../contributor-image/resolver';

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

export type BackfillDb = typeof defaultDb;

export async function backfillContributorImageForUri(
  uri: string,
  log: Logger,
  db: BackfillDb = defaultDb,
  resolve: ContributorImageResolver = resolveContributorImage,
): Promise<{ updated: boolean; reason: string }> {
  const rows = await db.select().from(contributors).where(eq(contributors.uri, uri)).limit(1);
  const row = rows[0];
  if (!row) return { updated: false, reason: 'not_found' };
  if (row.imageCheckedAt !== null) return { updated: false, reason: 'already_checked' };
  if (row.imageUrl) return { updated: false, reason: 'already_has_image' };

  let resolved: ResolvedContributorImage | undefined;
  try {
    resolved = await resolve({
      rkey: row.rkey,
      name: row.name,
      log,
    });
  } catch (err) {
    if (err instanceof UpstreamDeferred) {
      // The resolver never got an answer: the row stays unchecked so a later
      // run retries it, instead of being stamped as a permanent miss.
      log.warn(
        { stage: 'contributor-image-backfill', uri, upstream: err.upstream, reason: err.reason },
        'upstream deferred; leaving contributor unchecked',
      );
      return { updated: false, reason: 'deferred' };
    }
    throw err;
  }

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
