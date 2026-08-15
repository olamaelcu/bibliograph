import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { userRecords } from '../db/schema.js';
import { COLLECTION } from '../xrpc/views.js';
import { getUserRecord, listByCollection } from './query.js';

function testDb(): ReturnType<typeof createTestDb>['db'] {
	return createTestDb().db;
}

function seed(db: ReturnType<typeof createTestDb>['db'], did: string, collection: string, rkey: string, value: Record<string, unknown>) {
	db.insert(userRecords)
		.values({ did, collection, rkey, cid: 'bafyreicid', record: { $type: collection, ...value }, indexedAt: 0 })
		.run();
}

describe('getUserRecord', () => {
	it('reconstructs a PdsRecord from its (did, collection, rkey) identity', () => {
		const db = testDb();
		seed(db, 'did:web:alice.example.com', COLLECTION.shelf, 'shelf-1', { name: 'Favorites' });
		const rec = getUserRecord(db, 'did:web:alice.example.com', COLLECTION.shelf, 'shelf-1');
		expect(rec).toBeDefined();
		expect(rec?.uri).toBe('at://did:web:alice.example.com/net.olamaelcu.livtet.biblio.shelf/shelf-1');
		expect(rec?.cid).toBe('bafyreicid');
		expect((rec?.value as { name: string }).name).toBe('Favorites');
	});

	it('returns undefined when the identity is not indexed', () => {
		const db = testDb();
		expect(getUserRecord(db, 'did:web:alice.example.com', COLLECTION.shelf, 'nope')).toBeUndefined();
	});

	it('does not cross collections or DIDs sharing the same rkey', () => {
		const db = testDb();
		seed(db, 'did:web:alice.example.com', COLLECTION.shelf, 'x', { name: 'Alice shelf' });
		seed(db, 'did:web:bob.example.com', COLLECTION.shelf, 'x', { name: 'Bob shelf' });
		seed(db, 'did:web:alice.example.com', COLLECTION.review, 'x', { status: 'read' });

		const aliceShelf = getUserRecord(db, 'did:web:alice.example.com', COLLECTION.shelf, 'x');
		expect((aliceShelf?.value as { name: string }).name).toBe('Alice shelf');
	});
});

describe('listByCollection', () => {
	it('lists every indexed record in a collection across all DIDs', () => {
		const db = testDb();
		seed(db, 'did:web:alice.example.com', COLLECTION.review, 'rev-1', { status: 'read' });
		seed(db, 'did:web:bob.example.com', COLLECTION.review, 'rev-1', { status: 'reading' });
		seed(db, 'did:web:alice.example.com', COLLECTION.shelf, 'shelf-1', { name: 'Favorites' });

		const reviews = listByCollection(db, COLLECTION.review);
		expect(reviews).toHaveLength(2);
		expect(reviews.map((r) => r.uri).sort()).toEqual([
			'at://did:web:alice.example.com/net.olamaelcu.livtet.biblio.review/rev-1',
			'at://did:web:bob.example.com/net.olamaelcu.livtet.biblio.review/rev-1',
		]);
	});

	it('returns an empty list for a collection with no indexed records', () => {
		const db = testDb();
		expect(listByCollection(db, COLLECTION.actor)).toEqual([]);
	});
});
