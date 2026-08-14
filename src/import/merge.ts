import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import {
	books,
	contributors,
	genres,
	works,
	type ImportIssueEntityType,
	type ReleaseStatus,
} from '../db/schema.js';
import type { IdentifierSpec } from './identifiers.js';
import { bookIdentifiersAdapter, contributorIdentifiersAdapter, genreIdentifiersAdapter, upsertIdentifiers, workIdentifiersAdapter } from './identifiers.js';
import { flagIssue } from './issues.js';
import { sourceKeySlug } from './slugs.js';

export interface EntityTable {
	pk: string;
	title?: string | null;
	name?: string | null;
	releaseStatus: ReleaseStatus;
	[k: string]: unknown;
}

export interface MergeCandidate {
	entityType: 'book' | 'work' | 'contributor' | 'genre';
	pk: string;
	source: string;
	/** Human key fields used for the title/name fallback match. */
	matchName: string | null;
	identifiers: IdentifierSpec[];
	/** Field values to merge/conflict-check. Values are strings for text, ISO for dates. */
	fields: Record<string, string | null>;
}

const tableFor = {
	book: books,
	work: works,
	contributor: contributors,
	genre: genres,
} as const;

const adapterFor = {
	book: bookIdentifiersAdapter,
	work: workIdentifiersAdapter,
	contributor: contributorIdentifiersAdapter,
	genre: genreIdentifiersAdapter,
} as const;

export interface MergeResult {
	pk: string;
	existed: boolean;
	conflictFields: string[];
}

/**
 * Merge a candidate into the catalog. Lookup order: identifier resource →
 * title/name fallback → insert. Conflicting field values become open issues;
 * the stored value wins and incoming is recorded on the issue.
 */
export function mergeEntity(db: BetterSQLite3Database, candidate: MergeCandidate): MergeResult {
	const table = tableFor[candidate.entityType];
	const adapter = adapterFor[candidate.entityType];

	// 1. Identifier match (unique resource index guarantees ≤1)
	let pk: string | null = null;
	for (const id of candidate.identifiers) {
		const hit = adapter.findByResource(db, id.resource);
		if (hit !== null) {
			pk = hit;
			break;
		}
	}

	// 2. Title/name fallback (case-insensitive)
	if (pk === null && candidate.matchName) {
		const nameCol = candidate.entityType === 'book' || candidate.entityType === 'work' ? 'title' : 'name';
		const rows = db
			.select()
			.from(table)
			.where(eq(table[nameCol as keyof typeof table] as never, candidate.matchName as never))
			.all();
		if (rows.length === 1) pk = (rows[0] as unknown as { pk: string }).pk;
		else if (rows.length > 1) {
			// Ambiguous — leave staged with an issue rather than guessing.
			flagIssue(db, {
				entityType: candidate.entityType,
				entityPk: candidate.pk,
				field: 'matchName',
				incomingValue: candidate.matchName,
				storedValue: `${rows.length} existing records share this name`,
				source: candidate.source,
			});
		}
	}

	const existed = pk !== null;
	const effectivePk = pk ?? candidate.pk;
	const conflictFields: string[] = [];

	if (existed) {
		// Merge fields: stored value wins; differences become open issues.
		for (const [field, incoming] of Object.entries(candidate.fields)) {
			if (incoming === null || incoming === undefined) continue;
			const existingRow = db.select().from(table).where(eq(table.pk as never, effectivePk as never)).get();
			const stored = existingRow ? (existingRow as unknown as Record<string, unknown>)[field] : undefined;
			const storedStr = stored == null ? null : String(stored);
			if (storedStr !== incoming) {
				flagIssue(db, {
					entityType: candidate.entityType,
					entityPk: effectivePk,
					field,
					incomingValue: incoming,
					storedValue: storedStr,
					source: candidate.source,
				});
				conflictFields.push(field);
			}
		}
		upsertIdentifiers(db, adapter, effectivePk, candidate.identifiers);
	} else {
		// New row, staged.
		const now = Math.floor(Date.now() / 1000);
		const insertValues: Record<string, unknown> = {
			pk: effectivePk,
			createdAt: now,
			releaseStatus: 'staged',
			...candidate.fields,
		};
		db.insert(table).values(insertValues as never).onConflictDoNothing().run();
		upsertIdentifiers(db, adapter, effectivePk, candidate.identifiers);
	}

	return { pk: effectivePk, existed, conflictFields };
}

/** Re-derive a deterministic slug from an OL-style key (compat helper). */
export { sourceKeySlug };
