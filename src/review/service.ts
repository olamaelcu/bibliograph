import { and, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { importIssues } from '../db/schema.js';
import { entityTable, type ReviewEntityType } from './views.js';
import { coerceValue, editableFields } from './fields.js';

export interface ReviewListRow {
	pk: string;
	status: string;
	openIssues: number;
	name: string;
}

export function listForReview(
	db: BetterSQLite3Database,
	entity: ReviewEntityType,
	opts: { status?: string },
): ReviewListRow[] {
	const view = entityTable[entity];
	const statusCol = view.releaseStatus as never;
	const nameCol = (
		entity === 'book' || entity === 'work'
			? (view as { title: unknown }).title
			: (view as { name: unknown }).name
	) as never;

	const conds: ReturnType<typeof eq>[] = [];
	if (opts.status) conds.push(eq(statusCol, opts.status as never));

	const rows = db
		.select()
		.from(view)
		.where(conds.length ? and(...conds) : undefined)
		.orderBy(sql`${nameCol} asc`)
		.all() as Array<Record<string, unknown>>;

	return rows.map((r) => ({
		pk: String(r.pk),
		status: String(r.releaseStatus ?? 'staged'),
		name: String(r[String(nameCol)] ?? r.pk),
		openIssues: 0,
	}));
}

/** Rows with ≥1 open issue, via the per-entity review view. */
export function listWithIssues(db: BetterSQLite3Database, entity: ReviewEntityType): ReviewListRow[] {
	const viewName = entityViewNameOf(entity);
	const rows = db.all(sql`SELECT * FROM ${sql.raw(viewName)}`) as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		pk: String(r.pk),
		status: String(r.releaseStatus ?? 'staged'),
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

function entityViewNameOf(entity: ReviewEntityType): string {
	const map = {
		book: 'book_import_issues',
		work: 'work_import_issues',
		contributor: 'contributor_import_issues',
		genre: 'genre_import_issues',
		contributorRole: 'contributor_role_import_issues',
	} as const;
	return map[entity];
}

export function showRecord(
	db: BetterSQLite3Database,
	entity: ReviewEntityType,
	pk: string,
): Record<string, unknown> | null {
	const view = entityTable[entity];
	const row = db.select().from(view).where(eq(view.pk as never, pk as never)).get();
	if (!row) return null;
	return row as unknown as Record<string, unknown>;
}

export function editField(
	db: BetterSQLite3Database,
	entity: ReviewEntityType,
	pk: string,
	field: string,
	rawValue: string,
): { field: string; value: string | number | null } {
	if (!(editableFields[entity] as readonly string[]).includes(field)) {
		throw new Error(`field '${field}' is not editable on '${entity}'`);
	}
	const value = coerceValue(entity, field, rawValue);
	const view = entityTable[entity];
	db.update(view)
		.set({ [field]: value } as never)
		.where(eq(view.pk as never, pk as never))
		.run();
	resolveIssuesForField(db, entity, pk, field);
	return { field, value };
}

function resolveIssuesForField(db: BetterSQLite3Database, entity: ReviewEntityType, pk: string, field: string): void {
	db.update(importIssues)
		.set({ status: 'resolved', resolvedAt: Math.floor(Date.now() / 1000) })
		.where(
			and(
				eq(importIssues.entityType, entity),
				eq(importIssues.entityPk, pk),
				eq(importIssues.field, field),
				eq(importIssues.status, 'open'),
			),
		)
		.run();
}

export function openIssueCount(db: BetterSQLite3Database, entity: ReviewEntityType, pk: string): number {
	const row = db
		.select({ count: sql`count(*)` })
		.from(importIssues)
		.where(and(eq(importIssues.entityType, entity), eq(importIssues.entityPk, pk), eq(importIssues.status, 'open')))
		.get();
	return Number(row?.count ?? 0);
}

/** Staged dependents of a book: work, contributors, genres. */
export function stagedDependents(db: BetterSQLite3Database, bookPk: string): string[] {
	const out: string[] = [];
	const book = db.select().from(entityTable.book).where(eq(entityTable.book.pk as never, bookPk as never)).get();
	if (!book) return out;
	const b = book as unknown as { workPk?: string | null };

	if (b.workPk) {
		const w = db
			.select()
			.from(entityTable.work)
			.where(
				and(
					eq(entityTable.work.pk as never, b.workPk as never),
					eq(entityTable.work.releaseStatus as never, 'staged' as never),
				),
			)
			.get();
		if (w) out.push(`work ${b.workPk}`);
	}
	const contribs = db.all(sql`
    SELECT c.pk FROM book_contributors bc
    JOIN contributors c ON c.pk = bc.contributor_pk
    WHERE bc.book_pk = ${bookPk} AND c.release_status = 'staged'
  `) as Array<{ pk: string }>;
	for (const c of contribs) out.push(`contributor ${c.pk}`);

	const genres = db.all(sql`
    SELECT g.pk FROM book_genres bg
    JOIN genres g ON g.pk = bg.genre_pk
    WHERE bg.book_pk = ${bookPk} AND g.release_status = 'staged'
  `) as Array<{ pk: string }>;
	for (const g of genres) out.push(`genre ${g.pk}`);

	return out;
}

export function setStatus(
	db: BetterSQLite3Database,
	entity: ReviewEntityType,
	pk: string,
	status: 'released' | 'rejected',
): void {
	const view = entityTable[entity];
	const now = Math.floor(Date.now() / 1000);
	db.update(view)
		.set({
			releaseStatus: status,
			releasedAt: status === 'released' ? now : null,
		} as never)
		.where(eq(view.pk as never, pk as never))
		.run();
}

export function resolveIssue(db: BetterSQLite3Database, issuePk: number): void {
	db.update(importIssues)
		.set({ status: 'resolved', resolvedAt: Math.floor(Date.now() / 1000) })
		.where(eq(importIssues.pk, issuePk))
		.run();
}

export function dismissIssue(db: BetterSQLite3Database, issuePk: number): void {
	db.update(importIssues)
		.set({ status: 'dismissed', resolvedAt: Math.floor(Date.now() / 1000) })
		.where(eq(importIssues.pk, issuePk))
		.run();
}
