import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { importIssues, type ReleaseStatus } from '../db/schema.js';
import { resolveIssuesForField } from '../import/issues.js';
import { entityTable, entityViewName, type ReviewEntityType } from './views.js';
import { coerceValue, editableFields } from './fields.js';

export interface ReviewListRow {
	pk: string;
	status: string;
	openIssues: number;
	name: string;
}

/** Below SQLite's bound-parameter limit, with headroom for the query's other params. */
const SQL_VARIABLE_CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Open-issue counts per pk, chunked to stay under SQLite's SQL variable limit. */
async function openIssueCounts(
	db: NodePgDatabase<typeof schema>,
	entity: ReviewEntityType,
	pks: string[],
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const batch of chunk(pks, SQL_VARIABLE_CHUNK_SIZE)) {
		const counted = await db
			.select({ entityPk: importIssues.entityPk, c: sql<number>`count(*)` })
			.from(importIssues)
			.where(
				and(
					eq(importIssues.entityType, entity),
					eq(importIssues.status, 'open'),
					inArray(importIssues.entityPk, batch),
				),
			)
			.groupBy(importIssues.entityPk);
		for (const row of counted) counts.set(row.entityPk, Number(row.c));
	}
	return counts;
}

export async function listForReview(
	db: NodePgDatabase<typeof schema>,
	entity: ReviewEntityType,
	opts: { status?: ReleaseStatus } = {},
): Promise<ReviewListRow[]> {
	const view = entityTable[entity];
	const statusCol = view.releaseStatus as never;
	const nameCol = (
		entity === 'book' || entity === 'work'
			? (view as { title: unknown }).title
			: (view as { name: unknown }).name
	) as never;
	const nameKey = (nameCol as { name: string }).name;

	const conds: ReturnType<typeof eq>[] = [];
	if (opts.status) conds.push(eq(statusCol, opts.status as never));

	const rows = (await db
		.select()
		.from(view)
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(sql`${nameCol} asc`)) as Array<Record<string, unknown>>;

	const pks = rows.map((r) => String(r.pk));
	const counts = pks.length > 0 ? await openIssueCounts(db, entity, pks) : new Map<string, number>();

	return rows.map((r) => ({
		pk: String(r.pk),
		status: String(r.releaseStatus ?? 'staged'),
		name: String(r[nameKey] ?? r.pk),
		openIssues: counts.get(String(r.pk)) ?? 0,
	}));
}

/** Rows with ≥1 open issue, via the per-entity review view. */
export async function listWithIssues(db: NodePgDatabase<typeof schema>, entity: ReviewEntityType): Promise<ReviewListRow[]> {
	const viewName = entityViewName[entity];
	const result = await db.execute(sql`SELECT * FROM ${sql.raw(viewName)} ORDER BY pk`);
	const rows = result.rows as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		pk: String(r.pk),
		status: String(r.release_status ?? r.releaseStatus ?? 'staged'),
		name: String(r.title ?? r.name ?? r.pk),
		openIssues: countOpenIssues(r.open_issues),
	}));
}

/** SQLite returns json_group_array output as a JSON text string. */
function countOpenIssues(raw: unknown): number {
	if (typeof raw === 'string') {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed.length;
		} catch {
			return 0;
		}
	}
	if (Array.isArray(raw)) return raw.length;
	return Number(raw ?? 0);
}

export async function showRecord(
	db: NodePgDatabase<typeof schema>,
	entity: ReviewEntityType,
	pk: string,
): Promise<Record<string, unknown> | null> {
	const view = entityTable[entity];
	const row = (await db.select().from(view).where(eq(view.pk as never, pk as never)))[0];
	if (!row) return null;
	return row as unknown as Record<string, unknown>;
}

export async function editField(
	db: NodePgDatabase<typeof schema>,
	entity: ReviewEntityType,
	pk: string,
	field: string,
	rawValue: string,
): Promise<{ field: string; value: string | number | null }> {
	if (!(editableFields[entity] as readonly string[]).includes(field)) {
		throw new Error(`field '${field}' is not editable on '${entity}'`);
	}
	const value = coerceValue(entity, field, rawValue);
	const view = entityTable[entity];
	const res = await db
		.update(view)
		.set({ [field]: value } as never)
		.where(eq(view.pk as never, pk as never));
	if (res.rowCount === 0) throw new Error(`no ${entity} row with pk '${pk}'`);
	await resolveIssuesForField(db, entity, pk, field);
	return { field, value };
}

export async function openIssueCount(db: NodePgDatabase<typeof schema>, entity: ReviewEntityType, pk: string): Promise<number> {
	const row = (await db
		.select({ count: sql`count(*)` })
		.from(importIssues)
		.where(and(eq(importIssues.entityType, entity), eq(importIssues.entityPk, pk), eq(importIssues.status, 'open'))))[0];
	return Number(row?.count ?? 0);
}

