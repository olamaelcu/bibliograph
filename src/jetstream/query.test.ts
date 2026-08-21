import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { userRecords } from '../db/schema.js';
import { COLLECTION } from '../lex/collections.js';
import { getUserRecord, listByCollection } from './query.js';

async function testDb(): Promise<ReturnType<typeof createTestDb>['db']> {
	const { db } = await createTestDb();
	return db;
}

async function seed(db: ReturnType<typeof createTestDb>['db'], did: string, collection: string, rkey: string, value: Record<string, unknown>) {
	await db.insert(userRecords).values({ did, collection, rkey, cid: 'bafyreicid', record: { $type: collection, ...value }, indexedAt: 0 });
}

	describe('getUserRecord', () => {
	it('reconstructs a PdsRecord from its (did, collection, rkey) identity', async () => {
		const db = await testDb();
		await seed(db, 'did:web:alice.example.com', COLLECTION.shelf, 'shelf-1', { name: 'Favorites' });
		const rec = await getUserRecord(db, 'did:web:alice.example.com', COLLECTION.shelf, 'shelf-1');
		expect(rec).toBeDefined();
		expect(rec?.uri).toBe('at://did:web:alice.example.com/net.olamaelcu.livtet.biblio.shelf/shelf-1');
		expect(rec?.cid).toBe('bafyreicid');
		expect((rec?.value as { name: string }).name).toBe('Favorites');
	});

	it('returns undefined when the identity is not indexed', async () => {
		const db = await testDb();
		expect(await getUserRecord(db, 'did:web:alice.example.com', COLLECTION.shelf, 'nope')).toBeUndefined();
	});

	it('does not cross collections or DIDs sharing the same rkey', async () => {
		const db = await testDb();
		await seed(db, 'did:web:alice.example.com', COLLECTION.shelf, 'x', { name: 'Alice shelf' });
		await seed(db, 'did:web:bob.example.com', COLLECTION.shelf, 'x', { name: 'Bob shelf' });
		await seed(db, 'did:web:alice.example.com', COLLECTION.bookShelf, 'x', { position: 1 });

		const aliceShelf = await getUserRecord(db, 'did:web:alice.example.com', COLLECTION.shelf, 'x');
		expect((aliceShelf?.value as { name: string }).name).toBe('Alice shelf');
	});
});

describe('listByCollection', () => {
	it('lists every indexed record in a collection across all DIDs', async () => {
		const db = await testDb();
		await seed(db, 'did:web:alice.example.com', COLLECTION.bookShelf, 'shelf-1', { position: 1 });
		await seed(db, 'did:web:bob.example.com', COLLECTION.bookShelf, 'shelf-1', { position: 2 });
		await seed(db, 'did:web:alice.example.com', COLLECTION.shelf, 'shelf-2', { name: 'Favorites' });

		const shelvings = await listByCollection(db, COLLECTION.bookShelf);
		expect(shelvings).toHaveLength(2);
		expect(shelvings.map((r) => r.uri).sort()).toEqual([
			'at://did:web:alice.example.com/net.olamaelcu.livtet.biblio.bookShelving/shelf-1',
			'at://did:web:bob.example.com/net.olamaelcu.livtet.biblio.bookShelving/shelf-1',
		]);
	});

	it('returns an empty list for a collection with no indexed records', async () => {
		const db = await testDb();
		expect(await listByCollection(db, COLLECTION.actor)).toEqual([]);
	});
});
