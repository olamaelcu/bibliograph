import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { db } from '../db';
import { contributors } from '../db/schema';
import {
  parseAuthorKey,
  contributorUri,
  contributorRkey,
} from '../ol/keys';
import { getContributorByRkey } from './open-library';
import { enqueueIngest } from '../jobs/enqueue';
import type { ContributionEntry } from '../search/types';

/**
 * Resolve OpenLibrary author keys (e.g. `/authors/OL26392A`) into a list of
 * `ContributionEntry` strongRefs that point at the corresponding
 * `community.lexicon.book.contributor` record in the biblio repo.
 *
 * For each key:
 *   1. If the contributor already exists in the DB, reuse its stored uri+cid.
 *   2. Otherwise fetch `/authors/{olid}.json`, build a `ContributorItem`,
 *      compute a deterministic cid via `cidForLex`, fire-and-forget an ingest,
 *      and return the strongRef using that cid.
 *
 * The function never throws: malformed keys are skipped with a warn log,
 * DB or OL failures degrade to "skip this contributor" so the surrounding
 * edition/work build can still succeed with a partial contributor list.
 */
export async function resolveOlContributors(
  authorKeys: string[],
  log: Logger,
  signal?: AbortSignal,
): Promise<ContributionEntry[]> {
  const entries: ContributionEntry[] = [];
  for (const key of authorKeys) {
    try {
      const olid = parseAuthorKey(key);
      const uri = contributorUri(olid);

      let cid: string | null = null;

      // DB hit
      try {
        const [row] = await db
          .select({ cid: contributors.cid })
          .from(contributors)
          .where(eq(contributors.uri, uri))
          .limit(1);
        if (row?.cid) cid = row.cid;
      } catch (err) {
        log.warn(
          { stage: 'resolve-ol-contributors', uri, err: String(err) },
          'db lookup failed; falling back to ol fetch',
        );
      }

      // DB miss → fetch OL doc + compute cid
      if (!cid) {
        const item = await getContributorByRkey(contributorRkey(olid), log, signal);
        if (!item) {
          log.warn(
            { stage: 'resolve-ol-contributors', olid },
            'ol author lookup returned null; skipping',
          );
          continue;
        }
        const value = {
          $type: 'community.lexicon.book.contributor' as const,
          name: item.name,
          aliases: item.aliases,
          bio: undefined,
          bornYear: item.bornYear,
          diedYear: item.diedYear,
          linkedDid: undefined,
          identifiers: item.identifiers,
          createdAt: item.createdAt,
        };
        cid = (await cidForLex(value as unknown as LexMap)).toString();
        // Fire-and-forget so the build path doesn't block on the worker queue.
        enqueueIngest('contributor', item).catch((err) => {
          log.warn(
            { stage: 'resolve-ol-contributors', uri, err: String(err) },
            'enqueue contributor ingest failed',
          );
        });
      }

      entries.push({ subject: { uri, cid }, role: 'author' });
    } catch (err) {
      log.warn(
        { stage: 'resolve-ol-contributors', key, err: String(err) },
        'skip malformed ol author key',
      );
    }
  }
  return entries;
}
