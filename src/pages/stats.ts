import { count, eq, isNotNull } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import { db } from '../db/connection.js';
import {
	backfillState,
	bookContributors,
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
	/** Table with a cover/portrait field: how many rows have one. */
	coverCount?: number;
}

	export interface CatalogStats {
	catalog: CatalogRow[];
	openIssues: number;
	backfill: Array<{
		name: string;
		complete: boolean;
		stopped: boolean;
		totalProcessed: number;
		totalRecords: number | null;
		fileSize: number | null;
	}>;
}

const RELEASE_TABLES: Array<{ label: string; table: AnyPgTable; status: AnyPgColumn }> = [
	{ label: 'books', table: books, status: books.releaseStatus },
	{ label: 'works', table: works, status: works.releaseStatus },
	{ label: 'contributors', table: contributors, status: contributors.releaseStatus },
	{ label: 'genres', table: genres, status: genres.releaseStatus },
	{ label: 'contributor roles', table: contributorRoles, status: contributorRoles.releaseStatus },
];

export async function getCatalogStats(): Promise<CatalogStats> {
	const catalog: CatalogRow[] = [];
	for (const { label, table, status } of RELEASE_TABLES) {
		const total = Number((await db.select({ n: count() }).from(table))[0]?.n ?? 0);
		const grouped = await db
			.select({ status, n: count() })
			.from(table)
			.groupBy(status);
		const byStatus: Record<ReleaseStatus, number> = { staged: 0, released: 0, rejected: 0 };
		for (const row of grouped) {
			byStatus[row.status as ReleaseStatus] = Number(row.n);
		}
		catalog.push({ label, total, byStatus });
	}

	const formatsTotal = Number((await db.select({ n: count() }).from(formats))[0]?.n ?? 0);
	catalog.push({ label: 'formats', total: formatsTotal });

	const bookContributorsTotal = Number((await db.select({ n: count() }).from(bookContributors))[0]?.n ?? 0);
	catalog.push({ label: 'book contributors', total: bookContributorsTotal });

	const bookCovers = Number((await db.select({ n: count() }).from(books).where(isNotNull(books.coverUrl)))[0]?.n ?? 0);
	const contributorPortraits =
		Number((await db.select({ n: count() }).from(contributors).where(isNotNull(contributors.imageUrl)))[0]?.n ?? 0);
	for (const row of catalog) {
		if (row.label === 'books') row.coverCount = bookCovers;
		if (row.label === 'contributors') row.coverCount = contributorPortraits;
	}

	const openIssues =
		Number((await db.select({ n: count() }).from(importIssues).where(eq(importIssues.status, 'open')))[0]?.n ?? 0);

	const rows = await db.select().from(backfillState).orderBy(backfillState.name);

	return {
		catalog,
		openIssues,
		backfill: rows.map((b) => ({
			name: b.name,
			complete: b.complete === 1,
			stopped: b.stopped === 1,
			totalProcessed: b.totalProcessed ?? 0,
			totalRecords: b.totalRecords ?? null,
			fileSize: b.fileSize,
		})),
	};
}

/** Live stats page; queries the database on every request. */
export async function renderStatsPage(): Promise<string> {
	return renderPage('stats', {
		title: 'Stats',
		description: 'Live catalog statistics for the Bibliograph AppView database.',
		stats: await getCatalogStats(),
	});
}
