import { inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { editions } from '../db/schema';
import { enqueueCoverBackfill, enqueueDescriptionBackfill } from './enqueue';

/**
 * Queue the enrichment a catalog page is waiting on.
 *
 * One query decides which editions need work; the jobs themselves re-check the
 * row, so a later ingest winning the race is not an error.
 */
export async function maybeEnqueueEditionBackfills(uris: readonly string[]): Promise<void> {
	const unique = Array.from(new Set(uris));
	if (unique.length === 0) return;
	const rows = await db
		.select({
			uri: editions.uri,
			rkey: editions.rkey,
			needDescription: sql<boolean>`${editions.description} is null and ${editions.descriptionCheckedAt} is null`,
			needCover: sql<boolean>`${editions.coverUrl} is null and ${editions.coverCheckedAt} is null`,
		})
		.from(editions)
		.where(inArray(editions.uri, unique));

	for (const row of rows) {
		if (row.needCover) await enqueueCoverBackfill(row.uri, row.rkey, 'on-read');
		if (row.needDescription) await enqueueDescriptionBackfill(row.uri, 'on-read');
	}
}
