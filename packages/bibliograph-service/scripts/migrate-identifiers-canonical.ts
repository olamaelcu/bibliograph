#!/usr/bin/env tsx
// Rewrite stored `identifiers` jsonb into the canonical
// `community.lexicon.book.defs#identifier` shape and recompute record CIDs.
//
// Why this is a data migration and not a schema migration: the columns are
// untyped `jsonb`, so nothing about the column changes. What changes is the
// meaning of what is inside it — `{ uri, resource }` becomes
// `{ type, value, url? }`, where `type` is a global scheme token (`isbn`, …) or
// the provider's domain (`goodreads.com`, …) and `value` is the provider's own
// key. The lexicon compares identifiers by exact `type`/`value` equality, so
// `community.lexicon.book.resolveEditions` can only match a request against a
// row that is already canonical.
//
// ISBN-10 is not representable in the new shape (the lexicon requires
// hyphenless ISBN-13 on write), so ISBN-10 identifiers become ISBN-13. An
// edition therefore ends up with at most one `isbn` identifier.
//
// Every row's `cid` is recomputed from the same record value the AppView
// serves, because a changed `identifiers` field changes the record bytes.
//
// Usage:
//   pnpm db:migrate:identifiers --dry-run   # report only
//   pnpm db:migrate:identifiers             # apply
//
// Safe to re-run: rows already in canonical form pass through `rowIdentifiers`
// unchanged.

import { asc, eq, gt } from 'drizzle-orm';
import type { LexMap } from '@atproto/lex-data';
import { cidForLex } from '@atproto/lex-cbor';
import { db } from '../src/lib/server/db';
import {
	contributors as contributorsTable,
	editions as editionsTable,
	publishers as publishersTable,
	works as worksTable,
} from '../src/lib/server/db/schema';
import {
	contributorRecordValue,
	publisherRecordValue,
	workRecordValue,
} from '../src/lib/server/book-records';
import { editionRecordCid, rowIdentifiers } from '../src/lib/server/edition-record';
import { loadContributorRefs } from '../src/lib/server/contributor-refs';
import { wireContributors } from '../src/lib/server/book-wire';
import { identifierKey } from '../src/lib/server/identifiers';

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = 500;

interface Stats {
	scanned: number;
	identifiersChanged: number;
	cidChanged: number;
	skippedNoIdentifiers: number;
}

function newStats(): Stats {
	return { scanned: 0, identifiersChanged: 0, cidChanged: 0, skippedNoIdentifiers: 0 };
}

/**
 * Structural equality that ignores object key order.
 *
 * `jsonb` does not preserve key order (it re-sorts on storage), so comparing
 * `JSON.stringify` output directly reports every already-migrated row as
 * changed and rewrites it on each run.
 */
