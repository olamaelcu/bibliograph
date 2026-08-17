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

/**
 * Insert an open issue unless an identical open issue already exists.
 *
 * Dedup relies on the partial unique index `import_issues_open_dedup`
 * (entity_type, entity_pk, field, source) WHERE status='open' added in
 * migration 0005. The previous SELECT-before-INSERT approach was a
 * per-record bottleneck during OL dumps (33k seq-scans on 2,684 rows in
 * a single import run); the ON CONFLICT path lets Postgres do the dedup
 * in the index directly.
 *
 * `incomingValue` is excluded from the index because callers may pass
 * NULL (the prior COALESCE NULL-handling is preserved here as a SELECT
 * fallback so the unique index is not bloated with empty-string rows).
 * The vast majority of issue specs carry a non-null incomingValue, so
 * the indexed path is the common case.
 */
export async function flagIssue(db: Database, spec: IssueSpec): Promise<void> {
	if (spec.incomingValue !== null) {
		// Indexed path: the partial unique index dedupes identical open
		// issues in the engine, no SELECT required.
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
			})
			.onConflictDoNothing({
				target: [importIssues.entityType, importIssues.entityPk, importIssues.field, importIssues.source],
				where: sql`${importIssues.status} = 'open'`,
			});
		return;
	}
	// NULL-incomingValue fallback: pre-existing open row with the same
	// (entity_type, entity_pk, field, source) would dedup at the index
	// only if the stored value also matches. Without an indexed column
	// for incomingValue, fall back to a SELECT.
	const existing = await db
		.select({ pk: importIssues.pk })
		.from(importIssues)
		.where(
			and(
				eq(importIssues.entityType, spec.entityType),
				eq(importIssues.entityPk, spec.entityPk),
				eq(importIssues.field, spec.field),
				eq(importIssues.source, spec.source),
				eq(importIssues.status, 'open'),
				sql`${importIssues.incomingValue} IS NULL`,
			),
		)
		.limit(1);
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
