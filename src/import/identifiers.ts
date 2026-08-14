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

/** Upsert a set of identifier specs onto an entity, returning how many were new. */
export function upsertIdentifiers(
	db: BetterSQLite3Database,
	adapter: PkAdapter,
	pk: string,
	specs: IdentifierSpec[],
): number {
	let added = 0;
	for (const spec of specs) {
		const existing = adapter.findByResource(db, spec.resource);
		if (existing === null) {
			adapter.upsert(db, pk, spec);
			added += 1;
		}
	}
	return added;
}