function sameJson(a: unknown, b: unknown): boolean {
	return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

async function cidOf(value: Record<string, unknown> | null): Promise<string | null> {
	if (!value) return null;
	return (await cidForLex(value as unknown as LexMap)).toString();
}

/** Resolve the wire contributors a record value needs, for a stored row. */
async function resolvedContributors(raw: unknown) {
	const entries = Array.isArray(raw)
		? (raw as Array<{ subject: { uri: string; cid: string }; role: string }>)
		: [];
	const uris = [...new Set(entries.map((entry) => entry.subject?.uri).filter((uri): uri is string => !!uri))];
	const refs = await loadContributorRefs(uris);
	return wireContributors(entries, refs);
}

/**
 * Edition rows: canonical identifiers + recomputed CID. The new identifiers are
 * passed explicitly so the CID is hashed from exactly what gets written.
 */
async function migrateEditions(): Promise<Stats> {
	const stats = newStats();
	let cursor: string | undefined;
	for (;;) {
		const page = await db
			.select()
			.from(editionsTable)
			.where(cursor ? gt(editionsTable.uri, cursor) : undefined)
			.orderBy(asc(editionsTable.uri))
			.limit(PAGE_SIZE);
		if (page.length === 0) break;
		cursor = page[page.length - 1]!.uri;

		for (const row of page) {
			stats.scanned++;
			const identifiers = rowIdentifiers(row.identifiers);
			if (identifiers.length === 0) {
				// `defs#edition` requires at least one identifier; there is no valid
				// record to hash, so leave the row untouched and report it.
				stats.skippedNoIdentifiers++;
				continue;
			}
			const deduped = [...new Map(identifiers.map((identifier) => [identifierKey(identifier), identifier])).values()];
			const contributors = await resolvedContributors(row.contributors);
			const cid = await editionRecordCid(row, { identifiers: deduped, contributors });

			const identifiersChanged = !sameJson(row.identifiers, deduped);
			const cidChanged = cid !== null && cid !== row.cid;
			if (identifiersChanged) stats.identifiersChanged++;
			if (cidChanged) stats.cidChanged++;
			if (DRY_RUN || (!identifiersChanged && !cidChanged)) continue;

			await db
				.update(editionsTable)
				.set({
					identifiers: deduped,
					...(cid !== null ? { cid } : {}),
				})
				.where(eq(editionsTable.uri, row.uri));
		}
		if (page.length < PAGE_SIZE) break;
	}
	return stats;
}

/** Work rows: canonical identifiers + recomputed CID (contributors are names). */
async function migrateWorks(): Promise<Stats> {
	const stats = newStats();
	let cursor: string | undefined;
	for (;;) {
		const page = await db
			.select()
			.from(worksTable)
			.where(cursor ? gt(worksTable.uri, cursor) : undefined)
			.orderBy(asc(worksTable.uri))
			.limit(PAGE_SIZE);
		if (page.length === 0) break;
		cursor = page[page.length - 1]!.uri;

		for (const row of page) {
			stats.scanned++;
			const identifiers = rowIdentifiers(row.identifiers);
			const contributors = await resolvedContributors(row.contributors);
			const value = workRecordValue({ ...row, identifiers }, contributors);
			const cid = await cidOf(value);

			const identifiersChanged = !sameJson(row.identifiers, identifiers);
			const cidChanged = cid !== null && cid !== row.cid;
			if (identifiersChanged) stats.identifiersChanged++;
			if (cidChanged) stats.cidChanged++;
			if (DRY_RUN || (!identifiersChanged && !cidChanged)) continue;

			await db
				.update(worksTable)
				.set({ identifiers, ...(cid !== null ? { cid } : {}) })
				.where(eq(worksTable.uri, row.uri));
		}
		if (page.length < PAGE_SIZE) break;
	}
	return stats;
}

/** Contributor rows: canonical identifiers + recomputed CID. */
async function migrateContributors(): Promise<Stats> {
	const stats = newStats();
	let cursor: string | undefined;
	for (;;) {
		const page = await db
			.select()
			.from(contributorsTable)
			.where(cursor ? gt(contributorsTable.uri, cursor) : undefined)
			.orderBy(asc(contributorsTable.uri))
			.limit(PAGE_SIZE);
		if (page.length === 0) break;
		cursor = page[page.length - 1]!.uri;

		for (const row of page) {
			stats.scanned++;
			const identifiers = rowIdentifiers(row.identifiers);
			const cid = await cidOf(contributorRecordValue({ ...row, identifiers }));

			const identifiersChanged = !sameJson(row.identifiers, identifiers);
			const cidChanged = cid !== null && cid !== row.cid;
			if (identifiersChanged) stats.identifiersChanged++;
			if (cidChanged) stats.cidChanged++;
			if (DRY_RUN || (!identifiersChanged && !cidChanged)) continue;

			await db
				.update(contributorsTable)
				.set({ identifiers, ...(cid !== null ? { cid } : {}) })
				.where(eq(contributorsTable.uri, row.uri));
		}
		if (page.length < PAGE_SIZE) break;
	}
	return stats;
}

/** Publisher rows: canonical identifiers + recomputed CID. */
async function migratePublishers(): Promise<Stats> {
	const stats = newStats();
	let cursor: string | undefined;
	for (;;) {
		const page = await db
			.select()
			.from(publishersTable)
			.where(cursor ? gt(publishersTable.uri, cursor) : undefined)
			.orderBy(asc(publishersTable.uri))
			.limit(PAGE_SIZE);
		if (page.length === 0) break;
		cursor = page[page.length - 1]!.uri;

		for (const row of page) {
			stats.scanned++;
			const identifiers = rowIdentifiers(row.identifiers);
			const cid = await cidOf(publisherRecordValue({ ...row, identifiers }));

			const identifiersChanged = !sameJson(row.identifiers, identifiers);
			const cidChanged = cid !== null && cid !== row.cid;
			if (identifiersChanged) stats.identifiersChanged++;
			if (cidChanged) stats.cidChanged++;
			if (DRY_RUN || (!identifiersChanged && !cidChanged)) continue;

			await db
				.update(publishersTable)
				.set({ identifiers, ...(cid !== null ? { cid } : {}) })
				.where(eq(publishersTable.uri, row.uri));
		}
		if (page.length < PAGE_SIZE) break;
	}
	return stats;
}

async function main(): Promise<void> {
	console.log(`[identifiers] ${DRY_RUN ? 'DRY RUN — no writes' : 'migrating'}`);

	const steps: Array<[string, () => Promise<Stats>]> = [
		// Contributors first: their identifiers are embedded in the `contributors`
		// of every edition and work record value, so normalising them afterwards
		// would invalidate the CIDs those collections just wrote.
		['contributors', migrateContributors],
		['publishers', migratePublishers],
		['works', migrateWorks],
		['editions', migrateEditions],
	];

	for (const [name, run] of steps) {
		const stats = await run();
		console.log(
			`[identifiers] ${name}: scanned=${stats.scanned} identifiers=${stats.identifiersChanged} cid=${stats.cidChanged}` +
				(stats.skippedNoIdentifiers > 0 ? ` skippedNoIdentifiers=${stats.skippedNoIdentifiers}` : ''),
		);
	}

	console.log('[identifiers] done');
	process.exit(0);
}

await main();
