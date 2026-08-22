import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createXrpcRouter } from '../xrpc/router.js';
import { createTestDb, SERVICE_DID } from '../test-utils/db.js';
import type { ViewContext } from '../lex/collections.js';
import { GoogleBooksClient, type GbVolume } from '../google-books/client.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

async function app() {
	const { db, seed } = await createTestDb();
	await seed();
	const router = createXrpcRouter(db, ctx);
	return {
		fetch: (path: string, init?: RequestInit) =>
			router.fetch(new Request(`https://books.example.com${path}`, init)),
		db,
	};
}

const COLL = {
	book: 'net.olamaelcu.livtet.biblio.book',
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
		const { fetch } = await app();
		const res1 = await fetch(getRecordUrl(COLL.book, 'book-dune'));
		expect(res1.status).toBe(200);
		const body1 = await res1.json();
		expect(body1.uri).toBe(`at://${SERVICE_DID}/${COLL.book}/book-dune`);
		expect(body1.value.$type).toBe(COLL.book);
		expect(body1.value.title).toBe('Dune (40th Anniversary)');
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
		const { fetch, db } = await app();
		await fetch(getRecordUrl(COLL.book, 'book-dune'));
		const result = await db.execute(sql`SELECT cid FROM books WHERE pk = ${'book-dune'}`);
		const row = result.rows[0] as { cid: string };
		expect(row.cid).toMatch(/^bafy/);
	});

	it('returns RecordNotFound for a missing record', async () => {
		const { fetch } = await app();
		const res = await fetch(getRecordUrl(COLL.book, 'nope'));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('RecordNotFound');
	});

	it('rejects a repo we do not host', async () => {
		const { fetch } = await app();
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
		const { fetch } = await app();
		const params = new URLSearchParams({
			repo: SERVICE_DID,
			collection: 'net.olamaelcu.livtet.biblio.nonsense',
			rkey: 'x-1',
		});
		const res = await fetch(`/xrpc/com.atproto.repo.getRecord?${params}`);
		expect(res.status).toBe(400);
	});

	it('rejects a cid mismatch', async () => {
		const { fetch } = await app();
		const res = await fetch(getRecordUrl(COLL.book, 'book-dune', 'cid=bafyreiflattest'));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('InvalidRequest');
	});

	it('returns other owned collections', async () => {
		const { fetch } = await app();
		for (const [collection, rkey] of [
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
		const { fetch } = await app();
		const res = await fetch(getRecordUrl(COLL.genre, 'scifi'));
		const body = await res.json();
		expect(body.value.parent).toBe(`at://${SERVICE_DID}/${COLL.genre}/fiction`);
	});
});

describe('com.atproto.repo.listRecords', () => {
	it('lists records for a collection', async () => {
		const { fetch } = await app();
		const params = new URLSearchParams({ repo: SERVICE_DID, collection: COLL.book });
		const res = await fetch(`/xrpc/com.atproto.repo.listRecords?${params}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.records).toHaveLength(2);
		expect(body.records[0].value.$type).toBe(COLL.book);
	});

	it('paginates with limit and cursor', async () => {
		const { fetch } = await app();
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
		const { fetch } = await app();
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
		const { fetch } = await app();
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
		const { fetch } = await app();
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
		const { fetch } = await app();
		const params = new URLSearchParams({ repo: 'did:web:other.example.com' });
		const res = await fetch(`/xrpc/com.atproto.repo.describeRepo?${params}`);
		expect(res.status).toBe(400);
	});
});

describe('com.atproto.identity.resolveHandle', () => {
	it('resolves our own handle', async () => {
		const { fetch } = await app();
		const params = new URLSearchParams({ handle: 'books.example.com' });
		const res = await fetch(`/xrpc/com.atproto.identity.resolveHandle?${params}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.did).toBe(SERVICE_DID);
	});

	it('rejects foreign handles', async () => {
		const { fetch } = await app();
		const params = new URLSearchParams({ handle: 'someone.example.net' });
		const res = await fetch(`/xrpc/com.atproto.identity.resolveHandle?${params}`);
		expect(res.status).toBe(400);
	});
});

function stubGbFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: { count: number; urls: string[] } } {
	const counter = { count: 0, urls: [] as string[] };
	const fetchImpl = (async (input: Request | URL | string, _init?: RequestInit) => {
		counter.count += 1;
		counter.urls.push(String(input));
		if (status >= 400) {
			return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
				status,
				headers: { 'content-type': status === 404 ? 'text/plain' : 'application/json' },
			});
		}
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		});
	}) as typeof fetch;
	return { fetch: fetchImpl, calls: counter };
}

async function appWithGb(fetchImpl: typeof fetch) {
	const { db, seed } = await createTestDb();
	await seed();
	const gb = new GoogleBooksClient({ apiKey: 'test', fetchImpl });
	const router = createXrpcRouter(db, ctx, { client: gb });
	return {
		fetch: (path: string) =>
			router.fetch(new Request(`https://books.example.com${path}`)),
		db,
	};
}

