import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { bookWorkStaging } from '../db/schema.js';
import { logger } from '../logger.js';
import { sourceKeySlug } from './slugs.js';

type Database = NodePgDatabase<typeof schema>;

/**
 * Record a deferred book→work link. Called from mergeEntity when a book insert
 * hits the `books_work_pk_works_pk_fk` violation (work not yet imported) so the
 * book row still lands with work_pk=NULL. resolveBookWorks drains this table
 * once the work arrives (typically via works:dump completing or a subsequent
 * editions:rehydrate pass).
 */
export async function stageBookWork(
	db: Database,
	bookPk: string,
	workOlKey: string,
	source: string,
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db
		.insert(bookWorkStaging)
		.values({ bookPk, workOlKey, source, createdAt: now })
		.onConflictDoNothing();
}

/**
 * Walk the deferred link table; for every entry whose work has since landed,
 * UPDATE books.work_pk and DELETE the staging row. Idempotent: rows whose
 * work still doesn't exist are left for the next drain.
 *
 * Returns the number of links resolved.
 */
export async function resolveBookWorks(
	db: Database,
	opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
	const batchSize = opts.batchSize ?? 10_000;
	const maxBatches = opts.maxBatches;
	let resolved = 0;
	let batches = 0;

	while (true) {
		if (maxBatches !== undefined && ++batches > maxBatches) break;
		const rows = (await db.execute(sql`
			SELECT book_pk, work_ol_key
			FROM book_work_staging
			ORDER BY book_pk
			LIMIT ${batchSize}
		`)).rows as Array<{ book_pk: string; work_ol_key: string }>;
		if (rows.length === 0) break;

		await db.transaction(async (tx) => {
			for (const row of rows) {
				const workPk = sourceKeySlug(row.work_ol_key);
				const updated = await tx.execute(sql`
					UPDATE books
					SET work_pk = ${workPk}
					WHERE pk = ${row.book_pk}
					  AND work_pk IS NULL
					  AND EXISTS (SELECT 1 FROM works WHERE pk = ${workPk})
				`);
				const rowCount = Number((updated as unknown as { rowCount?: number }).rowCount ?? 0);
				if (rowCount > 0) {
					resolved += rowCount;
					logger.debug({ bookPk: row.book_pk, workPk }, 'book-works: resolved deferred link');
				}
				// Always drop the staging row: it's either resolved or stale.
				// Stale links (work never materializes) keep the book at
				// work_pk=NULL and surface as an open import_issue elsewhere
				// if/when appropriate; we don't block ingestion on them.
				await tx.execute(sql`
					DELETE FROM book_work_staging
					WHERE book_pk = ${row.book_pk}
				`);
			}
		});
	}

	return resolved;
}
