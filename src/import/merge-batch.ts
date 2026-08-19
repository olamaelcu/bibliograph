/**
 * Batched merge path for the OL import hot loop.
 *
 * The single-record `mergeEntity` issues 2N+ round-trip SELECTs per record
 * (N = identifiers in the candidate) inside a per-batch transaction. For
 * editions (1 OL key + 1-3 ISBNs + 1 author OL key) that's 8-16 SELECTs per
 * record, or 16k-32k SELECTs per 2k-record batch — the dominant cost on
 * editions (33 rec/sec observed on the live import before this path was
 * available).
 *
 * This module hoists those lookups to per-batch scope: collect every
 * candidate's resources + pks, then issue a small number of
 * `WHERE resource = ANY($1)` / `WHERE pk = ANY($1)` lookups against the
 * identifier and entity tables. The merge logic per candidate is
 * otherwise identical to `mergeEntity`.
 *
 * Conflict semantics are preserved:
 * - Identifier conflict (resource owned by another pk) surfaces as an
 *   import_issues row, same as the per-record path.
 * - Slug collision (candidate pk exists but no identifier match) surfaces
 *   as an import_issues row, same as before.
 * - Cross-record conflicts within a batch (record A claims `isbn:123`,
 *   record B also claims `isbn:123` and wins the race) are detected by
 *   tracking the local `claimedThisBatch` set and re-running the
 *   identifier lookup against it before any insert.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { inArray } from 'drizzle-orm';
import {
	books,
	contributors,
	genres,
	works,
	type ImportIssueEntityType,
} from '../db/schema.js';
import type { IdentifierSpec } from './identifiers.js';
import { bookIdentifiersAdapter, contributorIdentifiersAdapter, genreIdentifiersAdapter, workIdentifiersAdapter } from './identifiers.js';
import { flagIssue } from './issues.js';
import { logger } from '../logger.js';

type Database = NodePgDatabase<typeof schema>;
// Drizzle's transaction callback receives a Tx whose shape is a subset
// of Database. We accept either here so callers can pass either the
// outer Database or an in-flight transaction handle.
type Tx = Database;

import type { MergeCandidate, MergeResult } from './merge.js';
import { stageBookWork } from './book-works.js';

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

/**
 * Build a per-batch merge context. Pre-fetches every resource the batch
 * touches and every pk the batch might land on, so the per-candidate
 * merge step can do plain Map lookups instead of round-trip SELECTs.
 */
export async function buildMergeBatchContext(tx: Tx, candidates: MergeCandidate[]): Promise<MergeBatchContext> {
	const ctx: MergeBatchContext = {
		bookResources: new Map(),
		workResources: new Map(),
		contributorResources: new Map(),
		genreResources: new Map(),
		bookRows: new Map(),
		workRows: new Map(),
		contributorRows: new Map(),
		genreRows: new Map(),
	};

	// Collect every resource per identifier table.
	const bookResources = new Set<string>();
	const workResources = new Set<string>();
	const contributorResources = new Set<string>();
	const genreResources = new Set<string>();
	for (const c of candidates) {
		const set = resourceSetFor(c.entityType, bookResources, workResources, contributorResources, genreResources);
		for (const id of c.identifiers) set.add(id.resource);
	}
	if (bookResources.size) {
		for (const [resource, pk] of await fetchIdentifierOwners(tx, bookIdentifiersAdapter, bookResources)) {
			ctx.bookResources.set(resource, pk);
		}
	}
	if (workResources.size) {
		for (const [resource, pk] of await fetchIdentifierOwners(tx, workIdentifiersAdapter, workResources)) {
			ctx.workResources.set(resource, pk);
		}
	}
	if (contributorResources.size) {
		for (const [resource, pk] of await fetchIdentifierOwners(tx, contributorIdentifiersAdapter, contributorResources)) {
			ctx.contributorResources.set(resource, pk);
		}
	}
	if (genreResources.size) {
		for (const [resource, pk] of await fetchIdentifierOwners(tx, genreIdentifiersAdapter, genreResources)) {
			ctx.genreResources.set(resource, pk);
		}
	}

	// Pre-fetch existing rows for every candidate pk (whether it resolved
	// via identifier or not). insert/upsert decisions + field conflict
	// detection both need them.
	const candidatePksByType = new Map<MergeCandidate['entityType'], Set<string>>();
	for (const c of candidates) {
		let set = candidatePksByType.get(c.entityType);
		if (!set) {
			set = new Set();
			candidatePksByType.set(c.entityType, set);
		}
		set.add(c.pk);
	}
	if (candidatePksByType.has('book')) {
		const pks = [...candidatePksByType.get('book')!];
		const rows = await tx.select().from(books).where(inArray(books.pk, pks));
		for (const r of rows) ctx.bookRows.set(r.pk, r);
	}
	if (candidatePksByType.has('work')) {
		const pks = [...candidatePksByType.get('work')!];
		const rows = await tx.select().from(works).where(inArray(works.pk, pks));
		for (const r of rows) ctx.workRows.set(r.pk, r);
	}
	if (candidatePksByType.has('contributor')) {
		const pks = [...candidatePksByType.get('contributor')!];
		const rows = await tx.select().from(contributors).where(inArray(contributors.pk, pks));
		for (const r of rows) ctx.contributorRows.set(r.pk, r);
	}
	if (candidatePksByType.has('genre')) {
		const pks = [...candidatePksByType.get('genre')!];
		const rows = await tx.select().from(genres).where(inArray(genres.pk, pks));
		for (const r of rows) ctx.genreRows.set(r.pk, r);
	}

	return ctx;
}

