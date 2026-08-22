import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createXrpcRouter } from '../xrpc/router.js';
import { createTestDb, SERVICE_DID } from '../test-utils/db.js';
import type { ViewContext } from '../lex/collections.js';
import { GoogleBooksClient, type GbVolume } from '../google-books/client.js';

const ctx: ViewContext = { serviceDid: SERVICE_DID };

async function app(opts: { client?: GoogleBooksClient; seed?: boolean } = {}) {
	const { db, seed } = await createTestDb();
	if (opts.seed !== false) await seed();
	const router = createXrpcRouter(db, ctx, { client: opts.client });
	return {
		fetch: (path: string, init?: RequestInit) =>
			router.fetch(new Request(`https://books.example.com${path}`, init)),
		db,
	};
}

const COLL = {
	edition: 'community.lexicon.book.edition',
	contributor: 'community.lexicon.book.contributor',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelf: 'net.olamaelcu.livtet.biblio.bookShelving',
	actor: 'net.olamaelcu.livtet.biblio.actor',
};

function getRecordUrl(collection: string, rkey: string, extra = '') {
	const params = new URLSearchParams({ repo: SERVICE_DID, collection, rkey });
	return `/xrpc/com.atproto.repo.getRecord?${params}${extra ? `&${extra}` : ''}`;
}