/** Staged dependents of a book: work, contributors, genres. */
export async function stagedDependents(db: NodePgDatabase<typeof schema>, bookPk: string): Promise<string[]> {
	const out: string[] = [];
	const book = (await db.select().from(entityTable.book).where(eq(entityTable.book.pk as never, bookPk as never)))[0];
	if (!book) return out;
	const b = book as unknown as { workPk?: string | null };

	if (b.workPk) {
		const w = (await db
			.select()
			.from(entityTable.work)
			.where(
				and(
					eq(entityTable.work.pk as never, b.workPk as never),
					eq(entityTable.work.releaseStatus as never, 'staged' as never),
				),
			))[0];
		if (w) out.push(`work ${b.workPk}`);
	}
	const contribs = (await db.execute(sql`
    SELECT c.pk FROM book_contributors bc
    JOIN contributors c ON c.pk = bc.contributor_pk
    WHERE bc.book_pk = ${bookPk} AND c.release_status = 'staged'
  `)).rows as Array<{ pk: string }>;
	for (const c of contribs) out.push(`contributor ${c.pk}`);

	const genres = (await db.execute(sql`
    SELECT g.pk FROM book_genres bg
    JOIN genres g ON g.pk = bg.genre_pk
    WHERE bg.book_pk = ${bookPk} AND g.release_status = 'staged'
  `)).rows as Array<{ pk: string }>;
	for (const g of genres) out.push(`genre ${g.pk}`);

	return out;
}

export async function setStatus(
	db: NodePgDatabase<typeof schema>,
	entity: ReviewEntityType,
	pk: string,
	status: 'released' | 'rejected',
): Promise<void> {
	const view = entityTable[entity];
	const now = Math.floor(Date.now() / 1000);
	const res = await db
		.update(view)
		.set({
			releaseStatus: status,
			releasedAt: status === 'released' ? now : null,
		} as never)
		.where(eq(view.pk as never, pk as never));
	if (res.rowCount === 0) throw new Error(`no ${entity} row with pk '${pk}'`);
}

export interface ApproveAllOptions {
	/** Release records that have open issues instead of skipping them. */
	keepIssues?: boolean;
	/** Cap the number of records released per entity. */
	limit?: number;
	/** Report what would be released without writing anything. */
	dryRun?: boolean;
}

export interface ApproveAllResult {
	entity: ReviewEntityType;
	approved: number;
	skippedWithIssues: number;
}

/**
 * Mass-approve: release every `staged` record of an entity, skipping any with
 * open issues unless `keepIssues`. Returns per-entity counts. Bypasses the
 * per-record dependency guard on purpose — the point is bulk release.
 */
export async function approveAll(
	db: NodePgDatabase<typeof schema>,
	entity: ReviewEntityType,
	opts: ApproveAllOptions = {},
): Promise<ApproveAllResult> {
	const view = entityTable[entity];
	const now = Math.floor(Date.now() / 1000);

	const staged = (await db
		.select({ pk: view.pk })
		.from(view)
		.where(eq(view.releaseStatus as never, 'staged' as never)) as Array<{ pk: string }>)
		.slice(0, opts.limit);
	const pks = staged.map((r) => String(r.pk));

	const result: ApproveAllResult = { entity, approved: 0, skippedWithIssues: 0 };
	if (pks.length === 0) return result;

	const counts = opts.keepIssues ? new Map<string, number>() : await openIssueCounts(db, entity, pks);

	const toRelease = pks.filter((pk) => opts.keepIssues || (counts.get(pk) ?? 0) === 0);
	result.skippedWithIssues = pks.length - toRelease.length;

	if (!opts.dryRun && toRelease.length > 0) {
		await db.transaction(async (tx) => {
			for (const pk of toRelease) {
				await tx
					.update(view)
					.set({ releaseStatus: 'released', releasedAt: now } as never)
					.where(eq(view.pk as never, pk as never));
			}
		});
	}
	result.approved = toRelease.length;
	return result;
}

export async function resolveIssue(db: NodePgDatabase<typeof schema>, issuePk: number): Promise<void> {
	const res = await db
		.update(importIssues)
		.set({ status: 'resolved', resolvedAt: Math.floor(Date.now() / 1000) })
		.where(eq(importIssues.pk, issuePk));
	if (res.rowCount === 0) throw new Error(`no issue with pk '${issuePk}'`);
}

export async function dismissIssue(db: NodePgDatabase<typeof schema>, issuePk: number): Promise<void> {
	const res = await db
		.update(importIssues)
		.set({ status: 'dismissed', resolvedAt: Math.floor(Date.now() / 1000) })
		.where(eq(importIssues.pk, issuePk));
	if (res.rowCount === 0) throw new Error(`no issue with pk '${issuePk}'`);
}