export interface MergeBatchContext {
	bookResources: Map<string, string>;
	workResources: Map<string, string>;
	contributorResources: Map<string, string>;
	genreResources: Map<string, string>;
	bookRows: Map<string, typeof books.$inferSelect>;
	workRows: Map<string, typeof works.$inferSelect>;
	contributorRows: Map<string, typeof contributors.$inferSelect>;
	genreRows: Map<string, typeof genres.$inferSelect>;
}

function resourceSetFor(
	entityType: MergeCandidate['entityType'],
	bookResources: Set<string>,
	workResources: Set<string>,
	contributorResources: Set<string>,
	genreResources: Set<string>,
): Set<string> {
	switch (entityType) {
		case 'book': return bookResources;
		case 'work': return workResources;
		case 'contributor': return contributorResources;
		case 'genre': return genreResources;
	}
}

/**
 * Merge every candidate in `candidates` using the pre-fetched
 * `ctx`. Identical behavior to the per-record `mergeEntity` for any
 * single candidate, but resolves lookups against `ctx` first, then a
 * per-batch `claimedThisBatch` set for cross-record conflicts, then
 * (only as a last resort) a single `tx.execute` SELECT to fetch a row
 * that wasn't pre-fetched.
 *
 * The returned `MergeResult` array is in the same order as `candidates`.
 */
export async function mergeBatch(
	tx: Tx,
	candidates: MergeCandidate[],
	ctx: MergeBatchContext,
	opts: { skipNameFallback?: boolean } = {},
): Promise<MergeResult[]> {
	// Track identifiers claimed by this batch so we can detect cross-record
	// conflicts: record A claims `isbn:123` first, record B also claims
	// `isbn:123` and would land on A's pk if both were just looked up.
	//
	// The value carries entityType so a later candidate of a DIFFERENT
	// entityType can see the claim and treat it as a cross-entity
	// conflict rather than silently adopting the other entity's pk.
	// Without the tag, an OL edition's work candidate (which includes
	// the edition's OL key in its identifiers per mapEditionToCandidates)
	// claims the resource first, then the book's lookup sees the claim
	// and adopts the work's pk as effectivePk, which is then written
	// as book_pk in the book_identifiers row — a work's pk as a
	// book_pk fails the FK to books and is exactly wrong.
	const claimed = new Map<IdentifierSpec['resource'], { entityType: MergeCandidate['entityType']; pk: string }>();
	const out: MergeResult[] = [];
	for (const c of candidates) {
		// Per-record savepoint: a malformed OL row that violates a NOT NULL,
		// CHECK, or FK constraint fails ONLY that record's subtransaction.
		// Without this, Postgres marks the outer batch transaction aborted
		// and every subsequent query in the same batch returns "current
		// transaction is aborted" until commit, producing a flood of
		// indistinguishable failures and rolling back all the other
		// (good) records in the batch. See batched-importer.ts:78 for the
		// same pattern in the per-record merge path.
		try {
			const res = await tx.transaction(async (savepoint) => mergeOne(savepoint, c, ctx, opts, claimed));
			out.push(res);
		} catch (err) {
			logger.warn({ err, pk: c.pk, entityType: c.entityType }, 'record failed in batched merge');
			out.push({ pk: c.pk, existed: false, conflictFields: [] });
		}
	}
	return out;
}

