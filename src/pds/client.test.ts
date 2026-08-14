import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPdsClient } from './client.js';
import { createFakePds, serveFakePds } from '../test-utils/fake-pds.js';

const COLLECTION = 'net.olamaelcu.livtet.biblio.book';
const TOKEN = 'test-bearer-token';

describe('createPdsClient', () => {
	let fake: ReturnType<typeof createFakePds>;
	let close: () => void;
	let client: ReturnType<typeof createPdsClient>;

	beforeEach(async () => {
		fake = createFakePds();
		const server = await serveFakePds(fake);
		close = server.close;
		client = createPdsClient({ pdsUrl: server.baseUrl, token: TOKEN });
	});

	afterEach(() => close());

	it('round-trips a record through putRecord and getRecord', async () => {
		const ref = await client.putRecord(COLLECTION, 'book-1', { $type: COLLECTION, title: 'Dune' });
		expect(ref.uri).toBe(`at://did:example:alice/${COLLECTION}/book-1`);
		expect(ref.cid).toMatch(/^baf/);

		const got = await client.getRecord(COLLECTION, 'book-1');
		expect(got.uri).toBe(ref.uri);
		expect(got.cid).toBe(ref.cid);
		expect(got.value).toEqual({ $type: COLLECTION, title: 'Dune' });
	});

	it('lists records in rkey order and paginates with a cursor', async () => {
		await client.putRecord(COLLECTION, 'a-1', { $type: COLLECTION, n: 1 });
		await client.putRecord(COLLECTION, 'a-2', { $type: COLLECTION, n: 2 });
		await client.putRecord(COLLECTION, 'a-3', { $type: COLLECTION, n: 3 });

		const page1 = await client.listRecords(COLLECTION, { limit: 2 });
		expect(page1.records.map((r) => r.uri)).toEqual([
			`at://did:example:alice/${COLLECTION}/a-1`,
			`at://did:example:alice/${COLLECTION}/a-2`,
		]);
		expect(page1.cursor).toBe('a-2');

		const page2 = await client.listRecords(COLLECTION, { limit: 2, cursor: page1.cursor });
		expect(page2.records.map((r) => r.uri)).toEqual([`at://did:example:alice/${COLLECTION}/a-3`]);
		expect(page2.cursor).toBeUndefined();
	});

	it('creates a record with an auto-generated rkey', async () => {
		const ref = await client.createRecord(COLLECTION, { $type: COLLECTION, title: 'Embassytown' });
		expect(ref.uri).toMatch(new RegExp(`^at://did:example:alice/${COLLECTION}/[a-z0-9]+$`));

		const rkey = ref.uri.split('/').pop()!;
		const got = await client.getRecord(COLLECTION, rkey);
		expect(got.value).toEqual({ $type: COLLECTION, title: 'Embassytown' });
	});

	it('deletes a record', async () => {
		await client.createRecord(COLLECTION, { $type: COLLECTION, title: 'Gone' }, { rkey: 'del-1' });
		await client.deleteRecord(COLLECTION, 'del-1');
		await expect(client.getRecord(COLLECTION, 'del-1')).rejects.toThrow();
	});

	it('applies batch writes (create + update + delete)', async () => {
		await client.putRecord(COLLECTION, 'batch-1', { $type: COLLECTION, v: 1 });

		await client.applyWrites([
			{ action: 'create', collection: COLLECTION, rkey: 'batch-2', value: { $type: COLLECTION, v: 2 } },
			{ action: 'update', collection: COLLECTION, rkey: 'batch-1', value: { $type: COLLECTION, v: 99 } },
			{ action: 'delete', collection: COLLECTION, rkey: 'batch-3' },
		]);

		const updated = await client.getRecord(COLLECTION, 'batch-1');
		expect(updated.value).toEqual({ $type: COLLECTION, v: 99 });
		const created = await client.getRecord(COLLECTION, 'batch-2');
		expect(created.value).toEqual({ $type: COLLECTION, v: 2 });
		await expect(client.getRecord(COLLECTION, 'batch-3')).rejects.toThrow();
	});

	it('uploads a blob', async () => {
		const bytes = new TextEncoder().encode('hello blob');
		const res = await client.uploadBlob(bytes, 'text/plain');
		expect(res.blob.$type).toBe('blob');
		expect(res.blob.ref.$link).toMatch(/^baf/);
		expect(res.blob.mimeType).toBe('text/plain');
		expect(res.blob.size).toBe(bytes.byteLength);
	});

	it('sends the bearer token on every request', async () => {
		await client.getRecord(COLLECTION, 'missing').catch(() => {});
		expect(fake.requests.length).toBeGreaterThan(0);
		for (const req of fake.requests) {
			expect(req.headers['authorization']).toBe(`Bearer ${TOKEN}`);
		}
	});
});
