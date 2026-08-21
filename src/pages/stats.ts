import { count, eq, getTableName, isNotNull, sql } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import { db } from '../db/connection.js';
import {
	bookContributors,
	books,
	contributorRoles,
	contributors,
	formats,
	genres,
	importIssues,
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
}

const RELEASE_TABLES: Array<{ label: string; table: AnyPgTable; status: AnyPgColumn }> = [
	{ label: 'books', table: books, status: books.releaseStatus },
	{ label: 'contributors', table: contributors, status: contributors.releaseStatus },
	{ label: 'genres', table: genres, status: genres.releaseStatus },
	{ label: 'contributor roles', table: contributorRoles, status: contributorRoles.releaseStatus },
];

/**
 * In-process cache for `getCatalogStats`. The stats page polls the JSON
 * endpoint once per second (POLL_MS=1000 in the template). With a 60s
 * TTL the DB sees one full stats query per minute per process instead of
 * 60, eliminating the I/O contention that was starving the OL backfill
 * import.
 */
const STATS_TTL_MS = 60_000;
let cached: { value: CatalogStats; expiresAt: number } | null = null;
let pending: Promise<CatalogStats> | null = null;

export async function getCatalogStats(): Promise<CatalogStats> {
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	if (pending) return pending;
	pending = (async () => {
		try {
			const value = await computeCatalogStats();
			cached = { value, expiresAt: Date.now() + STATS_TTL_MS };
			return value;
		} finally {
			pending = null;
		}
	})();
	return pending;
}

async function computeCatalogStats(): Promise<CatalogStats> {
	const liveTupRows = await db.execute<{ relname: string; n_live_tup: number | string }>(sql`
		SELECT relname, n_live_tup
		FROM pg_stat_user_tables
		WHERE relname IN ('books', 'contributors', 'genres', 'contributor_roles', 'formats', 'book_contributors', 'import_issues')
	`);
	const liveTup = new Map<string, number>();
	for (const r of liveTupRows.rows) liveTup.set(r.relname, Number(r.n_live_tup ?? 0));

	const catalog: CatalogRow[] = [];
	for (const { label, table, status } of RELEASE_TABLES) {
		const total = liveTup.get(tableName(table)) ?? 0;
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

	catalog.push({ label: 'formats', total: liveTup.get('formats') ?? 0 });
	catalog.push({ label: 'book contributors', total: liveTup.get('book_contributors') ?? 0 });

	const bookCovers = Number((await db.select({ n: count() }).from(books).where(isNotNull(books.coverUrl)))[0]?.n ?? 0);
	const contributorPortraits =
		Number((await db.select({ n: count() }).from(contributors).where(isNotNull(contributors.imageUrl)))[0]?.n ?? 0);
	for (const row of catalog) {
		if (row.label === 'books') row.coverCount = bookCovers;
		if (row.label === 'contributors') row.coverCount = contributorPortraits;
	}

	const openOpen =
		Number((await db.select({ n: count() }).from(importIssues).where(eq(importIssues.status, 'open')))[0]?.n ?? 0);

	return {
		catalog,
		openIssues: openOpen,
	};
}

/** Map a drizzle `AnyPgTable` to the underlying pg relname. */
function tableName(table: AnyPgTable): string {
	return getTableName(table);
}

/** Live stats page; queries the database on every request. */
export async function renderStatsPage(): Promise<string> {
	return renderPage('stats', {
		title: 'Stats',
		description: 'Live catalog statistics for the Bibliograph AppView database.',
		stats: await getCatalogStats(),
	});
}
