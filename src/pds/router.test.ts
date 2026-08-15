import { describe, expect, it } from 'vitest';
import { createXrpcRouter } from '../xrpc/router.js';
import { createTestDb, SERVICE_DID } from '../test-utils/db.js';
import type { ViewContext } from '../xrpc/views.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

function app() {
	const { db, sqlite, seed } = createTestDb();
	seed();
	const router = createXrpcRouter(db, ctx);
	return {
		fetch: (path: string, init?: RequestInit) =>
			router.fetch(new Request(`https://books.example.com${path}`, init)),
		db,
		sqlite,
	};
}

const COLL = {
	book: 'net.olamaelcu.livtet.biblio.book',
	work: 'net.olamaelcu.livtet.biblio.work',
	contributor: 'net.olamaelcu.livtet.biblio.contributor',
	format: 'net.olamaelcu.livtet.biblio.format',
	genre: 'net.olamaelcu.livtet.biblio.genre',
};

function getRecordUrl(collection: string, rkey: string, extra = '') {
	const params = new URLSearchParams({ repo: SERVICE_DID, collection, rkey });
	return `/xrpc/com.atproto.repo.getRecord?${params}${extra ? `&${extra}` : ''}`;
}

describe('com.atproto.repo.getRecord', () => {
	it('returns a typed record value with a stable cid', async () => {
		const { fetch } = app();
		const res1 = await fetch(getRecordUrl(COLL.book, 'book-dune'));
		expect(res1.status).toBe(200);
		const body1 = await res1.json();
		expect(body1.uri).toBe(`at://${SERVICE_DID}/${COLL.book}/book-dune`);
		expect(body1.value.$type).toBe(COLL.book);
		expect(body1.value.title).toBe('Dune (40th Anniversary)');
		expect(body1.value.work.$type).toBe(COLL.work);
		expect(body1.value.work.title).toBe('Dune');
		expect(body1.value.format.$type).toBe(COLL.format);
		expect(body1.value.format.unit).toBe('pages');
		expect(body1.value.genres).toHaveLength(2);
		expect(body1.value.identifiers[0].resource).toBe('isbn:0441172717');
		expect(body1.cid).toMatch(/^bafy/);

		// CID must be stable across calls
		const res2 = await fetch(getRecordUrl(COLL.book, 'book-dune'));
		const body2 = await res2.json();
		expect(body2.cid).toBe(body1.cid);
	});

	it('persists the computed cid into the database', async () => {
		const { fetch, sqlite } = app();
		await fetch(getRecordUrl(COLL.book, 'book-dune'));
		const row = sqlite
			.prepare('SELECT cid FROM books WHERE pk = ?')
			.get('book-dune') as { cid: string };
		expect(row.cid).toMatch(/^bafy/);
	});

	it('returns RecordNotFound for a missing record', async () => {
		const { fetch } = app();
		const res = await fetch(getRecordUrl(COLL.book, 'nope'));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('RecordNotFound');
	});

	it('rejects a repo we do not host', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({
			repo: 'did:web:other.example.com',
			collection: COLL.book,
			rkey: 'book-dune',
		});
		const res = await fetch(`/xrpc/com.atproto.repo.getRecord?${params}`);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('InvalidRequest');
	});

	it('rejects an unsupported collection', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({
			repo: SERVICE_DID,
			collection: 'net.olamaelcu.livtet.biblio.review',
			rkey: 'review-1',
		});
		const res = await fetch(`/xrpc/com.atproto.repo.getRecord?${params}`);
		expect(res.status).toBe(400);
	});

	it('rejects a cid mismatch', async () => {
		const { fetch } = app();
		const res = await fetch(getRecordUrl(COLL.book, 'book-dune', 'cid=bafyreiflattest'));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('InvalidRequest');
	});

	it('returns other owned collections', async () => {
		const { fetch } = app();
		for (const [collection, rkey] of [
			[COLL.work, 'work-dune'],
			[COLL.contributor, 'author-herbert'],
			[COLL.format, 'paperback'],
			[COLL.genre, 'scifi'],
		] as const) {
			const res = await fetch(getRecordUrl(collection, rkey));
			expect(res.status, collection).toBe(200);
			const body = await res.json();
			expect(body.cid).toMatch(/^bafy/);
			expect(body.value.$type).toBe(collection);
		}
	});

	it('genre view carries its parent uri', async () => {
		const { fetch } = app();
		const res = await fetch(getRecordUrl(COLL.genre, 'scifi'));
		const body = await res.json();
		expect(body.value.parent).toBe(`at://${SERVICE_DID}/${COLL.genre}/fiction`);
	});
});

describe('com.atproto.repo.listRecords', () => {
	it('lists records for a collection', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({ repo: SERVICE_DID, collection: COLL.book });
		const res = await fetch(`/xrpc/com.atproto.repo.listRecords?${params}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.records).toHaveLength(2);
		expect(body.records[0].value.$type).toBe(COLL.book);
	});

	it('paginates with limit and cursor', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({ repo: SERVICE_DID, collection: COLL.book, limit: '1' });
		const res1 = await fetch(`/xrpc/com.atproto.repo.listRecords?${params}`);
		const body1 = await res1.json();
		expect(body1.records).toHaveLength(1);
		expect(body1.cursor).toBeDefined();

		const res2 = await fetch(
			`/xrpc/com.atproto.repo.listRecords?${params}&cursor=${encodeURIComponent(body1.cursor)}`,
		);
		const body2 = await res2.json();
		expect(body2.records).toHaveLength(1);
		expect(body2.records[0].uri).not.toBe(body1.records[0].uri);
	});

	it('reverses order with reverse=true', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({ repo: SERVICE_DID, collection: COLL.book });
		const fwd = await fetch(`/xrpc/com.atproto.repo.listRecords?${params}`);
		const fwdBody = await fwd.json();
		const rev = await fetch(`/xrpc/com.atproto.repo.listRecords?${params}&reverse=true`);
		const revBody = await rev.json();
		expect(revBody.records.map((r: { uri: string }) => r.uri)).toEqual(
			fwdBody.records.map((r: { uri: string }) => r.uri).reverse(),
		);
	});

	it('rejects a repo we do not host', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({
			repo: 'did:web:other.example.com',
			collection: COLL.book,
		});
		const res = await fetch(`/xrpc/com.atproto.repo.listRecords?${params}`);
		expect(res.status).toBe(400);
	});
});

describe('com.atproto.repo.describeRepo', () => {
	it('describes our repo', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({ repo: SERVICE_DID });
		const res = await fetch(`/xrpc/com.atproto.repo.describeRepo?${params}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.did).toBe(SERVICE_DID);
		expect(body.handleIsCorrect).toBe(true);
		expect(body.collections).toContain(COLL.book);
		expect(body.collections).toContain(COLL.genre);
		expect(body.didDoc.id).toBe(SERVICE_DID);
	});

	it('rejects a repo we do not host', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({ repo: 'did:web:other.example.com' });
		const res = await fetch(`/xrpc/com.atproto.repo.describeRepo?${params}`);
		expect(res.status).toBe(400);
	});
});

describe('com.atproto.identity.resolveHandle', () => {
	it('resolves our own handle', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({ handle: 'books.example.com' });
		const res = await fetch(`/xrpc/com.atproto.identity.resolveHandle?${params}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.did).toBe(SERVICE_DID);
	});

	it('rejects foreign handles', async () => {
		const { fetch } = app();
		const params = new URLSearchParams({ handle: 'someone.example.net' });
		const res = await fetch(`/xrpc/com.atproto.identity.resolveHandle?${params}`);
		expect(res.status).toBe(400);
	});
});