async function mergeOne(
	tx: Tx,
	candidate: MergeCandidate,
	ctx: MergeBatchContext,
	opts: { skipNameFallback?: boolean },
	claimed: Map<string, { entityType: MergeCandidate['entityType']; pk: string }>,
): Promise<MergeResult> {
	const table = tableFor[candidate.entityType];
	const adapter = adapterFor[candidate.entityType];
	const nameCol = candidate.entityType === 'book' || candidate.entityType === 'work' ? 'title' : 'name';
	const resourceMap = resourceMapFor(candidate.entityType, ctx);
	const rowMap = rowMapFor(candidate.entityType, ctx);

	// 1. Identifier match (in-memory against ctx, then claimed set).
	let pk: string | null = null;
	let matchedResource: string | null = null;
	for (const id of candidate.identifiers) {
		const hit = resourceMap.get(id.resource);
		if (hit !== undefined) {
			pk = hit;
			matchedResource = id.resource;
			break;
		}
		const claim = claimed.get(id.resource);
		if (claim !== undefined) {
			if (claim.entityType === candidate.entityType) {
				// Same-entity-type claim from earlier in this batch: merge onto it.
				pk = claim.pk;
				matchedResource = id.resource;
				break;
			}
			// Cross-entity-type claim (e.g. a work candidate claimed an
			// edition's OL key earlier in this batch): the resource
			// is owned by a different entity. Do NOT merge onto it — the
			// candidate keeps its own pk, and the identifier conflict is
			// surfaced later in the identifier upsert loop.
			continue;
		}
	}

	// 2. Name fallback (skipped when skipNameFallback, like mergeEntity).
	let foundViaNameFallback = false;
	const matchName = candidate.matchName;
	if (!opts.skipNameFallback && pk === null && matchName) {
		// Case-insensitive match against the pre-fetched rows.
		const lc = matchName.toLowerCase();
		const matches: string[] = [];
		for (const [rowPk, row] of rowMap) {
			const v = (row as unknown as Record<string, unknown>)[nameCol];
			if (typeof v === 'string' && v.toLowerCase() === lc) {
				matches.push(rowPk);
				if (matches.length > 1) break;
			}
		}
		if (matches.length === 1) {
			pk = matches[0];
			foundViaNameFallback = true;
		} else if (matches.length > 1) {
			await flagIssue(tx, {
				entityType: candidate.entityType as ImportIssueEntityType,
				entityPk: candidate.pk,
				field: 'matchName',
				incomingValue: matchName,
				storedValue: `${matches.length} existing records share this name`,
				source: candidate.source,
			});
		}
	}

	const existed = pk !== null;
	const effectivePk = pk ?? candidate.pk;
	const existingRow = existed ? rowMap.get(effectivePk) : undefined;
	const conflictFields: string[] = [];

	if (existed) {
		for (const [field, incoming] of Object.entries(candidate.fields)) {
			if (incoming === null || incoming === undefined) continue;
			if (foundViaNameFallback && field === nameCol && matchName !== null && incoming.toLowerCase() === matchName.toLowerCase()) {
				continue;
			}
			const stored = existingRow ? (existingRow as unknown as Record<string, unknown>)[field] : undefined;
			const storedStr = stored == null ? null : String(stored);
			if (storedStr !== incoming) {
				await flagIssue(tx, {
					entityType: candidate.entityType as ImportIssueEntityType,
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
		const now = Math.floor(Date.now() / 1000);
		const insertValues: Record<string, unknown> = {
			...candidate.fields,
			pk: effectivePk,
			createdAt: now,
			releaseStatus: 'staged',
		};
		let insertResult: { rowCount: number | null };
		try {
			insertResult = await tx.insert(table).values(insertValues as never).onConflictDoNothing();
		} catch (err) {
			// Mirror merge.ts: books whose work hasn't landed yet fall back to
			// NULL and stage the link so resolveBookWorks can fill work_pk later.
			if (
				candidate.entityType === 'book'
				&& (insertValues as Record<string, unknown>).workPk != null
				&& isForeignKeyViolation(err)
				&& candidate.meta?.workOlKey
			) {
				const workOlKey = candidate.meta.workOlKey;
				logger.warn(
					{ bookPk: effectivePk, workPk: (insertValues as Record<string, unknown>).workPk, workOlKey, source: candidate.source },
					'merge: batched book work_pk FK missing; staging for later resolve',
				);
				const deferred = { ...insertValues, workPk: null };
				insertResult = await tx.insert(table).values(deferred as never).onConflictDoNothing();
				if ((insertResult.rowCount ?? 0) > 0) {
					await stageBookWork(tx, effectivePk, workOlKey, candidate.source);
				}
			} else {
				throw err;
			}
		}
		if (insertResult.rowCount === 0) {
			await flagIssue(tx, {
				entityType: candidate.entityType as ImportIssueEntityType,
				entityPk: effectivePk,
				field: 'pk',
				incomingValue: candidate.pk,
				storedValue: candidate.pk,
				source: candidate.source,
			});
		} else {
			// Refresh the row map so subsequent candidates in the batch
			// see the freshly-inserted row in their name-fallback scan.
			rowMap.set(effectivePk, insertValues as never);
		}
	}

	// 3. Identifier upsert with conflict detection. Use the pre-fetched
	// resourceMap (committed rows) plus the per-batch claimed set (rows
	// we just inserted in this same batch). The claimed set carries the
	// claimant's entityType so a cross-entity claim surfaces as a
	// conflict rather than silently overwriting the other entity's row.
	for (const id of candidate.identifiers) {
		const preExisting = resourceMap.get(id.resource);
		const claim = claimed.get(id.resource);
		// New to the DB. INSERT (on conflict do nothing handles the
		// race where another concurrent transaction inserted it).
		if (preExisting === undefined && claim === undefined) {
			await adapter.upsert(tx, effectivePk, id);
			claimed.set(id.resource, { entityType: candidate.entityType, pk: effectivePk });
			continue;
		}
		// Same-entity pre-existing row in the DB (or a same-entity
		// claim from earlier in this batch): no-op.
		if (preExisting === effectivePk) continue;
		if (claim && claim.entityType === candidate.entityType && claim.pk === effectivePk) continue;
		// Conflict: either a different entityType owns it, or a different
		// pk of the same entityType owns it. Flag the issue and do NOT
		// overwrite — the DB unique constraint on `resource` would also
		// block the insert, but the per-record mergeEntity path surfaces
		// the conflict as an import_issues row, so we match that.
		const storedValue = preExisting ?? (claim ? `${claim.pk} (${claim.entityType})` : 'unknown');
		await flagIssue(tx, {
			entityType: candidate.entityType as ImportIssueEntityType,
			entityPk: effectivePk,
			field: 'identifier',
			incomingValue: id.resource,
			storedValue,
			source: candidate.source,
		});
	}

	logger.debug({ entityType: candidate.entityType, pk: effectivePk, existed, conflictFields }, 'merge: batch resolved');
	return { pk: effectivePk, existed, conflictFields };
}

function resourceMapFor(entityType: MergeCandidate['entityType'], ctx: MergeBatchContext): Map<string, string> {
	switch (entityType) {
		case 'book': return ctx.bookResources;
		case 'work': return ctx.workResources;
		case 'contributor': return ctx.contributorResources;
		case 'genre': return ctx.genreResources;
	}
}

function rowMapFor(entityType: MergeCandidate['entityType'], ctx: MergeBatchContext) {
	switch (entityType) {
		case 'book': return ctx.bookRows;
		case 'work': return ctx.workRows;
		case 'contributor': return ctx.contributorRows;
		case 'genre': return ctx.genreRows;
	}
}

/**
 * Bulk-fetch the `(resource, pk)` pairs for one identifier table. The
 * drizzle table is a union type, so we type-erase to read whichever pk
 * column exists on the actual table at runtime.
 */
async function fetchIdentifierOwners(
	tx: Tx,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	adapter: any,
	resources: Set<string>,
): Promise<Array<[string, string]>> {
	const rows = await tx
		.select({ resource: adapter.table.resource, pk: adapter.table[adapter.pkCol.pk] })
		.from(adapter.table)
		.where(inArray(adapter.table.resource, [...resources]));
	return rows.map((r: { resource: string; pk: string }) => [r.resource, r.pk]);
}

/** True if `err` is a postgres SQLSTATE 23503 (foreign_key_violation). Mirror of merge.ts helper. */
function isForeignKeyViolation(err: unknown): boolean {
	const cause = (err as { cause?: { code?: string } }).cause;
	return cause?.code === '23503';
}
