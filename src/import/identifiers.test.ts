import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { bookIdentifiersAdapter, upsertIdentifiers } from './identifiers.js';

describe('identifiers', () => {
	it('finds pk by resource and upserts', () => {
		const { db, seed } = createTestDb();
		seed();
		// seed one book (test seed has book-dune)
		expect(bookIdentifiersAdapter.findByResource(db, 'isbn:0441172717')).toBe('book-dune');
		expect(bookIdentifiersAdapter.findByResource(db, 'isbn:0000000000')).toBeNull();

		const { added } = upsertIdentifiers(db, bookIdentifiersAdapter, 'book-flowers', [
			{ resource: 'isbn:9780000000002', url: 'https://example.test/2' },
			{ resource: 'isbn:9780000000003', url: 'https://example.test/3' },
		]);
		expect(added).toBe(2);
		expect(bookIdentifiersAdapter.findByResource(db, 'isbn:9780000000002')).toBe('book-flowers');
	});

	it('reports identifiers owned by another entity as conflicts', () => {
		const { db, seed } = createTestDb();
		seed();
		const { added, conflicts } = upsertIdentifiers(db, bookIdentifiersAdapter, 'book-flowers', [
			{ resource: 'isbn:0441172717', url: 'https://example.test/dune' },
			{ resource: 'isbn:9780000000002', url: 'https://example.test/2' },
		]);
		expect(added).toBe(1);
		expect(conflicts).toEqual([{ resource: 'isbn:0441172717', ownerPk: 'book-dune' }]);
	});
});