describe('com.atproto.repo.getRecord (gb- lazy import)', () => {
	const volume: GbVolume = {
		id: 'lazyVol',
		volumeInfo: {
			title: 'Lazy Title',
			authors: ['Lazy Author'],
			publishedDate: '2020-05-12',
			description: 'A description.',
			industryIdentifiers: [
				{ type: 'ISBN_13', identifier: '9780000000001' },
				{ type: 'ISBN_10', identifier: '0000000001' },
			],
			imageLinks: { thumbnail: 'https://books.google.com/img.jpg' },
		},
	};

	it('fetches, persists, and returns a gb- record on miss', async () => {
		const { fetch, db } = await appWithGb(stubGbFetch(volume).fetch);
		const res = await fetch(getRecordUrl(COLL.book, 'gb-lazyVol'));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.uri).toBe(`at://${SERVICE_DID}/${COLL.book}/gb-lazyVol`);
		expect(body.value.$type).toBe(COLL.book);
		expect(body.value.title).toBe('Lazy Title');
		expect(body.value.publishDate).toBe('2020-05-12T00:00:00.000Z');
		expect(body.value.description).toBe('A description.');
		expect(body.value.coverUrl).toBe('https://books.google.com/img.jpg');
		expect(body.value.identifiers).toEqual([
			{ resource: 'isbn_13:9780000000001', url: 'https://books.google.com/books?id=lazyVol' },
			{ resource: 'isbn_10:0000000001', url: 'https://books.google.com/books?id=lazyVol' },
		]);
		expect(body.cid).toMatch(/^bafy/);

		const persisted = await db.execute(
			sql`SELECT pk, title, description, cover_url FROM books WHERE pk = ${'gb-lazyVol'}`,
		);
		const row = (persisted.rows[0] ?? {}) as Record<string, unknown>;
		expect(row.title).toBe('Lazy Title');
		expect(row.description).toBe('A description.');
		expect(row.cover_url).toBe('https://books.google.com/img.jpg');

		const ids = await db.execute(
			sql`SELECT resource FROM book_identifiers WHERE book_pk = ${'gb-lazyVol'} ORDER BY resource`,
		);
		expect(ids.rows.map((r) => (r as { resource: string }).resource)).toEqual([
			'isbn_10:0000000001',
			'isbn_13:9780000000001',
		]);
	});

	it('persists a stable cid on first import', async () => {
		const { fetch, db } = await appWithGb(stubGbFetch(volume).fetch);
		const res = await fetch(getRecordUrl(COLL.book, 'gb-lazyVol'));
		const body = await res.json();
		const cidRow = await db.execute(
			sql`SELECT cid FROM books WHERE pk = ${'gb-lazyVol'}`,
		);
		expect((cidRow.rows[0] as { cid: string }).cid).toBe(body.cid);
	});

	it('does not call GB when the record is already in the DB', async () => {
		const stub = stubGbFetch(volume);
		const { fetch } = await appWithGb(stub.fetch);
		await fetch(getRecordUrl(COLL.book, 'gb-lazyVol'));
		expect(stub.calls.count).toBe(1);
		const before = stub.calls.count;
		await fetch(getRecordUrl(COLL.book, 'gb-lazyVol'));
		expect(stub.calls.count).toBe(before);
	});

	it('returns RecordNotFound when GB has no such volume', async () => {
		const { fetch } = await appWithGb(stubGbFetch('not found', 404).fetch);
		const res = await fetch(getRecordUrl(COLL.book, 'gb-missing'));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('RecordNotFound');
	});

	it('returns 502 when GB returns a non-404 error', async () => {
		const { fetch } = await appWithGb(stubGbFetch({ error: 'oops' }, 503).fetch);
		const res = await fetch(getRecordUrl(COLL.book, 'gb-broken'));
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toBe('UpstreamFailure');
	});

	it('returns RecordNotFound when GB omits volumeInfo.title', async () => {
		const { fetch } = await appWithGb(stubGbFetch({ id: 'noTitle' }).fetch);
		const res = await fetch(getRecordUrl(COLL.book, 'gb-noTitle'));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('RecordNotFound');
	});

	it('rejects an invalid gb- rkey without calling GB', async () => {
		const stub = stubGbFetch(volume);
		const { fetch } = await appWithGb(stub.fetch);
		const res = await fetch(getRecordUrl(COLL.book, 'gb-' + '!'.repeat(5)));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('InvalidRequest');
		expect(stub.calls.count).toBe(0);
	});

	it('returns 502 when no GoogleBooksClient is configured', async () => {
		const { db } = await createTestDb();
		await db.execute(sql`DELETE FROM books WHERE pk LIKE 'gb-%'`);
		const router = createXrpcRouter(db, ctx);
		const fetch = (path: string) =>
			router.fetch(new Request(`https://books.example.com${path}`));
		const res = await fetch(getRecordUrl(COLL.book, 'gb-noClient'));
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toBe('UpstreamFailure');
	});

	it('is idempotent under concurrent first-time imports', async () => {
		const stub = stubGbFetch(volume);
		const { fetch, db } = await appWithGb(stub.fetch);
		const urls = Array.from({ length: 5 }, () =>
			fetch(getRecordUrl(COLL.book, 'gb-lazyVol')),
		);
		const results = await Promise.all(urls);
		for (const res of results) expect(res.status).toBe(200);
		const ids = await db.execute(
			sql`SELECT resource FROM book_identifiers WHERE book_pk = ${'gb-lazyVol'} ORDER BY resource`,
		);
		expect(ids.rows.map((r) => (r as { resource: string }).resource)).toEqual([
			'isbn_10:0000000001',
			'isbn_13:9780000000001',
		]);
	});

	it('does not import a record for non-gb rkeys', async () => {
		const stub = stubGbFetch(volume);
		const { fetch } = await appWithGb(stub.fetch);
		const res = await fetch(getRecordUrl(COLL.book, 'book-dune'));
		expect(res.status).toBe(200);
		expect(stub.calls.count).toBe(0);
	});
});
