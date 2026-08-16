import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { and, eq, sql } from 'drizzle-orm';
import { importIssues, type ImportIssueEntityType } from '../db/schema.js';

type Database = NodePgDatabase<typeof schema>;

export interface IssueSpec {
	entityType: ImportIssueEntityType;
	entityPk: string;
	field: string;
	incomingValue: string | null;
	storedValue: string | null;
	source: string;
}

const dedupWhere = (db: Database, spec: IssueSpec) =>
	and(
		eq(importIssues.entityType, spec.entityType),
		eq(importIssues.entityPk, spec.entityPk),
		eq(importIssues.field, spec.field),
		eq(importIssues.source, spec.source),
		eq(importIssues.status, 'open'),
		sql`COALESCE(${importIssues.incomingValue}, '') = COALESCE(${spec.incomingValue}, '')`,
	);

/** Insert an open issue unless an identical open issue already exists. */
export async function flagIssue(db: Database, spec: IssueSpec): Promise<void> {
	const existing = await db.select().from(importIssues).where(dedupWhere(db, spec));
	if (existing[0]) return;
	await db.insert(importIssues)
		.values({
			entityType: spec.entityType,
			entityPk: spec.entityPk,
			field: spec.field,
			incomingValue: spec.incomingValue,
			storedValue: spec.storedValue,
			source: spec.source,
			status: 'open',
			createdAt: Math.floor(Date.now() / 1000),
		});
}

export async function openIssuesFor(db: Database, entityType: ImportIssueEntityType, entityPk: string) {
	return db
		.select()
		.from(importIssues)
		.where(and(eq(importIssues.entityType, entityType), eq(importIssues.entityPk, entityPk), eq(importIssues.status, 'open')));
}

export async function resolveIssuesForField(db: Database, entityType: ImportIssueEntityType, entityPk: string, field: string): Promise<void> {
	await db.update(importIssues)
		.set({ status: 'resolved', resolvedAt: Math.floor(Date.now() / 1000) })
		.where(
			and(
				eq(importIssues.entityType, entityType),
				eq(importIssues.entityPk, entityPk),
				eq(importIssues.field, field),
				eq(importIssues.status, 'open'),
			),
		);
}
