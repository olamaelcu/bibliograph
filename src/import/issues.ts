import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { importIssues, type ImportIssueEntityType } from '../db/schema.js';

export interface IssueSpec {
	entityType: ImportIssueEntityType;
	entityPk: string;
	field: string;
	incomingValue: string | null;
	storedValue: string | null;
	source: string;
}

const dedupWhere = (db: BetterSQLite3Database, spec: IssueSpec) =>
	and(
		eq(importIssues.entityType, spec.entityType),
		eq(importIssues.entityPk, spec.entityPk),
		eq(importIssues.field, spec.field),
		eq(importIssues.source, spec.source),
		eq(importIssues.status, 'open'),
		sql`COALESCE(${importIssues.incomingValue}, '') = COALESCE(${spec.incomingValue}, '')`,
	);

/** Insert an open issue unless an identical open issue already exists. */
export function flagIssue(db: BetterSQLite3Database, spec: IssueSpec): void {
	const existing = db.select().from(importIssues).where(dedupWhere(db, spec)).get();
	if (existing) return;
	db.insert(importIssues)
		.values({
			entityType: spec.entityType,
			entityPk: spec.entityPk,
			field: spec.field,
			incomingValue: spec.incomingValue,
			storedValue: spec.storedValue,
			source: spec.source,
			status: 'open',
			createdAt: Math.floor(Date.now() / 1000),
		})
		.run();
}

export function openIssuesFor(db: BetterSQLite3Database, entityType: ImportIssueEntityType, entityPk: string) {
	return db
		.select()
		.from(importIssues)
		.where(and(eq(importIssues.entityType, entityType), eq(importIssues.entityPk, entityPk), eq(importIssues.status, 'open')))
		.all();
}

export function resolveIssuesForField(db: BetterSQLite3Database, entityType: ImportIssueEntityType, entityPk: string, field: string): void {
	db.update(importIssues)
		.set({ status: 'resolved', resolvedAt: Math.floor(Date.now() / 1000) })
		.where(
			and(
				eq(importIssues.entityType, entityType),
				eq(importIssues.entityPk, entityPk),
				eq(importIssues.field, field),
				eq(importIssues.status, 'open'),
			),
		)
		.run();
}
