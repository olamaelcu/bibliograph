import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import {
	bookIdentifiers,
	contributorIdentifiers,
	genreIdentifiers,
	workIdentifiers,
} from '../db/schema.js';

export type IdentifierTable = typeof bookIdentifiers | typeof contributorIdentifiers | typeof genreIdentifiers | typeof workIdentifiers;

export interface IdentifierSpec {
	resource: string;
	url: string;
}

type PkAdapter = {
	findByResource: (db: BetterSQLite3Database, resource: string) => string | null;
	upsert: (db: BetterSQLite3Database, pk: string, spec: IdentifierSpec) => void;
	remove: (db: BetterSQLite3Database, pk: string) => void;
}

export type { PkAdapter };

export function identifierTaken(db: BetterSQLite3Database, adapter: PkAdapter, resource: string): boolean {
	return adapter.findByResource(db, resource) !== null;
}

function makeAdapter(table: IdentifierTable, pkCol: { pk: string }): PkAdapter {
	return {
		findByResource(db, resource) {
			const row = db.select().from(table).where(eq(table.resource, resource)).get();
			return row ? (row as unknown as Record<string, string>)[pkCol.pk] ?? null : null;
		},
		upsert(db, pk, spec) {
			db.insert(table)
				.values({ [pkCol.pk]: pk, resource: spec.resource, url: spec.url } as never)
				.onConflictDoNothing()
				.run();
		},
		remove(db, pk) {
			db.delete(table).where(eq(table[pkCol.pk as keyof typeof table] as never, pk as never)).run();
		},
	};
}

export const bookIdentifiersAdapter = makeAdapter(bookIdentifiers, { pk: 'bookPk' });
export const workIdentifiersAdapter = makeAdapter(workIdentifiers, { pk: 'workPk' });
export const contributorIdentifiersAdapter = makeAdapter(contributorIdentifiers, { pk: 'contributorPk' });
export const genreIdentifiersAdapter = makeAdapter(genreIdentifiers, { pk: 'genrePk' });

/** Result of an identifier upsert: newly claimed resources plus any resources already owned by a different entity. */
export interface IdentifierUpsertResult {
	added: number;
	conflicts: Array<{ resource: string; ownerPk: string }>;
}

/** Upsert identifier specs onto an entity, returning new claims and conflicting claims. */
export function upsertIdentifiers(
	db: BetterSQLite3Database,
	adapter: PkAdapter,
	pk: string,
	specs: IdentifierSpec[],
): IdentifierUpsertResult {
	let added = 0;
	const conflicts: IdentifierUpsertResult['conflicts'] = [];
	for (const spec of specs) {
		const existing = adapter.findByResource(db, spec.resource);
		if (existing === null) {
			adapter.upsert(db, pk, spec);
			added += 1;
		} else if (existing !== pk) {
			conflicts.push({ resource: spec.resource, ownerPk: existing });
		}
	}
	return { added, conflicts };
}
