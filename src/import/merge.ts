import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
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
import { logger } from '../logger.js';

type Database = NodePgDatabase<typeof schema>;

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
	/** Field values to merge/conflict-check. Values are strings for text, unix-second strings for date columns. */
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
export async function mergeEntity(db: Database, candidate: MergeCandidate): Promise<MergeResult> {
	const table = tableFor[candidate.entityType];
	const adapter = adapterFor[candidate.entityType];
	const nameCol = candidate.entityType === 'book' || candidate.entityType === 'work' ? 'title' : 'name';

	// 1. Identifier match (unique resource index guarantees ≤1)
	let pk: string | null = null;
	let matchedResource: string | null = null;
	for (const id of candidate.identifiers) {
		const hit = await adapter.findByResource(db, id.resource);
		if (hit !== null) {
			pk = hit;
			matchedResource = id.resource;
			break;
		}
	}
	logger.debug(
		{
			entityType: candidate.entityType,
			pk: candidate.pk,
			source: candidate.source,
			matchName: candidate.matchName,
			matchedResource,
			existingPk: pk,
			identifierLookups: candidate.identifiers.length,
		},
		'merge: identifier match',
	);

	// 2. Title/name fallback (case-insensitive)
	let foundViaNameFallback = false;
	const matchName = candidate.matchName;
	if (pk === null && matchName) {
		const rows = await db
			.select()
			.from(table)
			.where(sql`lower(${table[nameCol as keyof typeof table] as never}) = lower(${matchName})`);
		if (rows.length === 1) {
			pk = (rows[0] as unknown as { pk: string }).pk;
			foundViaNameFallback = true;
			logger.debug(
				{ entityType: candidate.entityType, pk: candidate.pk, matchName, existingPk: pk },
				'merge: name fallback matched',
			);
		} else if (rows.length > 1) {
			// Ambiguous — leave staged with an issue rather than guessing.
			logger.warn(
				{ entityType: candidate.entityType, pk: candidate.pk, matchName, matches: rows.length },
				'merge: name fallback ambiguous',
			);
			await flagIssue(db, {
				entityType: candidate.entityType,
				entityPk: candidate.pk,
				field: 'matchName',
				incomingValue: matchName,
				storedValue: `${rows.length} existing records share this name`,
				source: candidate.source,
			});
		} else {
			logger.debug({ entityType: candidate.entityType, pk: candidate.pk, matchName }, 'merge: name fallback matched nothing');
		}
	}

	const existed = pk !== null;
	const effectivePk = pk ?? candidate.pk;
	const conflictFields: string[] = [];
	const existingRows = existed
		? await db.select().from(table).where(eq(table.pk as never, effectivePk as never))
		: [];
	const existingRow = existingRows[0];
	logger.debug({ entityType: candidate.entityType, pk: effectivePk, existed }, 'merge: resolved');

	if (existed) {
		// Merge fields: stored value wins; differences become open issues.
		for (const [field, incoming] of Object.entries(candidate.fields)) {
			if (incoming === null || incoming === undefined) continue;
			// The name fallback matched this record; an incoming value for that same
			// column equal to matchName is the source of the match, not a conflict.
			if (foundViaNameFallback && field === nameCol && matchName !== null && incoming.toLowerCase() === matchName.toLowerCase()) {
				continue;
			}
			const stored = existingRow ? (existingRow as unknown as Record<string, unknown>)[field] : undefined;
			const storedStr = stored == null ? null : String(stored);
			if (storedStr !== incoming) {
				logger.debug(
					{ entityType: candidate.entityType, pk: effectivePk, field, incoming, stored: storedStr },
					'merge: field conflict',
				);
				await flagIssue(db, {
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
	} else {
		// New row, staged.
		const now = Math.floor(Date.now() / 1000);
		const insertValues: Record<string, unknown> = {
			// Candidate fields first so the invariants below can never be overridden.
			...candidate.fields,
			pk: effectivePk,
			createdAt: now,
			releaseStatus: 'staged',
		};
		const insertResult = await db.insert(table).values(insertValues as never).onConflictDoNothing();
		if (insertResult.rowCount === 0) {
			// The pk already exists but nothing above matched it (slug collision); the
			// insert silently no-op'd, so surface the collision as an issue.
			logger.warn({ entityType: candidate.entityType, pk: effectivePk, candidatePk: candidate.pk, source: candidate.source }, 'merge: slug collision');
			await flagIssue(db, {
				entityType: candidate.entityType,
				entityPk: effectivePk,
				field: 'pk',
				incomingValue: candidate.pk,
				storedValue: candidate.pk,
				source: candidate.source,
			});
		} else {
			logger.debug(
				{ entityType: candidate.entityType, pk: effectivePk, source: candidate.source, fields: Object.keys(candidate.fields) },
				'merge: inserted',
			);
		}
	}

	const { conflicts } = await upsertIdentifiers(db, adapter, effectivePk, candidate.identifiers);
	for (const conflict of conflicts) {
		logger.warn(
			{ entityType: candidate.entityType, pk: effectivePk, resource: conflict.resource, ownerPk: conflict.ownerPk },
			'merge: identifier conflict',
		);
		await flagIssue(db, {
			entityType: candidate.entityType,
			entityPk: effectivePk,
			field: 'identifier',
			incomingValue: conflict.resource,
			storedValue: conflict.ownerPk,
			source: candidate.source,
		});
	}

	return { pk: effectivePk, existed, conflictFields };
}

/** Re-derive a deterministic slug from an OL-style key (compat helper). */
export { sourceKeySlug };
