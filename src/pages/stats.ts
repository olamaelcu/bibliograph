import { count, eq } from 'drizzle-orm';
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import { db } from '../db/connection.js';
import {
	backfillState,
	books,
	contributorRoles,
	contributors,
	formats,
	genres,
	importIssues,
	works,
} from '../db/schema.js';
import { renderPage } from './render.js';

type ReleaseStatus = 'staged' | 'released' | 'rejected';

interface CatalogRow {
	label: string;
	total: number;
	/** Tables without a release_status column (e.g. formats) omit the breakdown. */
	byStatus?: Record<ReleaseStatus, number>;
}

export interface CatalogStats {
	catalog: CatalogRow[];
	openIssues: number;
	backfill: Array<{
		name: string;
		complete: boolean;
		totalProcessed: number;
		fileSize: number | null;
	}>;
}

const RELEASE_TABLES: Array<{ label: string; table: AnySQLiteTable; status: AnySQLiteColumn }> = [
	{ label: 'books', table: books, status: books.releaseStatus },
	{ label: 'works', table: works, status: works.releaseStatus },
	{ label: 'contributors', table: contributors, status: contributors.releaseStatus },
	{ label: 'genres', table: genres, status: genres.releaseStatus },
	{ label: 'contributor roles', table: contributorRoles, status: contributorRoles.releaseStatus },
];

export function getCatalogStats(): CatalogStats {
	const catalog: CatalogRow[] = [];
	for (const { label, table, status } of RELEASE_TABLES) {
		const total = db.select({ n: count() }).from(table).get()?.n ?? 0;
		const grouped = db
			.select({ status, n: count() })
			.from(table)
			.groupBy(status)
			.all();
		const byStatus: Record<ReleaseStatus, number> = { staged: 0, released: 0, rejected: 0 };
		for (const row of grouped) {
			byStatus[row.status as ReleaseStatus] = row.n;
		}
		catalog.push({ label, total, byStatus });
	}

	const formatsTotal = db.select({ n: count() }).from(formats).get()?.n ?? 0;
	catalog.push({ label: 'formats', total: formatsTotal });

	const openIssues =
		db.select({ n: count() }).from(importIssues).where(eq(importIssues.status, 'open')).get()?.n ?? 0;

	const rows = db.select().from(backfillState).orderBy(backfillState.name).all();

	return {
		catalog,
		openIssues,
		backfill: rows.map((b) => ({
			name: b.name,
			complete: b.complete === 1,
			totalProcessed: b.totalProcessed ?? 0,
			fileSize: b.fileSize,
		})),
	};
}

/** Live stats page; queries the database on every request. */
export function renderStatsPage(): string {
	return renderPage('stats', {
		title: 'Stats',
		description: 'Live catalog statistics for the Bibliograph AppView database.',
		stats: getCatalogStats(),
	});
}
