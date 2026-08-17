import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
	bookIdentifiers,
	contributorIdentifiers,
	genreIdentifiers,
	workIdentifiers,
} from '../db/schema.js';

type Database = NodePgDatabase<typeof schema>;

export type IdentifierTable = typeof bookIdentifiers | typeof contributorIdentifiers | typeof genreIdentifiers | typeof workIdentifiers;

export interface IdentifierSpec {
	resource: string;
	url: string;
}

export type PkAdapter = {
	findByResource: (db: Database, resource: string) => Promise<string | null>;
	upsert: (db: Database, pk: string, spec: IdentifierSpec) => Promise<void>;
	remove: (db: Database, pk: string) => Promise<void>;
	/** The underlying identifier table; exposed for batched lookups in `mergeBatch`. */
	readonly table: IdentifierTable;
	/** The pk column on the table (e.g. `bookPk`, `workPk`). */
	readonly pkCol: { pk: string };
}

export async function identifierTaken(db: Database, adapter: PkAdapter, resource: string): Promise<boolean> {
	return (await adapter.findByResource(db, resource)) !== null;
}

function makeAdapter(table: IdentifierTable, pkCol: { pk: string }): PkAdapter {
	return {
		table,
		pkCol,
		async findByResource(db, resource) {
			const rows = await db.select().from(table).where(eq(table.resource, resource));
			const row = rows[0];
			return row ? (row as unknown as Record<string, string>)[pkCol.pk] ?? null : null;
		},
		async upsert(db, pk, spec) {
			await db.insert(table)
				.values({ [pkCol.pk]: pk, resource: spec.resource, url: spec.url } as never)
				.onConflictDoNothing();
		},
		async remove(db, pk) {
			await db.delete(table).where(eq(table[pkCol.pk as keyof typeof table] as never, pk as never));
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
export async function upsertIdentifiers(
	db: Database,
	adapter: PkAdapter,
	pk: string,
	specs: IdentifierSpec[],
): Promise<IdentifierUpsertResult> {
	let added = 0;
	const conflicts: IdentifierUpsertResult['conflicts'] = [];
	for (const spec of specs) {
		const existing = await adapter.findByResource(db, spec.resource);
		if (existing === null) {
			await adapter.upsert(db, pk, spec);
			added += 1;
		} else if (existing !== pk) {
			conflicts.push({ resource: spec.resource, ownerPk: existing });
		}
	}
	return { added, conflicts };
}
