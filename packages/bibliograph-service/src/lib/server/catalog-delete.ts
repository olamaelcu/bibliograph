import { eq } from 'drizzle-orm';
import { db } from './db/index';
import {
  editions,
  works,
  edition_work_votes,
  labels,
} from './db/schema';
import { PUBLISHER_DID } from './did';


const EDITION_COLLECTION = 'community.lexicon.book.edition';

/**
 * Delete an edition and, only if no other edition references it, its linked work.
 * Dependent rows (votes, labels, isbn enrichment) are cleaned up first.
 *
 * This writes directly to the database (catalog-level operation), not through
 * the lexicon publisher pipeline.
 */
export async function deleteEditionAndLinkedWork(rkey: string) {
  const uri = `at://${PUBLISHER_DID}/${EDITION_COLLECTION}/${rkey}`;

  // Read the linked work before deleting the edition.
  const [editionRow] = await db
    .select({ workUri: editions.workUri })
    .from(editions)
    .where(eq(editions.uri, uri))
    .limit(1);

  // Clean up dependent rows.
  await db.delete(edition_work_votes).where(eq(edition_work_votes.editionUri, uri));
  await db.delete(labels).where(eq(labels.uri, uri));

  // Delete the edition row (cascades edition_isbn_enrichment via FK).
  await db.delete(editions).where(eq(editions.uri, uri));

  // Only delete the linked work when no other edition points to it.
  if (editionRow?.workUri) {
    const remaining = await db.select({ uri: editions.uri })
      .from(editions)
      .where(eq(editions.workUri, editionRow.workUri))
      .limit(1);
    if (remaining.length === 0) {
      await db.delete(labels).where(eq(labels.uri, editionRow.workUri));
      await db.delete(works).where(eq(works.uri, editionRow.workUri));
    }
  }
}