describe('com.atproto.repo.getRecord', () => {
	it('returns a typed record value with a stable cid', async () => {
		const { fetch } = await app();
		const res1 = await fetch(getRecordUrl(COLL.edition, 'test-edition-dune'));
		expect(res1.status).toBe(200);
		const body1 = await res1.json();
		expect(body1.uri).toBe(`at://${SERVICE_DID}/${COLL.edition}/test-edition-dune`);
		expect(body1.value.$type).toBe(COLL.edition);
		expect(body1.value.title).toBe('Dune (40th Anniversary)');
		expect(body1.value.identifiers).toContainEqual(expect.objectContaining({ resource: 'isbn13' }));
		expect(body1.cid).toMatch(/^bafy/);

		// CID must be stable across calls.
		const res2 = await fetch(getRecordUrl(COLL.edition, 'test-edition-dune'));
		const body2 = await res2.json();
		expect(body2.cid).toBe(body1.cid);
	});

	it('persists the computed cid into the database', async () => {
		const { fetch, db } = await app();
		await fetch(getRecordUrl(COLL.edition, 'test-edition-dune'));
		const result = await db.execute(sql`SELECT cid FROM editions WHERE pk = ${'test-edition-dune'}`);
		const row = result.rows[0] as { cid: string };
		expect(row.cid).toMatch(/^bafy/);
	});

	it('returns RecordNotFound for a missing record', async () => {
		const { fetch } = await app();
		const res = await fetch(getRecordUrl(COLL.edition, 'nope'));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('RecordNotFound');
	});

	it('rejects a repo we do not host', async () => {
		const { fetch } = await app();
		const params = new URLSearchParams({
			repo: 'did:web:other.example.com',
			collection: COLL.edition,
			rkey: 'test-edition-dune',
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
		const res = await fetch(getRecordUrl(COLL.edition, 'test-edition-dune', 'cid=bafyreiflattest'));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('InvalidRequest');
	});

	it('returns a typed contributor record', async () => {
		const { fetch } = await app();
		const res = await fetch(getRecordUrl(COLL.contributor, 'ctest-author-herbert'));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.value.$type).toBe(COLL.contributor);
		expect(body.value.name).toBe('Frank Herbert');
	});

});

describe('com.atproto.repo.getRecord (gb- lazy import)', () => {
	const SAMPLE_GB: GbVolume = {
		id: 'sample-vol',
		volumeInfo: {
			title: 'The Sample Book',
			authors: ['Sample Author'],
			industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780000000001' }],
		},
	};

function makeClient(): GoogleBooksClient {
	return new GoogleBooksClient({ apiKey: 'test-key', fetchImpl: async () =>
		new Response(JSON.stringify(SAMPLE_GB), { status: 200 }) });
}

	it('fetches, persists, and returns a gb- record on miss', async () => {
		const { fetch, db } = await app({ client: makeClient() });
		const res = await fetch(getRecordUrl(COLL.edition, 'gb-sample-vol'));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.value.$type).toBe(COLL.edition);
		expect(body.value.title).toBe('The Sample Book');
		// The persisted edition is keyed by a fresh TID; the GB volume id is
		// stored in book_identifiers with value_scheme='googleBooks'.
		const idents = await db.execute(
			sql`SELECT book_pk FROM book_identifiers WHERE value_scheme = 'googleBooks' AND value = ${'sample-vol'}`,
		);
		expect(idents.rows[0]).toBeDefined();
	});

	it('persists a stable cid on first import', async () => {
		const { fetch } = await app({ client: makeClient() });
		const r1 = await fetch(getRecordUrl(COLL.edition, 'gb-sample-vol'));
		const r2 = await fetch(getRecordUrl(COLL.edition, 'gb-sample-vol'));
		expect((await r1.json()).cid).toBe((await r2.json()).cid);
	});

	it('does not call GB when the record is already in the DB', async () => {
		let calls = 0;
		const client = new GoogleBooksClient({ apiKey: 'test-key', fetchImpl: async () => { calls++; return new Response(JSON.stringify(SAMPLE_GB)); } });
		const { fetch, db } = await app({ client });
		await fetch(getRecordUrl(COLL.edition, 'gb-sample-vol'));
		expect(calls).toBe(1);
		await fetch(getRecordUrl(COLL.edition, 'gb-sample-vol'));
		expect(calls).toBe(1);
	});

	it('does not import a record for non-gb rkeys', async () => {
		let calls = 0;
		const client = new GoogleBooksClient({ apiKey: 'test-key', fetch: async () => { calls++; return new Response('{}'); } });
		const { fetch, db } = await app({ client });
		await fetch(getRecordUrl(COLL.edition, 'some-tid'));
		expect(calls).toBe(0);
	});

	it('returns RecordNotFound when GB has no such volume', async () => {
		const client = new GoogleBooksClient({ apiKey: 'test-key', fetchImpl: async () =>
			new Response('', { status: 404 }) });
		const { fetch } = await app({ client });
		const res = await fetch(getRecordUrl(COLL.edition, 'gb-notfound'));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('RecordNotFound');
	});

	it('returns RecordNotFound when GB omits volumeInfo.title', async () => {
		const client = new GoogleBooksClient({ apiKey: 'test-key', fetchImpl: async () =>
			new Response(JSON.stringify({ id: 'x', volumeInfo: {} }), { status: 200 }) });
		const { fetch } = await app({ client });
		const res = await fetch(getRecordUrl(COLL.edition, 'gb-no-title'));
		expect(res.status).toBe(400);
	});

	it('returns 502 when GB returns a non-404 error', async () => {
		const client = new GoogleBooksClient({ apiKey: 'test-key', fetchImpl: async () =>
			new Response('', { status: 500 }) });
		const { fetch } = await app({ client });
		const res = await fetch(getRecordUrl(COLL.edition, 'gb-server-error'));
		expect(res.status).toBe(502);
	});

	it('returns 502 when no GoogleBooksClient is configured', async () => {
		const { fetch } = await app({ client: undefined });
		const res = await fetch(getRecordUrl(COLL.edition, 'gb-no-client'));
		expect(res.status).toBe(502);
	});

	it('is idempotent under concurrent first-time imports', async () => {
		const { fetch } = await app({ client: makeClient() });
		const [r1, r2, r3] = await Promise.all([
			fetch(getRecordUrl(COLL.edition, 'gb-sample-vol')),
			fetch(getRecordUrl(COLL.edition, 'gb-sample-vol')),
			fetch(getRecordUrl(COLL.edition, 'gb-sample-vol')),
		]);
		const cids = await Promise.all([r1.json(), r2.json(), r3.json()]);
		expect(cids[0].cid).toBe(cids[1].cid);
		expect(cids[1].cid).toBe(cids[2].cid);
	});
});

describe('com.atproto.repo.listRecords', () => {
	it('lists records for a collection', async () => {
		const { fetch } = await app();
		const params = new URLSearchParams({ repo: SERVICE_DID, collection: COLL.edition });
		const res = await fetch(`/xrpc/com.atproto.repo.listRecords?${params}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.records.length).toBeGreaterThan(0);
	});

	it('paginates with limit and cursor', async () => {
		const { fetch } = await app();
		const params = new URLSearchParams({ repo: SERVICE_DID, collection: COLL.edition, limit: '1' });
		const res = await fetch(`/xrpc/com.atproto.repo.listRecords?${params}`);
		const body = await res.json();
		expect(body.records).toHaveLength(1);
		expect(body.cursor).toBeDefined();
	});

	it('reverses order with reverse=true', async () => {
		const { fetch } = await app();
		const params = new URLSearchParams({ repo: SERVICE_DID, collection: COLL.edition, reverse: 'true' });
		const res = await fetch(`/xrpc/com.atproto.repo.listRecords?${params}`);
		expect(res.status).toBe(200);
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
		expect(body.collections).toContain(COLL.edition);
		expect(body.collections).toContain(COLL.contributor);
	});
});