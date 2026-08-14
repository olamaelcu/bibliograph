import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getServiceDid } from '../did.js';
import { makeDidDoc, makeJwt } from '../test-utils/fake-auth.js';
import { createFakePds, serveFakePds } from '../test-utils/fake-pds.js';
import { createXrpcRouter } from '../xrpc/router.js';
import { createTestDb, SERVICE_DID } from '../test-utils/db.js';
import type { ViewContext } from '../xrpc/views.js';
import { registerUploadBlobRoute } from './router.js';

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

// ─── write-proxy helpers ─────────────────────────────────────────────────────

const USER_DID = 'did:web:alice.example.com';
const USER_COLLS = {
	review: 'net.olamaelcu.livtet.biblio.review',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelving: 'net.olamaelcu.livtet.biblio.bookShelving',
	actor: 'net.olamaelcu.livtet.biblio.actor',
} as const;

interface OutboundCall {
	pathname: string;
	body?: unknown;
}

interface WriteHarness {
	fetch: (path: string, init?: RequestInit) => Promise<Response>;
	fake: ReturnType<typeof createFakePds>;
	token: string;
	calls: OutboundCall[];
}

const openServers: Array<() => void> = [];

afterEach(() => {
	while (openServers.length) openServers.pop()!();
	vi.unstubAllGlobals();
});

/**
 * fetch stub that answers DID-document lookups from the fixture, lets every
 * other request hit the real network (the fake PDS), and records the JSON
 * bodies of outbound xrpc POSTs so tests can assert on the forwarded request.
 */
function routingFetch(didDoc: Record<string, unknown>, calls: OutboundCall[]): typeof fetch {
	const realFetch = globalThis.fetch;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith('/.well-known/did.json')) {
			return new Response(JSON.stringify(didDoc), { status: 200 });
		}
		if (url.pathname.startsWith('/xrpc/') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
			const req = new Request(input, init);
			calls.push({ pathname: url.pathname, body: await req.json().catch(() => undefined) });
		}
		return realFetch(input, init);
	}) as typeof fetch;
}

async function writeApp(): Promise<WriteHarness> {
	const { db, seed } = createTestDb();
	seed();
	const fake = createFakePds({ repo: USER_DID });
	const server = await serveFakePds(fake);
	openServers.push(server.close);
	const didDoc = makeDidDoc({ serviceEndpoint: server.baseUrl, alsoKnownAs: ['at://alice.example.com'] });
	const calls: OutboundCall[] = [];
	vi.stubGlobal('fetch', routingFetch(didDoc, calls));

	const router = createXrpcRouter(db, { serviceDid: SERVICE_DID });
	const app = new Hono();
	registerUploadBlobRoute(app);
	app.all('/xrpc/*', (c) => router.fetch(c.req.raw));
	app.onError((err, c) => {
		if (typeof err === 'object' && err !== null && 'status' in err) {
			const e = err as { status: number; error: string; message: string };
			return c.json(
				{ error: e.error || 'UnexpectedError', message: e.message || 'An error occurred' },
				e.status as never,
			);
		}
		return c.json({ error: 'InternalServerError', message: 'An unexpected error occurred' }, 500);
	});

	const token = makeJwt({ sub: USER_DID, aud: getServiceDid() });
	return {
		fetch: (path, init) => app.fetch(new Request(`https://books.example.com${path}`, init)),
		fake,
		token,
		calls,
	};
}

function post(token: string, body: unknown, contentType = 'application/json'): RequestInit {
	const headers: Record<string, string> = { 'content-type': contentType };
	if (token) headers.authorization = `Bearer ${token}`;
	return { method: 'POST', headers, body: JSON.stringify(body) };
}

describe('com.atproto.repo.uploadBlob (proxy, Hono route)', () => {
	it('forwards a raw blob body and returns {blob}', async () => {
		const w = await writeApp();
		const bytes = new TextEncoder().encode('fake-cover-bytes');
		const res = await w.fetch('/xrpc/com.atproto.repo.uploadBlob', {
			method: 'POST',
			headers: { authorization: `Bearer ${w.token}`, 'content-type': 'image/png' },
			body: bytes,
		});
		expect(res.status).toBe(200);
		const out = await res.json();
		expect(out.blob.$type).toBe('blob');
		expect(out.blob.ref.$link).toMatch(/^baf/);
		expect(out.blob.mimeType).toBe('image/png');
		expect(out.blob.size).toBe(bytes.byteLength);
	});

	it('rejects an upload without a bearer token', async () => {
		const w = await writeApp();
		const res = await w.fetch('/xrpc/com.atproto.repo.uploadBlob', {
			method: 'POST',
			headers: { 'content-type': 'image/png' },
			body: new TextEncoder().encode('nope'),
		});
		expect(res.status).toBe(401);
		expect(w.fake.requests).toHaveLength(0);
	});
});
