import { count, eq, getTableName, isNotNull, sql } from 'drizzle-orm';
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

/**
 * In-process cache for `getCatalogStats`. The stats page polls the JSON
 * endpoint once per second (POLL_MS=1000 in the template). Without
 * caching, every poll issues 11 `count(*)` queries — `count(*) from
 * contributors` on a 12M+ row table is a full table scan. With a 60s
 * TTL the DB sees one full stats query per minute per process instead
 * of 60, eliminating the I/O contention that was starving the OL
 * backfill import (see import-issues: the import's INSERTs were waiting
 * on BufferMapping/AioIoCompletion locks the count scans held).
 *
 * The cache value is invalidated by TTL only. For a stats display the
 * 60s staleness is invisible to humans; backfill state changes every
 * batch but the operator-facing page tolerates the delay.
 */
const STATS_TTL_MS = 60_000;
let cached: { value: CatalogStats; expiresAt: number } | null = null;
let pending: Promise<CatalogStats> | null = null;

export async function getCatalogStats(): Promise<CatalogStats> {
	if (cached && cached.expiresAt > Date.now()) return cached.value;
	// Coalesce concurrent requests while a refresh is in flight: the
	// in-flight Promise is shared so the first caller drives the query
	// and the rest await the same result.
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
	// Pull the totals from `pg_stat_user_tables.n_live_tup` (O(1) lookup
	// maintained by autovacuum) instead of `count(*)` (full table scan).
	// The breakdown counts (`group by release_status`) still scan, but
	// with the in-process cache above, they run at most once per minute
	// per process, which is the only cost the import actually competes
	// for.
	const liveTupRows = await db.execute<{ relname: string; n_live_tup: number | string }>(sql`
		SELECT relname, n_live_tup
		FROM pg_stat_user_tables
		WHERE relname IN ('books', 'works', 'contributors', 'genres', 'contributor_roles', 'formats', 'book_contributors', 'import_issues')
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

	// Cover / portrait counts are filtered COUNT queries; for very large
	// tables these can still be slow, so we keep them in the cached
	// path. The 60s TTL caps the total cost to one scan per minute.
	const bookCovers = Number((await db.select({ n: count() }).from(books).where(isNotNull(books.coverUrl)))[0]?.n ?? 0);
	const contributorPortraits =
		Number((await db.select({ n: count() }).from(contributors).where(isNotNull(contributors.imageUrl)))[0]?.n ?? 0);
	for (const row of catalog) {
		if (row.label === 'books') row.coverCount = bookCovers;
		if (row.label === 'contributors') row.coverCount = contributorPortraits;
	}

	const openIssues = liveTup.get('import_issues') ?? 0;
	// For the live UI we want exact open-issue counts (these matter for
	// the import operator). The status filter is index-friendly
	// (import_issues_status_idx from migration 0000) and the table is
	// small (issues are bounded by record count).
	const openOpen =
		Number((await db.select({ n: count() }).from(importIssues).where(eq(importIssues.status, 'open')))[0]?.n ?? 0);
	void openIssues; // covered by openOpen below

	const rows = await db.select().from(backfillState).orderBy(backfillState.name);

	return {
		catalog,
		openIssues: openOpen,
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
